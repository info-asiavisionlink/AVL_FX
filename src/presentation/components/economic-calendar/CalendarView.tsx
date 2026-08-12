"use client";

// =================================================================
// CalendarView — AVL AI Economic Calendar (Full Page)
// =================================================================
//
// 機能:
//   - TODAY / TOMORROW / THIS WEEK タブ
//   - JST タイムゾーン基準
//   - 重要度フィルター / 通貨フィルター
//   - カウントダウン (T-Xm)
//   - PAST / UPCOMING / RELEASED 状態
//   - HIGH IMPACT 強調表示
//   - データソース状態表示
//   - demo/fallback data 禁止
// =================================================================

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSettingsStore }  from "@/application/stores/settingsStore";
import { cn }                from "@/lib/utils";
import { AlertTriangle, AlertCircle, Info, RefreshCw, Clock, Calendar } from "lucide-react";
import type { CalEvent, CalMeta } from "@/app/api/economic-calendar/route";

// ── 定数 ──────────────────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
const MONTHS_EN = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

const CCY_COLOR: Record<string, { text: string; bg: string; border: string }> = {
  USD: { text: "text-green-300",   bg: "bg-green-900/25",  border: "border-green-800/40" },
  EUR: { text: "text-blue-300",    bg: "bg-blue-900/25",   border: "border-blue-800/40"  },
  JPY: { text: "text-red-300",     bg: "bg-red-900/25",    border: "border-red-800/40"   },
  GBP: { text: "text-yellow-300",  bg: "bg-yellow-900/25", border: "border-yellow-800/40"},
  AUD: { text: "text-cyan-300",    bg: "bg-cyan-900/25",   border: "border-cyan-800/40"  },
  CAD: { text: "text-orange-300",  bg: "bg-orange-900/25", border: "border-orange-800/40"},
  CHF: { text: "text-purple-300",  bg: "bg-purple-900/25", border: "border-purple-800/40"},
  NZD: { text: "text-teal-300",    bg: "bg-teal-900/25",   border: "border-teal-800/40"  },
};

// 指標名日本語マッピング（主要なもの）
const JA: Record<string, string> = {
  "CPI m/m": "消費者物価 前月比", "CPI y/y": "消費者物価 前年比",
  "Core CPI m/m": "コアCPI 前月比", "Core CPI y/y": "コアCPI 前年比",
  "PPI m/m": "生産者物価 前月比",
  "Initial Jobless Claims": "新規失業申請件数",
  "Unemployment Rate": "失業率",
  "Non-Farm Payrolls": "非農業部門雇用者数",
  "Average Hourly Earnings m/m": "平均時給 前月比",
  "GDP q/q": "GDP 前期比", "GDP y/y": "GDP 前年比",
  "Retail Sales m/m": "小売売上高 前月比",
  "Core Retail Sales m/m": "コア小売売上 前月比",
  "ISM Manufacturing PMI": "ISM製造業PMI",
  "ISM Services PMI": "ISMサービスPMI",
  "Fed Interest Rate Decision": "FRB 政策金利",
  "FOMC Statement": "FOMC 声明",
  "FOMC Meeting Minutes": "FOMC 議事録",
  "ADP Non-Farm Employment": "ADP雇用変化",
  "Trade Balance": "貿易収支",
  "Building Permits": "建設許可件数",
  "Housing Starts": "住宅着工件数",
  "Consumer Confidence": "消費者信頼感",
  "CB Consumer Confidence": "CB消費者信頼感",
  "Michigan Consumer Sentiment": "ミシガン消費者信頼感",
  "Durable Goods Orders m/m": "耐久財受注 前月比",
  "PCE Price Index m/m": "PCEデフレーター 前月比",
  "Core PCE Price Index m/m": "コアPCE 前月比",
  "ECB Interest Rate Decision": "ECB 政策金利",
  "ECB Press Conference": "ECB 記者会見",
  "ECB Meeting Accounts": "ECB 議事録",
  "ECB Minutes": "ECB 議事録",
  "German CPI m/m": "独CPI 前月比",
  "German GDP q/q": "独GDP 前期比",
  "Flash Manufacturing PMI": "製造業PMI速報",
  "Flash Services PMI": "サービスPMI速報",
  "BoJ Interest Rate Decision": "日銀 政策金利",
  "BoJ Rate Decision": "日銀 政策金利",
  "BoJ Press Conference": "日銀総裁 会見",
  "Tankan Manufacturing Index": "日銀短観 製造業",
  "Tokyo CPI y/y": "東京CPI 前年比",
  "BoE Interest Rate Decision": "BOE 政策金利",
  "BoE Rate Decision": "BOE 政策金利",
  "BoE Minutes": "BOE 議事録",
  "UK CPI y/y": "英CPI 前年比",
  "Manufacturing PMI": "製造業PMI",
  "Services PMI": "サービスPMI",
  "Composite PMI": "総合PMI",
};

function translateTitle(title: string): string {
  if (JA[title]) return JA[title];
  for (const [en, ja] of Object.entries(JA)) {
    if (title.toLowerCase().includes(en.toLowerCase())) return ja;
  }
  return title;
}

// ── ユーティリティ ─────────────────────────────────────────────────

function toJSTDateStr(utcMs: number): string {
  return new Date(utcMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function fmtTimeJST(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("ja-JP", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
  });
}

function fmtDateHeader(dateStr: string, isToday: boolean, isTomorrow: boolean): {
  label: string; dayJa: string; dateEn: string;
} {
  const d  = new Date(dateStr + "T00:00:00+09:00");
  const mm = MONTHS_EN[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, "0");
  const dayJa = DAYS_JA[d.getDay()];
  return {
    label:  isToday ? "TODAY" : isTomorrow ? "TOMORROW" : `${mm} ${dd}`,
    dayJa,
    dateEn: `${d.getFullYear()}.${mm}.${dd} (${dayJa})`,
  };
}

function countdown(nowMs: number, eventSec: number): string | null {
  const diff = eventSec * 1000 - nowMs;
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
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    if (ev.time * 1000 < now) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ev.time, now]);

  const isPast   = ev.time * 1000 < now;
  const secLeft  = ev.time - tick / 1000;
  const isImm    = !isPast && secLeft < 600;    // 10分以内
  const isNear   = !isPast && secLeft < 3600;   // 1時間以内
  const isHigh   = ev.impact >= 3;
  const isMed    = ev.impact === 2;
  const cd       = !isPast ? countdown(tick, ev.time) : null;
  const released = isPast && ev.actual != null;
  const timeStr  = fmtTimeJST(ev.time);
  const titleJa  = translateTitle(ev.title);

  const ccy      = CCY_COLOR[ev.currency] ?? { text:"text-gray-400", bg:"bg-gray-800/20", border:"border-gray-700/30" };

  const impactColor = isHigh ? "#ef4444" : isMed ? "#f59e0b" : "#6b7280";
  const impactLabel = isHigh ? "HIGH" : isMed ? "MED" : "LOW";

  return (
    <div
      className={cn(
        "border-l-2 mb-2 rounded-r-sm transition-all cursor-pointer",
        isPast      ? "opacity-40 border-l-gray-700 bg-[#0a0d12]" :
        isImm       ? "border-l-red-500 bg-red-950/20" :
        isNear      ? "border-l-amber-500 bg-amber-950/10" :
        isHigh      ? "border-l-red-600 bg-[#0e0f18]" :
                      "border-l-[#1a2535] bg-[#0a0d12]"
      )}
      onClick={() => setOpen(o => !o)}
    >
      <div className="px-3 py-2.5">
        {/* Row 1: 時刻 + 通貨 + 重要度 + ステータス */}
        <div className="flex items-center gap-2 mb-2">
          {/* 時刻 */}
          <span className={cn(
            "text-[13px] font-black font-mono tabular-nums shrink-0",
            isPast ? "text-gray-600" :
            isImm  ? "text-red-300" :
            isNear ? "text-amber-300" : "text-gray-200"
          )}>
            {timeStr}
          </span>

          {/* 通貨バッジ */}
          <span className={cn(
            "text-[9px] font-mono font-bold px-2 py-0.5 border rounded-sm shrink-0",
            ccy.text, ccy.bg, ccy.border
          )}>
            {ev.currency}
          </span>

          {/* 重要度バー */}
          <div className="flex items-center gap-0.5 shrink-0">
            {[1, 2, 3].map(i => (
              <div key={i} className="w-1.5 h-3 rounded-[1px]"
                style={{ background: i <= ev.impact ? impactColor : "#1a2535" }}/>
            ))}
            <span className="text-[7px] font-mono ml-1" style={{ color: `${impactColor}90` }}>
              {impactLabel}
            </span>
          </div>

          <div className="flex-1"/>

          {/* ステータス / カウントダウン */}
          {released && (
            <span className="text-[8px] font-mono font-bold text-green-500 border border-green-800/40 px-1.5 py-0.5 shrink-0">
              発表済
            </span>
          )}
          {!isPast && !released && isImm && cd && (
            <span className="text-[8px] font-mono font-bold text-red-400 border border-red-700/50 px-1.5 py-0.5 shrink-0"
              style={{ animation: "avl-blink 1s ease-in-out infinite" }}>
              {cd}
            </span>
          )}
          {!isPast && !released && isNear && !isImm && cd && (
            <span className="text-[8px] font-mono text-amber-400/80 shrink-0">{cd}</span>
          )}
        </div>

        {/* Row 2: 指標名 */}
        <p className={cn(
          "text-[12px] font-semibold leading-tight mb-1",
          isPast ? "text-gray-500" : isHigh ? "text-white" : "text-gray-200"
        )}>
          {titleJa}
        </p>
        {titleJa !== ev.title && (
          <p className="text-[9px] text-gray-600 font-mono leading-none mb-1.5">{ev.title}</p>
        )}

        {/* Row 3: 予想/前回/実績 */}
        {(ev.forecast || ev.previous || ev.actual) && (
          <div className="flex items-center gap-4 mt-1.5">
            {ev.previous && (
              <div className="flex flex-col items-center">
                <span className="text-[7px] font-mono text-gray-600 mb-0.5">前回</span>
                <span className="text-[10px] font-mono tabular-nums text-gray-400">{ev.previous}</span>
              </div>
            )}
            {ev.forecast && (
              <div className="flex flex-col items-center">
                <span className="text-[7px] font-mono text-gray-600 mb-0.5">予想</span>
                <span className="text-[10px] font-mono tabular-nums text-cyan-400">{ev.forecast}</span>
              </div>
            )}
            <div className="flex flex-col items-center">
              <span className="text-[7px] font-mono text-gray-600 mb-0.5">結果</span>
              {ev.actual ? (
                <span className={cn(
                  "text-[11px] font-mono font-bold tabular-nums",
                  ev.forecast && !isNaN(parseFloat(ev.actual)) && !isNaN(parseFloat(ev.forecast))
                    ? parseFloat(ev.actual) >= parseFloat(ev.forecast)
                      ? "text-green-400" : "text-red-400"
                    : "text-gray-200"
                )}>
                  {ev.actual}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-gray-700">—</span>
              )}
            </div>
          </div>
        )}

        {/* 展開: 詳細 */}
        {open && (
          <div className="mt-2 pt-2 border-t border-[#1a2535] text-[9px] font-mono text-gray-600 space-y-0.5">
            <p>国: <span className="text-gray-400">{ev.country}</span></p>
            <p>UTC: <span className="text-gray-400">{new Date(ev.time * 1000).toISOString()}</span></p>
            <p>JST: <span className="text-gray-400">{new Date(ev.time * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</span></p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Date Section Header ──────────────────────────────────────────

function DateHeader({ dateStr, now }: { dateStr: string; now: number }) {
  const todayStr    = toJSTDateStr(now);
  const tomorrowStr = toJSTDateStr(now + 86400_000);
  const { label, dateEn } = fmtDateHeader(
    dateStr,
    dateStr === todayStr,
    dateStr === tomorrowStr,
  );

  return (
    <div className="sticky top-0 z-10 bg-[#050810] border-b border-[#1a2535] px-4 py-2 flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="w-0.5 h-5 bg-cyan-500/50"/>
        <div>
          <p className="text-[8px] font-mono text-cyan-500/60 tracking-[0.3em] leading-none">{label}</p>
          <p className="text-[11px] font-bold font-mono text-gray-300 leading-tight">{dateEn}</p>
        </div>
      </div>
    </div>
  );
}

// ── CalendarView (Main) ───────────────────────────────────────────

type RangeKey = "today" | "tomorrow" | "week";
type ImpactFilter = "all" | "high" | "medium";

export function CalendarView() {
  const { settings }         = useSettingsStore();
  const [range, setRange]    = useState<RangeKey>("today");
  const [impact, setImpact]  = useState<ImpactFilter>("all");
  const [ccyFilter, setCcy]  = useState<string>("all");
  const [events, setEvents]  = useState<CalEvent[]>([]);
  const [meta, setMeta]      = useState<CalMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow]        = useState(Date.now());

  // 1秒ごとにnow更新（カウントダウン用）
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const key = settings.twelveDataKey;
      const url = `/api/economic-calendar?range=${range}${key ? `&key=${key}` : ""}`;
      const res  = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: CalEvent[]; meta: CalMeta };
      setEvents(data.events ?? []);
      setMeta(data.meta ?? null);
    } catch (e) {
      console.error("[CalendarView]", e);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [range, settings.twelveDataKey]);

  useEffect(() => { void load(); }, [load]);

  // フィルタ後イベント
  const filtered = useMemo(() => {
    let ev = [...events];
    if (impact === "high")   ev = ev.filter(e => e.impact >= 3);
    if (impact === "medium") ev = ev.filter(e => e.impact >= 2);
    if (ccyFilter !== "all") ev = ev.filter(e => e.currency === ccyFilter);
    return ev.sort((a, b) => a.time - b.time);
  }, [events, impact, ccyFilter]);

  // 通貨一覧（データに存在するもののみ）
  const currencies = useMemo(() => {
    const set = new Set(events.map(e => e.currency));
    return Array.from(set).sort();
  }, [events]);

  // 日付ごとにグループ化
  const grouped = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const ev of filtered) {
      const d = toJSTDateStr(ev.time * 1000);
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(ev);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const todayStr = toJSTDateStr(now);

  const highCount = events.filter(e => e.impact >= 3 && e.time * 1000 > now).length;

  return (
    <div className="flex flex-col h-full bg-[#050810] text-gray-100">

      {/* ── ヘッダー ── */}
      <div className="shrink-0 border-b border-[#1a2535] bg-[#03050d] px-4 py-3">
        <div className="flex items-center gap-3 mb-3">
          <Calendar size={14} className="text-cyan-500/70"/>
          <div>
            <p className="text-[8px] font-mono text-cyan-500/60 tracking-[0.3em] leading-none">AVL AI</p>
            <p className="text-[13px] font-black font-mono tracking-wider text-cyan-300 leading-none">
              ECONOMIC CALENDAR
            </p>
          </div>
          <div className="flex-1"/>
          <button onClick={load} disabled={loading}
            className="text-gray-600 hover:text-gray-300 transition-colors p-1">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""}/>
          </button>
        </div>

        {/* Range タブ */}
        <div className="flex gap-1 mb-2">
          {(["today", "tomorrow", "week"] as RangeKey[]).map(r => (
            <button key={r}
              onClick={() => setRange(r)}
              className={cn(
                "text-[9px] font-mono font-bold px-3 py-1 border transition-all",
                range === r
                  ? "border-cyan-700/60 text-cyan-300 bg-cyan-900/20"
                  : "border-[#1a2535] text-gray-600 hover:text-gray-400"
              )}>
              {r === "today" ? "今日" : r === "tomorrow" ? "明日" : "今週"}
            </button>
          ))}
        </div>

        {/* 重要度フィルター */}
        <div className="flex gap-1 mb-2">
          {(["all", "high", "medium"] as ImpactFilter[]).map(f => (
            <button key={f}
              onClick={() => setImpact(f)}
              className={cn(
                "text-[8px] font-mono px-2 py-0.5 border transition-all",
                impact === f
                  ? f === "high"   ? "border-red-700/60 text-red-400 bg-red-900/15"
                  : f === "medium" ? "border-amber-700/60 text-amber-400 bg-amber-900/15"
                  :                  "border-cyan-700/60 text-cyan-400 bg-cyan-900/15"
                  : "border-[#1a2535] text-gray-700 hover:text-gray-500"
              )}>
              {f === "all" ? "全て" : f === "high" ? "高" : "中以上"}
            </button>
          ))}
        </div>

        {/* 通貨フィルター */}
        {currencies.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setCcy("all")}
              className={cn(
                "text-[8px] font-mono px-2 py-0.5 border transition-all",
                ccyFilter === "all"
                  ? "border-gray-600 text-gray-300 bg-gray-800/30"
                  : "border-[#1a2535] text-gray-700 hover:text-gray-500"
              )}>ALL</button>
            {currencies.map(c => {
              const s = CCY_COLOR[c] ?? { text:"text-gray-400", bg:"bg-gray-800/20", border:"border-gray-700/30" };
              return (
                <button key={c} onClick={() => setCcy(prev => prev === c ? "all" : c)}
                  className={cn(
                    "text-[8px] font-mono font-bold px-2 py-0.5 border transition-all",
                    ccyFilter === c ? [s.text, s.bg, s.border].join(" ") : "border-[#1a2535] text-gray-700 hover:text-gray-500"
                  )}>
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 本日日付バー ── */}
      <div className="shrink-0 px-4 py-1.5 bg-[#04060c] border-b border-[#1a2535] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock size={10} className="text-gray-700"/>
          <span className="text-[9px] font-mono text-gray-600">
            {new Date(now).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false })} JST
          </span>
        </div>
        {highCount > 0 && (
          <span className="text-[8px] font-mono text-red-400 border border-red-800/40 px-2 py-0.5">
            ▲ HIGH {highCount}件
          </span>
        )}
      </div>

      {/* ── データソース状態 ── */}
      {meta && (
        <div className={cn(
          "shrink-0 px-4 py-1 border-b text-[8px] font-mono flex items-center gap-2",
          meta.source === "none"
            ? "border-red-900/30 bg-red-950/10 text-red-500/70"
            : "border-[#1a2535] text-gray-700"
        )}>
          <span>{meta.source === "twelve_data" ? "📡 Twelve Data" : "⚠ データソース未接続"}</span>
          {meta.error && <span className="text-red-500/60">— {meta.error}</span>}
          {meta.source === "twelve_data" && (
            <span>· 取得: {new Date(meta.fetchedAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} JST</span>
          )}
        </div>
      )}

      {/* ── イベント一覧 ── */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="flex items-center gap-2 text-gray-600">
              <RefreshCw size={12} className="animate-spin"/>
              <span className="text-[10px] font-mono">読み込み中...</span>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Calendar size={20} className="text-gray-800"/>
            <div className="text-center">
              <p className="text-[11px] text-gray-600 font-mono">
                {meta?.source === "none"
                  ? "経済指標データを取得できません"
                  : range === "today"
                  ? `${todayStr} (JST) の指標なし`
                  : "該当する指標なし"}
              </p>
              {meta?.source === "none" && (
                <p className="text-[9px] text-gray-800 font-mono mt-1">
                  設定から Twelve Data API キーを設定してください
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="pb-4">
            {grouped.map(([dateStr, evs]) => (
              <div key={dateStr}>
                <DateHeader dateStr={dateStr} now={now}/>
                <div className="px-3 pt-2">
                  {evs.map(ev => <EventCard key={ev.id} ev={ev} now={now}/>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
