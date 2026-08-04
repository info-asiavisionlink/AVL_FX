"use client";

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/application/stores/settingsStore";
import { RefreshCw, AlertTriangle, AlertCircle, Info } from "lucide-react";

interface CalEvent {
  id:       string;
  time:     number;
  currency: string;
  country:  string;
  title:    string;
  impact:   number;   // 1=low 2=med 3=high
  actual?:  string;
  forecast?: string;
  previous?: string;
}

function ImpactIcon({ level }: { level: number }) {
  if (level >= 3) return <AlertTriangle size={9} className="text-red-400" />;
  if (level === 2) return <AlertCircle  size={9} className="text-yellow-400" />;
  return              <Info           size={9} className="text-gray-600" />;
}

const CCY_COLOR: Record<string, string> = {
  USD: "text-green-400", EUR: "text-blue-400", JPY: "text-red-400",
  GBP: "text-yellow-400", AUD: "text-cyan-400", CAD: "text-orange-400",
  CHF: "text-purple-400", NZD: "text-teal-400",
};

export function EconomicCalendarPanel() {
  const [events,  setEvents]  = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter,  setFilter]  = useState<"all"|"high">("all");
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

  const now      = Date.now() / 1000;
  const displayed = events
    .filter(e => filter === "high" ? e.impact >= 3 : true)
    .sort((a, b) => a.time - b.time);

  return (
    <div className="flex flex-col h-full bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#0d1520] shrink-0">
        <div className="w-0.5 h-3 bg-cyan-500/60" />
        <span className="text-[8px] text-cyan-500/70 font-mono tracking-widest flex-1">ECONOMIC CALENDAR</span>
        <button
          onClick={() => setFilter(f => f === "all" ? "high" : "all")}
          className={cn("text-[7px] font-mono border px-1.5 py-0.5 transition-all",
            filter === "high"
              ? "border-red-700/50 text-red-400 bg-red-900/20"
              : "border-[#0d1520] text-gray-600 hover:text-gray-400"
          )}>
          {filter === "high" ? "HIGH IMPACT" : "ALL"}
        </button>
        <button onClick={load} disabled={loading} className="text-gray-600 hover:text-gray-300">
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* イベント一覧 */}
      <div className="flex-1 overflow-y-auto">
        {displayed.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[9px] text-gray-700 font-mono">
              {loading ? "読み込み中..." : "本日の経済指標はありません"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#0d1520]/50">
            {displayed.map(ev => {
              const isPast   = ev.time < now;
              const isNear   = !isPast && ev.time - now < 3600;
              const timeStr  = new Date(ev.time * 1000).toLocaleTimeString("ja-JP", {
                hour: "2-digit", minute: "2-digit",
              });
              return (
                <div key={ev.id}
                  className={cn("px-3 py-2 flex gap-2 items-start",
                    isPast  ? "opacity-40" : "",
                    isNear  ? "bg-yellow-900/10" : "hover:bg-[#0d1520]/30"
                  )}>
                  {/* 時刻・インパクト */}
                  <div className="shrink-0 w-14 text-right">
                    <p className={cn("text-[9px] font-mono font-semibold",
                      isNear ? "text-yellow-400" : "text-gray-400"
                    )}>{timeStr}</p>
                    <div className="flex justify-end mt-0.5">
                      <ImpactIcon level={ev.impact} />
                    </div>
                  </div>

                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className={cn("text-[8px] font-mono font-bold",
                        CCY_COLOR[ev.currency] ?? "text-gray-400"
                      )}>{ev.currency}</span>
                      {isNear && (
                        <span className="text-[6px] text-yellow-400 font-mono border border-yellow-700/50 px-1">
                          UPCOMING
                        </span>
                      )}
                      {isPast && ev.actual && (
                        <span className="text-[6px] text-green-400 font-mono border border-green-800/30 px-1">
                          RELEASED
                        </span>
                      )}
                    </div>
                    <p className="text-[8px] text-gray-300 font-mono leading-tight truncate">{ev.title}</p>
                    {(ev.actual || ev.forecast || ev.previous) && (
                      <div className="flex gap-2 mt-1 text-[7px] font-mono">
                        {ev.actual   && <span className="text-green-400">実: {ev.actual}</span>}
                        {ev.forecast && <span className="text-cyan-500/70">予: {ev.forecast}</span>}
                        {ev.previous && <span className="text-gray-600">前: {ev.previous}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
