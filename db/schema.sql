-- TBD: Neon / PostgreSQL schema
-- Apply with: node db/migrate.js   (loads .env.local)

create extension if not exists "pgcrypto";
create extension if not exists vector;

-- ─────────────────────────────────────────────────────────────────
-- users: 個人ユーザー（パスワード認証 + HMAC セッショントークン）
-- ─────────────────────────────────────────────────────────────────
create table if not exists users (
  id             uuid        primary key default gen_random_uuid(),
  email          text        not null,
  password_hash  text        not null,
  display_name   text,
  created_at     timestamptz not null default now()
);
create unique index if not exists users_email_uniq on users (lower(email));

-- ─────────────────────────────────────────────────────────────────
-- nodes: 自己参照ツリー。各ノードがエージェントとして機能する。
--   parent_id=NULL がルートノード。
--   削除は ON DELETE CASCADE で配下を巻き込む。
-- ─────────────────────────────────────────────────────────────────
create table if not exists nodes (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references users(id) on delete cascade,
  parent_id      uuid        references nodes(id) on delete cascade,
  name           text        not null,
  system_prompt  text        not null default '',
  status         text        not null default 'active',  -- active / waiting / blocked / dormant / done
  progress       integer     not null default 0,         -- 0-100
  priority       integer     not null default 0,         -- 0=low, 1=med, 2=high
  next_action    text,
  auto_named     boolean     not null default true,
  sort_order     integer     not null default 0,
  embedding      vector(1536),
  position_x     double precision,
  position_y     double precision,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists nodes_user_idx on nodes (user_id);
create index if not exists nodes_parent_idx on nodes (parent_id);

-- 既存DB向け：星座キャンバスの位置情報カラムを後付け（冪等）
alter table nodes add column if not exists position_x double precision;
alter table nodes add column if not exists position_y double precision;

-- ─────────────────────────────────────────────────────────────────
-- fragments: ユーザーが投げ込んだ生の入力。整理前は node_id=NULL。
-- ─────────────────────────────────────────────────────────────────
create table if not exists fragments (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  node_id      uuid        references nodes(id) on delete set null,
  raw_text     text        not null,
  source       text        not null default 'text',  -- text / voice / file
  source_meta  jsonb,
  embedding    vector(1536),
  created_at   timestamptz not null default now()
);
create index if not exists fragments_user_idx on fragments (user_id, created_at desc);
create index if not exists fragments_node_idx on fragments (node_id);

-- ─────────────────────────────────────────────────────────────────
-- issues: ノードに紐づく「課題（やるべきこと・解決すべき問題）」。
--   断片＝生の入力、課題＝アクション項目、成果物＝完成物 の3層。
-- ─────────────────────────────────────────────────────────────────
create table if not exists issues (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references users(id) on delete cascade,
  node_id              uuid        references nodes(id) on delete set null,
  title                text        not null,
  description          text        not null default '',
  status               text        not null default 'open',  -- open / in_progress / done / wontfix
  priority             integer     not null default 0,        -- 0=low, 1=med, 2=high
  due_date             date,
  source_fragment_ids  uuid[]      not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists issues_user_idx on issues (user_id, created_at desc);
create index if not exists issues_node_idx on issues (node_id);
create index if not exists issues_node_status_idx on issues (node_id, status);

-- ─────────────────────────────────────────────────────────────────
-- outputs: ノードが生成した成果物。チャット応答を「保存」ボタンで昇格。
--   parent_output_id で再生成の系譜を辿れる。
-- ─────────────────────────────────────────────────────────────────
create table if not exists outputs (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references users(id) on delete cascade,
  node_id              uuid        not null references nodes(id) on delete cascade,
  type                 text        not null default 'free',  -- proposal / email / minutes / spec / free
  title                text        not null,
  content              text        not null default '',
  source_fragment_ids  uuid[]      not null default '{}',
  version              integer     not null default 1,
  parent_output_id     uuid        references outputs(id),
  created_at           timestamptz not null default now()
);
create index if not exists outputs_node_idx on outputs (node_id, created_at desc);
