/**
 * gateway-multi-connection-test.ts
 *
 * Multi-Connection Isolation Test
 *
 * 目的: Connection AとBのデータが完全に分離されることを確認する
 * 実行: npx tsx scripts/gateway-multi-connection-test.ts
 *
 * 前提:
 *   - GATEWAY_URL 環境変数またはデフォルト値でGatewayが起動していること
 *   - MT5_GATEWAY_SECRET 環境変数が設定されていること
 *   - テスト用にSupabase無効でGatewayを起動した場合、X-Connection-TokenはSkip
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
const SECRET      = process.env.MT5_GATEWAY_SECRET ?? "test-secret";

// テスト用の擬似Connection ID（実際のUUIDだが認証不要のdev mode想定）
const CONN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Token（Supabase無効モードでは検証スキップされる）
const TOKEN_A = "token_for_connection_a_" + "a".repeat(40);
const TOKEN_B = "token_for_connection_b_" + "b".repeat(40);

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function bridgePost(connId: string, token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SECRET}`,
      "X-Connection-Id": connId,
      "X-Connection-Token": token,
    },
    body: JSON.stringify(body),
  });
}

async function adminGet(path: string): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Test Suite
// ============================================================

async function runTests(): Promise<void> {
  console.log("==============================================");
  console.log("  AVL Gateway Multi-Connection Isolation Test");
  console.log(`  Gateway: ${GATEWAY_URL}`);
  console.log("==============================================\n");

  // -------------------------------------------------------
  // 1. Tick Isolation Test
  // -------------------------------------------------------
  console.log("[Test 1] Tick Isolation — Connection A/B でEURUSDのBidが混ざらないこと");

  await bridgePost(CONN_A, TOKEN_A, "/bridge/ticks", {
    symbol: "EURUSD", bid: 1.1000, ask: 1.1002, spread: 2.0, digits: 5, time: Math.floor(Date.now() / 1000),
  });
  await bridgePost(CONN_B, TOKEN_B, "/bridge/ticks", {
    symbol: "EURUSD", bid: 1.2000, ask: 1.2002, spread: 2.0, digits: 5, time: Math.floor(Date.now() / 1000),
  });

  await sleep(100);

  const tickA = await adminGet(`/connections/${CONN_A}/ticks/EURUSD`).then(r => r.json()) as Record<string, unknown>;
  const tickB = await adminGet(`/connections/${CONN_B}/ticks/EURUSD`).then(r => r.json()) as Record<string, unknown>;

  assert("Connection A の EURUSD bid = 1.1000", Math.abs((tickA.bid as number) - 1.1000) < 0.0001);
  assert("Connection B の EURUSD bid = 1.2000", Math.abs((tickB.bid as number) - 1.2000) < 0.0001);
  assert("User A price leak to User B: 0", Math.abs((tickB.bid as number) - 1.1000) > 0.05);
  assert("User B price leak to User A: 0", Math.abs((tickA.bid as number) - 1.2000) > 0.05);

  // -------------------------------------------------------
  // 2. Account Isolation Test
  // -------------------------------------------------------
  console.log("\n[Test 2] Account Isolation — Balance が混ざらないこと");

  await bridgePost(CONN_A, TOKEN_A, "/bridge/account", {
    login: 111111, broker: "Broker A", currency: "USD",
    balance: 10000, equity: 10050, margin: 500, freeMargin: 9550, marginLevel: 2010, leverage: 100,
  });
  await bridgePost(CONN_B, TOKEN_B, "/bridge/account", {
    login: 222222, broker: "Broker B", currency: "USD",
    balance: 50000, equity: 50100, margin: 1000, freeMargin: 49100, marginLevel: 5010, leverage: 200,
  });

  await sleep(100);

  const accA = await adminGet(`/connections/${CONN_A}/account`).then(r => r.json()) as Record<string, unknown>;
  const accB = await adminGet(`/connections/${CONN_B}/account`).then(r => r.json()) as Record<string, unknown>;

  assert("Connection A balance = 10000", (accA.balance as number) === 10000);
  assert("Connection B balance = 50000", (accB.balance as number) === 50000);
  assert("User A account leak to B: 0", (accB.balance as number) !== 10000);
  assert("User B account leak to A: 0", (accA.balance as number) !== 50000);
  assert("Connection A login = 111111", (accA.login as number) === 111111);
  assert("Connection B login = 222222", (accB.login as number) === 222222);

  // -------------------------------------------------------
  // 3. Bar Isolation Test
  // -------------------------------------------------------
  console.log("\n[Test 3] Bar Isolation — ChartデータがConnection間で混ざらないこと");

  const baseTime = Math.floor(Date.now() / 1000 / 3600) * 3600; // H1境界

  await bridgePost(CONN_A, TOKEN_A, "/bridge/bars/bulk", {
    symbol: "EURUSD", timeframe: "H1",
    bars: [{ time: baseTime - 7200, open: 1.0900, high: 1.0950, low: 1.0880, close: 1.0920, volume: 100 },
           { time: baseTime - 3600, open: 1.0920, high: 1.0960, low: 1.0900, close: 1.0940, volume: 120 }],
  });
  await bridgePost(CONN_B, TOKEN_B, "/bridge/bars/bulk", {
    symbol: "EURUSD", timeframe: "H1",
    bars: [{ time: baseTime - 7200, open: 1.2000, high: 1.2050, low: 1.1980, close: 1.2020, volume: 200 },
           { time: baseTime - 3600, open: 1.2020, high: 1.2060, low: 1.2000, close: 1.2040, volume: 220 }],
  });

  await sleep(100);

  const barsA = await adminGet(`/connections/${CONN_A}/bars/EURUSD/H1?count=5`).then(r => r.json()) as Array<Record<string, unknown>>;
  const barsB = await adminGet(`/connections/${CONN_B}/bars/EURUSD/H1?count=5`).then(r => r.json()) as Array<Record<string, unknown>>;

  assert("Connection A bars: 2本", barsA.length === 2);
  assert("Connection B bars: 2本", barsB.length === 2);
  assert("Connection A close ~1.09xx", barsA.length > 0 && (barsA[barsA.length - 1].close as number) < 1.15);
  assert("Connection B close ~1.20xx", barsB.length > 0 && (barsB[barsB.length - 1].close as number) > 1.15);
  assert("A bars not leaked to B", barsB.every(b => (b.close as number) > 1.15));
  assert("B bars not leaked to A", barsA.every(b => (b.close as number) < 1.15));

  // -------------------------------------------------------
  // 4. Connection Status Test
  // -------------------------------------------------------
  console.log("\n[Test 4] Connection Status — 各ConnectionのStatusが独立していること");

  const statusA = await adminGet(`/connections/${CONN_A}/status`).then(r => r.json()) as Record<string, unknown>;
  const statusB = await adminGet(`/connections/${CONN_B}/status`).then(r => r.json()) as Record<string, unknown>;

  assert("Connection A ID正確", statusA.connectionId === CONN_A);
  assert("Connection B ID正確", statusB.connectionId === CONN_B);
  assert("Connection A account有り", statusA.hasAccount === true);
  assert("Connection B account有り", statusB.hasAccount === true);

  // -------------------------------------------------------
  // 5. Connection List Test
  // -------------------------------------------------------
  console.log("\n[Test 5] Connection List — /connections で両接続が見えること");

  const connList = await adminGet("/connections").then(r => r.json()) as Array<Record<string, unknown>>;
  const idsInList = connList.map(c => c.connectionId as string);

  assert("Connection A が一覧に存在", idsInList.includes(CONN_A));
  assert("Connection B が一覧に存在", idsInList.includes(CONN_B));
  assert("Connection A と B は別エントリ", new Set(idsInList).size >= 2);

  // -------------------------------------------------------
  // 6. Admin Global State は変化なし（旧エンドポイント確認）
  // -------------------------------------------------------
  console.log("\n[Test 6] Admin Global State — 旧エンドポイントが動作すること");

  const health = await adminGet("/health").then(r => r.json()) as Record<string, unknown>;
  assert("Gateway health OK", health.status === "ok");

  // -------------------------------------------------------
  // Result
  // -------------------------------------------------------
  console.log("\n==============================================");
  console.log(`  結果: PASS ${passed} / FAIL ${failed} / TOTAL ${passed + failed}`);
  console.log("==============================================");

  if (failed > 0) {
    console.error(`\n❌ ${failed}件のテストが失敗しました`);
    console.error("   → Gateway Connection Namespaceの実装を確認してください");
    process.exit(1);
  } else {
    console.log("\n✅ 全テスト合格 — Multi-User Isolation VERIFIED");
    console.log("   CROSS-USER DATA ISOLATION: PASS");
    console.log("   ONE RAILWAY FOR MULTIPLE USERS: POSSIBLE");
  }
}

runTests().catch((err: unknown) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
