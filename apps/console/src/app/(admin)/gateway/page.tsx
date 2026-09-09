import { getGatewayConfig } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchGatewayFull() {
  const { url, secret } = getGatewayConfig();
  if (!url) return null;
  try {
    const headers = { "x-gateway-secret": secret };
    const [health, positions, account] = await Promise.all([
      fetch(`${url}/health`,    { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch(`${url}/positions`, { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch(`${url}/account`,   { headers, cache: "no-store" }).then(r => r.ok ? r.json() : null),
    ]);
    return { health, positions, account, url };
  } catch (e) {
    return { error: String(e), url };
  }
}

const endpoints = [
  { method: "POST", path: "/connect",       role: "EA起動通知" },
  { method: "POST", path: "/tick",          role: "Tickストリーム受信" },
  { method: "POST", path: "/bar",           role: "リアルタイムBar受信" },
  { method: "POST", path: "/bars/bulk",     role: "過去Bar一括受信（起動時）" },
  { method: "POST", path: "/positions",     role: "ポジション一覧受信" },
  { method: "POST", path: "/account",       role: "口座情報受信" },
  { method: "POST", path: "/heartbeat",     role: "死活監視" },
  { method: "GET",  path: "/health",        role: "サーバー状態確認" },
  { method: "GET",  path: "/bars/:sym/:tf", role: "過去Bar取得（Trading View用）" },
  { method: "GET",  path: "/tick/:sym",     role: "最新Tick取得（Trading View用）" },
  { method: "GET",  path: "/positions",     role: "ポジション一覧取得" },
  { method: "GET",  path: "/account",       role: "口座情報取得" },
  { method: "GET",  path: "/symbols",       role: "受信中シンボル一覧" },
  { method: "WS",   path: "/ws",            role: "Tick/Bar/ポジションのリアルタイム配信" },
];

export default async function GatewayPage() {
  const gw = await fetchGatewayFull();
  const isConnected = gw?.health?.status === "ok";

  // health から取得できる全シンボル情報
  const tickSymbols: string[] = gw?.health?.tickSymbols ?? [];
  const barKeys: string[]     = gw?.health?.barKeys ?? [];
  const heartbeats: Record<string, string> = gw?.health?.heartbeats ?? {};

  const lastTickTs = gw?.health?.lastTickTs;
  const lastTickStr = lastTickTs
    ? new Date(lastTickTs).toLocaleString("ja-JP")
    : "―";

  const uptimeSec = gw?.health?.uptime ?? 0;
  const uptimeStr = uptimeSec > 0
    ? `${Math.floor(uptimeSec / 3600)}時間 ${Math.floor((uptimeSec % 3600) / 60)}分`
    : "―";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-widest" style={{ color: "var(--text-primary)" }}>ゲートウェイ</h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>MT5 ↔ Supabase ↔ Trading View のデータ中継サーバー</p>
      </div>

      {/* Status */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>接続状態</h2>
        <div className="flex items-center gap-4 mb-4">
          <div className="w-3 h-3 rounded-full"
               style={{ background: isConnected ? "#4ade80" : "#f87171", boxShadow: `0 0 8px ${isConnected ? "#4ade80" : "#f87171"}` }} />
          <span className="text-sm font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            {isConnected ? "オンライン" : gw?.error ? "エラー" : "オフライン"}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "受信シンボル数",  value: `${tickSymbols.length} 銘柄` },
            { label: "受信中TF組み合わせ", value: `${barKeys.length} 個` },
            { label: "最終Tick受信",    value: lastTickStr },
            { label: "稼働時間",        value: uptimeStr },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg p-3" style={{ background: "var(--bg-secondary)" }}>
              <p className="text-[9px] tracking-widest mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
              <p className="text-xs font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-lg px-4 py-2" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
          <p className="text-[9px] mb-0.5" style={{ color: "var(--text-muted)" }}>サーバーURL (Railway)</p>
          <p className="text-xs font-mono" style={{ color: "var(--accent-cyan)" }}>{gw?.url || "未設定"}</p>
        </div>
        {gw?.error && (
          <div className="mt-3 rounded-lg px-4 py-2" style={{ background: "#1a0a0a", border: "1px solid #f87171" }}>
            <p className="text-[9px] font-mono" style={{ color: "#f87171" }}>{gw.error}</p>
          </div>
        )}
      </div>

      {/* Active symbols grid */}
      {isConnected && tickSymbols.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold tracking-widest" style={{ color: "var(--text-secondary)" }}>
              受信中のシンボル ({tickSymbols.length} 銘柄)
            </h2>
            <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>最終Heartbeat時刻</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {tickSymbols.map((sym: string) => {
              const hb = heartbeats[sym];
              const ageMin = hb ? (Date.now() - new Date(hb).getTime()) / 60000 : null;
              const fresh = ageMin !== null && ageMin < 5;
              return (
                <div key={sym} className="rounded-lg px-3 py-2.5"
                     style={{ background: "var(--bg-secondary)", border: `1px solid ${fresh ? "rgba(0,255,136,0.2)" : "var(--border)"}` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                         style={{ background: fresh ? "#4ade80" : "#94a3b8" }} />
                    <p className="text-[11px] font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>{sym}</p>
                  </div>
                  <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                    {ageMin !== null ? `${Math.round(ageMin)}分前` : "―"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Positions & Account */}
      {isConnected && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>オープンポジション数</p>
            <p className="text-2xl font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>
              {Array.isArray(gw.positions) ? `${gw.positions.length} 件` : "―"}
            </p>
            <p className="text-[9px] mt-1" style={{ color: "var(--text-muted)" }}>Admin MT5の現在のポジション</p>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>口座残高 (Admin MT5)</p>
            <p className="text-2xl font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>
              {gw.account?.balance != null
                ? `${gw.account.balance.toLocaleString()} ${gw.account.currency ?? "USD"}`
                : "―"}
            </p>
            <p className="text-[9px] mt-1" style={{ color: "var(--text-muted)" }}>
              有効証拠金: {gw.account?.equity != null
                ? `${gw.account.equity.toLocaleString()} ${gw.account.currency ?? "USD"}`
                : "―"}
            </p>
          </div>
        </div>
      )}

      {/* Endpoints */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>APIエンドポイント一覧</h2>
        <div className="space-y-1">
          {endpoints.map(ep => (
            <div key={ep.path + ep.method} className="flex items-center gap-3 px-3 py-2 rounded"
                 style={{ background: "var(--bg-secondary)" }}>
              <span className={`text-[9px] font-mono font-bold w-10 text-center rounded px-1 py-0.5 flex-shrink-0 ${
                ep.method === "POST" ? "bg-blue-900 text-blue-300" :
                ep.method === "GET"  ? "bg-green-900 text-green-300" :
                "bg-purple-900 text-purple-300"
              }`}>{ep.method}</span>
              <code className="text-[10px] font-mono w-44 flex-shrink-0" style={{ color: "var(--accent-cyan)" }}>{ep.path}</code>
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{ep.role}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Data flow */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-bold tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>データフロー</h2>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {["Admin MT5", "AVL DataManager EA", "ゲートウェイ (Railway)", "Supabase (bar_data)", "Trading View"].map((node, i, arr) => (
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
