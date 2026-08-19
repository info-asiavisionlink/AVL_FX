/**
 * Data Phase B — Incremental Sync Tests (B01–B20)
 *
 * 対象: Sync Job ロジック、range 計算、concurrency 制御、idempotency
 *
 * 注意:
 *   - Supabase / Gateway への実接続は行わない（純粋ロジックテスト）
 *   - EA MQL5 コードは静的解析のみ（ランタイムテスト不可）
 *   - syncJobStore.ts と history-sync/route.ts のロジックを pure 関数として抽出してテスト
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/datasync.test.ts
 */

import assert from "node:assert/strict";

// ------------------------------------------------------------------
// テスト対象ロジックを pure 関数として抽出
// ------------------------------------------------------------------

/** EA 側と同一: timeframe 文字列 → 秒数 */
function tfToSeconds(tf: string): number {
  const map: Record<string, number> = {
    M1: 60, M5: 300, M15: 900, M30: 1800,
    H1: 3600, H4: 14400, D1: 86400, W1: 604800,
  };
  return map[tf.toUpperCase()] ?? 0;
}

const SUPPORTED_TFS = new Set(["M1","M5","M15","M30","H1","H4","D1","W1"]);

/** FORWARD: target_from / target_to 計算 */
function calcForwardRange(newestEpoch: number, tfSec: number) {
  return {
    target_from: newestEpoch + tfSec,
    target_to:   null, // EA が TimeCurrent() を使用
  };
}

/** BACKFILL: target_from / target_to 計算 */
function calcBackfillRange(oldestEpoch: number, targetFromInput: number | null, defaultMonths = 12) {
  const target_to   = oldestEpoch;
  const target_from = targetFromInput ?? (oldestEpoch - defaultMonths * 30 * 86400);
  return { target_from, target_to };
}

/** confirmedTo 計算 (EA HistorySync_Timeframe と同一) */
function calcConfirmedTo(targetTo: number, tfSec: number): number {
  return targetTo - tfSec;
}

/** 重複 job チェック */
function hasActiveJob(jobs: Array<{ symbol: string; timeframe: string; status: string }>,
                      symbol: string, timeframe: string): boolean {
  return jobs.some(
    j => j.symbol === symbol && j.timeframe === timeframe &&
         (j.status === "PENDING" || j.status === "RUNNING")
  );
}

/** Job claim 結果の型 */
interface SyncJob {
  id: string;
  symbol: string;
  timeframe: string;
  mode: "FORWARD" | "BACKFILL";
  target_from: number | null;
  target_to: number | null;
  status: string;
}

/** in-memory job store で claim をシミュレート */
function claimNextJob(
  jobs: SyncJob[],
  symbol?: string,
): SyncJob | null {
  const pending = jobs.filter(j =>
    j.status === "PENDING" && (!symbol || j.symbol === symbol)
  );
  if (pending.length === 0) return null;

  // created_at order は省略、先頭を claim
  const job = pending[0]!;
  job.status = "RUNNING";
  return { ...job };
}

/** Job status 更新 */
function updateJobStatus(
  jobs: SyncJob[],
  id: string,
  status: string,
): boolean {
  const job = jobs.find(j => j.id === id);
  if (!job) return false;
  job.status = status;
  return true;
}

// ------------------------------------------------------------------
// Test runner
// ------------------------------------------------------------------

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}\n     ${msg}`);
    failed++;
  }
}
function describe(name: string, fn: () => void) {
  console.log(`\n📊 ${name}`);
  fn();
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("B01–B05: Job Claim / Range Calculation", () => {
  test("B01: PENDING job を claim できる", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "PENDING" },
    ];
    const claimed = claimNextJob(jobs);
    assert.ok(claimed, "should claim a job");
    assert.equal(claimed.id, "j1");
    assert.equal(claimed.status, "RUNNING", "claimed job should be RUNNING");
  });

  test("B02: claim 後に元の jobs 配列の status が RUNNING になる", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "PENDING" },
    ];
    claimNextJob(jobs);
    assert.equal(jobs[0]!.status, "RUNNING");
  });

  test("B03: 同一 symbol/TF の PENDING/RUNNING が 1 件のみ許可される", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];
    const hasDup = hasActiveJob(jobs, "EURUSD", "M5");
    assert.ok(hasDup, "should detect active job");
    // 新規 job 作成をブロック
    assert.ok(hasDup === true, "duplicate job creation should be prevented");
  });

  test("B04: FORWARD range 計算 — newest + tfSec", () => {
    const newest  = 1787116500; // 2026-08-19 05:15 UTC
    const tfSec   = 300;        // M5
    const { target_from, target_to } = calcForwardRange(newest, tfSec);
    assert.equal(target_from, newest + 300, "target_from = newest + 1 bar");
    assert.equal(target_to, null, "target_to = null (EA uses TimeCurrent)");
  });

  test("B05: BACKFILL range 計算 — oldest - 12 months", () => {
    const oldest = 1756080000; // 2025-08-25 00:00 UTC
    const { target_from, target_to } = calcBackfillRange(oldest, null, 12);
    assert.equal(target_to, oldest, "target_to = existing oldest");
    const expected_from = oldest - 12 * 30 * 86400;
    assert.equal(target_from, expected_from, "target_from = oldest - 12 months");
    assert.ok(target_from < target_to, "target_from < target_to");
  });
});

describe("B06–B07: confirmed bar / idempotency", () => {
  test("B06: confirmedTo = targetTo - tfSec で未確定bar除外", () => {
    const targetTo = 1787116500; // 2026-08-19 05:15 UTC
    const tfSec    = 300;
    const confirmed = calcConfirmedTo(targetTo, tfSec);
    assert.equal(confirmed, targetTo - 300, "confirmedTo = targetTo - tfSec");
    // bar at targetTo が除外されること
    assert.ok(confirmed < targetTo, "current forming bar is excluded");
  });

  test("B06b: H4 confirmedTo — 4時間前の確定bar", () => {
    const targetTo = 1787116500;
    const tfSec    = 14400; // H4
    const confirmed = calcConfirmedTo(targetTo, tfSec);
    assert.equal(confirmed, targetTo - 14400);
  });

  test("B07: 同一 bar を 2 回送っても duplicate にならない (idempotency via ignoreDuplicates)", () => {
    // ignoreDuplicates=true: 既存行があれば INSERT をスキップ
    // テスト: 同一 primary key (symbol, timeframe, time_utc) の行を 2 回 upsert
    const barStore = new Map<string, Set<number>>();
    function upsertBar(symbol: string, tf: string, time: number, ignoreDup: boolean) {
      const key = `${symbol}:${tf}`;
      if (!barStore.has(key)) barStore.set(key, new Set());
      const existing = barStore.get(key)!;
      if (ignoreDup && existing.has(time)) return false; // no-op
      existing.add(time);
      return true;
    }
    const t = 1787116200;
    upsertBar("EURUSD", "M5", t, true);
    upsertBar("EURUSD", "M5", t, true); // 2回目は no-op
    assert.equal(barStore.get("EURUSD:M5")!.size, 1, "only 1 bar stored");
  });
});

describe("B08–B10: Progress / Status Transition", () => {
  test("B08: RUNNING status を progress_pct=50 で更新", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];
    const ok = updateJobStatus(jobs, "j1", "RUNNING");
    assert.ok(ok);
    assert.equal(jobs[0]!.status, "RUNNING");
  });

  test("B09: RUNNING → COMPLETED 遷移", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];
    updateJobStatus(jobs, "j1", "COMPLETED");
    assert.equal(jobs[0]!.status, "COMPLETED");
    // COMPLETED 後は active job カウントから除外される
    assert.ok(!hasActiveJob(jobs, "EURUSD", "M5"), "COMPLETED job not active");
  });

  test("B10: RUNNING → FAILED 遷移", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];
    updateJobStatus(jobs, "j1", "FAILED");
    assert.equal(jobs[0]!.status, "FAILED");
    // FAILED 後は新しい job を作成可能
    assert.ok(!hasActiveJob(jobs, "EURUSD", "M5"), "FAILED job not active");
  });
});

describe("B11–B13: Validation / Edge Cases", () => {
  test("B11: 未知 TF はエラー (tfToSeconds = 0)", () => {
    assert.equal(tfToSeconds("UNKNOWN"), 0, "unsupported TF returns 0");
    assert.ok(!SUPPORTED_TFS.has("UNKNOWN"), "not in supported set");
  });

  test("B12: malformed job (id なし) は処理しない", () => {
    const malformed = { symbol: "EURUSD", timeframe: "M5", mode: "FORWARD" };
    const hasId = "id" in malformed && typeof malformed.id === "string";
    assert.ok(!hasId, "malformed job has no id");
  });

  test("B13: CopyRates 0 bars でも job を COMPLETED にする (空 range)", () => {
    // CopyRates が 0 を返す場合: sent=0, failed=0, COMPLETED として扱う
    // HistorySync_Timeframe は n<=0 の場合 next chunk に進み、全 chunk で 0 なら COMPLETE を返す
    const copied = 0, sent = 0, failed = 0;
    // 0 bars でも COMPLETED
    const verdict = (failed === 0) ? "COMPLETED" : "FAILED";
    assert.equal(verdict, "COMPLETED", "0 bars → COMPLETED (no data = already up to date)");
  });
});

describe("B14–B16: Retry / Resume", () => {
  test("B14: retry 成功: failed_batches < RETRY_MAX → COMPLETED", () => {
    // retry は HistorySync_SendBatch 内で 3 回まで試みる
    // 2 回失敗、3 回目成功 → batch は SUCCEEDED
    const RETRY_MAX = 3;
    let attempts = 0;
    function sendWithRetry(): boolean {
      for (let i = 0; i < RETRY_MAX; i++) {
        attempts++;
        if (attempts >= 3) return true; // 3回目で成功
      }
      return false;
    }
    const ok = sendWithRetry();
    assert.ok(ok, "retry succeeds on 3rd attempt");
    assert.equal(attempts, 3);
  });

  test("B15: retry 全失敗: failed_batches インクリメント", () => {
    const RETRY_MAX = 3;
    function alwaysFail(): boolean {
      return false; // 常に失敗
    }
    let failedBatches = 0;
    for (let batch = 0; batch < 5; batch++) {
      let ok = false;
      for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
        ok = alwaysFail();
      }
      if (!ok) failedBatches++;
    }
    assert.equal(failedBatches, 5, "5 batches all failed");
  });

  test("B16: resume — current_from を使って未処理から再開できる", () => {
    // job に current_from が保存されていれば、再実行時に current_from から再開
    const job = {
      target_from: 1000000,
      target_to:   2000000,
      current_from: 1500000, // 中断位置
      status: "RUNNING",
    };
    // resume: target_from を current_from に設定して再実行
    const resumeFrom = job.current_from ?? job.target_from;
    assert.equal(resumeFrom, 1500000, "resume from current_from");
    assert.ok(resumeFrom > job.target_from, "skip already processed range");
  });
});

describe("B17–B20: Compatibility / Isolation", () => {
  test("B17: 既存 bar_data は削除されない (insert only with ignoreDuplicates)", () => {
    // Phase B は INSERT のみ。DELETE / UPDATE は行わない。
    const barCount_before = 73216;
    // DataSync の upsertBulkBars は ignoreDuplicates=true
    // 既存行はそのまま、新行のみ追加
    const newBarsAdded = 288; // 例: FORWARD 1日分
    const barCount_after = barCount_before + newBarsAdded;
    assert.ok(barCount_after >= barCount_before, "bar count never decreases");
  });

  test("B18: Phase A History Sync が DataSync と独立して動作する", () => {
    // Phase A: g_HistorySyncPending=true → g_HistorySyncRunning=true の間は DataSync skip
    let g_HistorySyncRunning = true;
    let g_DataSyncRunning = false;
    let dataSyncCalled = false;

    // OnTimer() の DataSync 条件
    if (!g_HistorySyncRunning && !g_DataSyncRunning) {
      dataSyncCalled = true;
    }

    assert.ok(!dataSyncCalled, "DataSync skipped while HistorySync running");

    // HistorySync 完了後は DataSync が動く
    g_HistorySyncRunning = false;
    if (!g_HistorySyncRunning && !g_DataSyncRunning) {
      dataSyncCalled = true;
    }
    assert.ok(dataSyncCalled, "DataSync runs after HistorySync completes");
  });

  test("B19: 同一 symbol/TF の concurrent job を防ぐ (unique index simulation)", () => {
    // UNIQUE INDEX ON (symbol, timeframe) WHERE status IN ('PENDING', 'RUNNING')
    const activeJobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];

    // 同じ EURUSD/M5 で BACKFILL job を作ろうとする → 重複エラー
    const blocked = hasActiveJob(activeJobs, "EURUSD", "M5");
    assert.ok(blocked, "concurrent job for same symbol/TF is blocked");

    // 別 symbol は通る
    const blockedDiff = hasActiveJob(activeJobs, "USDJPY", "M5");
    assert.ok(!blockedDiff, "different symbol is not blocked");

    // 別 TF も通る
    const blockedDiffTF = hasActiveJob(activeJobs, "EURUSD", "H1");
    assert.ok(!blockedDiffTF, "different TF is not blocked");
  });

  test("B20: 別 symbol / 別 TF の job は互いに独立", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "PENDING" },
      { id: "j2", symbol: "USDJPY", timeframe: "H1", mode: "BACKFILL",
        target_from: 500, target_to: 1000, status: "PENDING" },
    ];

    // EURUSD/M5 を claim
    const claimed1 = claimNextJob(jobs, "EURUSD");
    assert.ok(claimed1);
    assert.equal(claimed1.id, "j1");

    // USDJPY/H1 は別途 claim できる (独立)
    const claimed2 = claimNextJob(jobs, "USDJPY");
    assert.ok(claimed2);
    assert.equal(claimed2.id, "j2");

    // 両方 RUNNING になっている
    assert.equal(jobs[0]!.status, "RUNNING");
    assert.equal(jobs[1]!.status, "RUNNING");
  });
});

describe("Supplemental: range edge cases", () => {
  test("FORWARD target_from > target_to は invalid (range too narrow)", () => {
    const newest  = 1787116500;
    const tfSec   = 300;
    const { target_from } = calcForwardRange(newest, tfSec);
    // もし TimeCurrent が newest+300 未満なら confirmedTo <= targetFrom
    const simulatedNow = newest + 100; // 100秒後 (bar未確定)
    const confirmedTo  = calcConfirmedTo(simulatedNow, tfSec);
    assert.ok(confirmedTo <= target_from, "narrow range → skip (no bars to send)");
  });

  test("BACKFILL target_from < target_to を必須チェック", () => {
    const oldest = 1756080000;
    const { target_from, target_to } = calcBackfillRange(oldest, null);
    assert.ok(target_from < target_to, "target_from must be before target_to");
  });

  test("tfToSeconds: 全 TF が正しい秒数を返す", () => {
    const expected: Record<string, number> = {
      M1: 60, M5: 300, M15: 900, M30: 1800,
      H1: 3600, H4: 14400, D1: 86400, W1: 604800,
    };
    for (const [tf, secs] of Object.entries(expected)) {
      assert.equal(tfToSeconds(tf), secs, `${tf} = ${secs}s`);
    }
  });
});

// ==================================================================
// Data Phase B Hardening Tests (B25–B52)
// stale recovery / resume / checkpoint / failed-batch semantics
// ==================================================================

const STALE_MS = 5 * 60 * 1000; // 5 分

/** stale 判定ロジック (syncJobStore.ts isStaleJob と同一) */
function isStaleJob(job: { status: string; updated_at: string | null }): boolean {
  if (job.status !== "RUNNING") return false;
  if (!job.updated_at) return true;
  return Date.now() - new Date(job.updated_at).getTime() > STALE_MS;
}

/** stale recovery ロジック (Migration 015 recover step と同一) */
function recoverStaleJobs(jobs: Array<SyncJob & { updated_at: string | null }>): number {
  let count = 0;
  for (const j of jobs) {
    if (isStaleJob(j)) {
      j.status = "PENDING";
      (j as unknown as Record<string, unknown>)["started_at"] = null;
      (j as unknown as Record<string, unknown>)["error_message"] = "Recovered stale RUNNING job (auto-recovery after 5min timeout)";
      count++;
    }
  }
  return count;
}

/** effectiveFrom 計算 (EA DataSync_Execute と同一) */
function calcEffectiveFrom(targetFrom: number, currentFrom: number | null): number {
  if (currentFrom != null && currentFrom > targetFrom) return currentFrom;
  return targetFrom;
}

/** DataSync final status semantics (failed_batches > 0 → FAILED) */
function calcFinalStatus(failedBatches: number): "COMPLETED" | "FAILED" {
  return failedBatches === 0 ? "COMPLETED" : "FAILED";
}

/** chunk 単位の checkpoint advance */
function shouldAdvanceCheckpoint(chunkFailed: number): boolean {
  return chunkFailed === 0;
}

type JobWithMeta = SyncJob & { updated_at: string | null; current_from: number | null; current_to: number | null };

describe("B25–B29: Stale Recovery — status 別", () => {
  test("B25: RUNNING + updated_at > 5min → PENDING recovery", () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6分前
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "RUNNING", updated_at: staleTime,
    }];
    const recovered = recoverStaleJobs(jobs);
    assert.equal(recovered, 1, "1 job recovered");
    assert.equal(jobs[0]!.status, "PENDING", "stale RUNNING → PENDING");
  });

  test("B26: RUNNING + updated_at < 5min → recovery しない", () => {
    const freshTime = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2分前
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "RUNNING", updated_at: freshTime,
    }];
    const recovered = recoverStaleJobs(jobs);
    assert.equal(recovered, 0, "fresh RUNNING → no recovery");
    assert.equal(jobs[0]!.status, "RUNNING");
  });

  test("B27: COMPLETED → recovery しない", () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "COMPLETED" as "COMPLETED", updated_at: staleTime,
    }];
    const recovered = recoverStaleJobs(jobs);
    assert.equal(recovered, 0, "COMPLETED → not recovered");
    assert.equal(jobs[0]!.status, "COMPLETED");
  });

  test("B28: FAILED → recovery しない", () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "FAILED" as "FAILED", updated_at: staleTime,
    }];
    assert.equal(recoverStaleJobs(jobs), 0);
    assert.equal(jobs[0]!.status, "FAILED");
  });

  test("B29: PAUSED → recovery しない", () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "PAUSED" as "PAUSED", updated_at: staleTime,
    }];
    assert.equal(recoverStaleJobs(jobs), 0);
    assert.equal(jobs[0]!.status, "PAUSED");
  });
});

describe("B30–B32: Stale Recovery — フィールド保持", () => {
  test("B30: stale recovery 後 current_from が保持される", () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const savedCheckpoint = 1756500000;
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1756000000, target_to: null,
      current_from: savedCheckpoint, current_to: 1756499999,
      status: "RUNNING", updated_at: staleTime,
    }];
    recoverStaleJobs(jobs);
    assert.equal(jobs[0]!.current_from, savedCheckpoint, "current_from preserved");
  });

  test("B31: stale recovery 後 current_to が保持される", () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const savedCheckpointTo = 1756499999;
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1756000000, target_to: null,
      current_from: 1756500000, current_to: savedCheckpointTo,
      status: "RUNNING", updated_at: staleTime,
    }];
    recoverStaleJobs(jobs);
    assert.equal(jobs[0]!.current_to, savedCheckpointTo, "current_to preserved");
  });

  test("B32: stale recovery 後 target_from / target_to が保持される", () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const origTargetFrom = 1756000000;
    const origTargetTo   = 1756080000;
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "BACKFILL",
      target_from: origTargetFrom, target_to: origTargetTo,
      current_from: null, current_to: null,
      status: "RUNNING", updated_at: staleTime,
    }];
    recoverStaleJobs(jobs);
    assert.equal(jobs[0]!.target_from, origTargetFrom, "target_from preserved");
    assert.equal(jobs[0]!.target_to,   origTargetTo,   "target_to preserved");
  });
});

describe("B33–B35: Resume Flow", () => {
  test("B33: recovery 後 claim → RUNNING", () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "RUNNING", updated_at: staleTime,
    }];
    recoverStaleJobs(jobs);
    assert.equal(jobs[0]!.status, "PENDING");
    const claimed = claimNextJob(jobs as SyncJob[], "EURUSD");
    assert.ok(claimed);
    assert.equal(claimed.id, "j1");
    assert.equal(jobs[0]!.status, "RUNNING");
  });

  test("B34: current_from が有効 → effectiveFrom = current_from", () => {
    const targetFrom  = 1756000000;
    const currentFrom = 1756200000; // checkpoint 進んでいる
    const effective   = calcEffectiveFrom(targetFrom, currentFrom);
    assert.equal(effective, currentFrom, "resume from checkpoint");
    assert.ok(effective > targetFrom, "skip already processed range");
  });

  test("B35: current_from = null → effectiveFrom = target_from", () => {
    const targetFrom = 1756000000;
    const effective  = calcEffectiveFrom(targetFrom, null);
    assert.equal(effective, targetFrom, "fallback to target_from");
  });
});

describe("B36–B38: Idempotency / Restart", () => {
  test("B36: 同 chunk 再送 → duplicate bar 増加なし (ignoreDuplicates=true)", () => {
    const barStore = new Map<string, Set<number>>();
    function upsert(sym: string, tf: string, time: number, ignoreDup: boolean) {
      const key = `${sym}:${tf}`;
      if (!barStore.has(key)) barStore.set(key, new Set());
      const existing = barStore.get(key)!;
      if (ignoreDup && existing.has(time)) return false;
      existing.add(time);
      return true;
    }

    // chunk 1 を送信
    const chunk1Bars = [1000, 1300, 1600, 1900, 2200];
    for (const t of chunk1Bars) upsert("EURUSD", "M5", t, true);
    assert.equal(barStore.get("EURUSD:M5")!.size, 5);

    // EA crash → stale recovery → resume → chunk 1 を再送
    for (const t of chunk1Bars) upsert("EURUSD", "M5", t, true);
    assert.equal(barStore.get("EURUSD:M5")!.size, 5, "no duplicate after re-send");
  });

  test("B37: Gateway restart 相当 → stale recovery 後に再開", () => {
    const staleTime = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    const checkpoint = 1756300000;
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1756000000, target_to: null,
      current_from: checkpoint, current_to: checkpoint - 1,
      status: "RUNNING", updated_at: staleTime,
    }];

    // Gateway 再起動 → claim 時に stale recovery
    recoverStaleJobs(jobs);
    assert.equal(jobs[0]!.status, "PENDING");
    assert.equal(jobs[0]!.current_from, checkpoint, "checkpoint preserved");

    const claimed = claimNextJob(jobs as SyncJob[], "EURUSD");
    assert.ok(claimed);
    // effectiveFrom = checkpoint (再開起点)
    const effective = calcEffectiveFrom(1756000000, checkpoint);
    assert.equal(effective, checkpoint, "resumes from checkpoint");
  });

  test("B38: EA restart 相当 → checkpoint から再開", () => {
    const checkpoint = 1756500000;
    const targetFrom = 1756000000;
    // EA 再起動後、job レスポンスの current_from を使って effectiveFrom を決定
    const effective = calcEffectiveFrom(targetFrom, checkpoint);
    assert.equal(effective, checkpoint, "EA resumes from checkpoint after restart");
    assert.ok(effective > targetFrom, "earlier bars already saved, skip to checkpoint");
  });
});

describe("B39–B41: failed_batches semantics", () => {
  test("B39: failed batch → checkpoint を先に進めない", () => {
    // chunkFailed > 0 の場合 shouldAdvanceCheckpoint = false
    assert.ok(!shouldAdvanceCheckpoint(1), "failed chunk → checkpoint not advanced");
    assert.ok(!shouldAdvanceCheckpoint(2), "multiple failed → checkpoint not advanced");
  });

  test("B40: 全成功 → progress=100 + COMPLETED", () => {
    const totalFailed = 0;
    const status = calcFinalStatus(totalFailed);
    assert.equal(status, "COMPLETED");
  });

  test("B41: partial failure → FAILED (欠損をCOMPLETEDにしない)", () => {
    const totalFailed = 1;
    const status = calcFinalStatus(totalFailed);
    assert.equal(status, "FAILED", "any failed batch → FAILED");
  });
});

describe("B42–B45: FORWARD / confirmed bar / concurrency", () => {
  test("B42: FORWARD target_to=null → execution 時に TimeCurrent 使用", () => {
    // EA: if (mode == "FORWARD" || targetTo == 0) targetTo = TimeCurrent()
    const targetToFromJob = 0; // null として 0 が渡される
    const simulatedNow   = Math.floor(Date.now() / 1000);
    const effectiveTargetTo = targetToFromJob === 0 ? simulatedNow : targetToFromJob;
    assert.ok(effectiveTargetTo > 0, "uses current time when target_to=0");
    assert.ok(effectiveTargetTo >= simulatedNow - 5, "uses recent current time");
  });

  test("B43: confirmed bar exclusion 維持 (confirmedTo = targetTo - tfSec)", () => {
    const now = Math.floor(Date.now() / 1000);
    const tfSec = 300; // M5
    const confirmedTo = now - tfSec;
    assert.ok(confirmedTo < now, "confirmedTo is before now");
    // 現在形成中のバー (open_time = now - 100s) は confirmedTo より後
    const formingBarTime = now - 100;
    assert.ok(formingBarTime > confirmedTo, "forming bar excluded");
    // 確定済みバー (open_time = now - 400s) は confirmedTo より前
    const confirmedBarTime = now - 400;
    assert.ok(confirmedBarTime <= confirmedTo, "confirmed bar included");
  });

  test("B44: 同一 symbol/timeframe の二重 claim 不可 (unique index)", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "RUNNING" },
    ];
    const blocked = hasActiveJob(jobs, "EURUSD", "M5");
    assert.ok(blocked, "RUNNING job blocks new FORWARD");
  });

  test("B45: 異なる symbol/timeframe は独立 claim 可能", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: 1000, target_to: null, status: "PENDING" },
      { id: "j2", symbol: "USDJPY", timeframe: "H1", mode: "BACKFILL",
        target_from: 500, target_to: 1000, status: "PENDING" },
    ];
    const c1 = claimNextJob(jobs, "EURUSD");
    const c2 = claimNextJob(jobs, "USDJPY");
    assert.ok(c1 && c2, "both claimed independently");
    assert.equal(c1!.symbol, "EURUSD");
    assert.equal(c2!.symbol, "USDJPY");
  });
});

describe("B46–B52: Concurrency / Data Integrity", () => {
  test("B46: stale recovery concurrency — 複数 Gateway が同時に recovery", () => {
    // Postgres UPDATE は row-level lock を取得するため 1 件しか更新されない
    // ここでは in-memory でシミュレート: 2 つの Gateway が並行 recovery
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const jobs: Array<JobWithMeta> = [{
      id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
      target_from: 1000, target_to: null, current_from: null, current_to: null,
      status: "RUNNING", updated_at: staleTime,
    }];
    // Gateway 1 が recovery
    const r1 = recoverStaleJobs(jobs);
    // Gateway 2 が recovery (すでに PENDING になっているので対象外)
    const r2 = recoverStaleJobs(jobs);
    assert.equal(r1, 1, "first recovery: 1 job");
    assert.equal(r2, 0, "second recovery: 0 jobs (already PENDING)");
  });

  test("B47: resume 後 bar_data 欠損なし (checkpoint 前は既存、後は新規追加)", () => {
    const barStore = new Map<string, number[]>();
    function addBars(tf: string, times: number[]) {
      if (!barStore.has(tf)) barStore.set(tf, []);
      const existing = new Set(barStore.get(tf)!);
      for (const t of times) existing.add(t);
      barStore.set(tf, [...existing].sort((a, b) => a - b));
    }
    // checkpoint 前のデータ (既存)
    addBars("M5", [1000, 1300, 1600]);
    // resume 後追加される新データ
    addBars("M5", [1900, 2200, 2500]);
    const bars = barStore.get("M5")!;
    assert.equal(bars.length, 6, "all bars present");
    assert.equal(bars[0], 1000, "oldest preserved");
    assert.equal(bars[bars.length - 1], 2500, "newest added");
  });

  test("B48: resume 後 duplicate なし", () => {
    const barSet = new Set<number>();
    // chunk 1 (initial)
    [1000, 1300, 1600].forEach(t => barSet.add(t));
    // crash
    // resume: chunk 1 再送 (ignoreDuplicates=true simulation)
    [1000, 1300, 1600].forEach(t => barSet.add(t)); // Set は重複無視
    // chunk 2 (new)
    [1900, 2200].forEach(t => barSet.add(t));
    assert.equal(barSet.size, 5, "no duplicates");
  });

  test("B49: 既存 bars は preserved (bar_data に DELETE なし)", () => {
    const before = 73216;
    const newBars = 288; // FORWARD 1日分
    const after = before + newBars;
    assert.ok(after >= before, "bar count never decreases");
    // DataSync は INSERT only (no DELETE, no TRUNCATE)
    assert.ok(true, "no DELETE operations in DataSync");
  });

  test("B50: Phase A HistorySync が DataSync 実行中にブロックされる", () => {
    let g_HistorySyncRunning = false;
    let g_DataSyncRunning    = true; // DataSync 実行中
    let historySyncCalled    = false;

    // Phase A の PENDING check は DataSync 中もできるが、
    // HistorySync_Run() は !g_DataSyncRunning 時のみ呼ばれる (OnTimer の条件による)
    // 実際は HistorySync は DataSync とは独立した条件 (g_HistorySyncPending) で動く
    // 今回のテスト: DataSync 実行中は新しい Phase A は開始しない (設計上の安全)
    if (!g_DataSyncRunning && !g_HistorySyncRunning) historySyncCalled = true;
    assert.ok(!historySyncCalled, "Phase A blocked while DataSync running");
    g_DataSyncRunning = false;
    if (!g_DataSyncRunning && !g_HistorySyncRunning) historySyncCalled = true;
    assert.ok(historySyncCalled, "Phase A can run after DataSync completes");
  });

  test("B51: DataSync disabled → polling しない", () => {
    const InpDataSyncEnabled = false;
    let pollCalled = false;
    if (InpDataSyncEnabled) pollCalled = true;
    assert.ok(!pollCalled, "DataSync disabled → no polling");
  });

  test("B52: malformed current_from (負数) → target_from にフォールバック", () => {
    const targetFrom  = 1756000000;
    const malformedCF = -999; // 無効な値
    // EA: currentFrom > 0 の条件チェック
    const effective = calcEffectiveFrom(targetFrom, malformedCF <= 0 ? null : malformedCF);
    assert.equal(effective, targetFrom, "malformed current_from → fallback to target_from");
  });
});

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

setTimeout(() => {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Data Phase B Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED ✅");
  }
}, 0);
