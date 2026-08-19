// =================================================================
// syncJobStore.ts — market_data_sync_jobs Supabase 操作モジュール
//
// Data Phase B: Incremental Sync Job Management
//
// 責務:
//   - PENDING job の atomic claim (claim_next_sync_job RPC)
//   - Job 進捗・状態更新 (progress / COMPLETED / FAILED)
//   - FORWARD/BACKFILL の target range 計算 (bar_data の newest/oldest 取得)
//
// Supabase client: barDataStore.ts と同じ env vars を使用
//   SUPABASE_URL / SUPABASE_SERVICE_KEY(またはSUPABASE_SERVICE_ROLE_KEY)
//
// 設計:
//   - Gateway in-memory barStore に依存しない (bar_data が Source of Truth)
//   - fire-and-forget ではなく await する (job 管理は確実に更新が必要)
//   - エラー時は throw せず false / null を返して Gateway を止めない
// =================================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

// ------------------------------------------------------------------
// Supabase クライアント（barDataStore.ts と同一設定）
// ------------------------------------------------------------------

let _client: SupabaseClient | null = null;
let _initialized = false;

function getClient(): SupabaseClient | null {
  if (_initialized) return _client;
  _initialized = true;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[syncJob] SUPABASE_URL / SUPABASE_SERVICE_KEY 未設定 → sync job 機能スキップ");
    return null;
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: ws as any },
  });
  return _client;
}

// ------------------------------------------------------------------
// 定数
// ------------------------------------------------------------------

/** stale RUNNING job とみなすタイムアウト (ミリ秒)。Migration 015 の 5 分と合わせる。 */
export const SYNC_JOB_STALE_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------
// 型定義
// ------------------------------------------------------------------

export interface SyncJob {
  id:            string;
  symbol:        string;
  timeframe:     string;
  mode:          "FORWARD" | "BACKFILL";
  target_from:   number | null; // Unix epoch 秒
  target_to:     number | null; // Unix epoch 秒 (FORWARD では null → EA が TimeCurrent() を使用)
  current_from:  number | null; // Resume 起点 (最後に成功した chunk の次の開始時刻)
  current_to:    number | null; // 最後に成功した chunk の終了時刻
  status:        "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "PAUSED";
  updated_at?:   string | null; // stale 判定用
}

export interface ProgressUpdate {
  status:         "RUNNING" | "COMPLETED" | "FAILED";
  progress_pct?:  number;
  received_bars?: number;
  sent_bars?:     number;
  failed_batches?: number;
  current_from?:  number | null;
  current_to?:    number | null;
  error_message?: string | null;
}

// ------------------------------------------------------------------
// claimNextSyncJob — atomic PENDING→RUNNING 遷移
//
// claim_next_sync_job(p_symbol) RPC を呼び出す。
// 取得できなければ null を返す。
// ------------------------------------------------------------------

export async function claimNextSyncJob(symbol?: string): Promise<SyncJob | null> {
  const db = getClient();
  if (!db) return null;

  try {
    const { data, error } = await db
      .rpc("claim_next_sync_job", { p_symbol: symbol ?? null });

    if (error) {
      console.warn("[syncJob] claim_next_sync_job error:", error.message);
      return null;
    }

    const rows = data as SyncJob[] | null;
    if (!rows || rows.length === 0) return null;

    const job = rows[0]!;
    const isResumed = (job.current_from ?? 0) > 0;
    console.log(
      `[syncJob] CLAIMED job=${job.id} ${job.symbol}:${job.timeframe} mode=${job.mode}` +
      (isResumed ? ` (RESUME from current_from=${job.current_from})` : "")
    );
    return job;

  } catch (err) {
    console.warn("[syncJob] claimNextSyncJob exception:", err);
    return null;
  }
}

// ------------------------------------------------------------------
// updateSyncJobProgress — 進捗・状態を Supabase に書き込む
// ------------------------------------------------------------------

export async function updateSyncJobProgress(
  jobId: string,
  update: ProgressUpdate,
): Promise<boolean> {
  const db = getClient();
  if (!db) return false;

  const patch: Record<string, unknown> = {
    status:         update.status,
    updated_at:     new Date().toISOString(),
  };

  if (update.progress_pct  !== undefined) patch.progress_pct  = update.progress_pct;
  if (update.received_bars !== undefined) patch.received_bars = update.received_bars;
  if (update.sent_bars     !== undefined) patch.sent_bars     = update.sent_bars;
  if (update.failed_batches !== undefined) patch.failed_batches = update.failed_batches;
  if (update.current_from  !== undefined) patch.current_from  = update.current_from;
  if (update.current_to    !== undefined) patch.current_to    = update.current_to;
  if (update.error_message !== undefined) patch.error_message = update.error_message;

  if (update.status === "COMPLETED") patch.completed_at = new Date().toISOString();

  try {
    const { error } = await db
      .from("market_data_sync_jobs")
      .update(patch)
      .eq("id", jobId);

    if (error) {
      console.warn(`[syncJob] updateProgress error job=${jobId}:`, error.message);
      return false;
    }
    return true;

  } catch (err) {
    console.warn("[syncJob] updateSyncJobProgress exception:", err);
    return false;
  }
}

// ------------------------------------------------------------------
// createSyncJob — 新規 Sync Job を INSERT する
//
// target_from / target_to の計算は Next.js API 側で行う。
// Gateway は EA からの呼び出しを仲介するだけなので、
// Job 作成は Next.js API Route が直接 Supabase に INSERT する。
// ここでは Gateway からも作れるように helper を提供する。
// ------------------------------------------------------------------

export interface CreateJobParams {
  symbol:       string;
  timeframe:    string;
  mode:         "FORWARD" | "BACKFILL";
  target_from:  number | null;
  target_to:    number | null;
}

export async function createSyncJob(params: CreateJobParams): Promise<string | null> {
  const db = getClient();
  if (!db) return null;

  try {
    const { data, error } = await db
      .from("market_data_sync_jobs")
      .insert({
        symbol:      params.symbol.toUpperCase(),
        timeframe:   params.timeframe.toUpperCase(),
        mode:        params.mode,
        target_from: params.target_from,
        target_to:   params.target_to,
        status:      "PENDING",
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[syncJob] createSyncJob error:", error.message);
      return null;
    }

    const row = data as { id: string } | null;
    return row?.id ?? null;

  } catch (err) {
    console.warn("[syncJob] createSyncJob exception:", err);
    return null;
  }
}

// ------------------------------------------------------------------
// getBarDataRange — bar_data から newest / oldest を取得
//
// Next.js API と Gateway の両方から呼べる純粋なユーティリティ。
// bar_data の Source of Truth から target range を計算する。
// ------------------------------------------------------------------

export interface BarDataRange {
  oldest_epoch: number | null; // Unix epoch 秒
  newest_epoch: number | null;
}

export async function getBarDataRange(
  symbol: string,
  timeframe: string,
): Promise<BarDataRange> {
  const db = getClient();
  if (!db) return { oldest_epoch: null, newest_epoch: null };

  try {
    // MIN / MAX を get_bar_data_status() RPC から取得
    const { data, error } = await db
      .rpc("get_bar_data_status");

    if (error) {
      console.warn("[syncJob] get_bar_data_status error:", error.message);
      return { oldest_epoch: null, newest_epoch: null };
    }

    const rows = data as Array<{
      symbol: string;
      timeframe: string;
      oldest_bar: string;
      newest_bar: string;
    }> | null;

    const row = rows?.find(
      r => r.symbol === symbol.toUpperCase() && r.timeframe === timeframe.toUpperCase()
    );

    if (!row) return { oldest_epoch: null, newest_epoch: null };

    return {
      oldest_epoch: row.oldest_bar ? Math.floor(new Date(row.oldest_bar).getTime() / 1000) : null,
      newest_epoch: row.newest_bar ? Math.floor(new Date(row.newest_bar).getTime() / 1000) : null,
    };

  } catch (err) {
    console.warn("[syncJob] getBarDataRange exception:", err);
    return { oldest_epoch: null, newest_epoch: null };
  }
}

// ------------------------------------------------------------------
// TF_ToSeconds — timeframe 文字列 → 秒数
// EA 側と同一ロジック（UTC 計算用）
// ------------------------------------------------------------------

export function tfToSeconds(timeframe: string): number {
  switch (timeframe.toUpperCase()) {
    case "M1":  return 60;
    case "M5":  return 300;
    case "M15": return 900;
    case "M30": return 1800;
    case "H1":  return 3600;
    case "H4":  return 14400;
    case "D1":  return 86400;
    case "W1":  return 604800;
    default:    return 0;  // unsupported
  }
}

export const SUPPORTED_TIMEFRAMES = new Set(["M1","M5","M15","M30","H1","H4","D1","W1"]);

// ------------------------------------------------------------------
// isStaleJob — RUNNING job が stale かどうかを判定
// ------------------------------------------------------------------

export function isStaleJob(job: { status: string; updated_at?: string | null }): boolean {
  if (job.status !== "RUNNING") return false;
  if (!job.updated_at) return true; // updated_at がなければ stale とみなす
  const age = Date.now() - new Date(job.updated_at).getTime();
  return age > SYNC_JOB_STALE_MS;
}

export function jobAgeSeconds(job: { updated_at?: string | null }): number {
  if (!job.updated_at) return 0;
  return Math.floor((Date.now() - new Date(job.updated_at).getTime()) / 1000);
}
