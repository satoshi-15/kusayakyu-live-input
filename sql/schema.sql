-- 草野球ライブ入力アプリ: テーブル定義
-- rules/集計ルール.md, scripts/validate.py の result enum と同期させること(手動運用)。

create extension if not exists pgcrypto;

create table if not exists games (
  game_id text primary key,
  opponent_name text,
  game_date date,
  our_half text not null check (our_half in ('top', 'bottom')),
  lineup jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

-- access_tokenはanonから一切SELECTできない(rls_policies.sql参照)。RPC関数内でのみ照合する。
create table if not exists game_secrets (
  game_id text primary key references games(game_id) on delete cascade,
  access_token uuid not null default gen_random_uuid()
);

-- ニックネームのみ格納する(本名・背番号・スカイツリーグIDは入れない。公開リポジトリ・公開DBのため)。
create table if not exists players (
  id text primary key,
  display_name text not null,
  guest boolean not null default false
);

create table if not exists live_atbats (
  id bigint generated always as identity primary key,
  game_id text not null references games(game_id) on delete cascade,
  client_uuid uuid not null,
  inning int not null check (inning >= 1),
  half text not null check (half in ('top', 'bottom')),
  batter_id text not null,
  order_no int,
  outs_before int check (outs_before between 0 and 2),
  -- scripts/validate.py の ALLOWED_RESULTS (AB_RESULTS | NON_AB_RESULTS) と同じ13種。
  result text not null check (result in (
    'groundout', 'flyout', 'strikeout', 'walk', 'hbp', 'single', 'double', 'triple',
    'home_run', 'sac_bunt', 'sac_fly', 'fielders_choice', 'reached_on_error'
  )),
  ab boolean not null default false,
  hit_type text check (hit_type is null or hit_type in ('single', 'double', 'triple', 'home_run')),
  rbi int not null default 0 check (rbi between 0 and 4),
  scored boolean not null default false,
  detail text,
  -- 守備側half(batter_id='opponent')のレコードで必須。rules/集計ルール.md セクション11参照。
  pitcher_id text,
  opponent_batter_name text,
  entered_by text,
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  unique (game_id, client_uuid),
  -- 守備側half(batter_id='opponent')のレコードはpitcher_id必須(rules/集計ルール.md セクション11)。
  constraint pitcher_required_for_opponent check (batter_id <> 'opponent' or pitcher_id is not null)
);

create index if not exists live_atbats_game_idx on live_atbats (game_id, id);

-- 盗塁・盗塁死・暴投・ボーク。打席とは独立して発生するため専用テーブルに分離
-- (rules/集計ルール.md セクション8。当初atbatsにbool付与する案だったが3専門家レビューで撤回)。
create table if not exists live_events (
  id bigint generated always as identity primary key,
  game_id text not null references games(game_id) on delete cascade,
  client_uuid uuid not null,
  inning int not null,
  half text not null check (half in ('top', 'bottom')),
  type text not null check (type in ('stolen_base', 'caught_stealing', 'runner_out_advancing', 'wild_pitch', 'balk')),
  -- stolen_base/caught_stealingで必須(誰の盗塁かをbaserunning_events.jsonのrunner_idとして引き継ぐため)。
  runner_id text,
  pitcher_id text,
  runner_note text,
  entered_by text,
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  unique (game_id, client_uuid)
);

create index if not exists live_events_game_idx on live_events (game_id, id);
