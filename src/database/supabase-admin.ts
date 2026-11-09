import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * 토큰 검증용 service role 클라이언트 (프로세스당 1개).
 * 기본 옵션으로 만들면 인스턴스마다 자동 갱신 setInterval이 돌아 해제되지 않으므로,
 * 요청마다 createClient를 호출하지 말고 이 함수를 쓸 것.
 */
export function getSupabaseAdmin(): SupabaseClient {
  client ??= createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return client;
}
