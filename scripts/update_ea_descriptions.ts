/**
 * update_ea_descriptions.ts — 全EAのdescriptionに事実確認レポートを記録
 * Usage: npx tsx --env-file=.env.local scripts/update_ea_descriptions.ts
 */
export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };
const barCache = new Map<string, Bar[]>();

async function fetchBars(sym: string, tf: string): Promise<Bar[]> {
  const key = `${sym}_${tf}`;
  if (barCache.has(key)) return barCache.get(key)!;
  const rows: BarRow[] = [];
  let offset = 0;
  while (true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
          `&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=1000&offset=${offset}`,
          { headers: hdrs }
        );
        const b = await res.json() as BarRow[];
        rows.push(...b);
        if (b.length < 1000) {
          const bars = rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
          barCache.set(key, bars);
          return bars;
        }
        offset += 1000;
        break;
      } catch { if (attempt === 2) throw new Error(`fetch failed`); await new Promise(r => setTimeout(r,1000)); }
    }
  }
}

function wilsonCI(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = wins / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - spread) * 100, Math.min(1, center + spread) * 100];
}

async function getStrategies(): Promise<{ id: string; name: string; spec: StrategySpec }[]> {
  const res  = await fetch(`${SB_URL}/rest/v1/strategy_registry?select=id,name,symbols,timeframes,entry_conditions,exit_conditions,filters,risk,strategy_type&order=magic_number.asc`, { headers: hdrs });
  const rows = await res.json() as Record<string, unknown>[];
  return rows.map(r => ({ id: String(r.id), name: String(r.name), spec: r as unknown as StrategySpec }));
}

async function updateDescription(id: string, desc: string): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/strategy_registry?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...hdrs, "Content-Type": "application/json" },
    body: JSON.stringify({ description: desc }),
  });
}

async function main() {
  console.log("=== EA Description 事実レポート更新 ===\n");
  const strategies = await getStrategies();

  // バーデータ一括取得
  const symTfs = new Set<string>();
  for (const { spec } of strategies) {
    for (const tf of spec.timeframes) symTfs.add(`${spec.symbols[0]}_${tf}`);
  }
  process.stdout.write("バーデータ取得中");
  for (const key of symTfs) {
    const [sym, tf] = key.split("_");
    await fetchBars(sym, tf);
    process.stdout.write(".");
  }
  console.log(" 完了\n");

  let ok = 0;
  for (const { id, name, spec } of strategies) {
    const sym    = spec.symbols[0];
    const mainTf = spec.timeframes[0];
    const bars   = Object.fromEntries(spec.timeframes.map(tf => [tf, barCache.get(`${sym}_${tf}`) ?? []]));

    let desc = "";
    try {
      const r = runBacktest({ spec, symbol: sym, mainTimeframe: mainTf, barsByTimeframe: bars, initialBalance: 10000, fixedLot: 0.01 });
      const trades = r.trades;
      if (!trades.length) { desc = "バックテスト結果なし"; }
      else {
        const wins  = trades.filter(t => t.result === "WIN").length;
        const pips  = trades.reduce((s, t) => s + t.pips, 0);
        const wr    = wins / trades.length * 100;
        const gw    = trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
        const gl    = Math.abs(trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
        const pf    = gl > 0 ? gw / gl : Infinity;
        const [ciLo, ciHi] = wilsonCI(wins, trades.length);

        // IS/OOS
        const cutIdx  = Math.floor(trades.length * 0.7);
        const isTrd   = trades.slice(0, cutIdx);
        const oosTrd  = trades.slice(cutIdx);
        const isWR    = isTrd.length  > 0 ? isTrd.filter(t => t.result === "WIN").length  / isTrd.length  * 100 : 0;
        const oosWR   = oosTrd.length > 0 ? oosTrd.filter(t => t.result === "WIN").length / oosTrd.length * 100 : 0;
        const isPips  = isTrd.reduce((s, t) => s + t.pips, 0);
        const oosPips = oosTrd.reduce((s, t) => s + t.pips, 0);

        // Same-bar
        const sameBar = trades.filter(t => t.entryBarIdx === t.exitBarIdx).length;
        const sameBarPct = sameBar / trades.length * 100;

        // Monthly
        const monthly = new Map<string, number>();
        for (const t of trades) {
          const d = new Date(t.entryTime);
          const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
          monthly.set(k, (monthly.get(k) ?? 0) + t.pips);
        }
        const monthVals  = [...monthly.values()];
        const profitMon  = monthVals.filter(v => v > 0).length;
        const worstMonth = monthVals.length ? Math.min(...monthVals) : 0;

        // Verdict
        const flags: string[] = [];
        if (oosPips <= 0) flags.push("OOSで損失");
        if (oosWR < 28)   flags.push(`OOS WR${oosWR.toFixed(0)}%`);
        if (sameBarPct > 20) flags.push(`同バー率${sameBarPct.toFixed(0)}%高`);
        if (ciLo < 25)    flags.push(`CI下限${ciLo.toFixed(0)}%`);

        const verdict = flags.length === 0 ? "✅ 信頼できる" : flags.length <= 2 ? "⚠ 要注意" : "❌ 疑問あり";

        desc = [
          `【事実確認レポート】`,
          `登録日: ${new Date().toLocaleDateString("ja-JP")}`,
          ``,
          `◆ 全期間成績`,
          `  取引数: ${trades.length}件  勝率: ${wr.toFixed(1)}%  PIPS: ${pips >= 0 ? "+" : ""}${pips.toFixed(0)}  PF: ${pf === Infinity ? "∞" : pf.toFixed(2)}`,
          `  95%信頼区間 (WR): ${ciLo.toFixed(1)}〜${ciHi.toFixed(1)}%`,
          ``,
          `◆ IS/OOS検証 (70%/30%分割)`,
          `  IS（学習期間）: WR ${isWR.toFixed(1)}%  ${isPips >= 0 ? "+" : ""}${isPips.toFixed(0)}pips`,
          `  OOS（検証期間）: WR ${oosWR.toFixed(1)}%  ${oosPips >= 0 ? "+" : ""}${oosPips.toFixed(0)}pips`,
          ``,
          `◆ 品質指標`,
          `  同バー決済率: ${sameBarPct.toFixed(1)}% （20%以上で精度懸念）`,
          `  黒字月: ${profitMon}/${monthVals.length}ヶ月`,
          `  最悪月: ${worstMonth.toFixed(0)}pips`,
          ``,
          `◆ 総合判定: ${verdict}`,
          flags.length ? `  注意事項: ${flags.join(", ")}` : "  特記事項なし",
        ].join("\n");
      }
    } catch (e) {
      desc = `エラー: ${e}`;
    }

    await updateDescription(id, desc);
    console.log(`  ✓ ${name}`);
    ok++;
  }

  console.log(`\n=== 完了: ${ok}/${strategies.length} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
