-- 2026-11-16: 修正モード(live-input-app v1.8)。Supabase SQL Editorでこのファイルを1回実行する(冪等)。
--  - live_events.type に runner_removed(記録ミスの走者を消す)を追加、to_base に first を追加
--  - submit_atbat / submit_event に p_created_at(過去の行の間への挿入用)を追加
--  - restore_atbat / restore_event / set_outs_before / set_runner_scored を追加
--  - soft_delete_atbat / undo_last_atbat で付随イベントも一緒に取り消す

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'live_events' and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%stolen_base%' or pg_get_constraintdef(con.oid) like '%to_base%')
  loop
    execute format('alter table live_events drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table live_events add constraint live_events_type_check check (type in (
  'stolen_base', 'caught_stealing', 'runner_out_advancing', 'runner_advance',
  'wild_pitch', 'balk', 'passed_ball', 'runner_removed'
));
alter table live_events add constraint live_events_to_base_check check (
  to_base is null or to_base in ('first', 'second', 'third', 'home')
);

-- v1.8で p_created_at を追加したため、旧シグネチャを削除してから作り直す(オーバーロードの曖昧さ回避)。
drop function if exists submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text,
  bigint[], bigint[], jsonb, text
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
  p_advanced_runner_moves jsonb default '[]',
  -- 打者走者自身がこの打席で(失策等により)追加で進んだ先の塁('second'/'third'/'home')。
  -- 通常の出塁のみ(そのまま一塁等)ならnullのまま。
  p_batter_advance_to_base text default null,
  -- 修正モードで過去の打席の間に挿入する場合の記録時刻(前後の行の中間)。通常の入力ではnull(=now())。
  p_created_at timestamptz default null
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_atbats;
  v_is_new boolean;
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
    result, ab, hit_type, rbi, scored, detail, pitcher_id, opponent_batter_name, entered_by, created_at
  ) values (
    p_game_id, p_client_uuid, p_inning, p_half, p_batter_id, p_order_no, p_outs_before,
    p_result, p_ab, p_hit_type, p_rbi, p_scored, p_detail, p_pitcher_id, p_opponent_batter_name, p_entered_by,
    coalesce(p_created_at, now())
  )
  -- client_uuidによるベキ等リトライ: 同じ内容の再送はDO NOTHINGで無害化し、既存行を返す
  on conflict (game_id, client_uuid) do nothing
  returning * into v_row;

  v_is_new := v_row.id is not null;

  if v_row.id is null then
    select * into v_row from live_atbats where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  -- 生還マーク・付随イベントの追加は、この打席が今回初めて挿入された場合のみ行う
  -- (client_uuidによる再送時に同じ副作用を二重に適用してしまうのを防ぐため)。
  if v_is_new and array_length(p_scored_runner_ids, 1) > 0 then
    update live_atbats set scored = true
    where game_id = p_game_id and id = any(p_scored_runner_ids) and deleted_at is null;
  end if;

  if v_is_new then
    v_row := _apply_atbat_consequences(
      p_game_id, p_inning, p_half, p_pitcher_id, p_entered_by, v_row,
      p_out_runner_ids, p_advanced_runner_moves, p_batter_advance_to_base
    );
  end if;

  return v_row;
end;
$$;

grant execute on function submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text,
  bigint[], bigint[], jsonb, text, timestamptz
) to anon, authenticated;


drop function if exists submit_event(text, uuid, uuid, int, text, text, text, text, text, text, bigint, text);

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
  p_to_base text default null,
  p_created_at timestamptz default null
)
returns live_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_events;
  v_is_new boolean;
begin
  perform _check_access(p_game_id, p_access_token);

  if not exists (select 1 from games where game_id = p_game_id and status = 'open') then
    raise exception 'game % is not open', p_game_id;
  end if;

  insert into live_events (
    game_id, client_uuid, inning, half, type, runner_id, pitcher_id, runner_note, entered_by,
    runner_atbat_id, to_base, created_at
  )
  values (
    p_game_id, p_client_uuid, p_inning, p_half, p_type, p_runner_id, p_pitcher_id, p_runner_note, p_entered_by,
    p_runner_atbat_id, p_to_base, coalesce(p_created_at, now())
  )
  on conflict (game_id, client_uuid) do nothing
  returning * into v_row;

  v_is_new := v_row.id is not null;

  if v_row.id is null then
    select * into v_row from live_events where game_id = p_game_id and client_uuid = p_client_uuid;
  end if;

  -- 暴投・ボーク・パスボール等、打席を介さずに走者が本塁まで進んだ(to_base='home')場合、
  -- その走者の出塁元打席をscored=trueにする(submit_atbatのp_scored_runner_idsと同じ仕組み)。
  -- client_uuidによる再送時にscoredを二重適用しないよう、新規挿入時のみ実行する。
  if v_is_new and p_type = 'runner_advance' and p_to_base = 'home' and p_runner_atbat_id is not null then
    update live_atbats set scored = true
    where id = p_runner_atbat_id and deleted_at is null;
  end if;

  return v_row;
end;
$$;

grant execute on function submit_event(
  text, uuid, uuid, int, text, text, text, text, text, text, bigint, text, timestamptz
) to anon, authenticated;


-- ===== v1.8 修正モード用 =====

-- 取り消した打席・イベントを元に戻す。
create or replace function restore_atbat(p_id bigint, p_access_token uuid)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_atbats;
  v_deleted_at timestamptz;
begin
  select game_id into v_game_id from live_atbats where id = p_id;
  if v_game_id is null then
    raise exception 'live_atbats id % not found', p_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  select deleted_at into v_deleted_at from live_atbats where id = p_id;

  update live_atbats set deleted_at = null, deleted_by = null
  where id = p_id
  returning * into v_row;

  -- 打席の取消と同時に取り消された付随イベントも戻す。
  if v_deleted_at is not null then
    update live_events set deleted_at = null, deleted_by = null
    where caused_by_atbat_id = p_id and deleted_at = v_deleted_at;
  end if;
  return v_row;
end;
$$;

grant execute on function restore_atbat(bigint, uuid) to anon, authenticated;

create or replace function restore_event(p_id bigint, p_access_token uuid)
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

  update live_events set deleted_at = null, deleted_by = null
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function restore_event(bigint, uuid) to anon, authenticated;

-- 取消・挿入・復活の後に、アプリ側で計算し直した各打席のアウト数(outs_before)を一括で書き戻す。
-- p_updates: [{"id": 123, "outs": 1}, ...]。値が変わる行だけ更新する。
create or replace function set_outs_before(p_game_id text, p_access_token uuid, p_updates jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_count int := 0;
begin
  perform _check_access(p_game_id, p_access_token);
  for v_item in select * from jsonb_array_elements(p_updates)
  loop
    update live_atbats set outs_before = (v_item->>'outs')::int
    where game_id = p_game_id and id = (v_item->>'id')::bigint
      and outs_before is distinct from (v_item->>'outs')::int;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

grant execute on function set_outs_before(text, uuid, jsonb) to anon, authenticated;

-- 走者の生還フラグを直接直す。生還を取り消す場合は、その走者の生還イベント(runner_advance to home)も取り消す
-- (残っていると走者一覧から消えたままになるため)。
create or replace function set_runner_scored(p_atbat_id bigint, p_access_token uuid, p_scored boolean, p_by text)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_atbats;
begin
  select game_id into v_game_id from live_atbats where id = p_atbat_id;
  if v_game_id is null then
    raise exception 'live_atbats id % not found', p_atbat_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  update live_atbats set scored = p_scored where id = p_atbat_id returning * into v_row;
  if not p_scored then
    update live_events set deleted_at = now(), deleted_by = p_by
    where runner_atbat_id = p_atbat_id and type = 'runner_advance' and to_base = 'home' and deleted_at is null;
  end if;
  return v_row;
end;
$$;

grant execute on function set_runner_scored(bigint, uuid, boolean, text) to anon, authenticated;


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

  -- この打席と同時に作られた付随イベント(走者の進塁・アウト等)も一緒に取り消す(v1.8)。
  -- 残すと取消済み打席の走塁死がアウト数に数えられ続けてしまうため。restore_atbatで一緒に戻る。
  if v_row.id is not null then
    update live_events set deleted_at = v_row.deleted_at, deleted_by = p_deleted_by
    where caused_by_atbat_id = p_id and deleted_at is null;
  end if;

  return v_row;
end;
$$;

grant execute on function soft_delete_atbat(bigint, uuid, text) to anon, authenticated;


create or replace function undo_last_atbat(
  p_game_id text, p_access_token uuid, p_deleted_by text, p_client_uuid uuid default null
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_id bigint;
  v_target_client_uuid uuid;
  v_row live_atbats;
begin
  perform _check_access(p_game_id, p_access_token);

  select id, client_uuid into v_target_id, v_target_client_uuid from live_atbats
  where game_id = p_game_id and deleted_at is null
  order by id desc limit 1;

  if v_target_id is null then
    return null;
  end if;

  if p_client_uuid is not null and v_target_client_uuid <> p_client_uuid then
    raise exception 'この試合の最新の打席は他の人が入力したものです(取り消し対象が一致しません)'
      using errcode = 'P0001';
  end if;

  -- この打席を起点とする走者イベント(盗塁死・進塁等)が既に記録されている場合、
  -- 打席だけを消すとイベント側のrunner_atbat_idが孤立し(derive.jsが静かに無視する)、
  -- 記録した走者の動きが跡形もなく消えてしまう。安全のため削除せず例外にする。
  if exists (
    select 1 from live_events
    where runner_atbat_id = v_target_id and deleted_at is null
  ) then
    raise exception 'この打席に関連する走者イベントが記録されているため取り消せません。個別の取消ボタンを使ってください'
      using errcode = 'P0001';
  end if;

  update live_atbats set deleted_at = now(), deleted_by = p_deleted_by
  where id = v_target_id
  returning * into v_row;

  update live_events set deleted_at = v_row.deleted_at, deleted_by = p_deleted_by
  where caused_by_atbat_id = v_target_id and deleted_at is null;

  return v_row;
end;
$$;

grant execute on function undo_last_atbat(text, uuid, text, uuid) to anon, authenticated;
