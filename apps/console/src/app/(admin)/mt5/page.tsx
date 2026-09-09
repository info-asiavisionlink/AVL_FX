import { getAdminSupabase, getGatewayConfig } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchMT5Status() {
  const { url, secret } = getGatewayConfig();
  if (!url) return null;
  try {
    const [healthRes, symbolsRes] = await Promise.all([
      fetch(`${url}/health`,   { headers: { "x-gateway-secret": secret }, cache: "no-store" }),
      fetch(`${url}/symbols`,  { headers: { "x-gateway-secret": secret }, cache: "no-store" }),
    ]);
    const health  = healthRes.ok  ? await healthRes.json()  : null;
    const symbols = symbolsRes.ok ? await symbolsRes.json() : [];
    return { health, symbols };
  } catch { return null; }
}

async function getBarStats() {
  const sb = await getAdminSupabase();
  const { data, count } = await sb.from("bar_data").select("symbol,timeframe,time_utc", { count: "exact", head: false })
    .order("time_utc", { ascending: false }).limit(10);
  return { recent: data ?? [], total: count ?? 0 };
}

export default async function MT5Page() {
  const [mt5, barStats] = await Promise.all([fetchMT5Status(), getBarStats()]);

  const connected = mt5?.health?.status === "ok";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-widest" style={{ color: "var(--text-primary)" }}>MT5接続状態</h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Admin MT5 DataManager の接続状況とデータフロー</p>
      </div>

      {/* Connection Status */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>接続状態</h2>
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
               style={{ boxShadow: connected ? "0 0 8px #4ade80" : "0 0 8px #f87171" }} />
          <span className="text-sm font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            {connected ? "接続中" : "未接続"}
          </span>
          {mt5?.health?.uptime_seconds && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              稼働時間: {Math.floor(mt5.health.uptime_seconds / 3600)}時間 {Math.floor((mt5.health.uptime_seconds % 3600) / 60)}分
            </span>
          )}
        </div>
        {mt5?.health && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ["バージョン",         mt5.health.version ?? "—"],
              ["Tick受信数/分",      mt5.health.ticks_per_minute ?? "—"],
              ["最終Tick受信",       mt5.health.last_tick_age_seconds != null ? `${mt5.health.last_tick_age_seconds}秒前` : "—"],
              ["受信シンボル数",      mt5.health.symbol_count ?? "—"],
            ].map(([label, val]) => (
              <div key={label as string} className="rounded-lg p-3" style={{ background: "var(--bg-secondary)" }}>
                <p className="text-[9px] tracking-widest mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
                <p className="text-sm font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>{val}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DataManager Files */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>EA ファイル一覧</h2>
        <div className="space-y-2">
          {[
            { file: "AVL_DataManager_v2.mq5", role: "Admin MT5 → Gateway へTick/Barを送信", path: "mt5/data-manager/" },
            { file: "AVL_ExecutionBridge.mq5", role: "User MT5 → 注文実行ブリッジ", path: "mt5/execution-bridge/" },
            { file: "AVL_FX_Bridge.mq5", role: "Gateway双方向ブリッジ (旧世代)", path: "mt5/execution-bridge/" },
          ].map(ea => (
            <div key={ea.file} className="flex items-start gap-3 rounded-lg px-4 py-3"
                 style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <span className="text-sm" style={{ color: "var(--accent-cyan)" }}>⬡</span>
              <div>
                <p className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>{ea.file}</p>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{ea.role}</p>
                <p className="text-[9px] mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>repo: {ea.path}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Symbol List */}
      {mt5?.symbols && mt5.symbols.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>
            受信中のシンボル ({mt5.symbols.length} 銘柄)
          </h2>
          <div className="flex flex-wrap gap-2">
            {mt5.symbols.map((s: string) => (
              <span key={s} className="px-2 py-1 rounded text-[10px] font-mono"
                    style={{ background: "var(--bg-secondary)", color: "var(--accent-cyan)", border: "1px solid var(--border)" }}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent Bars from Supabase */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-1" style={{ color: "var(--text-secondary)" }}>Supabase 直近バーデータ</h2>
        <p className="text-[9px] mb-4" style={{ color: "var(--text-muted)" }}>総蓄積数: {barStats.total.toLocaleString()} 本</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr style={{ color: "var(--text-muted)" }}>
                {["シンボル","時間足","バー時刻"].map(h => (
                  <th key={h} className="text-left pb-2 pr-4 font-medium tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {barStats.recent.map((row: Record<string, string>, i: number) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                  <td className="py-1.5 pr-4 font-mono">{row.symbol}</td>
                  <td className="py-1.5 pr-4 font-mono">{row.timeframe}</td>
                  <td className="py-1.5 font-mono">{new Date(row.time_utc).toLocaleString("ja-JP")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-[9px] text-right" style={{ color: "var(--text-muted)" }}>
        Admin MT5 → AVL DataManager → Gateway → Supabase pipeline
      </div>
    </div>
  );
}
