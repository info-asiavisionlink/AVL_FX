"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { cn }        from "@/lib/utils";
import { AlertTriangle, AlertCircle, Calendar, ExternalLink, RefreshCw } from "lucide-react";
import type { CalEvent, CalMeta } from "@/app/api/economic-calendar/route";

const CCY_COLOR: Record<string, string> = {
  USD: "text-green-400", EUR: "text-blue-400",   JPY: "text-red-400",
  GBP: "text-yellow-400", AUD: "text-cyan-400",  CAD: "text-orange-400",
  CHF: "text-purple-400", NZD: "text-teal-400",
};

const JA: Record<string, string> = {
  "CPI m/m": "CPI 前月比", "CPI y/y": "CPI 前年比",
  "Core CPI m/m": "コアCPI 前月比", "Core CPI y/y": "コアCPI 前年比",
  "Initial Jobless Claims": "新規失業申請件数",
  "Non-Farm Payrolls": "NFP 雇用者数",
  "Unemployment Rate": "失業率",
  "GDP q/q": "GDP 前期比",
  "Retail Sales m/m": "小売売上高",
  "Fed Interest Rate Decision": "FRB 政策金利",
  "FOMC Meeting Minutes": "FOMC 議事録",
  "FOMC Statement": "FOMC 声明",
  "ECB Interest Rate Decision": "ECB 政策金利",
  "BoJ Interest Rate Decision": "日銀 政策金利",
  "BoE Interest Rate Decision": "BOE 政策金利",
  "Cash Rate": "政策金利",
  "Flash Manufacturing PMI": "製造業PMI速報",
  "Flash Services PMI": "サービスPMI速報",
  "ISM Manufacturing PMI": "ISM製造業PMI",
  "ISM Services PMI": "ISMサービスPMI",
  "ADP Non-Farm Employment Change": "ADP雇用変化",
  "PCE Price Index m/m": "PCEデフレーター",
  "Core PCE Price Index m/m": "コアPCE",
  "Trade Balance": "貿易収支",
  "Building Permits": "建設許可件数",
  "Consumer Confidence": "消費者信頼感",
  "Crude Oil Inventories": "原油在庫",
};

function ja(title: string): string {
  if (JA[title]) return JA[title];
  for (const [en, jp] of Object.entries(JA)) {
    if (title.toLowerCase().includes(en.toLowerCase())) return jp;
  }
  return title;
}

function fmtJST(sec: number) {
  return new Date(sec * 1000).toLocaleTimeString("ja-JP", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
  });
}

export function EconomicCalendarPanel() {
  const router = useRouter();
  const [events,  setEvents]  = useState<CalEvent[]>([]);
  const [meta,    setMeta]    = useState<CalMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/economic-calendar?range=today", {
        cache: "no-store",
        headers: { "x-from": "panel" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { events: CalEvent[]; meta: CalMeta };
      setEvents(d.events ?? []);
      setMeta(d.meta ?? null);
    } catch {
      setEvents([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const now      = Date.now() / 1000;
  const todayJST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  const upcoming = events
    .filter(e => e.time > now)
    .sort((a, b) => b.impact - a.impact || a.time - b.time)
    .slice(0, 6);

  return (
    <div className="flex flex-col h-full bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-[#0d1520] shrink-0">
        <Calendar size={9} className="text-cyan-500/60 shrink-0"/>
        <span className="text-[9px] text-cyan-500/60 font-mono tracking-wider flex-1 font-bold">経済指標</span>
        <span className="text-[8px] font-mono text-gray-700">{todayJST}</span>
        {loading && <RefreshCw size={8} className="text-gray-700 animate-spin shrink-0"/>}
        <button onClick={() => router.push("/calendar")} className="text-gray-700 hover:text-gray-400 ml-0.5">
          <ExternalLink size={9}/>
        </button>
      </div>

      {/* コンテンツ */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <p className="text-[8px] text-gray-700 font-mono">読み込み中...</p>
          </div>
        ) : upcoming.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-16 gap-1">
            <Calendar size={12} className="text-gray-800"/>
            <p className="text-[8px] text-gray-700 font-mono">
              {!meta || meta.source === "none" ? "取得エラー" : "本日の指標なし"}
            </p>
            {meta?.error && (
              <p className="text-[7px] text-red-900 font-mono px-2 text-center leading-tight">
                {meta.error}
              </p>
            )}
          </div>
        ) : (
          <div className="py-0.5">
            {upcoming.map(ev => {
              const isHigh = ev.impact >= 3;
              const isMed  = ev.impact === 2;
              const sec    = ev.time - now;
              const isImm  = sec < 600;
              const isNear = sec < 3600;
              const ccy    = CCY_COLOR[ev.currency] ?? "text-gray-400";

              return (
                <button key={ev.id} onClick={() => router.push("/calendar")}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 border-b border-[#0d1520]/40 border-l-2 transition-colors",
                    isImm  ? "border-l-red-500 bg-red-950/20" :
                    isNear ? "border-l-amber-500/70 bg-amber-950/10" :
                    isHigh ? "border-l-red-700/60 hover:bg-[#0d1520]/30" :
                             "border-l-transparent hover:bg-[#0d1520]/20"
                  )}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={cn("text-[10px] font-mono font-bold tabular-nums shrink-0",
                      isImm ? "text-red-300" : isNear ? "text-amber-300" : "text-gray-300")}>
                      {fmtJST(ev.time)}
                    </span>
                    <span className={cn("text-[8px] font-mono font-bold shrink-0", ccy)}>
                      {ev.currency}
                    </span>
                    {isHigh && <AlertTriangle size={8} className="text-red-400 shrink-0"/>}
                    {isMed  && <AlertCircle   size={8} className="text-amber-400 shrink-0"/>}
                  </div>
                  <p className="text-[9px] text-gray-300 leading-tight truncate">{ja(ev.title)}</p>
                  {(ev.forecast || ev.previous) && (
                    <p className="text-[7px] font-mono text-gray-700 mt-0.5">
                      {ev.forecast && <>予 <span className="text-cyan-600">{ev.forecast}</span></>}
                      {ev.forecast && ev.previous && <span className="mx-1 text-gray-800">·</span>}
                      {ev.previous && <>前 <span className="text-gray-600">{ev.previous}</span></>}
                    </p>
                  )}
                </button>
              );
            })}
            <button onClick={() => router.push("/calendar")}
              className="w-full py-1.5 text-center text-[8px] font-mono text-cyan-700/60 hover:text-cyan-500 transition-colors">
              全て表示 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
