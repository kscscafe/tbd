# TBD ロードマップ
*v0.1 — 2026.05.09*

> 工数は杉崎 + Claude Code の二人三脚を前提とした目安。実装の体感で前後する。

---

## Phase 0：準備（半日〜1日）

- [ ] GitHub に新規リポジトリ作成（候補：`kscscafe/tbd`）
- [ ] Neon に新規プロジェクト作成（otera-chat と分離）
- [ ] Vercel に新規プロジェクト作成・GitHub 連携
- [ ] otera-chat から流用ファイルをコピー
  - `api/_lib.js` / `api/fragments.js`（改造前提でコピー）/ `db/migrate.js` / `dev.js` / `package.json` / `vercel.json` / `.env.local.example`
- [ ] `.env.local` 設定
  - `DATABASE_URL`（新Neon）
  - `ANTHROPIC_API_KEY`
  - `SESSION_SECRET`（ランダム文字列）
- [ ] `db/schema.sql` を TBD 用に書き直し（users / nodes / fragments / outputs）
- [ ] `node db/migrate.js` で初期スキーマ適用

## Phase 1：バックエンド（3〜5日）

- [ ] `api/auth.js` 新規（POST /signup / POST /login、bcrypt + HMAC token）
- [ ] `api/fragments.js` を user_id 軸に書き換え
- [ ] `api/nodes.js` 新規（GET ツリー / POST / PUT 名前・親変更 / DELETE）
- [ ] `api/cluster.js` を階層対応 auto-grow に書き換え
- [ ] `api/agent-chat.js` 新規（ノード文脈チャット、子孫の断片・outputs を文脈注入）
- [ ] `api/outputs.js` 新規（POST 保存 / GET 一覧 / PUT / DELETE）
- [ ] curl / Postman で全エンドポイントの動作確認
- [ ] Vercel デプロイ確認

## Phase 2：フロントエンド MVP（3〜5日）

- [ ] `public/login.html` — 認証画面
- [ ] `public/index.html` — メイン画面（3ペイン）
  - 左：インデントツリーナビ
  - 中央：選択ノード詳細 + 断片リスト
  - 右：チャット
- [ ] フローティング「+」ボタンで断片投入モーダル
- [ ] 「整理する」ボタンで `/api/cluster` 実行 → ツリー再描画
- [ ] ツリー D&D（HTML5 Drag&Drop API、簡易版）
- [ ] ノード詳細に「📦 成果物」タブ・「💾 保存」ボタン
- [ ] ステータス・進捗・優先度のインライン編集

## Phase 3：杉崎ドッグフード（2週間）

- [ ] 杉崎が自分の Claude Projects 7体の内容を移行
- [ ] 毎日使ってフィードバック収集（バグ・UX 違和感を都度メモ）
- [ ] バグ修正・UX 改善イテレーション
- [ ] この期間で「使い続けられる」ことを確認

## Phase 4：限定β（4週間）

- [ ] LP 作成（簡易、Notion or 1ページ HTML）
- [ ] ASD/ADHD コミュニティ経由で 5〜10人にβ募集
- [ ] フィードバック収集・優先タスク化
- [ ] Phase 2 機能（俯瞰ビュー強化、サンバースト、関連性可視化）を必要に応じて追加

## Phase 5：一般公開・課金（4週間）

- [ ] 課金プラン実装（Stripe）
- [ ] LP 強化
- [ ] 公開

---

## 技術的な後回しタスク（Phase 2 以降に組み込み判断）

- pgvector セマンティック検索（fragments / nodes 両方の embedding 書き込み + 検索）
- ノード間の関連性自動検出（埋め込みコサイン距離 → 線描画）
- サンバースト / ツリーマップ可視化（D3.js or echarts）
- 音声入力（Whisper API or iOS Speech Framework）
- パターン検出（「3日連続で同じ話題」「2週間放置」「先月との矛盾」）
- ファイル添付（Vercel Blob、otera-chat 流用可）
- ノードのマージ・分割 UI
- iOS / Android アプリ着手判断（バックエンド固まってから）

---

## 判断が必要なポイント

| いつ | 何を決める | メモ |
|---|---|---|
| Phase 0 着手前 | リポジトリ名 | `kscscafe/tbd` でいい？正式名称が決まったら rename |
| Phase 0 着手前 | 正式プロダクト名（コードネーム TBD のまま？） | 後回しでも可 |
| Phase 1 着手前 | 認証方式（パスワード？マジックリンク？） | MVPはパスワード推奨（実装が早い） |
| Phase 2 着手前 | UI ライブラリ（Tailwind CDN / Alpine.js / 素 JS） | otera-chat は素 JS、TBD も最初は揃えるのが楽 |
| Phase 3 完了時 | モバイル先行（Flutter / Swift）の判断 | 杉崎が自分でWebを使い続けられるかで判断 |
| Phase 4 完了時 | 課金プランの最終決定（価格・内訳） | Claude API コストを実測してから |

---

## 関連ドキュメント

- `app_concept_spec.md` — コンセプト仕様（v0.2）
- `tbd_claudecode_prompt.md` — Claude Code 向け実装プロンプト（v0.2）
