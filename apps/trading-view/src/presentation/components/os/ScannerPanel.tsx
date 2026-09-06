"use client";

// =================================================================
// ScannerPanel — マルチシンボル Opportunity Scanner ダッシュボード
//
// ┌─────────┬─────────┬───────────┬────────┬─────────┐
// │ SYMBOL  │ SIGNAL  │ CONF      │ DATA   │ STATUS  │
// ├─────────┼─────────┼───────────┼────────┼─────────┤
// │ EURUSD  │ BUY     │ 45        │ 95     │ READY   │
// │ USDJPY  │ WAIT    │ --        │ 35     │ NO DATA │
// └─────────┴─────────┴───────────┴────────┴─────────┘
// =================================================================

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Scan, Play, RefreshCw, TrendingUp, TrendingDown, Minus,
         AlertCircle, CheckCircle, Shield, Activity } from "lucide-react";
import type { ScanResult, ScanOpportunity } from "@/app/api/ai/brain/scan/route";

interface ScannerPanelProps {
  defaultSymbols?: string[];
}

type ScanStatus = "idle" | "scanning" | "done" | "error";

export function ScannerPanel({ defaultSymbols }: ScannerPanelProps) {
  const [status,  setStatus]  = useState<ScanStatus>("idle");
  const [result,  setResult]  = useState<ScanResult | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  const symbols = defaultSymbols ?? [
    "EURUSD","USDJPY","GBPUSD","GOLD","AUDUSD","USDCAD",
    "EURJPY","GBPJPY","NZDUSD","USDCHF",
  ];

  const runScan = useCallback(async () => {
    setStatus("scanning");
    setError(null);
    try {
      const res = await fetch("/api/ai/brain/scan", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbols, maxResults: 20 }),
      });
      if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
      const data = await res.json() as ScanResult;
      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [symbols]);

  const dirColor = (d: string) =>
    d === "BUY" ? "text-green-400" : d === "SELL" ? "text-red-400" : "text-gray-600";
  const dirIcon  = (d: string) =>
    d === "BUY"  ? <TrendingUp size={9} className="text-green-400"/> :
    d === "SELL" ? <TrendingDown size={9} className="text-red-400"/> :
                   <Minus size={9} className="text-gray-600"/>;

  const dqColor = (n: number) =>
    n >= 75 ? "text-green-400" : n >= 50 ? "text-yellow-400" : "text-red-400";

  const dqBar = (n: number) => (
    <div className="w-full h-1 bg-[#0d1520] rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all",
        n >= 75 ? "bg-green-500" : n >= 50 ? "bg-yellow-500" : "bg-red-500"
      )} style={{ width: `${n}%` }} />
    </div>
  );

  const priorityBadge = (p: ScanOpportunity["priority"]) => {
    const cls =
      p === "HIGH"   ? "border-green-700/50 text-green-300 bg-green-950/20" :
      p === "MEDIUM" ? "border-yellow-700/50 text-yellow-300 bg-yellow-950/20" :
      p === "LOW"    ? "border-gray-700/50 text-gray-500" :
                       "border-[#0d1520] text-gray-700";
    return <span className={cn("text-[6px] font-mono border px-1 py-0.5 tracking-wider", cls)}>{p}</span>;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-900/20 bg-[#05070A] shrink-0">
        <div className="flex items-center gap-2">
          <Scan size={10} className="text-cyan-400/60"/>
          <span className="text-[9px] font-mono tracking-wider text-cyan-400/80">OPPORTUNITY SCANNER</span>
          <span className="text-[7px] font-mono border border-yellow-700/40 text-yellow-400 px-1.5 py-0.5">DRY RUN</span>
        </div>
        <button onClick={runScan} disabled={status === "scanning"}
          className={cn("flex items-center gap-1.5 px-3 py-1 text-[8px] font-mono border transition-all",
            status === "scanning"
              ? "border-purple-700/50 text-purple-300 cursor-wait"
              : "border-cyan-700/40 text-cyan-400 hover:bg-cyan-900/20"
          )}>
          {status === "scanning"
            ? <><Scan size={8} className="animate-spin"/> SCANNING...</>
            : <><Play size={8}/> SCAN {symbols.length} SYMBOLS</>}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="border-b border-red-700/30 bg-red-950/10 px-3 py-1.5 shrink-0">
          <p className="text-[7px] font-mono text-red-400">
            <AlertCircle size={8} className="inline mr-1"/>{error}
          </p>
        </div>
      )}

      {/* Idle state */}
      {status === "idle" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-6">
          <Scan size={28} className="text-gray-800"/>
          <div>
            <p className="text-[9px] font-mono text-gray-600">SCAN ボタンで {symbols.length} シンボルを分析</p>
            <p className="text-[7.5px] font-mono text-gray-700 mt-1">
              データ品質スコア付きランキングを生成します
            </p>
          </div>
        </div>
      )}

      {/* Results */}
      {result && status === "done" && (
        <div className="flex-1 overflow-y-auto avl-scroll">

          {/* Summary bar */}
          <div className="px-3 py-2 border-b border-cyan-900/15 bg-[#03050a] shrink-0">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[7px] font-mono text-cyan-400/50">
                {new Date(result.timestamp).toLocaleTimeString("ja-JP")} — {result.scanned} symbols scanned
              </p>
              <button onClick={runScan} className="text-gray-700 hover:text-gray-400 transition-colors">
                <RefreshCw size={9}/>
              </button>
            </div>
            <p className="text-[7.5px] font-mono text-gray-400">{result.summary}</p>
          </div>

          {/* Best opportunity highlight */}
          {result.best && (
            <div className={cn("mx-3 my-2 border p-2.5",
              result.best.direction === "BUY"
                ? "border-green-700/40 bg-green-950/10"
                : "border-red-700/40 bg-red-950/10"
            )}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[7px] font-mono text-gray-600 tracking-wider">BEST OPPORTUNITY</span>
                {priorityBadge(result.best.priority)}
              </div>
              <div className="flex items-center gap-2">
                {dirIcon(result.best.direction)}
                <span className={cn("text-[13px] font-mono font-bold", dirColor(result.best.direction))}>
                  {result.best.symbol}
                </span>
                <span className={cn("text-[10px] font-mono font-semibold", dirColor(result.best.direction))}>
                  {result.best.direction}
                </span>
                <span className="text-[8px] text-gray-600 ml-auto">conf={result.best.confidence}</span>
              </div>
              {result.best.entry && (
                <div className="flex gap-3 mt-1.5 text-[7px] font-mono">
                  <span className="text-gray-700">ENTRY <span className="text-white">{result.best.entry?.toFixed(5)}</span></span>
                  <span className="text-gray-700">SL <span className="text-red-400">{result.best.sl?.toFixed(5)}</span></span>
                  <span className="text-gray-700">TP <span className="text-green-400">{result.best.tp?.toFixed(5)}</span></span>
                  <span className="text-gray-700">RR <span className="text-cyan-400">{result.best.rr}</span></span>
                </div>
              )}
              <p className="text-[6.5px] font-mono text-gray-600 mt-1">{result.best.reason}</p>
            </div>
          )}

          {/* Ranking Table */}
          <div className="px-3 pb-2">
            <p className="text-[7px] font-mono text-cyan-400/40 tracking-wider mb-1.5">RANKING TABLE</p>
            <div className="border border-[#0d1520] overflow-hidden">
              {/* Header */}
              <div className="grid grid-cols-12 gap-0 bg-[#030508] border-b border-[#0d1520] px-2 py-1">
                {["#","SYMBOL","SIGNAL","CONF","DATA QUALITY","STATUS"].map((h, i) => (
                  <div key={h} className={cn("text-[6.5px] font-mono text-gray-700 tracking-wider",
                    i === 0 ? "col-span-1" : i === 1 ? "col-span-2" : i === 2 ? "col-span-2" :
                    i === 3 ? "col-span-1" : i === 4 ? "col-span-3" : "col-span-3"
                  )}>{h}</div>
                ))}
              </div>

              {/* All opportunities + skipped */}
              {[...result.opportunities, ...result.skipped].map((o) => {
                const isActionable = !o.skipped && o.direction !== "WAIT" && o.setup_quality !== "INSUFFICIENT";
                return (
                  <div key={o.symbol}
                    className={cn(
                      "grid grid-cols-12 gap-0 px-2 py-1 border-b border-[#080c14] transition-colors",
                      isActionable
                        ? o.direction === "BUY" ? "bg-green-950/8" : "bg-red-950/8"
                        : ""
                    )}>
                    {/* Rank */}
                    <div className="col-span-1 text-[7px] font-mono text-gray-700 self-center">
                      {o.skipped ? "—" : o.rank}
                    </div>
                    {/* Symbol */}
                    <div className="col-span-2 text-[8px] font-mono font-semibold text-gray-200 self-center">
                      {o.symbol}
                    </div>
                    {/* Signal */}
                    <div className="col-span-2 self-center">
                      <div className="flex items-center gap-0.5">
                        {dirIcon(o.direction)}
                        <span className={cn("text-[7.5px] font-mono font-bold", dirColor(o.direction))}>
                          {o.skipped ? "—" : o.direction}
                        </span>
                      </div>
                    </div>
                    {/* Confidence */}
                    <div className="col-span-1 text-[7.5px] font-mono self-center">
                      {o.skipped || o.direction === "WAIT"
                        ? <span className="text-gray-700">—</span>
                        : <span className={o.confidence >= 50 ? "text-cyan-400" : "text-gray-500"}>{o.confidence}</span>
                      }
                    </div>
                    {/* Data Quality */}
                    <div className="col-span-3 self-center pr-2">
                      <div className="flex items-center gap-1">
                        <span className={cn("text-[7px] font-mono w-6 text-right shrink-0", dqColor(o.dataQuality))}>
                          {o.dataQuality}
                        </span>
                        {dqBar(o.dataQuality)}
                      </div>
                    </div>
                    {/* Status */}
                    <div className="col-span-3 self-center">
                      {o.skipped ? (
                        <span className="text-[6.5px] font-mono text-red-400/70 flex items-center gap-0.5">
                          <AlertCircle size={7}/> NO DATA
                        </span>
                      ) : isActionable ? (
                        <span className="text-[6.5px] font-mono text-green-400/80 flex items-center gap-0.5">
                          <CheckCircle size={7}/> READY
                        </span>
                      ) : (
                        <span className="text-[6.5px] font-mono text-gray-600">WAIT</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Notes section */}
            {result.skipped.length > 0 && (
              <div className="mt-2 border border-yellow-900/20 bg-yellow-950/10 p-2">
                <div className="flex items-center gap-1 mb-1">
                  <Activity size={7} className="text-yellow-500/60"/>
                  <p className="text-[6.5px] font-mono text-yellow-500/60">
                    {result.skipped.length} SYMBOLS SKIPPED — EA not attached to charts
                  </p>
                </div>
                <p className="text-[6px] font-mono text-gray-700 leading-relaxed">
                  {result.skipped.slice(0,5).map(s => s.symbol).join(", ")}
                  {result.skipped.length > 5 ? ` + ${result.skipped.length-5} more` : ""}
                </p>
                <p className="text-[6px] font-mono text-gray-800 mt-0.5">
                  → MT5でそれぞれのチャートにAVL_DataManager_v2をアタッチしてください
                </p>
              </div>
            )}

            <div className="mt-2 border border-[#0d1520] p-2">
              <div className="flex items-center gap-1 mb-0.5">
                <Shield size={7} className="text-gray-700"/>
                <p className="text-[6.5px] font-mono text-gray-700">SAFETY: {result.note}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
