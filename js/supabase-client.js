// Supabase接続設定。anon(publishable)キーはRLSが安全境界のため公開情報として扱ってよい
// (実装計画フェーズ2「Supabaseスキーマ設計」参照)。書き込み権限を持つsecretキーはここには置かない。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://mddtxlivzbarvaoeslhg.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_H52ULZDlsoA0wVHPPg76Fw_p1tMCxE8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
});
