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


-- 既存DBに古い5引数版(track_pitching追加前)・6引数版(game_type追加前)が残っている場合に備えて
-- 明示的に削除する。
drop function if exists create_game(text, text, date, text, jsonb);
drop function if exists create_game(text, text, date, text, jsonb, boolean);

create or replace function create_game(
  p_game_id text,
  p_opponent_name text,
  p_game_date date,
  p_our_half text,
  p_lineup jsonb,
  p_track_pitching boolean default true,
  p_game_type text default 'official'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
begin
  insert into games (game_id, opponent_name, game_date, our_half, lineup, track_pitching, game_type)
  values (p_game_id, p_opponent_name, p_game_date, p_our_half, coalesce(p_lineup, '[]'::jsonb),
          coalesce(p_track_pitching, true), coalesce(p_game_type, 'official'));

  -- 守備交代ログ(lineup_history)の起点として、試合開始時のスタメンも1行記録しておく。
  insert into lineup_history (game_id, inning, half, lineup, changed_by)
  values (p_game_id, null, null, coalesce(p_lineup, '[]'::jsonb), null);

  insert into game_secrets (game_id) values (p_game_id)
  returning access_token into v_token;

  return v_token;
end;
$$;

grant execute on function create_game(text, text, date, text, jsonb, boolean, text) to anon, authenticated;


-- 初期画面(index.html)から開催中の試合に事前のURL共有無しで入室できるようにするための一覧取得。
-- access_tokenを含めて返す(game_secretsは直接SELECTさせず、この関数経由でのみ公開する)。
-- 試合開始前にURLを都度配る手間をなくすためのもので、公開リポジトリ・チーム限定運用を前提に
-- あえてtokenを一覧公開する(status='open'のみ。closed/archivedになれば一覧・入室リンクから消える)。
create or replace function list_open_games()
returns table (
  game_id text,
  opponent_name text,
  game_date date,
  our_half text,
  created_at timestamptz,
  access_token uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select g.game_id, g.opponent_name, g.game_date, g.our_half, g.created_at, s.access_token
  from games g
  join game_secrets s on s.game_id = g.game_id
  where g.status = 'open'
  order by g.created_at desc;
$$;

grant execute on function list_open_games() to anon, authenticated;


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


-- 既存DBに古い3引数版(交代ログ追加前)が残っている場合に備えて明示的に削除する。
drop function if exists update_lineup(text, uuid, jsonb);

-- 試合作成後にオーダー(打順・守備位置)の記載ミスに気づいた場合、試合中いつでも編集できるようにする。
-- 呼び出しのたびにlineup_historyへ変更後の全スナップショットを1行追加する(守備交代ログ)。
-- p_inning/p_halfは呼び出し元(js/app.js)がcurrentPointerから渡す「その時点のイニング・表裏」
-- (試合開始前の初期登録時はnullのままでよい)。
create or replace function update_lineup(
  p_game_id text,
  p_access_token uuid,
  p_lineup jsonb,
  p_inning int default null,
  p_half text default null,
  p_changed_by text default null
)
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

  insert into lineup_history (game_id, inning, half, lineup, changed_by)
  values (p_game_id, p_inning, p_half, v_row.lineup, p_changed_by);

  return v_row;
end;
$$;

grant execute on function update_lineup(text, uuid, jsonb, int, text, text) to anon, authenticated;


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
drop function if exists submit_atbat(
  text, uuid, uuid, int, text, text, int, int, text, boolean, text, int, boolean, text, text, text, text,
  bigint[], bigint[], jsonb
);

-- 打席(live_atbats)に付随する走者イベント(走塁死・進塁・打者走者自身の進塁)をlive_eventsへ
-- 記録する共通ロジック。submit_atbat(新規打席)とedit_atbat_full(打席の編集)の両方から呼ぶ
-- (編集時は同じロジックで作り直せるようにするため、打席作成時と共通化してある)。
-- p_rowはこの打席の現在の行(挿入直後 or 更新直後)。挿入されたlive_eventsには
-- caused_by_atbat_id = p_row.idを設定し、後から「この打席が原因のイベント」を特定できるようにする。
-- 戻り値はp_row(打者走者自身がhomeまで進んだ場合のみscoredをtrueにして返す)。
create or replace function _apply_atbat_consequences(
  p_game_id text,
  p_inning int,
  p_half text,
  p_pitcher_id text,
  p_entered_by text,
  p_row live_atbats,
  p_out_runner_ids bigint[],
  p_advanced_runner_moves jsonb,
  p_batter_advance_to_base text
)
returns live_atbats
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row live_atbats := p_row;
  v_out_runner_id bigint;
  v_out_batter_id text;
  v_out_seq int := 0;
  v_move jsonb;
  v_move_atbat_id bigint;
  v_move_batter_id text;
begin
  -- この打席と同一プレーでアウトになった既存走者を、走塁死イベントと同じ形でlive_eventsに記録する
  -- (例: 三塁走者がホームで刺されたフィルダースチョイス)。pitcher_idはこの打席自身のp_pitcher_id
  -- (相手打席=守備側でのみ非null)を引き継ぐ。created_atはv_row.created_atより後の時刻を明示的に
  -- 指定する(同一トランザクション内ではnow()がトランザクション開始時刻を返すため、指定しないと
  -- この打席の行と全く同じcreated_atになり、import_from_supabase.pyのafter_seq算出を誤らせる)。
  if array_length(p_out_runner_ids, 1) > 0 then
    foreach v_out_runner_id in array p_out_runner_ids
    loop
      select batter_id into v_out_batter_id from live_atbats
      where game_id = p_game_id and id = v_out_runner_id and deleted_at is null;

      if v_out_batter_id is not null then
        v_out_seq := v_out_seq + 1;
        insert into live_events (
          game_id, client_uuid, inning, half, type, runner_id, runner_atbat_id, pitcher_id, runner_note,
          entered_by, created_at, caused_by_atbat_id
        ) values (
          p_game_id, gen_random_uuid(), p_inning, p_half, 'runner_out_advancing',
          v_out_batter_id, v_out_runner_id, p_pitcher_id, null, p_entered_by,
          v_row.created_at + (v_out_seq * interval '1 millisecond'), v_row.id
        );
      end if;
    end loop;
  end if;

  -- 同じ打席の中で「進塁」を選択された既存走者を、盗塁と同じ仕組みで走者一覧のbaseに反映する
  -- (例: 1塁走者が単打で3塁まで進んだ場合など)。p_advanced_runner_movesは
  -- [{"atbat_id": 123, "to_base": "second"}, ...] 形式。
  if jsonb_array_length(p_advanced_runner_moves) > 0 then
    for v_move in select * from jsonb_array_elements(p_advanced_runner_moves)
    loop
      v_move_atbat_id := (v_move->>'atbat_id')::bigint;
      select batter_id into v_move_batter_id from live_atbats
      where game_id = p_game_id and id = v_move_atbat_id and deleted_at is null;

      if v_move_batter_id is not null then
        v_out_seq := v_out_seq + 1;
        insert into live_events (
          game_id, client_uuid, inning, half, type, runner_id, runner_atbat_id, to_base, pitcher_id,
          runner_note, entered_by, created_at, caused_by_atbat_id
        ) values (
          p_game_id, gen_random_uuid(), p_inning, p_half, 'runner_advance',
          v_move_batter_id, v_move_atbat_id, v_move->>'to_base', null, null, p_entered_by,
          v_row.created_at + (v_out_seq * interval '1 millisecond'), v_row.id
        );
      end if;
    end loop;
  end if;

  -- 打者走者自身の進塁(エラー等でさらに先の塁まで進んだ場合)。runner_atbat_idにこの打席自身の
  -- v_row.idを使うことで、既存のderiveRunnersOnBase(js/derive.js)がそのまま扱える。
  -- to_base='home'の場合は打者自身がこの打席で生還したことになるため、scored列も直接trueに更新する。
  if p_batter_advance_to_base is not null then
    v_out_seq := v_out_seq + 1;
    insert into live_events (
      game_id, client_uuid, inning, half, type, runner_id, runner_atbat_id, to_base, pitcher_id,
      runner_note, entered_by, created_at, caused_by_atbat_id
    ) values (
      p_game_id, gen_random_uuid(), p_inning, p_half, 'runner_advance',
      v_row.batter_id, v_row.id, p_batter_advance_to_base, null, null, p_entered_by,
      v_row.created_at + (v_out_seq * interval '1 millisecond'), v_row.id
    );

    if p_batter_advance_to_base = 'home' then
      update live_atbats set scored = true where id = v_row.id;
      v_row.scored := true;
    end if;
  end if;

  return v_row;
end;
$$;

revoke execute on function _apply_atbat_consequences(text, int, text, text, text, live_atbats, bigint[], jsonb, text) from public, anon, authenticated;


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
  p_batter_advance_to_base text default null
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
  bigint[], bigint[], jsonb, text
) to anon, authenticated;


-- 既存DBに古い13引数版(edit_atbat、走者イベント編集非対応)が残っている場合に備えて明示的に削除する。
drop function if exists edit_atbat(
  bigint, uuid, text, int, int, text, boolean, text, int, boolean, text, text, text
);

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
    ('single', 'double', 'triple', 'home_run', 'walk', 'hbp', 'reached_on_error', 'fielders_choice', 'strikeout_reached')
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


-- 既存DBに古い3引数版(client_uuidチェック追加前)が残っている場合に備えて明示的に削除する。
drop function if exists undo_last_atbat(text, uuid, text);

-- 直前1件のワンタップ取消(モーダル無し)用。非削除の中で最新のidを1件取り消す。
-- p_client_uuidを渡した場合、対象行のclient_uuidと一致しない(=自分の直前の打席ではない、
-- 他の人が新しい打席を入力した)場合は削除せず例外を投げる。
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

  return v_row;
end;
$$;

grant execute on function undo_last_atbat(text, uuid, text, uuid) to anon, authenticated;


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
  v_is_new boolean;
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


-- 助っ人選手をその場で登録する(打者選択の「その他(自由入力)」から呼ばれる)。
-- players書き込みはRLS方針上anon/authenticatedに直接権限が無いため、この関数経由のみ許可する。
-- access_tokenによるゲーム単位の照合は行わない(選手マスタは全ゲーム共通のため)。
create or replace function add_guest_player(p_id text, p_display_name text)
returns players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row players;
begin
  if p_id is null or length(trim(p_id)) = 0 then
    raise exception 'id is required';
  end if;
  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception 'display_name is required';
  end if;

  insert into players (id, display_name, guest)
  values (p_id, p_display_name, true)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function add_guest_player(text, text) to anon, authenticated;


-- 検証用試合データの自動削除
-- opponent_nameに「検証」を含む試合(games行)を作成から24時間後に削除する。
-- games -> live_atbats/live_events は on delete cascade のため、games行の削除だけで連鎖削除される。
create extension if not exists pg_cron with schema extensions;

create or replace function delete_expired_verification_games()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from games
  where opponent_name ilike '%検証%'
    and created_at < now() - interval '24 hours';
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'delete-verification-games-hourly') then
    perform cron.unschedule('delete-verification-games-hourly');
  end if;
end;
$$;

select cron.schedule(
  'delete-verification-games-hourly',
  '0 * * * *',
  $$select delete_expired_verification_games();$$
);
