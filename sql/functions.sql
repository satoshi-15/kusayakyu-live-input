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


-- 既存DBに古い5引数版(track_pitching追加前)が残っている場合に備えて明示的に削除する。
drop function if exists create_game(text, text, date, text, jsonb);

create or replace function create_game(
  p_game_id text,
  p_opponent_name text,
  p_game_date date,
  p_our_half text,
  p_lineup jsonb,
  p_track_pitching boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
begin
  insert into games (game_id, opponent_name, game_date, our_half, lineup, track_pitching)
  values (p_game_id, p_opponent_name, p_game_date, p_our_half, coalesce(p_lineup, '[]'::jsonb),
          coalesce(p_track_pitching, true));

  insert into game_secrets (game_id) values (p_game_id)
  returning access_token into v_token;

  return v_token;
end;
$$;

grant execute on function create_game(text, text, date, text, jsonb, boolean) to anon, authenticated;


-- 試合中いつでも投手成績記録のON/OFFを切り替える(実装計画フェーズ2のMVP要求の未実装分)。
create or replace function set_track_pitching(p_game_id text, p_access_token uuid, p_value boolean)
returns games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row games;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  update games set track_pitching = p_value
  where game_id = p_game_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function set_track_pitching(text, uuid, boolean) to anon, authenticated;


-- 試合作成後にオーダー(打順・守備位置)の記載ミスに気づいた場合、試合中いつでも編集できるようにする。
create or replace function update_lineup(p_game_id text, p_access_token uuid, p_lineup jsonb)
returns games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row games;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  update games set lineup = coalesce(p_lineup, '[]'::jsonb)
  where game_id = p_game_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function update_lineup(text, uuid, jsonb) to anon, authenticated;


-- 既存DBに古い17/18/19引数版(進塁記録追加前)が残っている場合に備えて明示的に削除する。
drop function if exists submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text
);
drop function if exists submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text, bigint[]
);
drop function if exists submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text, bigint[], bigint[]
);

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
  p_entered_by text,
  p_scored_runner_ids bigint[] default '{}',
  p_out_runner_ids bigint[] default '{}',
  p_advanced_runner_moves jsonb default '[]'
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_atbats;
  v_out_runner_id bigint;
  v_out_batter_id text;
  v_is_new boolean;
  v_out_seq int := 0;
  v_move jsonb;
  v_move_atbat_id bigint;
  v_move_batter_id text;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  if p_batter_id = 'opponent' and p_pitcher_id is null
     and exists (select 1 from games where game_id = p_game_id and track_pitching) then
    raise exception 'pitcher_id is required for opponent at-bats while track_pitching is on';
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

  v_is_new := v_row.id is not null;

  if v_row.id is null then
    select * into v_row from live_atbats where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  -- 生還マーク・走者アウトイベントの追加は、この打席が今回初めて挿入された場合のみ行う
  -- (client_uuidによる再送時に同じ副作用を二重に適用してしまうのを防ぐため)。
  if v_is_new and array_length(p_scored_runner_ids, 1) > 0 then
    update live_atbats set scored = true
    where game_id = p_game_id and id = any(p_scored_runner_ids) and deleted_at is null;
  end if;

  -- この打席と同一プレーでアウトになった既存走者を、走塁死イベントと同じ形でlive_eventsに記録する
  -- (例: 三塁走者がホームで刺されたフィルダースチョイス)。既存の「走塁死」クイックイベントと
  -- 同じtype='runner_out_advancing'を使うことで、アウトカウント・走者一覧の除去ロジックを共用する。
  -- pitcher_idはこの打席自身のp_pitcher_id(相手打席=守備側でのみ非null)を引き継ぐ。これにより
  -- aggregate.pyのaggregate_pitching()が野選での走者アウトも投手の奪アウト数に正しく計上できる
  -- (fielders_choice自体はPITCHING_OUT_RESULTSから除外済みのため、ここが唯一のアウト計上経路)。
  -- created_atは明示的にv_row.created_atより後の時刻を指定する: 同一トランザクション内では
  -- now()がトランザクション開始時刻を返すため、何も指定しないとこの打席の行と全く同じ
  -- created_atになってしまい、import_from_supabase.pyのafter_seq算出(created_at基準の前後判定)が
  -- この打席をイベントより「後」と誤認識してしまう(該当プレー自体が無視される形になるバグ)。
  if v_is_new and array_length(p_out_runner_ids, 1) > 0 then
    foreach v_out_runner_id in array p_out_runner_ids
    loop
      select batter_id into v_out_batter_id from live_atbats
      where game_id = p_game_id and id = v_out_runner_id and deleted_at is null;

      if v_out_batter_id is not null then
        v_out_seq := v_out_seq + 1;
        insert into live_events (
          game_id, client_uuid, inning, half, type, runner_id, runner_atbat_id, pitcher_id, runner_note,
          entered_by, created_at
        ) values (
          p_game_id, gen_random_uuid(), p_inning, p_half, 'runner_out_advancing',
          v_out_batter_id, v_out_runner_id, p_pitcher_id, null, p_entered_by,
          v_row.created_at + (v_out_seq * interval '1 millisecond')
        );
      end if;
    end loop;
  end if;

  -- 同じ打席の中で「進塁」を選択された既存走者を、盗塁と同じ仕組みで走者一覧のbaseに反映する
  -- (例: 1塁走者が単打で3塁まで進んだ場合など)。p_advanced_runner_movesは
  -- [{"atbat_id": 123, "to_base": "second"}, ...] 形式。created_atの扱いはp_out_runner_idsと同じ。
  if v_is_new and jsonb_array_length(p_advanced_runner_moves) > 0 then
    for v_move in select * from jsonb_array_elements(p_advanced_runner_moves)
    loop
      v_move_atbat_id := (v_move->>'atbat_id')::bigint;
      select batter_id into v_move_batter_id from live_atbats
      where game_id = p_game_id and id = v_move_atbat_id and deleted_at is null;

      if v_move_batter_id is not null then
        v_out_seq := v_out_seq + 1;
        insert into live_events (
          game_id, client_uuid, inning, half, type, runner_id, runner_atbat_id, to_base, pitcher_id,
          runner_note, entered_by, created_at
        ) values (
          p_game_id, gen_random_uuid(), p_inning, p_half, 'runner_advance',
          v_move_batter_id, v_move_atbat_id, v_move->>'to_base', null, null, p_entered_by,
          v_row.created_at + (v_out_seq * interval '1 millisecond')
        );
      end if;
    end loop;
  end if;

  return v_row;
end;
$$;

grant execute on function submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text,
  bigint[], bigint[], jsonb
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

  if p_batter_id = 'opponent' and p_pitcher_id is null
     and exists (select 1 from games where game_id = v_game_id and track_pitching) then
    raise exception 'pitcher_id is required for opponent at-bats while track_pitching is on';
  end if;

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


-- 既存DBに古い10引数版(runner_atbat_id/to_base追加前)が残っている場合に備えて明示的に削除する。
drop function if exists submit_event(text, uuid, uuid, int, text, text, text, text, text, text);

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
  p_entered_by text,
  p_runner_atbat_id bigint default null,
  p_to_base text default null
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

  insert into live_events (
    game_id, client_uuid, inning, half, type, runner_id, pitcher_id, runner_note, entered_by,
    runner_atbat_id, to_base
  )
  values (
    p_game_id, p_client_uuid, p_inning, p_half, p_type, p_runner_id, p_pitcher_id, p_runner_note, p_entered_by,
    p_runner_atbat_id, p_to_base
  )
  on conflict (game_id, client_uuid) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from live_events where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  return v_row;
end;
$$;

grant execute on function submit_event(
  text, uuid, uuid, int, text, text, text, text, text, text, bigint, text
) to anon, authenticated;


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
