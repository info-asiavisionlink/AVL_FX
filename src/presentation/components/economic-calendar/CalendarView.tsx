"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, AlertCircle, RefreshCw, Clock, Calendar,
} from "lucide-react";
import type { CalEvent, CalMeta } from "@/app/api/economic-calendar/route";

// ── 定数 ──────────────────────────────────────────────────────────

const JST = 9 * 3600_000;
const DAYS_JA    = ["日","月","火","水","木","金","土"];
const MONTHS_EN  = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

const CCY_COLOR: Record<string, { text: string; bg: string; border: string }> = {
  USD: { text:"text-green-300",  bg:"bg-green-900/25",  border:"border-green-800/40"  },
  EUR: { text:"text-blue-300",   bg:"bg-blue-900/25",   border:"border-blue-800/40"   },
  JPY: { text:"text-red-300",    bg:"bg-red-900/25",    border:"border-red-800/40"    },
  GBP: { text:"text-yellow-300", bg:"bg-yellow-900/25", border:"border-yellow-800/40" },
  AUD: { text:"text-cyan-300",   bg:"bg-cyan-900/25",   border:"border-cyan-800/40"   },
  CAD: { text:"text-orange-300", bg:"bg-orange-900/25", border:"border-orange-800/40" },
  CHF: { text:"text-purple-300", bg:"bg-purple-900/25", border:"border-purple-800/40" },
  NZD: { text:"text-teal-300",   bg:"bg-teal-900/25",   border:"border-teal-800/40"   },
};

const JA: Record<string, string> = {
  "CPI m/m": "CPI 前月比",              "CPI y/y": "CPI 前年比",
  "Core CPI m/m": "コアCPI 前月比",     "Core CPI y/y": "コアCPI 前年比",
  "PPI m/m": "PPI 前月比",              "PPI y/y": "PPI 前年比",
  "Initial Jobless Claims": "新規失業申請件数",
  "Unemployment Rate": "失業率",
  "Non-Farm Payrolls": "非農業部門雇用者数",
  "ADP Non-Farm Employment Change": "ADP雇用変化",
  "Average Hourly Earnings m/m": "平均時給 前月比",
  "GDP q/q": "GDP 前期比",              "GDP y/y": "GDP 前年比",
  "Retail Sales m/m": "小売売上高 前月比",
  "Core Retail Sales m/m": "コア小売売上高",
  "ISM Manufacturing PMI": "ISM製造業PMI",
  "ISM Services PMI": "ISMサービスPMI",
  "Flash Manufacturing PMI": "製造業PMI速報",
  "Flash Services PMI": "サービスPMI速報",
  "Manufacturing PMI": "製造業PMI",
  "Services PMI": "サービスPMI",
  "Composite PMI": "総合PMI",
  "Fed Interest Rate Decision": "FRB 政策金利",
  "FOMC Statement": "FOMC 声明",
  "FOMC Meeting Minutes": "FOMC 議事録",
  "PCE Price Index m/m": "PCEデフレーター 前月比",
  "Core PCE Price Index m/m": "コアPCE 前月比",
  "ECB Interest Rate Decision": "ECB 政策金利",
  "ECB Press Conference": "ECB 記者会見",
  "ECB Meeting Accounts": "ECB 議事録",
  "BoJ Interest Rate Decision": "日銀 政策金利",
  "BoJ Rate Decision": "日銀 政策金利",
  "BoJ Press Conference": "日銀総裁 会見",
  "BoE Interest Rate Decision": "BOE 政策金利",
  "Cash Rate": "政策金利",
  "RBA Rate Statement": "RBA 声明",
  "Trade Balance": "貿易収支",
  "Building Permits": "建設許可件数",
  "Housing Starts": "住宅着工件数",
  "Consumer Confidence": "消費者信頼感",
  "CB Consumer Confidence": "CB消費者信頼感",
  "Michigan Consumer Sentiment": "ミシガン消費者信頼感",
  "Durable Goods Orders m/m": "耐久財受注 前月比",
  "German CPI m/m": "独CPI 前月比",
  "German GDP q/q": "独GDP 前期比",
  "German Ifo Business Climate": "独Ifo景況感",
  "Tokyo CPI y/y": "東京CPI 前年比",
  "Tankan Manufacturing Index": "日銀短観 製造業",
  "UK CPI y/y": "英CPI 前年比",
  "Crude Oil Inventories": "原油在庫",
  "Natural Gas Storage": "天然ガス在庫",
};

function ja(title: string): string {
  if (JA[title]) return JA[title];
  for (const [en, jp] of Object.entries(JA)) {
    if (title.toLowerCase().includes(en.toLowerCase())) return jp;
  }
  return title;
}

// ── ユーティリティ ──────────────────────────────────────────────────

function toJSTDate(ms: number): string {
  return new Date(ms + JST).toISOString().slice(0, 10);
}

function fmtTimeJST(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString("ja-JP", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
  });
}

function dateHeader(dateStr: string, now: number) {
  const todayStr    = toJSTDate(now);
  const tomorrowStr = toJSTDate(now + 86400_000);
  const d   = new Date(dateStr + "T00:00:00+09:00");
  const mon = MONTHS_EN[d.getMonth()];
  const dd  = String(d.getDate()).padStart(2, "0");
  const day = DAYS_JA[d.getDay()];
  const label = dateStr === todayStr ? "TODAY" : dateStr === tomorrowStr ? "TOMORROW" : `${mon} ${dd}`;
  return { label, full: `${d.getFullYear()}.${mon}.${dd} (${day})` };
}

function countdown(nowMs: number, sec: number): string | null {
  const diff = sec * 1000 - nowMs;
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  if (h > 0) return `T-${h}h${String(m).padStart(2,"0")}m`;
  if (m > 0) return `T-${m}m${String(s).padStart(2,"0")}s`;
  return `T-${s}s`;
}

// ── EventCard ──────────────────────────────────────────────────────

function EventCard({ ev, now }: { ev: CalEvent; now: number }) {
  const [tick, setTick] = useState(Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (ev.time * 1000 < now) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ev.time, now]);

  const isPast  = ev.time * 1000 < now;
  const secLeft = ev.time - tick / 1000;
  const isImm   = !isPast && secLeft < 600;
  const isNear  = !isPast && secLeft < 3600;
  const isHigh  = ev.impact >= 3;
  const isMed   = ev.impact === 2;
  const cd      = !isPast ? countdown(tick, ev.time) : null;
  const ccy     = CCY_COLOR[ev.currency] ?? { text:"text-gray-400", bg:"bg-gray-800/20", border:"border-gray-700/30" };
  const impactHex = isHigh ? "#ef4444" : isMed ? "#f59e0b" : "#4b5563";

  return (
    <div
      onClick={() => setOpen(o => !o)}
      className={cn(
        "border-l-2 mb-1.5 rounded-r-sm cursor-pointer transition-all",
        isPast  ? "opacity-35 border-l-gray-700 bg-[#080b10]" :
        isImm   ? "border-l-red-500 bg-red-950/20" :
        isNear  ? "border-l-amber-500 bg-amber-950/10" :
        isHigh  ? "border-l-red-600/80 bg-[#0c0e17]" :
                  "border-l-[#1a2535]/80 bg-[#080b10] hover:bg-[#0c0e17]"
      )}
    >
      <div className="px-3 py-2.5">
        {/* Row 1: 時刻・通貨・インパクト・ステータス */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={cn("text-[13px] font-black font-mono tabular-nums shrink-0",
            isPast ? "text-gray-600" : isImm ? "text-red-300" : isNear ? "text-amber-300" : "text-gray-200")}>
            {fmtTimeJST(ev.time)}
          </span>
          <span className={cn("text-[9px] font-mono font-bold px-1.5 py-0.5 border rounded-sm shrink-0",
            ccy.text, ccy.bg, ccy.border)}>
            {ev.currency}
          </span>
          {/* インパクトバー */}
          <div className="flex items-center gap-0.5 shrink-0">
            {[1,2,3].map(i => (
              <div key={i} className="w-1.5 h-3 rounded-[1px]"
                style={{ background: i <= ev.impact ? impactHex : "#1a2535" }}/>
            ))}
            <span className="text-[7px] font-mono ml-1" style={{ color: `${impactHex}90` }}>
              {isHigh ? "HIGH" : isMed ? "MED" : "LOW"}
            </span>
          </div>
          <div className="flex-1"/>
          {isPast && ev.actual && (
            <span className="text-[8px] font-mono font-bold text-green-500 border border-green-800/40 px-1.5 py-0.5 shrink-0">
              発表済
            </span>
          )}
          {!isPast && isImm && cd && (
            <span className="text-[8px] font-mono font-bold text-red-400 border border-red-700/50 px-1.5 py-0.5 shrink-0 animate-pulse">
              {cd}
            </span>
          )}
          {!isPast && isNear && !isImm && cd && (
            <span className="text-[8px] font-mono text-amber-400/80 shrink-0">{cd}</span>
          )}
        </div>

        {/* Row 2: 指標名 */}
        <p className={cn("text-[12px] font-semibold leading-tight",
          isPast ? "text-gray-500" : isHigh ? "text-white" : "text-gray-200")}>
          {ja(ev.title)}
        </p>
        {ja(ev.title) !== ev.title && (
          <p className="text-[9px] text-gray-700 font-mono mt-0.5">{ev.title}</p>
        )}

        {/* Row 3: 前回・予想・結果 */}
        {(ev.forecast || ev.previous || ev.actual) && (
          <div className="flex items-center gap-5 mt-2">
            {ev.previous && (
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">前回</p>
                <p className="text-[10px] font-mono tabular-nums text-gray-400">{ev.previous}</p>
              </div>
            )}
            {ev.forecast && (
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">予想</p>
                <p className="text-[10px] font-mono tabular-nums text-cyan-400">{ev.forecast}</p>
              </div>
            )}
            <div>
              <p className="text-[7px] font-mono text-gray-700 mb-0.5">結果</p>
              {ev.actual ? (
                <p className={cn("text-[11px] font-mono font-bold tabular-nums",
                  ev.forecast && !isNaN(parseFloat(ev.actual)) && !isNaN(parseFloat(ev.forecast))
                    ? parseFloat(ev.actual) >= parseFloat(ev.forecast) ? "text-green-400" : "text-red-400"
                    : "text-gray-200")}>
                  {ev.actual}
                </p>
              ) : (
                <p className="text-[10px] font-mono text-gray-700">—</p>
              )}
            </div>
          </div>
        )}

        {/* 展開: 詳細 */}
        {open && (
          <div className="mt-2 pt-2 border-t border-[#1a2535] text-[9px] font-mono text-gray-600 space-y-0.5">
            <p>通貨: <span className="text-gray-400">{ev.country}</span></p>
            <p>UTC: <span className="text-gray-400">{new Date(ev.time * 1000).toISOString()}</span></p>
            <p>JST: <span className="text-gray-400">{new Date(ev.time * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</span></p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── DateSection ────────────────────────────────────────────────────

function DateSection({ dateStr, events, now }: { dateStr: string; events: CalEvent[]; now: number }) {
  const { label, full } = dateHeader(dateStr, now);
  return (
    <div>
      <div className="sticky top-0 z-10 bg-[#050810] border-b border-[#1a2535] px-4 py-2 flex items-center gap-3">
        <div className="w-0.5 h-5 bg-cyan-500/40 shrink-0"/>
        <div>
          <p className="text-[8px] font-mono text-cyan-500/50 tracking-[0.3em] leading-none">{label}</p>
          <p className="text-[11px] font-bold font-mono text-gray-300 leading-tight">{full}</p>
        </div>
        <div className="flex-1"/>
        <span className="text-[8px] font-mono text-gray-700">{events.length}件</span>
      </div>
      <div className="px-3 pt-2">
        {events.map(ev => <EventCard key={ev.id} ev={ev} now={now}/>)}
      </div>
    </div>
  );
}

// ── CalendarView ──────────────────────────────────────────────────

type RangeKey    = "today" | "tomorrow" | "week";
type ImpactKey   = "all" | "high" | "medium";

export function CalendarView() {
  const [range,   setRange]   = useState<RangeKey>("today");
  const [impact,  setImpact]  = useState<ImpactKey>("all");
  const [ccy,     setCcy]     = useState("all");
  const [events,  setEvents]  = useState<CalEvent[]>([]);
  const [meta,    setMeta]    = useState<CalMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [now,     setNow]     = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/economic-calendar?range=${range}`, {
        cache: "no-store",
        headers: { "x-from": "calendar" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { events: CalEvent[]; meta: CalMeta };
      setEvents(d.events ?? []);
      setMeta(d.meta ?? null);
    } catch (e) {
      console.error("[CalendarView]", e);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    let ev = [...events];
    if (impact === "high")   ev = ev.filter(e => e.impact >= 3);
    if (impact === "medium") ev = ev.filter(e => e.impact >= 2);
    if (ccy !== "all")       ev = ev.filter(e => e.currency === ccy);
    return ev.sort((a, b) => a.time - b.time);
  }, [events, impact, ccy]);

  const currencies = useMemo(() =>
    [...new Set(events.map(e => e.currency))].sort(), [events]);

  const grouped = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const ev of filtered) {
      const d = toJSTDate(ev.time * 1000);
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(ev);
    }
    return [...m.entries()].sort(([a],[b]) => a.localeCompare(b));
  }, [filtered]);

  const highAhead = events.filter(e => e.impact >= 3 && e.time * 1000 > now).length;

  return (
    <div className="flex flex-col h-full bg-[#050810] text-gray-100">

      {/* ── ヘッダー ── */}
      <div className="shrink-0 border-b border-[#1a2535] bg-[#03050d] px-4 py-3">
        <div className="flex items-center gap-3 mb-3">
          <Calendar size={14} className="text-cyan-500/70"/>
          <div>
            <p className="text-[8px] font-mono text-cyan-500/50 tracking-[0.3em] leading-none">AVL AI</p>
            <p className="text-[13px] font-black font-mono tracking-wider text-cyan-300 leading-none">
              ECONOMIC CALENDAR
            </p>
          </div>
          <div className="flex-1"/>
          <button onClick={load} disabled={loading} className="text-gray-600 hover:text-gray-300 p-1 transition-colors">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""}/>
          </button>
        </div>

        {/* Range タブ */}
        <div className="flex gap-1 mb-2">
          {(["today","tomorrow","week"] as RangeKey[]).map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={cn("text-[9px] font-mono font-bold px-3 py-1 border transition-all",
                range === r
                  ? "border-cyan-700/60 text-cyan-300 bg-cyan-900/20"
                  : "border-[#1a2535] text-gray-600 hover:text-gray-400")}>
              {r === "today" ? "今日" : r === "tomorrow" ? "明日" : "今週"}
            </button>
          ))}
        </div>

        {/* インパクトフィルター */}
        <div className="flex gap-1 mb-2">
          {(["all","high","medium"] as ImpactKey[]).map(f => (
            <button key={f} onClick={() => setImpact(f)}
              className={cn("text-[8px] font-mono px-2 py-0.5 border transition-all",
                impact === f
                  ? f === "high"   ? "border-red-700/60 text-red-400 bg-red-900/15"
                  : f === "medium" ? "border-amber-700/60 text-amber-400 bg-amber-900/15"
                  :                  "border-cyan-700/60 text-cyan-400 bg-cyan-900/15"
                  : "border-[#1a2535] text-gray-700 hover:text-gray-500")}>
              {f === "all" ? "全て" : f === "high" ? "HIGH" : "MED以上"}
            </button>
          ))}
        </div>

        {/* 通貨フィルター */}
        {currencies.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setCcy("all")}
              className={cn("text-[8px] font-mono px-2 py-0.5 border transition-all",
                ccy === "all"
                  ? "border-gray-600 text-gray-300 bg-gray-800/30"
                  : "border-[#1a2535] text-gray-700 hover:text-gray-500")}>
              ALL
            </button>
            {currencies.map(c => {
              const s = CCY_COLOR[c] ?? { text:"text-gray-400", bg:"bg-gray-800/20", border:"border-gray-700/30" };
              return (
                <button key={c} onClick={() => setCcy(p => p === c ? "all" : c)}
                  className={cn("text-[8px] font-mono font-bold px-2 py-0.5 border transition-all",
                    ccy === c ? `${s.text} ${s.bg} ${s.border}` : "border-[#1a2535] text-gray-700 hover:text-gray-500")}>
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── ステータスバー ── */}
      <div className="shrink-0 px-4 py-1.5 bg-[#04060c] border-b border-[#1a2535] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Clock size={9} className="text-gray-700 shrink-0"/>
          <span className="text-[9px] font-mono text-gray-600 truncate">
            {new Date(now).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false })} JST
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {meta?.source === "forex_factory" && (
            <span className="text-[8px] font-mono text-gray-700">
              📡 Forex Factory
            </span>
          )}
          {meta?.source === "none" && (
            <span className="text-[8px] font-mono text-red-500/70">
              ⚠ {meta.error ?? "取得エラー"}
            </span>
          )}
          {highAhead > 0 && (
            <span className="text-[8px] font-mono text-red-400 border border-red-800/40 px-2 py-0.5">
              ▲ HIGH {highAhead}
            </span>
          )}
        </div>
      </div>

      {/* ── イベントリスト ── */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-gray-600">
            <RefreshCw size={12} className="animate-spin"/>
            <span className="text-[10px] font-mono">読み込み中...</span>
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Calendar size={20} className="text-gray-800"/>
            <p className="text-[11px] text-gray-600 font-mono">
              {!meta || meta.source === "none"
                ? "経済指標データを取得できません"
                : range === "today" ? "本日の指標はありません"
                : "該当する指標なし"}
            </p>
          </div>
        ) : (
          <div className="pb-6">
            {grouped.map(([d, evs]) => (
              <DateSection key={d} dateStr={d} events={evs} now={now}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
