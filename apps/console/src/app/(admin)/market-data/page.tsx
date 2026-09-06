import { getAdminSupabase } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.MT5_GATEWAY_URL ?? process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

async function getRealtimeData() {
  try {
    const [tickRes, posRes, accRes] = await Promise.all([
      fetch(`${GATEWAY_URL}/symbols`, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, cache: "no-store", signal: AbortSignal.timeout(4000) }),
      fetch(`${GATEWAY_URL}/positions`, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, cache: "no-store", signal: AbortSignal.timeout(4000) }),
      fetch(`${GATEWAY_URL}/account`, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, cache: "no-store", signal: AbortSignal.timeout(4000) }),
    ]);
    return {
      symbols:   tickRes.ok  ? await tickRes.json()  : [],
      positions: posRes.ok   ? await posRes.json()   : [],
      account:   accRes.ok   ? await accRes.json()   : null,
    };
  } catch {
    return { symbols: [], positions: [], account: null };
  }
}

async function getLatestBars() {
  const sb = await getAdminSupabase();
  const { data } = await sb
    .from("bar_data")
    .select("symbol, timeframe, time_utc, close")
    .order("time_utc", { ascending: false })
    .limit(200);
  return data ?? [];
}

export default async function MarketDataPage() {
  const [rt, bars] = await Promise.all([getRealtimeData(), getLatestBars()]);

  // シンボル別最新バー
  const latestBySymbolTF = new Map<string, { time: string; close: number }>();
  for (const b of bars) {
    const key = `${b.symbol}:${b.timeframe}`;
    if (!latestBySymbolTF.has(key)) latestBySymbolTF.set(key, { time: b.time_utc, close: b.close });
  }

  const symbols: Array<{ symbol: string; bid: number; ask: number; spread: number; time: number }> = rt.symbols;
  const account: { balance?: number; equity?: number; currency?: string; broker?: string; login?: number } | null = rt.account;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black tracking-widest" style={{ color: "var(--text-primary)" }}>市場データ</h2>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Admin MT5 DataManager経由のリアルタイム市場データ</p>
      </div>

      {/* Account Info */}
      {account && (
        <div className="rounded-xl p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
          <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>ADMIN MT5 ACCOUNT</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
            {[
              ["Broker",   account.broker ?? "―"],
              ["Login",    account.login  ? "****" + String(account.login).slice(-4) : "―"],
              ["残高",     account.balance ? `${account.balance.toLocaleString()} ${account.currency}` : "―"],
              ["有効証拠金", account.equity ? `${account.equity.toLocaleString()} ${account.currency}` : "―"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span style={{ color: "var(--text-muted)" }}>{k}</span>
                <span style={{ color: "var(--text-primary)" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Realtime Symbols */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <p className="text-[9px] font-black tracking-widest" style={{ color: "var(--text-muted)" }}>
            リアルタイム市場データ ({symbols.length} シンボル)
          </p>
        </div>
        {symbols.length === 0 ? (
          <p className="p-5 text-xs" style={{ color: "var(--text-muted)" }}>Gateway接続なし — DataManagerが停止しているか未接続です</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["シンボル", "Bid", "Ask", "スプレッド", "最終更新"].map(h => (
                    <th key={h} className="px-4 py-2 text-left font-mono" style={{ color: "var(--text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbols.slice(0, 30).map((s) => (
                  <tr key={s.symbol} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                    <td className="px-4 py-2 font-black" style={{ color: "var(--accent-cyan)" }}>{s.symbol}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-primary)" }}>{s.bid?.toFixed(5)}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-primary)" }}>{s.ask?.toFixed(5)}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-muted)" }}>{s.spread?.toFixed(1)}</td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text-muted)" }}>
                      {s.time ? new Date(s.time * 1000).toLocaleTimeString("ja-JP") : "―"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Supabase Latest Bars */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <p className="text-[9px] font-black tracking-widest" style={{ color: "var(--text-muted)" }}>
            SUPABASE 最新バー (Trading View / Backtest提供データ)
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Symbol:TF", "最新バー時刻", "終値"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-mono" style={{ color: "var(--text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(latestBySymbolTF.entries()).slice(0, 20).map(([key, v]) => (
                <tr key={key} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="px-4 py-2 font-black" style={{ color: "var(--accent-green)" }}>{key}</td>
                  <td className="px-4 py-2 font-mono" style={{ color: "var(--text-secondary)" }}>
                    {new Date(v.time).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-2 font-mono" style={{ color: "var(--text-primary)" }}>{v.close.toFixed(5)}</td>
                </tr>
              ))}
              {latestBySymbolTF.size === 0 && (
                <tr><td colSpan={3} className="px-4 py-4 text-xs" style={{ color: "var(--text-muted)" }}>データがありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
