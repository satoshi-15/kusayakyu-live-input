-- 草野球ライブ入力アプリ: テーブル定義
-- rules/集計ルール.md, scripts/validate.py の result enum と同期させること(手動運用)。

create extension if not exists pgcrypto;

create table if not exists games (
  game_id text primary key,
  opponent_name text,
  game_date date,
  our_half text not null check (our_half in ('top', 'bottom')),
  lineup jsonb not null default '[]'::jsonb,
  -- 投手成績(相手打席の詳細)を記録するかどうか。試合作成時に選択、試合中も変更可能。
  -- OFFの間は守備側halfを「アウトのみ」の簡易入力にする(game.html参照)。
  track_pitching boolean not null default true,
  -- 練習試合か公式戦か。練習試合はスカイツリーグ登録の対象外にする(TeamSへは引き続き登録する)。
  game_type text not null default 'official' check (game_type in ('official', 'practice')),
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
  -- scripts/validate.py の ALLOWED_RESULTS (AB_RESULTS | NON_AB_RESULTS) と同じ14種。
  result text not null check (result in (
    'groundout', 'flyout', 'strikeout', 'walk', 'hbp', 'single', 'double', 'triple',
    'home_run', 'sac_bunt', 'sac_fly', 'fielders_choice', 'reached_on_error', 'strikeout_reached'
  )),
  ab boolean not null default false,
  hit_type text check (hit_type is null or hit_type in ('single', 'double', 'triple', 'home_run')),
  rbi int not null default 0 check (rbi between 0 and 4),
  scored boolean not null default false,
  detail text,
  -- 投手成績を記録する場合のみ入力(games.track_pitching参照)。OFF時はnullのままでよく、
  -- aggregate_pitching()はpitcher_idが無いレコードを自動的にスキップする。
  pitcher_id text,
  opponent_batter_name text,
  entered_by text,
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  -- 直近の編集(edit_atbat_full)のclient_uuid。オフラインキュー・自動リトライによる編集の再送で
  -- 走者イベントが二重に取消・再作成されるのを防ぐための冪等性ガードに使う。
  last_edit_client_uuid uuid,
  unique (game_id, client_uuid)
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
  type text not null check (
    type in (
      'stolen_base', 'caught_stealing', 'runner_out_advancing', 'runner_advance',
      'wild_pitch', 'balk', 'passed_ball'
    )
  ),
  -- 表示・エクスポート用(自チームは選手id、相手チームはopponent_batter_nameを入れる)。
  runner_id text,
  -- 走者を特定する正本のキー。自チーム・相手チームどちらの走者も、出塁した打席のidで一意に指す
  -- (相手選手には安定した選手idが無いため。js/derive.jsのderiveRunnersOnBase参照)。
  runner_atbat_id bigint references live_atbats(id),
  -- type='runner_advance'の進塁先。'home'は打席を介さない生還(暴投・ボーク・パスボール等)を表す。
  to_base text check (to_base is null or to_base in ('second', 'third', 'home')),
  pitcher_id text,
  runner_note text,
  entered_by text,
  -- この行を発生させた打席(submit_atbat/edit_atbat_fullが打席と同時に作る付随イベントにのみ設定)。
  -- 打席編集(edit_atbat_full)時に「この打席が原因で作られたイベント」だけを特定して
  -- 取消・再作成するために使う。盗塁等の単独クイックイベントはnullのまま。
  caused_by_atbat_id bigint references live_atbats(id),
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  unique (game_id, client_uuid)
);

create index if not exists live_events_game_idx on live_events (game_id, id);

-- オーダー(打順・守備位置)編集の履歴。update_lineup RPCが呼ばれるたびに、変更後の全スナップショット
-- を1行追加する(差分計算はせず、表示側で前回スナップショットとの比較として導出する設計)。
-- 守備位置の交代がいつ・誰によって行われたかを追跡し、将来的なスカイツリーグ登録の守備欄自動反映・
-- 盗塁阻止(捕手成績)算出の入力に使う想定(現時点では記録のみ)。
create table if not exists lineup_history (
  id bigint generated always as identity primary key,
  game_id text not null references games(game_id) on delete cascade,
  -- 変更時点のイニング・表裏(呼び出し元がcurrentPointerから渡す。試合開始前の初期登録ならnull)。
  inning int,
  half text check (half is null or half in ('top', 'bottom')),
  lineup jsonb not null,
  changed_by text,
  created_at timestamptz not null default now()
);

create index if not exists lineup_history_game_idx on lineup_history (game_id, id);
