// =================================================================
// Console Admin Authentication
//
// 方針:
//   - Server-side専用。Client JSへ漏洩しない
//   - ADMIN_EMAILS環境変数に登録されたメールのみ許可
//   - Hardcoded admin boolean禁止
//   - Supabase auth + email allowlist による2重確認
// =================================================================

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Admin許可メールリスト（Server-sideのみ） */
function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
  );
}

/** 現在のリクエストがAdmin認証済みか確認 */
export async function isAdmin(): Promise<boolean> {
  const adminEmails = getAdminEmails();
  if (adminEmails.size === 0) return false; // ENV未設定 = 全拒否

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return false;

  return adminEmails.has(user.email.toLowerCase());
}

/** Admin確認 + 未認証なら/loginへredirect */
export async function requireAdmin() {
  const ok = await isAdmin();
  if (!ok) return null;
  return true;
}

/** Gateway URLとSecret (Server-side専用) */
export function getGatewayConfig() {
  return {
    url:    process.env.MT5_GATEWAY_URL ?? process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "",
    secret: process.env.MT5_GATEWAY_SECRET ?? "",
  };
}

/** Supabase Service Role Client (Console専用: 全テーブルアクセス) */
export async function getAdminSupabase() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
