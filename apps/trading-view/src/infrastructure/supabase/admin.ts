import { createClient } from "@supabase/supabase-js";

// Service Role クライアント — サーバーサイド専用（RLS バイパス）
// API Route / Server Component からのみ使用すること
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
