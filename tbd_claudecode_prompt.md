# Project TBD — Claude Code 実装プロンプト
*v0.2 — 2026.05.09*

## 指示

以下の仕様で TBD の MVP を構築してください。
**otera-chat（`/Users/ksugizaki/Documents/50_SaaS/otera-chat`）をテンプレート**として開始し、不要な部分を削除・必要な部分を追加してください。

---

## プロジェクト概要

**TBD（コードネーム）**

断片化した思考を AI が自動でツリー化・エージェント化し、各エージェントが仕事の主体となって成果物を仕上げる Web アプリ。ASD・ADHD ユーザーの「思考の義肢」となる。

参考：杉崎本人が Claude Projects で AI エージェント7体を手動運用し、中途半端に終わっていた仕事が完結するようになった体験を、設計を意識せず誰でも再現できるようにするのがゴール。

設計思想の詳細は `app_concept_spec.md` を参照。

---

## otera-chat からの流用方針

### そのまま使う
- `api/_lib.js` — Neon Pool / HMAC セッション / レート制限 / ensureSchema
- `db/migrate.js` — マイグレーション運用
- `package.json` の依存関係（@anthropic-ai/sdk / @neondatabase/serverless / ws / bcryptjs 等）
- pgvector 拡張 / `embedding vector(1536)` カラム

### 改造して使う
- `api/fragments.js` — `temple_id` → `user_id` に置換
- `api/cluster.js` — フラット分類 → **階層対応の auto-grow 分類**へ拡張（後述）
- `api/clusters.js` → `api/nodes.js` にリネーム＋ツリー操作（移動・マージ）追加

### 削除する
- `api/temples.js` — お寺特化の CRUD
- `api/chat.js` / `widget.html` / `widget.js` — 外部チャット
- `api/internal-chat*` — 寺族向け
- `api/crawl.js` — HP クロール
- `api/extract.js` の寺特化部分（汎用的に再利用なら残す）
- `api/notes.js` は **outputs テーブル用に再設計**

### 新規追加
- `api/auth.js` — ユーザー登録・ログイン（メール+パスワード、bcrypt）
- `api/outputs.js` — 成果物の保存・取得・バージョン管理
- `api/agent-chat.js` — ノードを文脈にチャット（親ノード → 子孫文脈も含める）

---

## DB スキーマ

```sql
create extension if not exists "pgcrypto";
create extension if not exists vector;

-- ユーザー
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  display_name text,
  created_at timestamptz not null default now()
);

-- ノード（ツリー構造、エージェント）
create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  parent_id uuid references nodes(id) on delete cascade,
  name text not null,
  system_prompt text not null default '',
  status text not null default 'active',  -- active / waiting / blocked / dormant / done
  progress integer not null default 0,    -- 0-100
  priority integer not null default 0,    -- 0=low, 1=med, 2=high
  next_action text,
  auto_named boolean not null default true,
  sort_order integer not null default 0,
  embedding vector(1536),                  -- ノード埋め込み（関連性検出用）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists nodes_user_idx on nodes (user_id);
create index if not exists nodes_parent_idx on nodes (parent_id);

-- 断片（生の入力）
create table if not exists fragments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  node_id uuid references nodes(id) on delete set null,
  raw_text text not null,
  source text not null default 'text',     -- text / voice / file
  source_meta jsonb,                        -- ファイル名・録音長等
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists fragments_user_idx on fragments (user_id, created_at desc);
create index if not exists fragments_node_idx on fragments (node_id);

-- 成果物
create table if not exists outputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  node_id uuid not null references nodes(id) on delete cascade,
  type text not null default 'free',       -- proposal / email / minutes / spec / free
  title text not null,
  content text not null default '',
  source_fragment_ids uuid[] not null default '{}',
  version integer not null default 1,
  parent_output_id uuid references outputs(id),  -- 再生成時の系譜
  created_at timestamptz not null default now()
);
create index if not exists outputs_node_idx on outputs (node_id, created_at desc);
```

---

## MVP スコープ(Phase 1)

1. **認証**
   - メール+パスワード登録・ログイン
   - HMAC セッショントークン（30日 TTL、otera-chat の `issueSessionToken` 流）

2. **断片インボックス**
   - テキスト入力欄
   - 送信で `/api/fragments` に POST、`node_id` は NULL のまま保存

3. **ツリー auto-grow 分類**（核心機能）
   - `/api/cluster` を階層対応に拡張
   - 未分類断片に対して、AI が以下を判断：
     - 既存ノードに追加（`type: existing_node`）
     - 既存ノード配下に新ノード作成（`type: new_child`）
     - 新ルートノード作成（`type: new_root`）
   - プロンプトに既存ツリー構造を渡し、JSON で結果を返させる

4. **ノード CRUD・ツリー操作**
   - ノード一覧（ツリー形式、再帰 SELECT or アプリ側組み立て）
   - 名前変更（→ auto_named=false）
   - 親変更（手動 D&D）
   - 削除（CASCADE で配下ノード・断片も処理）

5. **ノードチャット**
   - ノードを選んで対話
   - 文脈：そのノードの system_prompt + 配下の断片 + 配下の outputs
   - 親ノードを選ぶと子孫の文脈も含める（再帰 SELECT）

6. **成果物保存**
   - チャット応答を「💾 artifact として保存」ボタンで outputs テーブルに保存
   - ノード詳細に「📦 成果物」タブで履歴表示

7. **3ペイン俯瞰UI**
   - 左：インデントツリー（クリックで選択）
   - 中央：選択ノードの詳細（進捗・状態・優先度・next_action）+ 断片リスト
   - 右：チャット欄
   - 上部にダッシュボード行：全ノードの状態を横スクロールで一覧

---

## 後回し（Phase 2 以降）

- サンバースト / ツリーマップ可視化
- pgvector 関連性検出と線描画
- 音声入力（Whisper API）
- パターン検出・矛盾検出（「鏡」機能）
- ノードのマージ・分割
- ファイル添付（Vercel Blob）
- iOS / Android アプリ
- 課金（Stripe）

---

## 技術スタック

- **Framework:** なし（otera-chat と同じ素 HTML/CSS/JS + Vercel Functions）
- **Hosting:** Vercel
- **DB:** Neon PostgreSQL（otera-chat と別プロジェクトで新設）
- **AI:** Anthropic API（`claude-sonnet-4-6`）
- **Auth:** HMAC セッショントークン（`_lib.js` の `issueSessionToken` 流用）
- **Styling:** Tailwind CDN（軽量構成）

---

## 階層対応 cluster.js のプロンプト設計（指針）

### system prompt 概略

```
あなたは個人ユーザーが投げ込んだ思考の断片を、自動でツリー構造に整理するエージェントです。

ユーザー特性：
- ASD/ADHD 傾向で、自分で分類するのが苦手
- 全体像をツリーで把握したい
- 各分野の関連性が見える方が嬉しい

判断ルール：
- 未分類の断片を読み、似た内容ごとにグループ化
- 既存ツリーに明確に近いノードがあれば、そのノードに追加
- 既存の親ノードの新しい側面なら、その下に子ノードを新規作成
- どの既存ツリーにも合わない場合のみ、新しいルートノードを作る
- ノード名は10文字以内で端的に
- 既存ノードの名前・system_prompt は変更してはいけない（追記型）

出力形式（JSONのみ）：
{
  "groups": [
    {
      "target": {
        "type": "existing_node",
        "node_id": "uuid"
      },
      "fragment_indices": [0, 2]
    },
    {
      "target": {
        "type": "new_child",
        "parent_node_id": "uuid",
        "name": "新しい子ノード名",
        "system_prompt": "このノードのエージェント人格定義"
      },
      "fragment_indices": [1]
    },
    {
      "target": {
        "type": "new_root",
        "name": "新しいルートノード名",
        "system_prompt": "..."
      },
      "fragment_indices": [3]
    }
  ]
}
```

### user prompt の組み立て方

- 既存ツリーをインデント付き文字列でコンパクトに渡す（ノードIDも併記）
  ```
  [N1] 自社経営
    [N2] OFFICE ES
      [N3] 営業
    [N4] GATES JAPAN
  [N5] プロダクト開発
    [N6] LOUD
  ```
- 未分類断片を `[0] ...`, `[1] ...` 形式で列挙
- otera-chat の `cluster.js` の追記型ロジック（既存に触らない・新規だけ INSERT）を踏襲

### DB 反映ロジック（otera-chat ベース）

- 同一実行内で同じ `new_root` / `new_child` 名は重複作成しない（dedup map）
- ノード INSERT 後、`fragments.node_id` を UPDATE
- トランザクション境界は緩めでよい（otera-chat と同じ整合性レベル）

---

## 優先事項

1. **杉崎自身が使えるレベル**まで Phase 1 を仕上げる
2. デプロイまで完了させる（Vercel）
3. UI は最低限、機能優先
4. 課金・マルチデバイスは後回し

---

## 参考

- otera-chat：`/Users/ksugizaki/Documents/50_SaaS/otera-chat`
  - 必読：`api/cluster.js`, `api/_lib.js`, `db/schema.sql`, `docs/spec.md`
- 設計思想：`app_concept_spec.md`
- ロードマップ：`tbd_roadmap.md`
