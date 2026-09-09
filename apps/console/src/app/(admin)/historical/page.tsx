import { getAdminSupabase } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface BarStat {
  symbol: string;
  timeframe: string;
  bar_count: number;
  oldest_bar: string;
  newest_bar: string;
}

async function getHistoricalStats(): Promise<BarStat[]> {
  try {
    const sb = await getAdminSupabase();
    // RPC関数でGROUP BY集計 — 全2M行をクライアントに引かずにDBで集計
    const { data, error } = await sb.rpc("get_bar_stats");
    if (error) throw error;
    return (data as BarStat[]) ?? [];
  } catch {
    return [];
  }
}

const TF_ORDER = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

function DataStatus({ newestStr }: { newestStr: string }) {
  const diff = (Date.now() - new Date(newestStr).getTime()) / 3600_000;
  if (diff < 1)   return <span className="text-[9px] px-2 py-0.5 rounded font-black" style={{ background:"rgba(0,255,136,0.15)", color:"#00ff88" }}>最新</span>;
  if (diff < 24)  return <span className="text-[9px] px-2 py-0.5 rounded font-black" style={{ background:"rgba(0,255,136,0.08)", color:"#00ff88" }}>当日</span>;
  if (diff < 168) return <span className="text-[9px] px-2 py-0.5 rounded font-black" style={{ background:"rgba(251,191,36,0.1)", color:"#fbbf24" }}>今週</span>;
  return <span className="text-[9px] px-2 py-0.5 rounded font-black" style={{ background:"rgba(248,113,113,0.1)", color:"#f87171" }}>古い</span>;
}

export default async function HistoricalPage() {
  const stats = await getHistoricalStats();

  const sorted = [...stats].sort((a, b) => {
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    return TF_ORDER.indexOf(a.timeframe) - TF_ORDER.indexOf(b.timeframe);
  });

  const totalBars  = stats.reduce((s, r) => s + Number(r.bar_count), 0);
  const symbols    = [...new Set(stats.map(r => r.symbol))].sort();
  const timeframes = [...new Set(stats.map(r => r.timeframe))]
    .sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));

  // シンボルごとにグループ化
  const bySymbol = new Map<string, BarStat[]>();
  for (const row of sorted) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol)!.push(row);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black tracking-widest" style={{ color: "var(--text-primary)" }}>ヒストリカルデータ</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Supabase bar_data — Trading View / Backtestのデータ基盤</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "総バー数",   value: totalBars.toLocaleString() },
          { label: "シンボル数", value: symbols.length.toString() },
          { label: "時間足数",   value: timeframes.length.toString() },
        ].map(item => (
          <div key={item.label} className="rounded-xl p-5 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-3xl font-black" style={{ color: "var(--accent-cyan)" }}>{item.value}</p>
            <p className="text-[9px] mt-1.5 tracking-widest" style={{ color: "var(--text-muted)" }}>{item.label}</p>
          </div>
        ))}
      </div>

      {/* Symbol chips */}
      <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>取得済みシンボル</p>
        <div className="flex flex-wrap gap-2">
          {symbols.map(s => (
            <span key={s} className="px-2.5 py-1 rounded text-xs font-mono font-bold"
              style={{ background: "rgba(0,229,255,0.08)", color: "var(--accent-cyan)", border: "1px solid rgba(0,229,255,0.2)" }}>
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* Detail table — grouped by symbol */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <p className="text-[9px] font-black tracking-widest" style={{ color: "var(--text-muted)" }}>
            Symbol × Timeframe 詳細 ({stats.length} 組み合わせ)
          </p>
          <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>DB集計 (全{totalBars.toLocaleString()}行対象)</p>
        </div>
        {sorted.length === 0 ? (
          <p className="p-5 text-xs" style={{ color: "var(--text-muted)" }}>
            データなし — Admin MT5でDataManagerを起動してください
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["シンボル", "時間足", "バー数", "最古データ", "最新データ", "状態"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left font-mono font-bold"
                        style={{ color: "var(--text-muted)", background: "var(--bg-secondary)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const isFirstOfSymbol = i === 0 || sorted[i-1].symbol !== row.symbol;
                  return (
                    <tr key={`${row.symbol}:${row.timeframe}`}
                        style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", background: isFirstOfSymbol ? "rgba(0,229,255,0.02)" : undefined }}>
                      <td className="px-4 py-2 font-black text-[11px]" style={{ color: isFirstOfSymbol ? "var(--accent-cyan)" : "var(--text-muted)" }}>
                        {isFirstOfSymbol ? row.symbol : ""}
                      </td>
                      <td className="px-4 py-2 font-mono" style={{ color: "var(--text-secondary)" }}>{row.timeframe}</td>
                      <td className="px-4 py-2 font-mono font-bold" style={{ color: "var(--text-primary)" }}>
                        {Number(row.bar_count).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                        {new Date(row.oldest_bar).toLocaleDateString("ja-JP")}
                      </td>
                      <td className="px-4 py-2 font-mono text-[10px]" style={{ color: "var(--text-secondary)" }}>
                        {new Date(row.newest_bar).toLocaleString("ja-JP")}
                      </td>
                      <td className="px-4 py-2"><DataStatus newestStr={row.newest_bar} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
