import { getAdminSupabase, getGatewayConfig } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchGatewayHealth() {
  const { url, secret } = getGatewayConfig();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/health`, {
      headers: { "x-gateway-secret": secret },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchMarketDataStats() {
  try {
    const sb = await getAdminSupabase();
    const { data } = await sb
      .from("bar_data")
      .select("symbol, timeframe, time_utc")
      .order("time_utc", { ascending: false })
      .limit(500);
    if (!data) return { totalBars: 0, symbols: [], latestBar: null };
    const symbolMap = new Map<string, { bars: number; latest: string }>();
    for (const row of data) {
      const cur = symbolMap.get(row.symbol);
      if (!cur) symbolMap.set(row.symbol, { bars: 1, latest: row.time_utc });
      else { cur.bars++; if (row.time_utc > cur.latest) cur.latest = row.time_utc; }
    }
    return {
      totalBars: data.length,
      symbols: Array.from(symbolMap.entries()).map(([sym, v]) => ({ symbol: sym, ...v })),
      latestBar: data[0]?.time_utc ?? null,
    };
  } catch { return { totalBars: 0, symbols: [], latestBar: null }; }
}

async function fetchSupabaseStatus() {
  try {
    const sb = await getAdminSupabase();
    const { count, error } = await sb.from("bar_data").select("*", { count: "exact", head: true });
    return { ok: !error, totalRows: count ?? 0 };
  } catch { return { ok: false, totalRows: 0 }; }
}

function StatusBadge({ status }: { status: "ok" | "warn" | "error" | "unknown" }) {
  const cfg = {
    ok:      { label: "正常",   color: "#00ff88", bg: "rgba(0,255,136,0.1)" },
    warn:    { label: "注意",   color: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
    error:   { label: "エラー", color: "#f87171", bg: "rgba(248,113,113,0.1)" },
    unknown: { label: "不明",   color: "#94a3b8", bg: "rgba(148,163,184,0.1)" },
  }[status];
  return (
    <span className="px-2 py-0.5 rounded text-[9px] font-black tracking-widest"
      style={{ color: cfg.color, background: cfg.bg }}>{cfg.label}</span>
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

function Row({ label, value, sub, status }: { label: string; value: string; sub?: string; status?: "ok" | "warn" | "error" | "unknown" }) {
  return (
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
      <div className="flex items-center gap-2">
        <div className="text-right">
          <span className="text-xs font-mono" style={{ color: "var(--text-primary)" }}>{value}</span>
          {sub && <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>{sub}</p>}
        </div>
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
  const eaConnected = !!(gateway?.eaConnected);
  const lastTick    = gateway?.lastTickTs ? new Date(gateway.lastTickTs).toLocaleString("ja-JP") : "―";
  const tfCount     = ((gateway?.barKeys as string[]) ?? []).length;
  const uptimeSec   = (gateway as { uptime?: number } | null)?.uptime ?? 0;
  const uptimeStr   = uptimeSec > 0
    ? `${Math.floor(uptimeSec / 3600)}時間 ${Math.floor((uptimeSec % 3600) / 60)}分`
    : "―";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black tracking-widest" style={{ color: "var(--text-primary)" }}>ダッシュボード</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>AVL-FX プラットフォーム管理 — 管理者専用</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "MT5 DataManager", status: (eaConnected ? "ok" : "warn") as "ok"|"warn",  value: eaConnected ? "接続中" : "未接続" },
          { label: "ゲートウェイ",     status: (gatewayOk ? "ok" : "error") as "ok"|"error", value: gatewayOk ? "オンライン" : "オフライン" },
          { label: "Supabase",        status: (sbStatus.ok ? "ok" : "error") as "ok"|"error", value: sbStatus.ok ? "正常" : "エラー" },
          { label: "蓄積バー総数",      status: "ok" as "ok",                                   value: sbStatus.totalRows.toLocaleString() + " 本" },
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
        {/* Gateway */}
        <Card title="ゲートウェイ状態">
          <Row label="接続状態"       value={gatewayOk ? "オンライン" : "オフライン"} status={(gatewayOk ? "ok" : "error") as "ok"|"error"} />
          <Row label="EA接続"         value={eaConnected ? "接続中" : "未接続"} status={(eaConnected ? "ok" : "warn") as "ok"|"warn"} />
          <Row label="最終Tick受信"   value={lastTick} />
          <Row label="受信中TF数"     value={`${tfCount} 個`} sub="シンボル×時間足の組み合わせ数" />
          <Row label="稼働時間"        value={uptimeStr} />
          {!gateway && <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>⚠ ゲートウェイに接続できません — Railway の状態を確認してください</p>}
        </Card>

        {/* Market Data */}
        <Card title="直近の市場データ">
          <Row label="受信シンボル数" value={`${marketStats.symbols.length} 銘柄`} />
          <Row label="最新バー時刻"   value={marketStats.latestBar ? new Date(marketStats.latestBar).toLocaleString("ja-JP") : "―"} />
          {marketStats.symbols.slice(0, 5).map(s => (
            <Row key={s.symbol} label={s.symbol}
              value={`${new Date(s.latest).toLocaleString("ja-JP")}`}
              sub="最新バー時刻"
              status="ok" />
          ))}
          {marketStats.symbols.length === 0 && <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>bar_dataにデータがありません</p>}
        </Card>

        {/* Architecture */}
        <Card title="データフロー (概要)">
          <div className="text-xs space-y-2.5" style={{ color: "var(--text-secondary)" }}>
            {[
              { icon: "🖥️", text: "Admin MT5", sub: "AVL_DataManager EA が稼働中" },
              { icon: "↓",  text: "",          sub: "" },
              { icon: "🔀", text: "ゲートウェイ (Railway)", sub: "Tick・バーデータを受信してSupabaseへ保存" },
              { icon: "↓",  text: "",          sub: "" },
              { icon: "🗄️", text: "Supabase (bar_data)", sub: "全ユーザー共有の市場データ置き場" },
              { icon: "↓",  text: "",          sub: "" },
              { icon: "📈", text: "Trading View", sub: "チャート・バックテスト・AI分析が参照" },
            ].map((item, i) => item.text ? (
              <div key={i} className="flex items-start gap-2">
                <span>{item.icon}</span>
                <div>
                  <p className="font-bold" style={{ color: "var(--text-primary)" }}>{item.text}</p>
                  <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{item.sub}</p>
                </div>
              </div>
            ) : <p key={i} className="pl-1 text-[10px]" style={{ color: "var(--text-muted)" }}>　　　　↓</p>)}
          </div>
        </Card>

        {/* Supabase */}
        <Card title="Supabase 状態">
          <Row label="接続状態"        value={sbStatus.ok ? "正常" : "エラー"} status={(sbStatus.ok ? "ok" : "error") as "ok"|"error"} />
          <Row label="蓄積バー総数"    value={`${sbStatus.totalRows.toLocaleString()} 本`} sub="チャート・バックテストに使用される全期間データ" />
          <Row label="Trading View提供" value={sbStatus.ok && sbStatus.totalRows > 0 ? "提供可能" : "データ不足"} status={(sbStatus.totalRows > 0 ? "ok" : "warn") as "ok"|"warn"} />
        </Card>
      </div>
    </div>
  );
}
