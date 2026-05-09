# TBD

断片を投げ込むだけで、AI が自動でツリー化・エージェント化し、論理的な成果物として仕上げてくれるWebアプリ。

ASD・ADHD ユーザーの「思考の義肢」を目指す。

詳細は [`app_concept_spec.md`](./app_concept_spec.md) を参照。

## 構成

```
/
├── api/
│   └── _lib.js            # 共有ユーティリティ（Neon Pool / HMAC セッション / レート制限）
├── db/
│   ├── schema.sql         # users / nodes / fragments / outputs
│   └── migrate.js         # スキーマ適用スクリプト
├── public/                # フロントエンド（Phase 2 で実装）
├── dev.js                 # ローカル開発サーバ（Vercel Functions 互換）
├── vercel.json
└── package.json
```

- フロント：素 HTML/CSS/JS（otera-chat と同じ構成）
- API：Vercel Functions（Node.js 20+ / ESM）
- DB：Neon (PostgreSQL) + pgvector
- LLM：Anthropic `claude-sonnet-4-6`
- Auth：HMAC 署名のセッショントークン

## ドキュメント

- [`app_concept_spec.md`](./app_concept_spec.md) — コンセプト仕様（v0.2）
- [`tbd_claudecode_prompt.md`](./tbd_claudecode_prompt.md) — Claude Code 向け実装プロンプト
- [`tbd_roadmap.md`](./tbd_roadmap.md) — フェーズ別タスク分解

## セットアップ

### 1. Neon

[neon.tech](https://neon.tech) でプロジェクトを作成し、接続文字列を取得。

```bash
cp .env.local.example .env.local
# .env.local に DATABASE_URL / ANTHROPIC_API_KEY / SESSION_SECRET を設定
npm install
npm run db:migrate
```

### 2. ローカル開発

```bash
npm run dev
# → http://localhost:3000/
```

### 3. Vercel デプロイ

```bash
npx vercel link
npx vercel env add DATABASE_URL
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add SESSION_SECRET
npx vercel deploy --prod
```

## ステータス

Phase 0：準備（進行中）
- [x] リポジトリ初期構成
- [x] DB スキーマ定義
- [x] ローカル開発サーバ
- [ ] Neon プロジェクト作成・DATABASE_URL 設定
- [ ] migrate 実行
- [ ] Vercel プロジェクト作成・連携

詳細は `tbd_roadmap.md`。
