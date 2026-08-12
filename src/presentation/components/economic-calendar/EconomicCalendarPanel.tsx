"use client";

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/application/stores/settingsStore";
import { RefreshCw, AlertTriangle, AlertCircle, Info } from "lucide-react";

interface CalEvent {
  id:        string;
  time:      number;
  currency:  string;
  country:   string;
  title:     string;
  impact:    number;   // 1=low 2=med 3=high
  actual?:   string;
  forecast?: string;
  previous?: string;
}

// ── 英語イベント名 → 日本語訳 ──────────────────────────────────────
const JA: Record<string, string> = {
  // 米国
  "CPI m/m":                     "消費者物価 前月比",
  "Core CPI m/m":                "コアCPI 前月比",
  "CPI y/y":                     "消費者物価 前年比",
  "Core CPI y/y":                "コアCPI 前年比",
  "PPI m/m":                     "生産者物価 前月比",
  "Core PPI m/m":                "コアPPI 前月比",
  "Initial Jobless Claims":       "新規失業申請件数",
  "Unemployment Rate":            "失業率",
  "Non-Farm Payrolls":            "非農業部門雇用者数",
  "Average Hourly Earnings m/m":  "平均時給 前月比",
  "GDP q/q":                     "GDP 前期比",
  "Retail Sales m/m":            "小売売上高 前月比",
  "Core Retail Sales m/m":       "コア小売売上 前月比",
  "ISM Manufacturing PMI":       "ISM製造業PMI",
  "ISM Services PMI":            "ISMサービスPMI",
  "Fed Interest Rate Decision":  "FRB 政策金利決定",
  "FOMC Statement":              "FOMC 声明文",
  "FOMC Meeting Minutes":        "FOMC 議事録",
  "ADP Non-Farm Employment":     "ADP雇用変化",
  "Trade Balance":               "貿易収支",
  "Building Permits":            "建設許可件数",
  "Housing Starts":              "住宅着工件数",
  "Consumer Confidence":         "消費者信頼感指数",
  "CB Consumer Confidence":      "CB消費者信頼感",
  "Michigan Consumer Sentiment": "ミシガン消費者信頼感",
  "Durable Goods Orders m/m":    "耐久財受注 前月比",
  "Personal Spending m/m":       "個人支出 前月比",
  "PCE Price Index m/m":         "PCEコアデフレーター 前月比",
  "Core PCE Price Index m/m":    "コアPCE 前月比",
  // 欧州
  "ECB Interest Rate Decision":  "ECB 政策金利決定",
  "ECB Press Conference":        "ECB 記者会見",
  "ECB Meeting Accounts":        "ECB 議事録",
  "ECB Minutes":                 "ECB 議事録",
  "German CPI m/m":              "独 CPI 前月比",
  "German GDP q/q":              "独 GDP 前期比",
  "German IFO Business Climate": "独 IFO景況感",
  "EU CPI Flash y/y":            "EU CPI速報 前年比",
  "Flash Manufacturing PMI":     "製造業PMI速報",
  "Flash Services PMI":          "サービスPMI速報",
  // 日本
  "BoJ Interest Rate Decision":  "日銀 政策金利決定",
  "BoJ Rate Decision":           "日銀 政策金利決定",
  "BoJ Monetary Policy Statement": "日銀 金融政策声明",
  "BoJ Press Conference":        "日銀 総裁会見",
  "Tankan Manufacturing Index":  "日銀短観 製造業",
  "Tokyo CPI y/y":               "東京 CPI 前年比",
  "Japanese CPI y/y":            "日本 CPI 前年比",
  "Household Spending y/y":      "家計消費支出 前年比",
  // 英国
  "BoE Interest Rate Decision":  "BOE 政策金利決定",
  "BoE Rate Decision":           "BOE 政策金利決定",
  "BoE Minutes":                 "BOE 議事録",
  "UK CPI y/y":                  "英 CPI 前年比",
  "UK GDP q/q":                  "英 GDP 前期比",
  "UK Retail Sales m/m":         "英 小売売上高 前月比",
  // 汎用
  "Employment Change":           "雇用者数変化",
  "Manufacturing PMI":           "製造業PMI",
  "Services PMI":                "サービスPMI",
  "Composite PMI":               "総合PMI",
  "Interest Rate Decision":      "政策金利決定",
  "Press Conference":            "記者会見",
};

function translateTitle(title: string, currency: string): { ja: string; en: string } {
  // 完全一致を優先
  if (JA[title]) return { ja: JA[title], en: title };

  // 部分一致（短縮系に対応）
  for (const [en, ja] of Object.entries(JA)) {
    if (title.toLowerCase().includes(en.toLowerCase()) || en.toLowerCase().includes(title.toLowerCase())) {
      return { ja, en: title };
    }
  }

  // 翻訳なし → 英語そのまま
  return { ja: title, en: title };
}

function ImpactIcon({ level }: { level: number }) {
  if (level >= 3) return <AlertTriangle size={10} className="text-red-400 shrink-0" />;
  if (level === 2) return <AlertCircle  size={10} className="text-yellow-400 shrink-0" />;
  return              <Info           size={10} className="text-gray-600 shrink-0" />;
}

const CCY_COLOR: Record<string, string> = {
  USD: "text-green-400",  EUR: "text-blue-400",    JPY: "text-red-400",
  GBP: "text-yellow-400", AUD: "text-cyan-400",    CAD: "text-orange-400",
  CHF: "text-purple-400", NZD: "text-teal-400",    CNY: "text-rose-400",
};

const CCY_BG: Record<string, string> = {
  USD: "bg-green-900/20",  EUR: "bg-blue-900/20",  JPY: "bg-red-900/20",
  GBP: "bg-yellow-900/20", AUD: "bg-cyan-900/20",  CAD: "bg-orange-900/20",
  CHF: "bg-purple-900/20", NZD: "bg-teal-900/20",
};

const IMPACT_BAR: Record<number, string> = {
  1: "bg-gray-600",
  2: "bg-yellow-500",
  3: "bg-red-500",
};

export function EconomicCalendarPanel() {
  const [events,  setEvents]  = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter,  setFilter]  = useState<"all" | "high">("all");
  const { settings } = useSettingsStore();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const key = settings.twelveDataKey;
      const url = `/api/economic-calendar${key ? `?key=${key}` : ""}`;
      const res = await fetch(url);
      if (res.ok) setEvents(await res.json() as CalEvent[]);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [settings.twelveDataKey]);

  useEffect(() => { void load(); }, [load]);

  const now = Date.now() / 1000;
  const displayed = events
    .filter(e => filter === "high" ? e.impact >= 3 : true)
    .sort((a, b) => a.time - b.time);

  return (
    <div className="flex flex-col h-full bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#0d1520] shrink-0">
        <div className="w-0.5 h-3.5 bg-cyan-500/60"/>
        <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest flex-1 font-bold">
          経済指標
        </span>
        <button
          onClick={() => setFilter(f => f === "all" ? "high" : "all")}
          className={cn(
            "text-[8px] font-mono border px-1.5 py-0.5 transition-all",
            filter === "high"
              ? "border-red-700/50 text-red-400 bg-red-900/20"
              : "border-[#0d1520] text-gray-500 hover:text-gray-300"
          )}>
          {filter === "high" ? "高インパクト" : "全て"}
        </button>
        <button onClick={load} disabled={loading} className="text-gray-600 hover:text-gray-300 ml-1">
          <RefreshCw size={10} className={loading ? "animate-spin" : ""}/>
        </button>
      </div>

      {/* イベント一覧 */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {displayed.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[10px] text-gray-600 font-mono">
              {loading ? "読み込み中..." : "本日の指標はありません"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#0d1520]/60">
            {displayed.map(ev => {
              const isPast  = ev.time < now;
              const isNear  = !isPast && ev.time - now < 3600;
              const isNext  = !isPast && ev.time - now < 600; // 10分以内
              const timeStr = new Date(ev.time * 1000).toLocaleTimeString("ja-JP", {
                hour: "2-digit", minute: "2-digit",
              });
              const { ja: titleJa } = translateTitle(ev.title, ev.currency);
              const ccy = CCY_COLOR[ev.currency] ?? "text-gray-400";
              const ccyBg = CCY_BG[ev.currency] ?? "bg-gray-800/20";

              return (
                <div key={ev.id}
                  className={cn(
                    "px-2.5 py-2.5 transition-colors",
                    isPast  ? "opacity-35" : "",
                    isNext  ? "bg-red-900/15 border-l-2 border-red-500/60" :
                    isNear  ? "bg-yellow-900/10 border-l-2 border-yellow-600/40" :
                              "border-l-2 border-transparent hover:bg-[#0d1520]/40"
                  )}>

                  {/* 行1: 時刻 + 通貨バッジ + 重要度バー */}
                  <div className="flex items-center gap-2 mb-1.5">
                    {/* 時刻 */}
                    <span className={cn(
                      "text-[11px] font-mono font-bold shrink-0 tabular-nums",
                      isNext ? "text-red-300" : isNear ? "text-yellow-300" : "text-gray-300"
                    )}>
                      {timeStr}
                    </span>

                    {/* 通貨バッジ */}
                    <span className={cn(
                      "text-[8px] font-mono font-bold px-1.5 py-0.5 rounded-sm shrink-0",
                      ccy, ccyBg
                    )}>
                      {ev.currency}
                    </span>

                    {/* 重要度バー */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      {[1, 2, 3].map(i => (
                        <div key={i}
                          className={cn(
                            "w-1 h-3 rounded-sm transition-all",
                            i <= ev.impact ? IMPACT_BAR[ev.impact] : "bg-[#1a1d2e]"
                          )}/>
                      ))}
                    </div>

                    {/* ステータスバッジ */}
                    {isNext && (
                      <span className="text-[7px] font-mono font-bold text-red-400 border border-red-700/50 px-1 py-0.5 shrink-0"
                        style={{ animation: "avl-blink 1s ease-in-out infinite" }}>
                        まもなく
                      </span>
                    )}
                    {!isNext && isNear && (
                      <span className="text-[7px] font-mono text-yellow-400 border border-yellow-700/40 px-1 py-0.5 shrink-0">
                        予定
                      </span>
                    )}
                    {isPast && ev.actual && (
                      <span className="text-[7px] font-mono text-green-500/70 border border-green-800/30 px-1 py-0.5 shrink-0">
                        発表済
                      </span>
                    )}
                  </div>

                  {/* 行2: イベント名（日本語） */}
                  <p className={cn(
                    "text-[10px] font-semibold leading-snug mb-1",
                    isPast ? "text-gray-500" : "text-gray-200"
                  )}>
                    {titleJa}
                  </p>

                  {/* 行3: 予想・前回・実績 */}
                  {(ev.actual || ev.forecast || ev.previous) && (
                    <div className="flex items-center gap-3 mt-1">
                      {ev.forecast && (
                        <div className="flex items-center gap-1">
                          <span className="text-[8px] font-mono text-gray-600">予</span>
                          <span className="text-[9px] font-mono font-bold text-cyan-400 tabular-nums">
                            {ev.forecast}
                          </span>
                        </div>
                      )}
                      {ev.previous && (
                        <div className="flex items-center gap-1">
                          <span className="text-[8px] font-mono text-gray-600">前</span>
                          <span className="text-[9px] font-mono text-gray-500 tabular-nums">
                            {ev.previous}
                          </span>
                        </div>
                      )}
                      {ev.actual && (
                        <div className="flex items-center gap-1">
                          <span className="text-[8px] font-mono text-gray-600">実</span>
                          <span className={cn(
                            "text-[9px] font-mono font-bold tabular-nums",
                            ev.forecast && parseFloat(ev.actual) >= parseFloat(ev.forecast)
                              ? "text-green-400" : "text-red-400"
                          )}>
                            {ev.actual}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
