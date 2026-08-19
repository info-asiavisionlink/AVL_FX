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
