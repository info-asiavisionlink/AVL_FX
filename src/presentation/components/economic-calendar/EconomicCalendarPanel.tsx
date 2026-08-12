"use client";

// =================================================================
// EconomicCalendarPanel — チャートサイドバー用ミニカレンダー
// =================================================================
//
// 表示: 今日の未来イベント上位5件
// クリック: /calendar へ遷移
// データ: demo禁止、APIから直接取得
// =================================================================

import { useEffect, useState, useCallback } from "react";
import { useRouter }         from "next/navigation";
import { useSettingsStore }  from "@/application/stores/settingsStore";
import { cn }                from "@/lib/utils";
import { AlertTriangle, AlertCircle, Calendar, ExternalLink } from "lucide-react";
import type { CalEvent, CalMeta } from "@/app/api/economic-calendar/route";

const CCY_COLOR: Record<string, string> = {
  USD: "text-green-300", EUR: "text-blue-300",  JPY: "text-red-300",
  GBP: "text-yellow-300", AUD: "text-cyan-300", CAD: "text-orange-300",
};

const JA: Record<string, string> = {
  "CPI m/m": "消費者物価 前月比",
  "Core CPI m/m": "コアCPI 前月比",
  "Initial Jobless Claims": "新規失業申請件数",
  "Unemployment Rate": "失業率",
  "Non-Farm Payrolls": "NFP雇用者数",
  "GDP q/q": "GDP 前期比",
  "Retail Sales m/m": "小売売上高",
  "ISM Manufacturing PMI": "ISM製造業PMI",
  "Fed Interest Rate Decision": "FRB政策金利",
  "FOMC Meeting Minutes": "FOMC議事録",
  "ECB Interest Rate Decision": "ECB政策金利",
  "ECB Minutes": "ECB議事録",
  "BoJ Interest Rate Decision": "日銀政策金利",
  "BoJ Rate Decision": "日銀政策金利",
  "BoE Interest Rate Decision": "BOE政策金利",
  "Flash Manufacturing PMI": "製造業PMI速報",
  "Flash Services PMI": "サービスPMI速報",
};

function translateTitle(title: string): string {
  if (JA[title]) return JA[title];
  for (const [en, ja] of Object.entries(JA)) {
    if (title.toLowerCase().includes(en.toLowerCase())) return ja;
  }
  return title;
}

function fmtTimeJST(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("ja-JP", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
  });
}

export function EconomicCalendarPanel() {
  const { settings }          = useSettingsStore();
  const [events, setEvents]   = useState<CalEvent[]>([]);
  const [meta, setMeta]       = useState<CalMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const router                = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const key = settings.twelveDataKey;
      const url = `/api/economic-calendar?range=today${key ? `&key=${key}` : ""}`;
      const res  = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: CalEvent[]; meta: CalMeta };
      setEvents(data.events ?? []);
      setMeta(data.meta ?? null);
    } catch { setEvents([]); } finally { setLoading(false); }
  }, [settings.twelveDataKey]);

  useEffect(() => { void load(); }, [load]);

  const now = Date.now() / 1000;

  // 未来イベントを最大6件（重要度順）
  const upcoming = events
    .filter(e => e.time > now)
    .sort((a, b) => b.impact - a.impact || a.time - b.time)
    .slice(0, 6);

  const todayJST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col h-full bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[#0d1520] shrink-0">
        <Calendar size={10} className="text-cyan-500/60 shrink-0"/>
        <span className="text-[9px] text-cyan-500/60 font-mono tracking-wider flex-1 font-bold">経済指標</span>
        <span className="text-[8px] font-mono text-gray-700">{todayJST}</span>
        <button onClick={() => router.push("/calendar")}
          className="text-gray-700 hover:text-gray-400 transition-colors ml-1">
          <ExternalLink size={9}/>
        </button>
      </div>

      {/* イベントリスト */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {loading ? (
          <div className="p-3 text-center">
            <p className="text-[9px] text-gray-700 font-mono">読み込み中...</p>
          </div>
        ) : upcoming.length === 0 ? (
          <div className="p-3 text-center flex flex-col items-center gap-2">
            <Calendar size={14} className="text-gray-800"/>
            <p className="text-[9px] text-gray-700 font-mono">
              {meta?.source === "none"
                ? "API未設定"
                : "本日の指標なし"}
            </p>
            {meta?.source === "none" && (
              <button onClick={() => router.push("/settings")}
                className="text-[8px] font-mono text-cyan-600/70 hover:text-cyan-500 underline">
                設定する
              </button>
            )}
          </div>
        ) : (
          <div className="py-1">
            {upcoming.map(ev => {
              const isHigh  = ev.impact >= 3;
              const isMed   = ev.impact === 2;
              const ccy     = CCY_COLOR[ev.currency] ?? "text-gray-400";
              const secLeft = ev.time - now;
              const isImm   = secLeft < 600;
              const isNear  = secLeft < 3600;
              const titleJa = translateTitle(ev.title);

              return (
                <button key={ev.id}
                  onClick={() => router.push("/calendar")}
                  className={cn(
                    "w-full text-left px-2.5 py-2 border-b border-[#0d1520]/50",
                    "border-l-2 transition-colors",
                    isImm  ? "border-l-red-500 bg-red-950/15" :
                    isNear ? "border-l-amber-500/60 bg-amber-950/10" :
                    isHigh ? "border-l-red-800/50 hover:bg-[#0d1520]/30" :
                             "border-l-transparent hover:bg-[#0d1520]/30"
                  )}>
                  {/* 時刻 + 通貨 + 重要度 */}
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={cn(
                      "text-[10px] font-mono font-bold tabular-nums shrink-0",
                      isImm ? "text-red-300" : isNear ? "text-amber-300" : "text-gray-300"
                    )}>
                      {fmtTimeJST(ev.time)}
                    </span>
                    <span className={cn("text-[8px] font-mono font-bold shrink-0", ccy)}>
                      {ev.currency}
                    </span>
                    <div className="flex gap-0.5 items-center">
                      {isHigh && <AlertTriangle size={8} className="text-red-400"/>}
                      {isMed  && <AlertCircle   size={8} className="text-amber-400"/>}
                    </div>
                  </div>

                  {/* 指標名 */}
                  <p className="text-[9px] text-gray-300 leading-tight truncate">
                    {titleJa}
                  </p>

                  {/* 予想 */}
                  {ev.forecast && (
                    <p className="text-[8px] font-mono text-gray-600 mt-0.5">
                      予 <span className="text-cyan-500/70">{ev.forecast}</span>
                      {ev.previous && <span className="ml-2">前 <span className="text-gray-500">{ev.previous}</span></span>}
                    </p>
                  )}
                </button>
              );
            })}

            {/* 全て見るリンク */}
            <button onClick={() => router.push("/calendar")}
              className="w-full py-1.5 text-center text-[8px] font-mono text-cyan-600/50 hover:text-cyan-500 transition-colors border-t border-[#0d1520]">
              全て表示 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
