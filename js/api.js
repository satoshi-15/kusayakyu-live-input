// SupabaseのRPC関数呼び出しラッパー。書き込みは全てここを経由する(sql/functions.sql参照)。
import { supabase } from './supabase-client.js';

export async function createGame({ gameId, opponentName, gameDate, ourHalf, lineup, trackPitching, gameType }) {
  const { data, error } = await supabase.rpc('create_game', {
    p_game_id: gameId,
    p_opponent_name: opponentName,
    p_game_date: gameDate,
    p_our_half: ourHalf,
    p_lineup: lineup,
    p_track_pitching: trackPitching,
    p_game_type: gameType || 'official',
  });
  if (error) throw error;
  return data; // access_token (uuid文字列)
}

export async function setTrackPitching(gameId, accessToken, value) {
  const { data, error } = await supabase.rpc('set_track_pitching', {
    p_game_id: gameId,
    p_access_token: accessToken,
    p_value: value,
  });
  if (error) throw error;
  return data;
}

export async function updateLineup(gameId, accessToken, lineup, inning, half, changedBy) {
  const { data, error } = await supabase.rpc('update_lineup', {
    p_game_id: gameId,
    p_access_token: accessToken,
    p_lineup: lineup,
    p_inning: inning ?? null,
    p_half: half ?? null,
    p_changed_by: changedBy ?? null,
  });
  if (error) throw error;
  return data;
}

export async function fetchGame(gameId) {
  const { data, error } = await supabase.from('games').select('*').eq('game_id', gameId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchAllAtbats(gameId) {
  const { data, error } = await supabase.from('live_atbats').select('*').eq('game_id', gameId).order('id');
  if (error) throw error;
  return data;
}

export async function fetchAllEvents(gameId) {
  const { data, error } = await supabase.from('live_events').select('*').eq('game_id', gameId).order('id');
  if (error) throw error;
  return data;
}

export async function submitAtbat(gameId, accessToken, payload) {
  const { data, error } = await supabase.rpc('submit_atbat', {
    p_game_id: gameId,
    p_access_token: accessToken,
    p_client_uuid: payload.clientUuid,
    p_inning: payload.inning,
    p_half: payload.half,
    p_batter_id: payload.batterId,
    p_order_no: payload.orderNo,
    p_outs_before: payload.outsBefore,
    p_result: payload.result,
    p_ab: payload.ab,
    p_hit_type: payload.hitType,
    p_rbi: payload.rbi,
    p_scored: payload.scored,
    p_detail: payload.detail,
    p_pitcher_id: payload.pitcherId,
    p_opponent_batter_name: payload.opponentBatterName,
    p_entered_by: payload.enteredBy,
    p_scored_runner_ids: payload.scoredRunnerIds || [],
    p_out_runner_ids: payload.outRunnerIds || [],
    p_advanced_runner_moves: payload.advancedRunnerMoves || [],
    p_batter_advance_to_base: payload.batterAdvanceToBase || null,
  });
  if (error) throw error;
  return data;
}

export async function editAtbatFull(id, accessToken, payload) {
  const { data, error } = await supabase.rpc('edit_atbat_full', {
    p_id: id,
    p_access_token: accessToken,
    p_client_uuid: payload.clientUuid,
    p_batter_id: payload.batterId,
    p_order_no: payload.orderNo,
    p_outs_before: payload.outsBefore,
    p_result: payload.result,
    p_ab: payload.ab,
    p_hit_type: payload.hitType,
    p_rbi: payload.rbi,
    p_scored: payload.scored,
    p_detail: payload.detail,
    p_pitcher_id: payload.pitcherId,
    p_opponent_batter_name: payload.opponentBatterName,
    p_entered_by: payload.enteredBy,
    p_scored_runner_ids: payload.scoredRunnerIds || [],
    p_out_runner_ids: payload.outRunnerIds || [],
    p_advanced_runner_moves: payload.advancedRunnerMoves || [],
    p_batter_advance_to_base: payload.batterAdvanceToBase || null,
  });
  if (error) throw error;
  return data;
}

export async function softDeleteAtbat(id, accessToken, deletedBy) {
  const { data, error } = await supabase.rpc('soft_delete_atbat', {
    p_id: id,
    p_access_token: accessToken,
    p_deleted_by: deletedBy,
  });
  if (error) throw error;
  return data;
}

export async function undoLastAtbat(gameId, accessToken, deletedBy, clientUuid) {
  const { data, error } = await supabase.rpc('undo_last_atbat', {
    p_game_id: gameId,
    p_access_token: accessToken,
    p_deleted_by: deletedBy,
    p_client_uuid: clientUuid ?? null,
  });
  if (error) throw error;
  return data;
}

export async function submitEvent(gameId, accessToken, payload) {
  const { data, error } = await supabase.rpc('submit_event', {
    p_game_id: gameId,
    p_access_token: accessToken,
    p_client_uuid: payload.clientUuid,
    p_inning: payload.inning,
    p_half: payload.half,
    p_type: payload.type,
    p_runner_id: payload.runnerId,
    p_pitcher_id: payload.pitcherId,
    p_runner_note: payload.runnerNote,
    p_entered_by: payload.enteredBy,
    p_runner_atbat_id: payload.runnerAtbatId ?? null,
    p_to_base: payload.toBase ?? null,
  });
  if (error) throw error;
  return data;
}

export async function softDeleteEvent(id, accessToken, deletedBy) {
  const { data, error } = await supabase.rpc('soft_delete_event', {
    p_id: id,
    p_access_token: accessToken,
    p_deleted_by: deletedBy,
  });
  if (error) throw error;
  return data;
}

export async function closeGame(gameId, accessToken) {
  const { data, error } = await supabase.rpc('close_game', {
    p_game_id: gameId,
    p_access_token: accessToken,
  });
  if (error) throw error;
  return data;
}

export async function listOpenGames() {
  const { data, error } = await supabase.rpc('list_open_games');
  if (error) throw error;
  return data;
}

export async function addGuestPlayer(id, displayName) {
  const { data, error } = await supabase.rpc('add_guest_player', {
    p_id: id,
    p_display_name: displayName,
  });
  if (error) throw error;
  return data;
}

export async function fetchPlayers() {
  const { data, error } = await supabase.from('players').select('*').order('id');
  if (error) throw error;
  return data;
}
