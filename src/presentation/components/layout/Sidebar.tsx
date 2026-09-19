"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { createClient } from "@/infrastructure/supabase/client";
import { useEffect, useState } from "react";
import {
  BarChart2, CalendarDays, Newspaper,
  Briefcase, History, Settings, Cable, X, Bot, LogOut, User,
} from "lucide-react";

export const NAV = [
  { href: "/traders",   icon: Bot,          label: "AIトレーダー", group: 1 },
  { href: "/chart",     icon: BarChart2,    label: "チャート",      group: 1 },
  { href: "/calendar",  icon: CalendarDays, label: "カレンダー",    group: 1 },
  { href: "/news",      icon: Newspaper,    label: "ニュース",      group: 1 },
  { href: "/positions", icon: Briefcase,    label: "ポジション",    group: 2 },
  { href: "/history",   icon: History,      label: "取引履歴",      group: 2 },
  { href: "/settings",  icon: Settings,     label: "設定",          group: 2 },
];

interface SidebarProps {
  onClose?: () => void;
  mobile?: boolean;
}

export function Sidebar({ onClose, mobile = false }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useConnectionStore();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  let lastGroup = 0;

  useEffect(() => {
    const sb = createClient();
    sb.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserEmail(user.email ?? null);
    });
  }, []);

  async function handleSignOut() {
    const sb = createClient();
    await sb.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const width = mobile ? "w-[200px]" : "w-[88px]";

  return (
    <aside
      className={cn("relative flex flex-col h-full shrink-0 overflow-hidden", width)}
      style={{
        background: "linear-gradient(180deg, #f97316 0%, #ea580c 100%)",
        borderRight: "1px solid rgba(249,115,22,0.2)",
        boxShadow: "2px 0 16px rgba(0,0,0,0.08)",
      }}
    >
      {/* 右端の薄いライン */}
      <div className="absolute right-0 top-0 bottom-0 w-px pointer-events-none"
        style={{ background: "rgba(255,255,255,0.15)" }} />

      {/* ロゴ */}
      <div className={cn(
        "flex items-center w-full h-[68px] shrink-0",
        mobile ? "px-4 justify-between" : "justify-center"
      )}
        style={{ borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
        <Link href="/chart" onClick={onClose}
          className="flex flex-col items-center justify-center select-none gap-0.5">
          <div
            className="w-10 h-10 rounded-xl flex flex-col items-center justify-center"
            style={{
              background: "rgba(255,255,255,0.95)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}>
            <span className="text-[13px] font-black leading-none" style={{ color: "#ea580c" }}>AVL</span>
            <span className="text-[7px] font-bold tracking-widest" style={{ color: "#f97316" }}>FX</span>
          </div>
        </Link>

        {mobile && onClose && (
          <button onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* ナビゲーション */}
      <nav className="flex flex-col w-full flex-1 px-2 py-3 gap-0.5 overflow-y-auto">
        {NAV.map(({ href, icon: Icon, label, group }, idx) => {
          const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));
          const showDivider = group !== lastGroup && lastGroup !== 0;
          lastGroup = group;

          return (
            <div key={`${href}-${idx}`} className="w-full">
              {showDivider && (
                <div className="w-full h-px my-2"
                  style={{ background: "rgba(255,255,255,0.2)" }} />
              )}
              <Link
                href={href}
                onClick={onClose}
                className={cn(
                  "relative flex items-center w-full rounded-xl transition-all duration-150",
                  mobile ? "flex-row gap-3 px-3 h-[48px]" : "flex-col justify-center h-[62px]",
                )}
                style={isActive ? {
                  background: "rgba(255,255,255,0.95)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                } : {
                  background: "transparent",
                }}
              >
                {/* ホバー */}
                {!isActive && (
                  <div className="absolute inset-0 rounded-xl opacity-0 hover:opacity-100 transition-opacity"
                    style={{ background: "rgba(255,255,255,0.12)" }} />
                )}

                <Icon
                  size={mobile ? 17 : 18}
                  className="shrink-0 transition-colors"
                  style={{ color: isActive ? "#ea580c" : "rgba(255,255,255,0.85)" }}
                />
                <span
                  className={cn(
                    "font-semibold transition-colors leading-tight",
                    mobile ? "text-[12px]" : "text-[9px] tracking-wide mt-0.5"
                  )}
                  style={{ color: isActive ? "#ea580c" : "rgba(255,255,255,0.85)" }}
                >
                  {label}
                </span>
              </Link>
            </div>
          );
        })}
      </nav>

      {/* MT5 接続 */}
      <div className="w-full px-2 shrink-0"
        style={{ borderTop: "1px solid rgba(255,255,255,0.15)" }}>
        <Link
          href="/mt5"
          onClick={onClose}
          className={cn(
            "relative flex items-center w-full rounded-xl mt-2 mb-1 transition-all duration-150",
            mobile ? "flex-row gap-3 px-3 h-[48px]" : "flex-col justify-center h-[62px]",
          )}
          style={pathname.startsWith("/mt5") ? {
            background: "rgba(255,255,255,0.95)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          } : { background: "transparent" }}
        >
          {!pathname.startsWith("/mt5") && (
            <div className="absolute inset-0 rounded-xl opacity-0 hover:opacity-100 transition-opacity"
              style={{ background: "rgba(255,255,255,0.12)" }} />
          )}
          <div className="relative shrink-0">
            <Cable
              size={mobile ? 17 : 18}
              style={{ color: pathname.startsWith("/mt5") ? "#ea580c" : "rgba(255,255,255,0.85)" }}
            />
            {/* 接続ドット */}
            <div
              className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-white"
              style={{
                background:
                  status === "connected" ? "#22c55e" :
                  status === "connecting" ? "#fbbf24" : "#6b7280",
              }}
            />
          </div>
          <span
            className={cn(
              "font-semibold leading-tight",
              mobile ? "text-[12px]" : "text-[9px] tracking-wide mt-0.5"
            )}
            style={{ color: pathname.startsWith("/mt5") ? "#ea580c" : "rgba(255,255,255,0.85)" }}
          >
            MT5
          </span>
        </Link>
      </div>

      {/* ユーザー */}
      {userEmail && (
        <div className="w-full px-2 pb-3 shrink-0">
          <div className="rounded-xl px-2 py-2 space-y-1.5"
            style={{ background: "rgba(0,0,0,0.12)" }}>
            <div className="flex items-center gap-1.5">
              <User size={9} style={{ color: "rgba(255,255,255,0.6)" }} />
              <span className="text-[7px] font-mono truncate" style={{ color: "rgba(255,255,255,0.6)" }}>
                {mobile ? userEmail : userEmail.split("@")[0]}
              </span>
            </div>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-1.5 rounded text-[9px] font-semibold transition-opacity hover:opacity-70"
              style={{ color: "rgba(255,255,255,0.8)" }}
            >
              <LogOut size={9} />
              <span>ログアウト</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
