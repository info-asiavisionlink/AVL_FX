import { getGatewayConfig } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchGatewayFull() {
  const { url, secret } = getGatewayConfig();
  if (!url) return null;
  try {
    const headers = { "x-gateway-secret": secret };
    const [health, tick, positions, account] = await Promise.all([
      fetch(`${url}/health`,    { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch(`${url}/tick/EURUSD`, { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch(`${url}/positions`,  { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch(`${url}/account`,    { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
    ]);
    return { health, tick, positions, account, url };
  } catch (e) {
    return { error: String(e), url };
  }
}

export default async function GatewayPage() {
  const gw = await fetchGatewayFull();

  const isConnected = gw?.health?.status === "ok";

  const endpoints = [
    { method: "POST", path: "/connect",     role: "EA起動通知" },
    { method: "POST", path: "/tick",        role: "Tickストリーム受信" },
    { method: "POST", path: "/bar",         role: "リアルタイムBar受信" },
    { method: "POST", path: "/bars/bulk",   role: "Historical Bar一括受信" },
    { method: "POST", path: "/positions",   role: "ポジションストリーム" },
    { method: "POST", path: "/account",     role: "口座情報ストリーム" },
    { method: "POST", path: "/heartbeat",   role: "死活監視" },
    { method: "GET",  path: "/health",      role: "サーバー状態確認" },
    { method: "GET",  path: "/bars/:sym/:tf", role: "過去Bar取得 (Trading View)" },
    { method: "GET",  path: "/tick/:sym",   role: "最新Tick (Trading View)" },
    { method: "GET",  path: "/positions",   role: "ポジション一覧 (Trading View)" },
    { method: "GET",  path: "/account",     role: "口座情報 (Trading View)" },
    { method: "GET",  path: "/symbols",     role: "シンボル一覧" },
    { method: "WS",   path: "/ws",          role: "Tick/Bar/Positionsリアルタイム配信" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-widest" style={{ color: "var(--text-primary)" }}>GATEWAY</h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>MT5 ↔ Supabase ↔ Trading View data bridge</p>
      </div>

      {/* Status Card */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>STATUS</h2>
        <div className="flex items-center gap-4 mb-4">
          <div className={`w-3 h-3 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`}
               style={{ boxShadow: isConnected ? "0 0 8px #4ade80" : "0 0 8px #f87171" }} />
          <span className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>
            {isConnected ? "ONLINE" : gw?.error ? "ERROR" : "OFFLINE"}
          </span>
        </div>
        <div className="rounded-lg px-4 py-2" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
          <p className="text-[9px] mb-0.5" style={{ color: "var(--text-muted)" }}>GATEWAY URL</p>
          <p className="text-xs font-mono" style={{ color: "var(--accent-cyan)" }}>{gw?.url || "NOT CONFIGURED"}</p>
        </div>
        {gw?.error && (
          <div className="mt-3 rounded-lg px-4 py-2" style={{ background: "#1a0a0a", border: "1px solid #f87171" }}>
            <p className="text-[9px] font-mono" style={{ color: "#f87171" }}>{gw.error}</p>
          </div>
        )}
      </div>

      {/* Live Data Snapshot */}
      {isConnected && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>EURUSD TICK</p>
            {gw.tick ? (
              <>
                <p className="text-lg font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>
                  {gw.tick.bid?.toFixed(5)}
                </p>
                <p className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                  ask: {gw.tick.ask?.toFixed(5)}
                </p>
              </>
            ) : <p className="text-xs" style={{ color: "var(--text-muted)" }}>No data</p>}
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>OPEN POSITIONS</p>
            <p className="text-lg font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>
              {Array.isArray(gw.positions) ? gw.positions.length : "—"}
            </p>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>ACCOUNT BALANCE</p>
            <p className="text-lg font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>
              {gw.account?.balance != null ? `$${gw.account.balance.toLocaleString()}` : "—"}
            </p>
          </div>
        </div>
      )}

      {/* Endpoints */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>API ENDPOINTS</h2>
        <div className="space-y-1">
          {endpoints.map(ep => (
            <div key={ep.path} className="flex items-center gap-3 px-3 py-2 rounded"
                 style={{ background: "var(--bg-secondary)" }}>
              <span className={`text-[9px] font-mono font-bold w-10 text-center rounded px-1 py-0.5 ${
                ep.method === "POST" ? "bg-blue-900 text-blue-300" :
                ep.method === "GET"  ? "bg-green-900 text-green-300" :
                "bg-purple-900 text-purple-300"
              }`}>{ep.method}</span>
              <code className="text-[10px] font-mono w-40" style={{ color: "var(--accent-cyan)" }}>{ep.path}</code>
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{ep.role}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Data Flow */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>DATA FLOW</h2>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {["Admin MT5", "AVL DataManager", "Gateway", "Supabase (bar_data/ticks)", "Trading View"].map((node, i, arr) => (
            <span key={node} className="flex items-center gap-2">
              <span className="px-3 py-1.5 rounded-lg font-mono"
                    style={{ background: "var(--bg-secondary)", color: "var(--accent-cyan)", border: "1px solid var(--border)" }}>
                {node}
              </span>
              {i < arr.length - 1 && <span style={{ color: "var(--text-muted)" }}>→</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
