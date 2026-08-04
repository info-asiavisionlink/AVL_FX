import { createBrowserClient } from "@supabase/ssr";

// ブラウザ用 Supabase クライアント（クライアントコンポーネントで使用）
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
