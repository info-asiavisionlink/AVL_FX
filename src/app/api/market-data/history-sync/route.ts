// =================================================================
// POST /api/market-data/history-sync
// GET  /api/market-data/history-sync
//
// Data Phase B — Incremental Sync Job 作成 / 状態確認
//
// POST: FORWARD または BACKFILL の Sync Job を作成する。
//   - Supabase bar_data から現在の newest/oldest を取得 (Source of Truth)
//   - target_from / target_to をサーバー側で計算 (クライアント入力に依存しない)
//   - PENDING または RUNNING の重複 job があればエラーを返す
//
// GET: 全 Sync Job の一覧を返す。
//
// Body (POST):
//   {
//     "symbol":      "EURUSD",
//     "timeframe":   "M5",
//     "mode":        "FORWARD" | "BACKFILL",
//     "target_from": "2024-08-25T00:00:00Z"  // BACKFILL のみ、省略時は oldest - 12 months
//   }
//
// 設計:
//   - GET /data-commands/pending で EA が取得 → Gateway 経由で実行
//   - target_from / target_to は epoch 秒 (integer) で保存
//   - FORWARD: target_to = null (EA が TimeCurrent() を使用)
//   - BACKFILL: target_to = oldest bar epoch 秒
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

const SUPPORTED_TIMEFRAMES = new Set(["M1","M5","M15","M30","H1","H4","D1","W1"]);
const BACKFILL_DEFAULT_MONTHS = 12;

/** timeframe 文字列 → 秒数（EA 側と同一ロジック） */
function tfToSeconds(tf: string): number {
  const map: Record<string, number> = {
    M1: 60, M5: 300, M15: 900, M30: 1800,
    H1: 3600, H4: 14400, D1: 86400, W1: 604800,
  };
  return map[tf.toUpperCase()] ?? 0;
}

// ------------------------------------------------------------------
// GET — Job 一覧
// ------------------------------------------------------------------

export async function GET(_req: NextRequest) {
  const db = createAdminClient();

  const { data, error } = await db
    .from("market_data_sync_jobs")
    .select("id, symbol, timeframe, mode, status, progress_pct, received_bars, sent_bars, failed_batches, target_from, target_to, started_at, completed_at, created_at, error_message")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ jobs: data ?? [] });
}

// ------------------------------------------------------------------
// POST — Job 作成
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const db = createAdminClient();

  let body: {
    symbol?:      string;
    timeframe?:   string;
    mode?:        string;
    target_from?: string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── バリデーション ──────────────────────────────────────────────

  const symbol    = body.symbol?.toUpperCase();
  const timeframe = body.timeframe?.toUpperCase();
  const mode      = body.mode?.toUpperCase() as "FORWARD" | "BACKFILL" | undefined;

  if (!symbol)    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  if (!timeframe) return NextResponse.json({ error: "timeframe is required" }, { status: 400 });
  if (!mode || !["FORWARD", "BACKFILL"].includes(mode)) {
    return NextResponse.json({ error: "mode must be FORWARD or BACKFILL" }, { status: 400 });
  }
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
    return NextResponse.json(
      { error: `timeframe must be one of: ${[...SUPPORTED_TIMEFRAMES].join(", ")}` },
      { status: 400 },
    );
  }

  const tfSec = tfToSeconds(timeframe);

  // ── 現在の bar_data 範囲を取得 (Source of Truth) ───────────────

  const { data: statusRows, error: statusErr } = await db
    .rpc("get_bar_data_status");

  if (statusErr) {
    return NextResponse.json({ error: `Failed to read bar_data status: ${statusErr.message}` }, { status: 500 });
  }

  const rangeRow = (statusRows as Array<{
    symbol: string; timeframe: string;
    oldest_bar: string | null; newest_bar: string | null;
  }>).find(r => r.symbol === symbol && r.timeframe === timeframe);

  // ── 重複ジョブチェック ──────────────────────────────────────────

  const { data: existingJobs, error: existErr } = await db
    .from("market_data_sync_jobs")
    .select("id, status")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .in("status", ["PENDING", "RUNNING"])
    .limit(1);

  if (existErr) {
    return NextResponse.json({ error: `DB error: ${existErr.message}` }, { status: 500 });
  }
  if (existingJobs && existingJobs.length > 0) {
    return NextResponse.json(
      { error: `Active job already exists for ${symbol}/${timeframe} (status: ${existingJobs[0]!.status}). Wait for it to complete or cancel it first.` },
      { status: 409 },
    );
  }

  // ── target_from / target_to を決定 ─────────────────────────────

  let targetFrom: number | null = null;
  let targetTo:   number | null = null;

  if (mode === "FORWARD") {
    if (!rangeRow?.newest_bar) {
      return NextResponse.json(
        { error: `No existing bar_data for ${symbol}/${timeframe}. Run a Full History Sync (Phase A) first.` },
        { status: 422 },
      );
    }
    // target_from = newest bar + 1 tfSec (次のbar開始時刻)
    const newestEpoch = Math.floor(new Date(rangeRow.newest_bar).getTime() / 1000);
    targetFrom = newestEpoch + tfSec;
    targetTo   = null; // EA が TimeCurrent() を使用
  } else {
    // BACKFILL
    if (!rangeRow?.oldest_bar) {
      return NextResponse.json(
        { error: `No existing bar_data for ${symbol}/${timeframe}. Run a Full History Sync (Phase A) first.` },
        { status: 422 },
      );
    }
    const oldestEpoch = Math.floor(new Date(rangeRow.oldest_bar).getTime() / 1000);
    // target_to = existing oldest bar time (confirmedTo ロジックが -tfSec してくれる)
    targetTo = oldestEpoch;

    if (body.target_from) {
      const parsed = new Date(body.target_from);
      if (isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "target_from is not a valid ISO date" }, { status: 400 });
      }
      targetFrom = Math.floor(parsed.getTime() / 1000);
    } else {
      // デフォルト: oldest から 12 ヶ月前
      targetFrom = oldestEpoch - BACKFILL_DEFAULT_MONTHS * 30 * 86400;
    }

    if (targetFrom >= targetTo) {
      return NextResponse.json(
        { error: `target_from (${new Date(targetFrom * 1000).toISOString()}) must be before existing oldest (${rangeRow.oldest_bar}).` },
        { status: 422 },
      );
    }
  }

  // ── Job INSERT ─────────────────────────────────────────────────

  const { data: inserted, error: insertErr } = await db
    .from("market_data_sync_jobs")
    .insert({
      symbol,
      timeframe,
      mode,
      target_from: targetFrom,
      target_to:   targetTo,
      status:      "PENDING",
    })
    .select("id, symbol, timeframe, mode, target_from, target_to, status, created_at")
    .single();

  if (insertErr || !inserted) {
    // 一意制約違反（concurrent insert race）
    if (insertErr?.code === "23505") {
      return NextResponse.json(
        { error: `Concurrent active job for ${symbol}/${timeframe}. Please retry later.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: `Failed to create job: ${insertErr?.message}` }, { status: 500 });
  }

  return NextResponse.json({
    jobId:       inserted.id,
    symbol:      inserted.symbol,
    timeframe:   inserted.timeframe,
    mode:        inserted.mode,
    target_from: inserted.target_from,
    target_to:   inserted.target_to,
    status:      inserted.status,
    created_at:  inserted.created_at,
    message:     `Sync job created. MT5 EA will pick it up within ${mode === "FORWARD" ? "30" : "30"}s if connected.`,
  }, { status: 201 });
}
