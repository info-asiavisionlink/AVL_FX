"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { useAIOSStore }       from "@/application/stores/aiOSStore";
import { Download, RefreshCw, Filter, TrendingUp, TrendingDown } from "lucide-react";

interface HistoryDeal {
  ticket:     number;
  symbol:     string;
  type:       number;  // 0=BUY, 1=SELL
  volume:     number;
  closeTime:  number;
  closePrice: number;
  profit:     number;
  swap:       number;
  commission: number;
  magic:      number;
  receivedAt?: number;
}

interface Stats {
  total:    number;
  wins:     number;
  losses:   number;
  winRate:  number;
  totalPL:  number;
  avgWin:   number;
  avgLoss:  number;
  maxWin:   number;
  maxLoss:  number;
  profitFactor: number;
}

function calcStats(deals: HistoryDeal[]): Stats {
  const wins   = deals.filter(d => d.profit > 0);
  const losses = deals.filter(d => d.profit < 0);
  const gross  = wins.reduce((s, d) => s + d.profit, 0);
  const loss   = Math.abs(losses.reduce((s, d) => s + d.profit, 0));
  return {
    total:    deals.length,
    wins:     wins.length,
    losses:   losses.length,
    winRate:  deals.length > 0 ? (wins.length / deals.length) * 100 : 0,
    totalPL:  deals.reduce((s, d) => s + d.profit + d.swap + d.commission, 0),
    avgWin:   wins.length > 0 ? gross / wins.length : 0,
    avgLoss:  losses.length > 0 ? loss / losses.length : 0,
    maxWin:   wins.length > 0 ? Math.max(...wins.map(d => d.profit)) : 0,
    maxLoss:  losses.length > 0 ? Math.max(...losses.map(d => Math.abs(d.profit))) : 0,
    profitFactor: loss > 0 ? gross / loss : 0,
  };
}

// 小型バーチャート（日次P&L）
function PnlChart({ deals }: { deals: HistoryDeal[] }) {
  if (deals.length === 0) return null;
  // 日次集計
  const daily: Record<string, number> = {};
  deals.forEach(d => {
    const day = new Date(d.closeTime * 1000).toLocaleDateString("ja-JP");
    daily[day] = (daily[day] ?? 0) + d.profit;
  });
  const days = Object.keys(daily).slice(-14); // 直近14日
  const vals = days.map(d => daily[d]);
  const max  = Math.max(...vals.map(Math.abs), 1);

  return (
    <div className="flex items-end gap-0.5 h-12">
      {days.map((day, i) => {
        const v    = vals[i];
        const h    = Math.max(2, Math.abs(v) / max * 40);
        const pos  = v >= 0;
        return (
          <div key={day} className="flex flex-col items-center gap-0.5 flex-1" title={`${day}: ${v.toFixed(2)}`}>
            {pos && <div className="bg-green-500/70 w-full" style={{ height: h }} />}
            <div className="h-px w-full bg-gray-700" />
            {!pos && <div className="bg-red-500/70 w-full" style={{ height: h }} />}
          </div>
        );
      })}
    </div>
  );
}

export function HistoryView() {
  const { status }  = useConnectionStore();
  const { aiLogs }  = useAIOSStore();
  const [deals,     setDeals]   = useState<HistoryDeal[]>([]);
  const [loading,   setLoading] = useState(false);
  const [error,     setError]   = useState<string | null>(null);
  const [filter,    setFilter]  = useState<"all" | "buy" | "sell" | "profit" | "loss">("all");
  const [symbol,    setSymbol]  = useState("EURUSD");

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mt5/history?symbol=${symbol}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json() as HistoryDeal[];
      setDeals(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setDeals([]);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (status === "connected") fetchHistory();
  }, [status, fetchHistory]);

  const displayed = deals.filter(d => {
    if (filter === "buy")    return d.type === 0;
    if (filter === "sell")   return d.type === 1;
    if (filter === "profit") return d.profit > 0;
    if (filter === "loss")   return d.profit < 0;
    return true;
  });

  const stats    = calcStats(deals);
  const aiOrders = aiLogs.filter(l => l.type === "order" || l.type === "signal");

  const handleDownload = () => {
    const csv = ["Ticket,Symbol,Type,Volume,CloseTime,ClosePrice,Profit,Swap,Commission",
      ...displayed.map(d =>
        `${d.ticket},${d.symbol},${d.type===0?"BUY":"SELL"},${d.volume},${new Date(d.closeTime*1000).toLocaleString("ja-JP")},${d.closePrice},${d.profit.toFixed(2)},${d.swap.toFixed(2)},${d.commission.toFixed(2)}`
      )
    ].join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
      download: `avl_history_${symbol}_${Date.now()}.csv`,
    });
    a.click();
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 pt-12 md:pt-4 bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">TRADE HISTORY</span>
        </div>

        {/* シンボル */}
        <select value={symbol} onChange={e => setSymbol(e.target.value)}
          className="bg-[#060a12] border border-[#0d1520] text-gray-300 text-[8px] font-mono px-2 py-0.5 focus:outline-none focus:border-cyan-700/50">
          {["EURUSD","USDJPY","GBPUSD","AUDUSD","XAUUSD"].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* フィルター */}
        <div className="flex gap-1">
          {(["all","buy","sell","profit","loss"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-2 py-0.5 text-[7px] font-mono border transition-all",
                filter === f ? "border-cyan-600/50 text-cyan-400 bg-cyan-900/20" : "border-[#0d1520] text-gray-700 hover:text-gray-400"
              )}>
              <Filter size={7} className="inline mr-0.5" />{f.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex gap-1.5 ml-auto">
          <button onClick={fetchHistory} disabled={loading}
            className="text-gray-600 hover:text-gray-300">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={handleDownload} disabled={deals.length === 0}
            className="text-gray-600 hover:text-gray-300 disabled:opacity-30">
            <Download size={11} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* 左: 統計 + チャート + テーブル */}
        <div className="flex flex-col flex-1 overflow-hidden gap-2">

          {/* 統計カード */}
          {deals.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5 shrink-0">
              {[
                { label: "Total", value: stats.total, color: "text-gray-300" },
                { label: "Win Rate", value: stats.winRate.toFixed(1) + "%", color: stats.winRate >= 50 ? "text-green-400" : "text-red-400" },
                { label: "P&L", value: (stats.totalPL >= 0 ? "+" : "") + stats.totalPL.toFixed(2), color: stats.totalPL >= 0 ? "text-green-400" : "text-red-400" },
                { label: "PF", value: stats.profitFactor.toFixed(2), color: stats.profitFactor >= 1.5 ? "text-green-400" : stats.profitFactor >= 1 ? "text-yellow-400" : "text-red-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="border border-[#0d1520] bg-[#060a12] p-2 text-center">
                  <p className="text-[7px] text-gray-700 font-mono">{label}</p>
                  <p className={cn("text-[10px] font-mono font-semibold", color)}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* P&L バーチャート */}
          {deals.length > 0 && (
            <div className="border border-[#0d1520] bg-[#060a12] p-2 shrink-0">
              <p className="text-[7px] text-gray-700 font-mono mb-1">Daily P&L (Last 14 days)</p>
              <PnlChart deals={deals} />
            </div>
          )}

          {/* テーブル */}
          <div className="flex-1 overflow-hidden border border-[#0d1520] bg-[#060a12]">
            {error ? (
              <div className="p-4 text-center">
                <p className="text-[9px] text-yellow-400 font-mono">
                  {status === "connected"
                    ? "履歴データ未受信。EA を再アタッチすると履歴が送信されます。"
                    : "MT5 に接続してください"
                  }
                </p>
                {error && <p className="text-[7px] text-gray-700 font-mono mt-1">{error}</p>}
              </div>
            ) : deals.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-[10px] text-gray-600 font-mono">
                  {loading ? "履歴を取得中..." : "取引履歴がありません（EA が履歴ストリームを送信するまでお待ちください）"}
                </p>
              </div>
            ) : (
              <div className="overflow-y-auto h-full">
                <table className="w-full text-[8px] font-mono">
                  <thead className="sticky top-0 bg-[#0d1520]">
                    <tr>
                      {["Ticket","Type","Vol","Close Time","Price","Profit","Net"].map(h => (
                        <th key={h} className="px-2 py-1.5 text-left text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((d) => {
                      const net = d.profit + d.swap + d.commission;
                      return (
                        <tr key={d.ticket} className="border-t border-[#0d1520]/50 hover:bg-[#0d1520]/30">
                          <td className="px-2 py-1 text-gray-700">{d.ticket}</td>
                          <td className={cn("px-2 py-1 font-semibold flex items-center gap-1", d.type===0?"text-green-400":"text-red-400")}>
                            {d.type===0 ? <TrendingUp size={8}/> : <TrendingDown size={8}/>}
                            {d.type===0?"BUY":"SELL"}
                          </td>
                          <td className="px-2 py-1 text-gray-400">{d.volume.toFixed(2)}</td>
                          <td className="px-2 py-1 text-gray-600">{new Date(d.closeTime*1000).toLocaleString("ja-JP",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
                          <td className="px-2 py-1 text-white">{d.closePrice.toFixed(5)}</td>
                          <td className={cn("px-2 py-1 font-semibold", d.profit>=0?"text-green-400":"text-red-400")}>{d.profit>=0?"+":""}{d.profit.toFixed(2)}</td>
                          <td className={cn("px-2 py-1", net>=0?"text-green-300":"text-red-300")}>{net>=0?"+":""}{net.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 右: AI注文ログ */}
        <div className="w-52 shrink-0 border border-[#0d1520] bg-[#060a12] p-2.5 overflow-y-auto">
          <p className="text-[8px] text-purple-500/70 font-mono tracking-widest mb-2">AI ORDER LOG</p>
          {aiOrders.length === 0 ? (
            <p className="text-[7px] text-gray-800 font-mono">AI 注文ログなし</p>
          ) : (
            <div className="space-y-1.5">
              {[...aiOrders].reverse().map(log => (
                <div key={log.id} className={cn("border p-1.5 text-[7px] font-mono",
                  log.type==="order" ? "border-orange-800/30 bg-orange-950/10 text-orange-300" : "border-cyan-800/30 bg-cyan-950/10 text-cyan-300"
                )}>
                  <p className="text-gray-700 text-[6px]">{new Date(log.ts).toLocaleString("ja-JP")}</p>
                  <p className="leading-snug">{log.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
