import { getAdminSupabase } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const GATEWAY_URL = process.env.MT5_GATEWAY_URL ?? process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

async function fetchGatewayHealth() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function fetchMarketDataStats() {
  const sb = await getAdminSupabase();
  const { data } = await sb
    .from("bar_data")
    .select("symbol, timeframe, time_utc")
    .order("time_utc", { ascending: false })
    .limit(1000);

  if (!data) return { totalBars: 0, symbols: [], latestBar: null };

  const symbolMap = new Map<string, { bars: number; latest: string }>();
  for (const row of data) {
    const key = row.symbol;
    const cur = symbolMap.get(key);
    if (!cur) { symbolMap.set(key, { bars: 1, latest: row.time_utc }); }
    else { cur.bars++; if (row.time_utc > cur.latest) cur.latest = row.time_utc; }
  }
  return {
    totalBars: data.length,
    symbols: Array.from(symbolMap.entries()).map(([sym, v]) => ({ symbol: sym, ...v })),
    latestBar: data[0]?.time_utc ?? null,
  };
}

async function fetchSupabaseStatus() {
  const sb = await getAdminSupabase();
  const { count, error } = await sb.from("bar_data").select("*", { count: "exact", head: true });
  return { ok: !error, totalRows: count ?? 0 };
}

function StatusBadge({ status }: { status: "ok" | "warn" | "error" | "unknown" }) {
  const cfg = {
    ok:      { label: "正常",     color: "#00ff88", bg: "rgba(0,255,136,0.1)" },
    warn:    { label: "注意",     color: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
    error:   { label: "エラー",   color: "#f87171", bg: "rgba(248,113,113,0.1)" },
    unknown: { label: "不明",     color: "#94a3b8", bg: "rgba(148,163,184,0.1)" },
  }[status];
  return (
    <span className="px-2 py-0.5 rounded text-[9px] font-black tracking-widest"
      style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
      <p className="text-[9px] font-black tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value, status }: { label: string; value: string; status?: "ok" | "warn" | "error" | "unknown" }) {
  return (
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono" style={{ color: "var(--text-primary)" }}>{value}</span>
        {status && <StatusBadge status={status} />}
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const [gateway, marketStats, sbStatus] = await Promise.all([
    fetchGatewayHealth(),
    fetchMarketDataStats(),
    fetchSupabaseStatus(),
  ]);

  const gatewayOk   = !!gateway;
  const eaConnected = gateway?.eaConnected ?? false;
  const lastTick    = gateway?.lastTickTs ? new Date(gateway.lastTickTs).toLocaleString("ja-JP") : "―";
  const barKeys     = gateway?.barKeys ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-black tracking-widest" style={{ color: "var(--text-primary)" }}>ダッシュボード</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>AVL-FX Platform Control Plane — Admin Only</p>
      </div>

      {/* System Status */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "MT5 DataManager", status: (eaConnected ? "ok" : "warn") as "ok"|"warn", value: eaConnected ? "接続中" : "未接続" },
          { label: "Gateway", status: (gatewayOk ? "ok" : "error") as "ok" | "error", value: gatewayOk ? "オンライン" : "オフライン" },
          { label: "Supabase", status: (sbStatus.ok ? "ok" : "error") as "ok" | "error", value: sbStatus.ok ? "正常" : "エラー" },
          { label: "総バーデータ", status: "ok" as "ok", value: sbStatus.totalRows.toLocaleString() + " 行" },
        ].map(item => (
          <div key={item.label} className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[8px] tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>{item.label}</p>
            <div className="flex items-center justify-between">
              <span className="text-sm font-black" style={{ color: "var(--text-primary)" }}>{item.value}</span>
              <StatusBadge status={item.status} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Gateway Status */}
        <Card title="GATEWAY STATUS">
          <Row label="接続状態"  value={gatewayOk ? "オンライン" : "オフライン"} status={(gatewayOk ? "ok" : "error") as "ok"|"error"} />
          <Row label="EA接続"   value={eaConnected ? "接続中" : "未接続"} status={(eaConnected ? "ok" : "warn") as "ok"|"warn"} />
          <Row label="最終Tick" value={lastTick} />
          <Row label="バーキー数" value={barKeys.length.toString()} />
          {gateway && <Row label="Uptime" value={Math.floor((gateway.uptime ?? 0) / 60) + " 分"} />}
          {!gateway && <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>Gatewayへ接続できません</p>}
        </Card>

        {/* Market Data */}
        <Card title="市場データ サマリー">
          <Row label="総シンボル数" value={marketStats.symbols.length.toString()} />
          <Row label="最新バー"    value={marketStats.latestBar ? new Date(marketStats.latestBar).toLocaleString("ja-JP") : "―"} />
          {marketStats.symbols.slice(0, 5).map(s => (
            <Row key={s.symbol} label={s.symbol}
              value={`${s.bars} bars | ${new Date(s.latest).toLocaleDateString("ja-JP")}`}
              status="ok" />
          ))}
          {marketStats.symbols.length === 0 && <p className="text-xs" style={{ color: "var(--text-muted)" }}>データがありません</p>}
        </Card>

        {/* Architecture Note */}
        <Card title="ARCHITECTURE">
          <div className="text-xs space-y-1.5" style={{ color: "var(--text-secondary)" }}>
            <p>📡 <span style={{ color: "var(--accent-cyan)" }}>Admin MT5</span> → DataManager → Gateway → Supabase</p>
            <p>📊 Supabase bar_data → Trading View (Chart / Backtest / AI)</p>
            <p>🔒 Admin MT5情報は一般ユーザーへ非公開</p>
            <p>👤 User MT5 = Execution専用 (Market Data Sourceとして使用しない)</p>
          </div>
        </Card>

        {/* Supabase */}
        <Card title="SUPABASE">
          <Row label="接続状態"  value={sbStatus.ok ? "正常" : "エラー"} status={(sbStatus.ok ? "ok" : "error") as "ok"|"error"} />
          <Row label="bar_data 総行数" value={sbStatus.totalRows.toLocaleString()} />
          <Row label="Trading View提供" value={sbStatus.ok && sbStatus.totalRows > 0 ? "可能" : "データ不足"} status={(sbStatus.totalRows > 0 ? "ok" : "warn") as "ok"|"warn"} />
        </Card>
      </div>
    </div>
  );
}
