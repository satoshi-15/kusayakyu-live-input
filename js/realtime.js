// Realtime購読。再接続時はdeltaに頼らず全件re-fetchして補正する(エンジニアレビュー反映)。
import { supabase } from './supabase-client.js';
import { fetchAllAtbats, fetchAllEvents } from './api.js';

// タブごとに一意なpresenceキー(同じ人が複数端末/タブで開いても別エントリとして数える)。
const presenceKey = crypto.randomUUID();

export function subscribeToGame(gameId, {
  onAtbatsChange, onEventsChange, onGameChange, onStatusChange, onRefetch, onPresenceChange, initialPresence,
}) {
  const channel = supabase
    .channel(`game:${gameId}`, { config: { presence: { key: presenceKey } } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_atbats', filter: `game_id=eq.${gameId}` }, onAtbatsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_events', filter: `game_id=eq.${gameId}` }, onEventsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `game_id=eq.${gameId}` }, onGameChange)
    .on('presence', { event: 'sync' }, () => {
      if (!onPresenceChange) return;
      const state = channel.presenceState();
      const names = Object.values(state).flat().map((meta) => meta.enteredBy);
      onPresenceChange(names);
    })
    .subscribe(async (status) => {
      onStatusChange(status);
      if (status === 'SUBSCRIBED') {
        // 再接続直後は取りこぼし防止のため必ず全件re-fetchする。
        const [atbats, events] = await Promise.all([fetchAllAtbats(gameId), fetchAllEvents(gameId)]);
        onRefetch({ atbats, events });
        if (initialPresence) await channel.track(initialPresence);
      }
    });

  return {
    unsubscribe: () => supabase.removeChannel(channel),
    updatePresence: (meta) => channel.track(meta),
  };
}
