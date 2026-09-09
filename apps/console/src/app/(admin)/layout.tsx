import { requireAdmin } from "@/lib/admin-auth";
import { redirect } from "next/navigation";
import Link from "next/link";

const NAV = [
  { href: "/dashboard",    label: "ダッシュボード",     icon: "📊" },
  { href: "/market-data",  label: "市場データ",          icon: "📡" },
  { href: "/historical",   label: "ヒストリカルデータ",   icon: "📁" },
  { href: "/mt5",          label: "MT5接続",             icon: "🖥️" },
  { href: "/gateway",      label: "ゲートウェイ",         icon: "🔀" },
  { href: "/system",       label: "システム診断",         icon: "🔍" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ok = await requireAdmin();
  if (!ok) redirect("/login?error=unauthorized");

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col" style={{ background: "var(--bg-secondary)", borderRight: "1px solid var(--border)" }}>
        {/* Brand */}
        <div className="px-5 py-5 border-b" style={{ borderColor: "var(--border)" }}>
          <p className="text-[9px] tracking-[0.3em]" style={{ color: "var(--text-muted)" }}>AVLFX</p>
          <h1 className="text-sm font-black tracking-widest mt-0.5" style={{ color: "var(--accent-cyan)" }}>CONSOLE</h1>
          <p className="text-[8px] mt-0.5" style={{ color: "var(--text-muted)" }}>管理者専用 コントロールパネル</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map(n => (
            <Link key={n.href} href={n.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs transition-all hover:opacity-80"
              style={{ color: "var(--text-secondary)" }}>
              <span style={{ fontSize: "14px" }}>{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t text-[8px]" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
          <p>管理者専用</p>
          <p className="mt-0.5">一般ユーザーには非公開</p>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  );
}
