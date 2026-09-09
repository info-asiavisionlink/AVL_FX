import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Server Action — Cookieにセッションを書き込む
async function loginAction(formData: FormData) {
  "use server";
  const email    = formData.get("email") as string;
  const password = formData.get("password") as string;

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (pairs) =>
          pairs.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          ),
      },
    }
  );

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // Admin check
  const { data: { user } } = await supabase.auth.getUser();
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  if (!user?.email || !adminEmails.has(user.email.toLowerCase())) {
    await supabase.auth.signOut();
    redirect("/login?error=unauthorized");
  }

  redirect("/dashboard");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMsg =
    error === "unauthorized" ? "このアカウントはConsoleへのアクセス権がありません" :
    error ? decodeURIComponent(error) : "";

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-primary)" }}>
      <div className="w-full max-w-sm p-8 rounded-xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="text-center mb-8">
          <p className="text-xs tracking-[0.3em] mb-1" style={{ color: "var(--text-muted)" }}>AVLFX</p>
          <h1 className="text-xl font-black tracking-widest" style={{ color: "var(--accent-cyan)" }}>CONSOLE</h1>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>管理者専用システム</p>
        </div>

        <form action={loginAction} className="space-y-4">
          <div>
            <label className="block text-xs mb-1.5 tracking-widest" style={{ color: "var(--text-muted)" }}>
              メールアドレス
            </label>
            <input
              name="email" type="email" required autoComplete="email"
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1.5 tracking-widest" style={{ color: "var(--text-muted)" }}>
              パスワード
            </label>
            <input
              name="password" type="password" required autoComplete="current-password"
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            />
          </div>
          {errorMsg && (
            <p className="text-xs" style={{ color: "#f87171" }}>{errorMsg}</p>
          )}
          <button
            type="submit"
            className="w-full py-2.5 rounded-lg text-xs font-black tracking-widest"
            style={{ background: "rgba(0,229,255,0.12)", color: "var(--accent-cyan)", border: "1px solid rgba(0,229,255,0.3)" }}
          >
            ログイン →
          </button>
        </form>
      </div>
    </div>
  );
}
