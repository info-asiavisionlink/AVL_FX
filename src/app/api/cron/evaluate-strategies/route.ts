// =================================================================
// POST /api/cron/evaluate-strategies
// Vercel Cron: * * * * * (毎分)
//
// RUNNING状態のすべてのStrategyを評価してシグナルを生成。
// シグナルがBUY/SELLの場合、execution_commandsにINSERTする。
// AUTHORIZATION: Bearer CRON_SECRET env var
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { evaluateStrategy } from "@/infrastructure/backtest/evaluator";
import { precomputeIndicators } from "@/infrastructure/backtest/indicators";
import { StrategySpecSchema } from "@/lib/strategySchema";
import type { Bar } from "@/infrastructure/analysis/types";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

// ------------------------------------------------------------------
// Internal: Fetch bars from Gateway
// ------------------------------------------------------------------

interface GatewayBar {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

async function fetchBarsFromGateway(
  connectionId: string,
  symbol: string,
  tf: string,
  count = 500,
): Promise<Bar[]> {
  if (!GATEWAY_URL || !GATEWAY_SECRET) return [];
  try {
    const url = `${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol.toUpperCase())}/${tf.toUpperCase()}?count=${count}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as GatewayBar[];
    // Convert Gateway bars (broker seconds) to Bar type (time in ms for evaluator)
    // The evaluator uses bars[i].time; gateway returns broker seconds.
    // Keep as broker seconds — consistent with backtest bar format (evaluator uses
    // getLastConfirmedBarIndex which only compares relative times).
    return raw.map((b) => ({
      time:   b.time,
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------
// POST handler (Vercel Cron calls GET, but we handle both)
// ------------------------------------------------------------------

export async function GET(req: NextRequest) {
  return handleEvaluation(req);
}

export async function POST(req: NextRequest) {
  return handleEvaluation(req);
}

async function handleEvaluation(req: NextRequest) {
  // Vercel Cronからのリクエスト検証
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = createAdminClient();

  // 1. strategy_runtime_stateからruntime_status='RUNNING'の全strategyを取得
  const { data: runningStates, error: stateErr } = await db
    .from("strategy_runtime_state")
    .select("strategy_id, connection_id, runtime_status")
    .eq("runtime_status", "RUNNING");

  if (stateErr) {
    console.error("[evaluate-strategies] Failed to fetch running states:", stateErr);
    return NextResponse.json({ error: stateErr.message }, { status: 500 });
  }

  if (!runningStates || runningStates.length === 0) {
    return NextResponse.json({ ok: true, evaluated: 0, message: "No running strategies" });
  }

  const results: Array<{
    strategyId: string;
    signal: string;
    inserted: boolean;
    error?: string;
  }> = [];

  // 2. 各strategyについて評価
  for (const runtimeState of runningStates) {
    const strategyId  = runtimeState.strategy_id as string;
    const connectionId = runtimeState.connection_id as string | null;

    try {
      // a. strategy_registryからspec, magic_number, user_idを取得
      const { data: stratRow, error: stratErr } = await db
        .from("strategy_registry")
        .select("user_id, magic_number, symbols, timeframes, entry_conditions, exit_conditions, filters, risk, name, strategy_type, description")
        .eq("id", strategyId)
        .single();

      if (stratErr || !stratRow) {
        results.push({ strategyId, signal: "SKIP", inserted: false, error: "Strategy not found" });
        continue;
      }

      // Spec validation
      const rawSpec = {
        name:             stratRow.name,
        strategy_type:    stratRow.strategy_type,
        description:      stratRow.description,
        symbols:          stratRow.symbols,
        timeframes:       stratRow.timeframes,
        entry_conditions: stratRow.entry_conditions,
        exit_conditions:  stratRow.exit_conditions,
        filters:          stratRow.filters,
        risk:             stratRow.risk,
      };
      const specResult = StrategySpecSchema.safeParse(rawSpec);
      if (!specResult.success) {
        results.push({ strategyId, signal: "SKIP", inserted: false, error: "Invalid spec" });
        continue;
      }
      const spec = specResult.data;

      if (!connectionId) {
        results.push({ strategyId, signal: "SKIP", inserted: false, error: "No connection_id" });
        continue;
      }

      const symbol = spec.symbols[0];
      const mainTf = spec.timeframes[0];

      if (!symbol || !mainTf) {
        results.push({ strategyId, signal: "SKIP", inserted: false, error: "No symbol or timeframe" });
        continue;
      }

      // b. Collect all required timeframes for multi-TF evaluation
      const tfsSet = new Set<string>([mainTf]);
      if (spec.filters?.trend_filter?.timeframe) {
        tfsSet.add(spec.filters.trend_filter.timeframe);
      }
      if (spec.filters?.trend_filters) {
        for (const tf of spec.filters.trend_filters) {
          tfsSet.add(tf.timeframe);
        }
      }
      for (const cond of spec.entry_conditions.conditions) {
        tfsSet.add(cond.timeframe);
      }

      // c. Gateway からバーを取得
      const barsByTimeframe: Record<string, Bar[]> = {};
      for (const tf of tfsSet) {
        barsByTimeframe[tf] = await fetchBarsFromGateway(connectionId, symbol, tf, 500);
      }

      const mainBars = barsByTimeframe[mainTf] ?? [];
      if (mainBars.length === 0) {
        results.push({ strategyId, signal: "SKIP", inserted: false, error: "No bars from Gateway" });
        continue;
      }

      // d. precomputeIndicators で指標計算
      const indicatorsByTimeframe: Record<string, ReturnType<typeof precomputeIndicators>> = {};
      for (const [tf, bars] of Object.entries(barsByTimeframe)) {
        if (bars.length > 0) {
          indicatorsByTimeframe[tf] = precomputeIndicators(bars);
        }
      }

      // e. evaluateStrategy でシグナル評価
      const lastBar = mainBars[mainBars.length - 1]!;
      const signal = evaluateStrategy({
        spec,
        evaluationTime:        lastBar.time * 1000, // broker seconds → ms
        barsByTimeframe,
        indicatorsByTimeframe,
      });

      // f. 最終更新
      const nowIso = new Date().toISOString();
      const updatePayload: Record<string, unknown> = {
        last_evaluated_at: nowIso,
        updated_at:        nowIso,
      };

      if (signal === "BUY" || signal === "SELL") {
        updatePayload.last_signal_at = nowIso;

        // 既存のPENDING execution_commandsがないこと確認
        const { data: existingCmd } = await db
          .from("execution_commands")
          .select("id")
          .eq("strategy_id", strategyId)
          .eq("status", "PENDING")
          .limit(1)
          .single();

        if (!existingCmd) {
          // currentPrice (lastBar.close を使用)
          const currentPrice = lastBar.close;

          // SL/TP計算 (pips指定がある場合のみ計算、それ以外はnull)
          // ポイント値はシンボル依存だがデフォルト 0.00001 (FX標準)
          // XAUUSD等は 0.01 だが、安全のためにnullを許容
          let stopLoss:   number | null = null;
          let takeProfit: number | null = null;

          const slSpec = spec.exit_conditions?.stop_loss;
          const tpSpec = spec.exit_conditions?.take_profit;

          if (slSpec?.method === "FIXED_PIPS" && slSpec.pips) {
            const pointValue = 0.00001; // FX standard
            const slPips = slSpec.pips * pointValue * 10; // pips → price distance
            stopLoss = signal === "BUY"
              ? currentPrice - slPips
              : currentPrice + slPips;
          }

          if (tpSpec?.method === "FIXED_PIPS" && tpSpec.pips) {
            const pointValue = 0.00001;
            const tpPips = tpSpec.pips * pointValue * 10;
            takeProfit = signal === "BUY"
              ? currentPrice + tpPips
              : currentPrice - tpPips;
          }

          const { error: insertErr } = await db
            .from("execution_commands")
            .insert({
              command_id:   randomUUID(),
              user_id:      stratRow.user_id,
              connection_id: connectionId,
              strategy_id:  strategyId,
              magic_number: stratRow.magic_number,
              action:       signal,
              symbol:       symbol,
              volume:       0.01,
              stop_loss:    stopLoss,
              take_profit:  takeProfit,
              status:       "PENDING",
              expires_at:   new Date(Date.now() + 300_000).toISOString(),
              created_at:   nowIso,
            });

          if (insertErr) {
            console.error(`[evaluate-strategies] Insert command failed for ${strategyId}:`, insertErr);
            results.push({ strategyId, signal, inserted: false, error: insertErr.message });
          } else {
            results.push({ strategyId, signal, inserted: true });
          }
        } else {
          // 既にPENDINGあり — 重複insertしない
          results.push({ strategyId, signal, inserted: false, error: "Duplicate PENDING command" });
        }
      } else {
        results.push({ strategyId, signal, inserted: false });
      }

      // g. strategy_runtime_state.last_evaluated_at 更新
      await db
        .from("strategy_runtime_state")
        .update(updatePayload)
        .eq("strategy_id", strategyId);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[evaluate-strategies] Error for strategy ${strategyId}:`, msg);
      results.push({ strategyId, signal: "ERROR", inserted: false, error: msg });
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[evaluate-strategies] Evaluated ${runningStates.length} strategies in ${elapsed}ms`);

  return NextResponse.json({
    ok:         true,
    evaluated:  runningStates.length,
    results,
    elapsedMs:  elapsed,
  });
}
