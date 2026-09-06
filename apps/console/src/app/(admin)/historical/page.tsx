import { getAdminSupabase } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

async function getHistoricalStats() {
  const sb = await getAdminSupabase();

  // Symbol×TF別の統計
  const { data } = await sb
    .from("bar_data")
    .select("symbol, timeframe, time_utc")
    .order("time_utc", { ascending: true });

  if (!data) return [];

  const map = new Map<string, { symbol: string; timeframe: string; count: number; oldest: string; newest: string }>();
  for (const row of data) {
    const key = `${row.symbol}:${row.timeframe}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { symbol: row.symbol, timeframe: row.timeframe, count: 1, oldest: row.time_utc, newest: row.time_utc });
    } else {
      cur.count++;
      if (row.time_utc > cur.newest) cur.newest = row.time_utc;
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    const ORDER = ["M1","M5","M15","M30","H1","H4","D1","W1"];
    return ORDER.indexOf(a.timeframe) - ORDER.indexOf(b.timeframe);
  });
}

function DataStatus({ newestStr }: { newestStr: string }) {
  const newest = new Date(newestStr);
  const diffHours = (Date.now() - newest.getTime()) / 3600_000;
  if (diffHours < 1)   return <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,136,0.1)", color: "#00ff88" }}>最新</span>;
  if (diffHours < 24)  return <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,136,0.07)", color: "#00ff88" }}>当日</span>;
  if (diffHours < 168) return <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(251,191,36,0.1)", color: "#fbbf24" }}>今週</span>;
  return <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>古い</span>;
}

export default async function HistoricalPage() {
  const stats = await getHistoricalStats();

  const totalBars   = stats.reduce((s, r) => s + r.count, 0);
  const symbols     = [...new Set(stats.map(r => r.symbol))];
  const timeframes  = [...new Set(stats.map(r => r.timeframe))];

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
          <div key={item.label} className="rounded-xl p-4 text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-2xl font-black" style={{ color: "var(--accent-cyan)" }}>{item.value}</p>
            <p className="text-[9px] mt-1" style={{ color: "var(--text-muted)" }}>{item.label}</p>
          </div>
        ))}
      </div>

      {/* Symbol Info */}
      <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>取得済みシンボル</p>
        <div className="flex flex-wrap gap-2">
          {symbols.map(s => (
            <span key={s} className="px-2.5 py-1 rounded text-xs font-mono" style={{ background: "rgba(0,229,255,0.08)", color: "var(--accent-cyan)", border: "1px solid rgba(0,229,255,0.2)" }}>{s}</span>
          ))}
        </div>
      </div>

      {/* Detailed Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <p className="text-[9px] font-black tracking-widest" style={{ color: "var(--text-muted)" }}>
            Symbol × Timeframe 詳細 ({stats.length} 組み合わせ)
          </p>
        </div>
        {stats.length === 0 ? (
          <p className="p-5 text-xs" style={{ color: "var(--text-muted)" }}>データがありません。Admin MT5を接続してDataManagerを起動してください。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["シンボル", "時間足", "バー数", "最古", "最新", "状態"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left font-mono font-bold" style={{ color: "var(--text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map(row => (
                  <tr key={`${row.symbol}:${row.timeframe}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                    <td className="px-4 py-2 font-black" style={{ color: "var(--accent-green)" }}>{row.symbol}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-secondary)" }}>{row.timeframe}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-primary)" }}>{row.count.toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {new Date(row.oldest).toLocaleDateString("ja-JP")}
                    </td>
                    <td className="px-4 py-2 font-mono text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      {new Date(row.newest).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-2"><DataStatus newestStr={row.newest} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
