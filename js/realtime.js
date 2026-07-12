// Realtime購読。再接続時はdeltaに頼らず全件re-fetchして補正する(エンジニアレビュー反映)。
import { supabase } from './supabase-client.js';
import { fetchAllAtbats, fetchAllEvents } from './api.js';

export function subscribeToGame(gameId, { onAtbatsChange, onEventsChange, onGameChange, onStatusChange, onRefetch }) {
  const channel = supabase
    .channel(`game:${gameId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_atbats', filter: `game_id=eq.${gameId}` }, onAtbatsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_events', filter: `game_id=eq.${gameId}` }, onEventsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `game_id=eq.${gameId}` }, onGameChange)
    .subscribe(async (status) => {
      onStatusChange(status);
      if (status === 'SUBSCRIBED') {
        // 再接続直後は取りこぼし防止のため必ず全件re-fetchする。
        const [atbats, events] = await Promise.all([fetchAllAtbats(gameId), fetchAllEvents(gameId)]);
        onRefetch({ atbats, events });
      }
    });

  return () => supabase.removeChannel(channel);
}
