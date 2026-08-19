/**
 * Regression Tests — BacktestService fetchBars pagination (BUG-2 Fix)
 *
 * BacktestService.fetchBars() は内部関数のため、
 * ここでは同一アルゴリズムを純粋関数として抽出してテストする。
 *
 * テスト対象アルゴリズム (fetchBars 内の pagination loop):
 *   for (;;) {
 *     const rows = fetch(offset, offset + PAGE_SIZE - 1);
 *     if (rows.length === 0) break;
 *     allRows.push(...rows);
 *     if (rows.length < PAGE_SIZE) break;
 *     offset += PAGE_SIZE;
 *   }
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/backtest_service_pagination.test.ts
 */

import assert from "node:assert/strict";

// ------------------------------------------------------------------
// ページネーションアルゴリズム (BacktestService.fetchBars と同一)
// ------------------------------------------------------------------

const PAGE_SIZE = 1000;

interface FetchResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * BacktestService.fetchBars のページネーション部分を純粋関数として抽出。
 * fetcher は (from, to) → { data, error } を返す非同期関数。
 */
async function paginatedFetch<T>(
  fetcher: (from: number, to: number) => Promise<FetchResult<T>>,
): Promise<{ rows: T[]; callCount: number }> {
  const allRows: T[] = [];
  let offset = 0;
  let callCount = 0;

  for (;;) {
    callCount++;
    const { data, error } = await fetcher(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`fetch failed: ${error.message}`);

    const rows = data ?? [];
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { rows: allRows, callCount };
}

/**
 * テスト用モック: totalBars 件のデータを PAGE_SIZE ずつ返す。
 * errorOnCall が指定された場合、その呼び出し回数でエラーを返す。
 */
function createMockFetcher<T>(
  allData: T[],
  errorOnCall?: number,
): (from: number, to: number) => Promise<FetchResult<T>> {
  let callCount = 0;
  return async (from: number, to: number) => {
    callCount++;
    if (errorOnCall !== undefined && callCount === errorOnCall) {
      return { data: null, error: { message: `Simulated DB error on call ${callCount}` } };
    }
    const slice = allData.slice(from, to + 1);
    return { data: slice, error: null };
  };
}

/**
 * タイムスタンプ昇順の bar-like データを生成する。
 */
function makeBarData(count: number): Array<{ time: number; open: number }> {
  return Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: 1.1 + i * 0.0001,
  }));
}

// ------------------------------------------------------------------
// Test runner
// ------------------------------------------------------------------

let passed = 0, failed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✅ ${name}`); passed++; })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${name}\n     ${msg}`);
      failed++;
    });
}
function describe(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n📊 ${name}`);
  return fn();
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

async function run() {
  await describe("BUG-2 Regression: fetchBars pagination", async () => {

    await test("P01: 0 bars → [] を返し 1 回 fetch", async () => {
      const fetcher = createMockFetcher<{ time: number }>(makeBarData(0));
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 0, "empty result");
      assert.equal(callCount, 1, "empty fetch = 1 call");
    });

    await test("P02: 1 bar → 正常取得、1 回 fetch", async () => {
      const data = makeBarData(1);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 1);
      assert.equal(callCount, 1);
      assert.equal(rows[0]!.time, data[0]!.time);
    });

    await test("P03: 999 bars (< PAGE_SIZE) → 1 回 fetch、全件取得", async () => {
      const data = makeBarData(999);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 999, "all 999 rows");
      assert.equal(callCount, 1, "< PAGE_SIZE → 1 call");
    });

    await test("P04: 1000 bars (= PAGE_SIZE) → 全 1000 件取得", async () => {
      const data = makeBarData(1000);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 1000, "all 1000 rows");
      // 1000 行ちょうど: 1 回目で 1000 取得 → 次の確認フェッチで 0 → break
      assert.ok(callCount >= 1, "at least 1 call");
      assert.ok(callCount <= 2, "at most 2 calls for 1000 bars");
    });

    await test("P05: 1001 bars → 2 回 fetch、全 1001 件取得", async () => {
      const data = makeBarData(1001);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 1001, "all 1001 rows");
      assert.equal(callCount, 2, "1000 + 1 → 2 calls");
    });

    await test("P06: 2000 bars → 3 回 fetch (1000 + 1000 + confirm)", async () => {
      const data = makeBarData(2000);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 2000, "all 2000 rows");
      assert.ok(callCount >= 2 && callCount <= 3, `callCount=${callCount} expected 2-3`);
    });

    await test("P07: 5347 bars (EURUSD/M5 実データ相当) → 全 5347 件取得", async () => {
      const data = makeBarData(5347);
      const fetcher = createMockFetcher(data);
      const { rows, callCount } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 5347, "all 5347 rows");
      // ceil(5347 / 1000) = 6 ページ、最後は 347 行 → 7 回以内
      assert.ok(callCount >= 6 && callCount <= 7, `callCount=${callCount}`);
    });

    await test("P08: タイムスタンプ昇順が維持される", async () => {
      const data = makeBarData(2500);
      const fetcher = createMockFetcher(data);
      const { rows } = await paginatedFetch(fetcher);
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          rows[i]!.time >= rows[i - 1]!.time,
          `timestamp[${i}]=${rows[i]!.time} < timestamp[${i-1}]=${rows[i-1]!.time}`,
        );
      }
    });

    await test("P09: duplicate なし (各 bar が一度だけ取得される)", async () => {
      const data = makeBarData(3000);
      const fetcher = createMockFetcher(data);
      const { rows } = await paginatedFetch(fetcher);
      const times = rows.map(r => r.time);
      const unique = new Set(times);
      assert.equal(unique.size, rows.length, "no duplicate timestamps");
    });

    await test("P10: fromDate フィルタが各ページで維持される (filter条件テスト)", async () => {
      // fromDate フィルタ付きの場合、結果はフィルタ後のデータ
      const cutoffMs = 1_700_000_000_000 + 500 * 60_000; // 500件目以降
      const allData = makeBarData(2000);
      const filtered = allData.filter(b => b.time >= cutoffMs);
      // filtered は 1500 件 (500 ~ 1999)

      // fromDate フィルタ適用済みのモック (フィルタ済みデータを返す)
      const fetcher = createMockFetcher(filtered);
      const { rows } = await paginatedFetch(fetcher);
      assert.equal(rows.length, filtered.length, "filter preserved across pages");
      assert.ok(rows[0]!.time >= cutoffMs, "first row respects fromDate");
    });

    await test("P11: DB エラー → Error を throw", async () => {
      const data = makeBarData(500);
      const fetcher = createMockFetcher(data, 1); // 1回目でエラー
      await assert.rejects(
        () => paginatedFetch(fetcher),
        /Simulated DB error/,
        "should throw on DB error",
      );
    });

    await test("P12: DB エラーが 2 ページ目で発生 → Error を throw", async () => {
      const data = makeBarData(2000);
      const fetcher = createMockFetcher(data, 2); // 2回目でエラー
      await assert.rejects(
        () => paginatedFetch(fetcher),
        /Simulated DB error/,
        "should throw on page 2 error",
      );
    });

    await test("P13: 正確なページ範囲で fetch される (range 検証)", async () => {
      const calls: Array<{ from: number; to: number }> = [];
      const data = makeBarData(2500);
      const fetcher = async (from: number, to: number) => {
        calls.push({ from, to });
        return { data: data.slice(from, to + 1), error: null };
      };
      await paginatedFetch(fetcher);
      assert.equal(calls[0]!.from, 0,    "page 1 from=0");
      assert.equal(calls[0]!.to,   999,  "page 1 to=999");
      assert.equal(calls[1]!.from, 1000, "page 2 from=1000");
      assert.equal(calls[1]!.to,   1999, "page 2 to=1999");
      assert.equal(calls[2]!.from, 2000, "page 3 from=2000");
    });

    await test("P14: 5029 bars (EURUSD/H1 実データ相当) → 全件取得", async () => {
      const data = makeBarData(5029);
      const fetcher = createMockFetcher(data);
      const { rows } = await paginatedFetch(fetcher);
      assert.equal(rows.length, 5029, "all 5029 H1 bars fetched");
    });

    await test("P15: 大量データでも欠落なし (3000 bars、中間チェック)", async () => {
      const count = 3000;
      const data = makeBarData(count);
      const fetcher = createMockFetcher(data);
      const { rows } = await paginatedFetch(fetcher);
      assert.equal(rows.length, count);
      // 先頭・末尾・中間の値が元データと一致する
      assert.equal(rows[0]!.time,          data[0]!.time);
      assert.equal(rows[999]!.time,         data[999]!.time);
      assert.equal(rows[1000]!.time,        data[1000]!.time);
      assert.equal(rows[count - 1]!.time,  data[count - 1]!.time);
    });

  });

  console.log(`\n${"=".repeat(55)}`);
  console.log(`BacktestService Pagination Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED ✅");
  }
}

run().catch(e => { console.error(e); process.exit(1); });
