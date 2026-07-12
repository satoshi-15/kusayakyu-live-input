-- 草野球ライブ入力アプリ: RPC関数(書き込みの唯一の経路)
--
-- 全関数 SECURITY DEFINER + SET search_path = public, pg_temp で作成する
-- (エンジニアレビュー反映: search_pathハイジャック対策)。
-- 所有者はテーブル所有者と同じロール(通常SQL Editorで実行した場合は postgres)を想定し、
-- RLSは所有者権限でバイパスされる前提。
--
-- game_idごとのaccess_tokenをURLフラグメント(#token=)経由でクライアントが持ち、
-- 各書き込み関数の呼び出し時に必ず照合する。不一致・存在しない場合は例外を投げる。

create or replace function _check_access(p_game_id text, p_access_token uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from game_secrets
    where game_id = p_game_id and access_token = p_access_token
  ) then
    raise exception 'invalid access_token for game_id %', p_game_id
      using errcode = '28000';
  end if;
end;
$$;

revoke execute on function _check_access(text, uuid) from public, anon, authenticated;


create or replace function create_game(
  p_game_id text,
  p_opponent_name text,
  p_game_date date,
  p_our_half text,
  p_lineup jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
begin
  insert into games (game_id, opponent_name, game_date, our_half, lineup)
  values (p_game_id, p_opponent_name, p_game_date, p_our_half, coalesce(p_lineup, '[]'::jsonb));

  insert into game_secrets (game_id) values (p_game_id)
  returning access_token into v_token;

  return v_token;
end;
$$;

grant execute on function create_game(text, text, date, text, jsonb) to anon, authenticated;


create or replace function submit_atbat(
  p_game_id text,
  p_access_token uuid,
  p_client_uuid uuid,
  p_inning int,
  p_half text,
  p_batter_id text,
  p_order_no int,
  p_outs_before int,
  p_result text,
  p_ab boolean,
  p_hit_type text,
  p_rbi int,
  p_scored boolean,
  p_detail text,
  p_pitcher_id text,
  p_opponent_batter_name text,
  p_entered_by text
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_atbats;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  insert into live_atbats (
    game_id, client_uuid, inning, half, batter_id, order_no, outs_before,
    result, ab, hit_type, rbi, scored, detail, pitcher_id, opponent_batter_name, entered_by
  ) values (
    p_game_id, p_client_uuid, p_inning, p_half, p_batter_id, p_order_no, p_outs_before,
    p_result, p_ab, p_hit_type, p_rbi, p_scored, p_detail, p_pitcher_id, p_opponent_batter_name, p_entered_by
  )
  -- client_uuidによるベキ等リトライ: 同じ内容の再送はDO NOTHINGで無害化し、既存行を返す
  on conflict (game_id, client_uuid) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from live_atbats where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  return v_row;
end;
$$;

grant execute on function submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text
) to anon, authenticated;


create or replace function edit_atbat(
  p_id bigint,
  p_access_token uuid,
  p_batter_id text,
  p_order_no int,
  p_outs_before int,
  p_result text,
  p_ab boolean,
  p_hit_type text,
  p_rbi int,
  p_scored boolean,
  p_detail text,
  p_pitcher_id text,
  p_opponent_batter_name text
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_atbats;
begin
  select game_id into v_game_id from live_atbats where id = p_id;
  if v_game_id is null then
    raise exception 'live_atbats id % not found', p_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  update live_atbats set
    batter_id = p_batter_id,
    order_no = p_order_no,
    outs_before = p_outs_before,
    result = p_result,
    ab = p_ab,
    hit_type = p_hit_type,
    rbi = p_rbi,
    scored = p_scored,
    detail = p_detail,
    pitcher_id = p_pitcher_id,
    opponent_batter_name = p_opponent_batter_name
  where id = p_id and deleted_at is null
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function edit_atbat(
  bigint, uuid, text, int, int, text, boolean, text, int, boolean, text, text, text
) to anon, authenticated;


create or replace function soft_delete_atbat(p_id bigint, p_access_token uuid, p_deleted_by text)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_atbats;
begin
  select game_id into v_game_id from live_atbats where id = p_id;
  if v_game_id is null then
    raise exception 'live_atbats id % not found', p_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  update live_atbats set deleted_at = now(), deleted_by = p_deleted_by
  where id = p_id and deleted_at is null
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function soft_delete_atbat(bigint, uuid, text) to anon, authenticated;


-- 直前1件のワンタップ取消(モーダル無し)用。非削除の中で最新のidを1件取り消す。
create or replace function undo_last_atbat(p_game_id text, p_access_token uuid, p_deleted_by text)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_id bigint;
  v_row live_atbats;
begin
  perform _check_access(p_game_id, p_access_token);

  select id into v_target_id from live_atbats
  where game_id = p_game_id and deleted_at is null
  order by id desc limit 1;

  if v_target_id is null then
    return null;
  end if;

  update live_atbats set deleted_at = now(), deleted_by = p_deleted_by
  where id = v_target_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function undo_last_atbat(text, uuid, text) to anon, authenticated;


create or replace function submit_event(
  p_game_id text,
  p_access_token uuid,
  p_client_uuid uuid,
  p_inning int,
  p_half text,
  p_type text,
  p_runner_id text,
  p_pitcher_id text,
  p_runner_note text,
  p_entered_by text
)
returns live_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_events;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  insert into live_events (game_id, client_uuid, inning, half, type, runner_id, pitcher_id, runner_note, entered_by)
  values (p_game_id, p_client_uuid, p_inning, p_half, p_type, p_runner_id, p_pitcher_id, p_runner_note, p_entered_by)
  on conflict (game_id, client_uuid) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from live_events where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  return v_row;
end;
$$;

grant execute on function submit_event(text, uuid, uuid, int, text, text, text, text, text, text) to anon, authenticated;


create or replace function soft_delete_event(p_id bigint, p_access_token uuid, p_deleted_by text)
returns live_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_events;
begin
  select game_id into v_game_id from live_events where id = p_id;
  if v_game_id is null then
    raise exception 'live_events id % not found', p_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  update live_events set deleted_at = now(), deleted_by = p_deleted_by
  where id = p_id and deleted_at is null
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function soft_delete_event(bigint, uuid, text) to anon, authenticated;


create or replace function close_game(p_game_id text, p_access_token uuid)
returns games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row games;
begin
  perform _check_access(p_game_id, p_access_token);

  update games set status = 'closed', closed_at = now()
  where game_id = p_game_id and status = 'open'
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function close_game(text, uuid) to anon, authenticated;
