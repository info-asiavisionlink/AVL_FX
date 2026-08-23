/**
 * run_backtest_for_new_eas.ts
 * 新規登録した7本のEAのバックテストを正式実行してDB保存する
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/run_backtest_for_new_eas.ts
 */

export {};

const BASE_URL = "https://avl-fx.vercel.app";  // 本番URL
// ローカルなら: const BASE_URL = "http://localhost:3000";

const STRATEGY_IDS = [
  { id: "fca9aa44-8fa6-45d6-bda4-339e4d6f437c", name: "H1 Ichimoku Cloud BUY" },
  { id: "34e8b3f1-42da-4a80-a634-9968eb3a723f", name: "H1 AO EMA MACD Triple BUY" },
  { id: "2f0c3adb-f371-49a1-b154-5e2904f840b4", name: "H1 Ichimoku MACD BUY" },
  { id: "13a361fd-1d5b-4cc0-91a3-23905beadcc4", name: "H1 Ichimoku RSI BUY" },
  { id: "d5ae40f3-73c5-4e45-bd6e-737e47c3223d", name: "H1 Ichimoku ADX BUY" },
  { id: "e082d49e-67a1-4811-a383-fc58086bcb3e", name: "H1 AO MACD BUY" },
  { id: "7d8db586-4f3b-4a1c-8004-dbfdc303ca7b", name: "H1 Ichimoku RSI MACD BUY" },
];

async function main() {
  console.log(`=== Backtest Job Runner ===`);
  console.log(`Target: ${BASE_URL}\n`);

  for (const { id, name } of STRATEGY_IDS) {
    process.stdout.write(`  Running: ${name} ... `);
    try {
      const res = await fetch(`${BASE_URL}/api/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId: id, period: "AVAILABLE", initialBalance: 10000 }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.log(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
        continue;
      }

      const data = await res.json() as {
        status: string;
        report?:  { totalTrades: number; winRate: number; totalPips: number; verdict: string };
        result?:  { total_trades: number; win_rate: number; total_pips: number; verdict: string };
      };
      const r = data.report ?? (data.result ? { totalTrades: data.result.total_trades, winRate: data.result.win_rate, totalPips: data.result.total_pips, verdict: data.result.verdict } : null);
      if ((data.status === "COMPLETED") && r) {
        console.log(`✅ T=${r.totalTrades} WR=${r.winRate.toFixed(1)}% Pips=${r.totalPips.toFixed(1)} → ${r.verdict}`);
      } else {
        console.log(`⚠ ${JSON.stringify(data).slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`❌ ${e}`);
    }

    // サーバー負荷軽減のため少し待機
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("\n=== Done ===");
}

main().catch(e => { console.error(e); process.exit(1); });
