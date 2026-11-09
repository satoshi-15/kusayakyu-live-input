-- 2026-11-09: 打席結果に守備妨害・打撃妨害・走塁妨害を追加(live-input-app v1.4)。
-- Supabase SQL Editorでこのファイルを1回実行する。何度実行しても同じ結果になる(冪等)。
--   interference_out     = 守備妨害(打者アウト、打数に数える)
--   catcher_interference = 打撃妨害(打者に一塁、打数に数えない、守備側に失策)
--   obstruction          = 走塁妨害(打者に一塁、打数に数えない、守備側に失策)

-- 1) live_atbats.result のCHECK制約を差し替える(名前に依存しないよう、result列のCHECK制約を探して削除)。
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'live_atbats' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%result%'
      and pg_get_constraintdef(con.oid) like '%groundout%'
  loop
    execute format('alter table live_atbats drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table live_atbats add constraint live_atbats_result_check check (result in (
  'groundout', 'flyout', 'strikeout', 'walk', 'hbp', 'single', 'double', 'triple',
  'home_run', 'sac_bunt', 'sac_fly', 'fielders_choice', 'reached_on_error', 'strikeout_reached',
  'interference_out', 'catcher_interference', 'obstruction'
));

-- 2) 打席編集RPC: 打撃妨害・走塁妨害を「塁に残る結果」として扱う(functions.sqlと同内容)。
-- 打席の編集(結果・打者・打点・生還・投手・相手打者名に加え、付随する走者イベントも作り直す)。
create or replace function edit_atbat_full(
  p_id bigint,
  p_access_token uuid,
  p_client_uuid uuid,
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
  p_batter_advance_to_base text default null
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id text;
  v_row live_atbats;
  v_will_stay_on_base boolean;
  v_blocking_count int;
begin
  select game_id into v_game_id from live_atbats where id = p_id and deleted_at is null;
  if v_game_id is null then
    raise exception 'live_atbats id % not found', p_id;
  end if;
  perform _check_access(v_game_id, p_access_token);

  select * into v_row from live_atbats where id = p_id;

  -- 冪等性ガード: オフラインキュー・自動リトライによる同じ編集の再送では何もせず現在の行を返す
  -- (submit_atbatのclient_uuid一意制約と同じ考え方。編集は取消→再作成を伴うため一意制約では
  -- 表現できず、last_edit_client_uuid列との比較で明示的にガードする)。
  if v_row.last_edit_client_uuid is not null and v_row.last_edit_client_uuid = p_client_uuid then
    return v_row;
  end if;

  if p_batter_id = 'opponent' and p_pitcher_id is null
     and exists (select 1 from games where game_id = v_game_id and track_pitching) then
    raise exception 'pitcher_id is required for opponent at-bats while track_pitching is on';
  end if;

  -- 編集後この打席が塁に残るかどうか(出塁する結果、かつ自分自身は生還していない)。
  v_will_stay_on_base := p_result in
    ('single', 'double', 'triple', 'home_run', 'walk', 'hbp', 'reached_on_error', 'fielders_choice', 'strikeout_reached',
     'catcher_interference', 'obstruction')
    and not p_scored;

  -- 出塁しない結果に変わる場合、この打席をrunner_atbat_idとして参照する「他の打席が原因で作られた」
  -- イベント(=この打席の走者に対する進塁・生還・アウトの記録)が既にあると参照が孤立するため拒否する
  -- (undo_last_atbatが使っている安全策と同じ考え方)。
  if not v_will_stay_on_base then
    select count(*) into v_blocking_count from live_events
    where runner_atbat_id = p_id and deleted_at is null
      and (caused_by_atbat_id is null or caused_by_atbat_id <> p_id);
    if v_blocking_count > 0 then
      raise exception 'この打席の走者は後続の打席で進塁・生還・アウトが記録されているため、出塁しない結果には変更できません。関連する記録を先に取り消してください'
        using errcode = 'P0001';
    end if;
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
    opponent_batter_name = p_opponent_batter_name,
    last_edit_client_uuid = p_client_uuid
  where id = p_id
  returning * into v_row;

  -- この打席が原因で作られた旧付随イベントを取消してから、新しい選択内容で作り直す。
  update live_events set deleted_at = now(), deleted_by = p_entered_by
  where caused_by_atbat_id = p_id and deleted_at is null;

  if array_length(p_scored_runner_ids, 1) > 0 then
    update live_atbats set scored = true
    where game_id = v_game_id and id = any(p_scored_runner_ids) and deleted_at is null;
  end if;

  v_row := _apply_atbat_consequences(
    v_game_id, v_row.inning, v_row.half, p_pitcher_id, p_entered_by, v_row,
    p_out_runner_ids, p_advanced_runner_moves, p_batter_advance_to_base
  );

  return v_row;
end;
$$;

grant execute on function edit_atbat_full(
  bigint, uuid, uuid, text, int, int, text, boolean, text, int, boolean, text, text, text, text,
  bigint[], bigint[], jsonb, text
) to anon, authenticated;
