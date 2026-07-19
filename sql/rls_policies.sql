-- 草野球ライブ入力アプリ: RLSポリシー
--
-- 方針(実装計画 フェーズ2「Supabaseスキーマ設計」参照):
--   1. 全テーブルでRLSを明示的に有効化する(デフォルト無効のテーブルが紛れ込むミスを防ぐ)。
--   2. SELECTは全テーブルanon開放(Realtimeのpostgres_changesがSELECT可能な行しか配信しないため必須)。
--   3. INSERT/UPDATE/DELETEはanon/authenticatedに一切ポリシーを与えない(=デフォルト拒否)。
--      書き込みは全てfunctions.sqlのSECURITY DEFINER関数経由のみで行う。
--   4. game_secretsはSELECTポリシーすら与えない(RPC関数内からのみ参照。誰にも直接読めない)。

alter table games enable row level security;
alter table game_secrets enable row level security;
alter table players enable row level security;
alter table live_atbats enable row level security;
alter table live_events enable row level security;
alter table lineup_history enable row level security;

create policy games_select_anon on games for select using (true);
create policy players_select_anon on players for select using (true);
create policy live_atbats_select_anon on live_atbats for select using (true);
create policy live_events_select_anon on live_events for select using (true);
create policy lineup_history_select_anon on lineup_history for select using (true);

-- game_secretsにはSELECTポリシーを作らない(=anon/authenticatedからは常に0行に見える)。

-- 上記以外のINSERT/UPDATE/DELETEポリシーは意図的に作成しない。
-- 書き込みが必要な操作はfunctions.sql内のSECURITY DEFINER関数(所有者権限で実行されRLSをバイパスする)
-- からのみ行う。関数の所有者がテーブル所有者(通常SQL Editorで実行した場合はpostgresロール)と
-- 一致していることを前提とする(所有者はデフォルトで自テーブルのRLSをバイパスするため)。
