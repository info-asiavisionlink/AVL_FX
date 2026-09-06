import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const from = searchParams.get("from") ?? "login"; // "login" | "signup"

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll()            { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        const createdAt     = new Date(user.created_at).getTime();
        const lastSignIn    = new Date(user.last_sign_in_at ?? user.created_at).getTime();
        const isNewUser     = Math.abs(lastSignIn - createdAt) < 10_000; // 初回ログインは10秒以内

        // ログインページから来た新規ユーザー = 新規登録なしで侵入しようとしている
        if (isNewUser && from === "login") {
          await supabase.auth.signOut();
          return NextResponse.redirect(
            `${origin}/signup?notice=register_first`
          );
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
