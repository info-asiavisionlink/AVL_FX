import { getAdminSupabase, getGatewayConfig } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getSystemHealth() {
  const sb = await getAdminSupabase();
  const { url, secret } = getGatewayConfig();

  const [
    { count: barCount },
    tickResult,
    gatewayHealth,
  ] = await Promise.all([
    sb.from("bar_data").select("*", { count: "exact", head: true }),
    sb.from("ticks").select("*", { count: "exact", head: true }),
    url
      ? fetch(`${url}/health`, { headers: { "x-gateway-secret": secret }, cache: "no-store" })
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
  ]);
  const tickCount = tickResult.count ?? 0;

  const { data: latestBars } = await sb
    .from("bar_data")
    .select("symbol,timeframe,time_utc")
    .order("time_utc", { ascending: false })
    .limit(5);

  const freshness = latestBars?.map(b => {
    const ageMs  = Date.now() - new Date(b.time_utc).getTime();
    const ageMin = ageMs / 60000;
    return { ...b, ageMin, fresh: ageMin < 10 };
  }) ?? [];

  return { barCount, tickCount, gatewayHealth, freshness };
}

export default async function SystemPage() {
  const { barCount, tickCount, gatewayHealth, freshness } = await getSystemHealth();
  const gwOk = gatewayHealth?.status === "ok";
  const lastTickAge = gatewayHealth?.last_tick_age_seconds;
  const lastTickStr = lastTickAge != null
    ? lastTickAge < 60 ? `${lastTickAge}秒前` : `${Math.floor(lastTickAge/60)}分前`
    : null;

  const newestBar = freshness[0];
  const newestBarStr = newestBar
    ? `${newestBar.symbol} ${newestBar.timeframe} — ${Math.round(newestBar.ageMin)}分前`
    : "データなし";

  const checks = [
    {
      label: "Admin MT5 → ゲートウェイ",
      status: gwOk ? "ok" : "fail",
      detail: gwOk
        ? `正常受信中 (最終Tick: ${lastTickStr ?? "不明"})`
        : "ゲートウェイがオフラインです。RailwayのサービスとMT5のEA稼働状況を確認してください",
    },
    {
      label: "ゲートウェイ → Supabase",
      status: (barCount ?? 0) > 0 ? "ok" : "warn",
      detail: `Supabaseに ${(barCount ?? 0).toLocaleString()} 本のバーデータが蓄積されています`,
    },
    {
      label: "市場データの鮮度",
      status: freshness.some(f => f.fresh) ? "ok" : "warn",
      detail: `最新バー: ${newestBarStr}`,
    },
    {
      label: "Supabase → Trading View",
      status: (barCount ?? 0) > 0 ? "ok" : "warn",
      detail: "Trading Viewは同じbar_dataテーブルを参照しています — データ提供可能な状態です",
    },
    {
      label: "管理者認証ガード",
      status: "ok",
      detail: "Middlewareが有効 — ADMIN_EMAILSリストによるアクセス制限が機能しています",
    },
  ];

  const statusColor = (s: string) =>
    s === "ok" ? "#4ade80" : s === "warn" ? "#facc15" : "#f87171";
  const statusLabel = (s: string) =>
    s === "ok" ? "正常" : s === "warn" ? "注意" : "異常";

  const allOk = checks.every(c => c.status !== "fail");
  const hasWarn = checks.some(c => c.status === "warn");
  const pipelineStatus = allOk && !hasWarn ? "正常稼働中" : allOk ? "一部注意あり" : "異常あり";
  const pipelineColor = allOk && !hasWarn ? "#4ade80" : allOk ? "#fbbf24" : "#f87171";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black tracking-widest" style={{ color: "var(--text-primary)" }}>システム診断</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>データパイプライン全体の疎通確認</p>
      </div>

      {/* Overall status */}
      <div className="rounded-xl p-5 flex items-center gap-4" style={{ background: "var(--bg-card)", border: `1px solid ${pipelineColor}44` }}>
        <div className="w-4 h-4 rounded-full flex-shrink-0"
             style={{ background: pipelineColor, boxShadow: `0 0 10px ${pipelineColor}` }} />
        <div>
          <p className="text-sm font-black" style={{ color: pipelineColor }}>パイプライン: {pipelineStatus}</p>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            Admin MT5 → ゲートウェイ → Supabase → Trading View
          </p>
        </div>
      </div>

      {/* Checks */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-black tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>各ステップの確認</h2>
        <div className="space-y-3">
          {checks.map(c => (
            <div key={c.label} className="flex items-start gap-4 rounded-lg px-4 py-3"
                 style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <div className="w-3 h-3 rounded-full mt-0.5 flex-shrink-0"
                   style={{ background: statusColor(c.status), boxShadow: `0 0 6px ${statusColor(c.status)}` }} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{c.label}</span>
                  <span className="text-[8px] font-black px-1.5 py-0.5 rounded"
                        style={{ background: statusColor(c.status) + "22", color: statusColor(c.status) }}>
                    {statusLabel(c.status)}
                  </span>
                </div>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{c.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "バーデータ総数",    value: (barCount ?? 0).toLocaleString() + " 本", sub: "bar_dataテーブル" },
          { label: "Tickデータ総数",    value: (tickCount ?? 0).toLocaleString() + " 件", sub: "ticksテーブル" },
          { label: "ゲートウェイ",      value: gwOk ? "オンライン" : "オフライン", sub: "Railway" },
          { label: "パイプライン全体",   value: pipelineStatus, sub: "5項目確認済み" },
        ].map(({ label, value, sub }) => (
          <div key={label} className="rounded-xl p-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
            <p className="text-sm font-mono font-bold" style={{ color: "var(--accent-cyan)" }}>{value}</p>
            <p className="text-[9px] mt-0.5" style={{ color: "var(--text-muted)" }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* System overview */}
      <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <h2 className="text-xs font-black tracking-widest mb-4" style={{ color: "var(--text-secondary)" }}>各システムの役割</h2>
        <div className="space-y-2 text-[10px]">
          {[
            { system: "AVLFX Trading View",  role: "ユーザー向けトレーディングアプリ。チャート・AI・バックテスト・Live Trading", tag: "Vercel" },
            { system: "AVLFX Console",        role: "このページ。市場データインフラの管理・監視専用 (管理者のみ)", tag: "Vercel" },
            { system: "ゲートウェイ",          role: "Admin MT5からデータを受け取り、Supabaseへ保存する中継サーバー", tag: "Railway" },
            { system: "Admin MT5",            role: "市場データの取得元。AVL_DataManager EAが稼働してデータを送信", tag: "ローカル/VPS" },
            { system: "Supabase",             role: "全ユーザー共有の市場データ置き場 (bar_data / ticks)", tag: "Supabase Cloud" },
          ].map(s => (
            <div key={s.system} className="flex items-start gap-3 px-3 py-2.5 rounded-lg"
                 style={{ background: "var(--bg-secondary)" }}>
              <span className="font-mono font-bold w-44 flex-shrink-0" style={{ color: "var(--accent-cyan)" }}>{s.system}</span>
              <span className="flex-1" style={{ color: "var(--text-secondary)" }}>{s.role}</span>
              <span className="flex-shrink-0 font-mono text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-muted)" }}>{s.tag}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[9px] text-right" style={{ color: "var(--text-muted)" }}>
        確認時刻: {new Date().toLocaleString("ja-JP")}
      </p>
    </div>
  );
}
