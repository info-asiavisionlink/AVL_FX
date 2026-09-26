import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const gateway = readFileSync(join(root, "src/index.ts"), "utf8");
const client = readFileSync(join(root, "../src/infrastructure/connection/GatewayClient.ts"), "utf8");
const tokenRoute = readFileSync(join(root, "../src/app/api/live/connection/ws-token/route.ts"), "utf8");

test("WebSocket handshake requires a short-lived signed scoped access token", () => {
  assert.match(gateway, /accessToken/);
  assert.match(gateway, /verifyWsAccessToken\(wsToken, wsConnId\)/);
  assert.match(gateway, /timingSafeEqual/);
  assert.doesNotMatch(gateway, /wsToken = urlObj\.searchParams\.get\("connectionToken"\)/);
  assert.match(tokenRoute, /\.eq\("user_id", user\.id\)/);
  assert.match(tokenRoute, /createHmac\("sha256"/);
  assert.match(tokenRoute, /TOKEN_TTL_SECONDS/);
});

test("GatewayClient obtains server-side WS credential and never sends SUBSCRIBE_CONNECTION", () => {
  assert.match(client, /\/api\/live\/connection\/ws-token/);
  assert.match(client, /accessToken/);
  assert.match(client, /connectionId/);
  assert.doesNotMatch(client, /SUBSCRIBE_CONNECTION/);
  assert.doesNotMatch(client, /connectionToken/);
  assert.doesNotMatch(client, /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|SERVICE_ROLE)/);
});

test("customer-sensitive Gateway events use connection-scoped delivery", () => {
  assert.equal((gateway.match(/broadcast\(/g) ?? []).length, 1, "only the unused helper declaration may remain");
  for (const event of ["EA_CONNECTED", "HEARTBEAT", "SYMBOLS", "INDICATORS", "TICK", "BAR", "ACCOUNT", "POSITIONS", "ORDERS", "EXECUTION_RESULT"]) {
    if (event === "EXECUTION_RESULT") {
      assert.match(gateway, /const execResultMsg = \{/);
      assert.match(gateway, /broadcastToConnection\(connId, execResultMsg\)/);
    } else {
      assert.match(gateway, new RegExp(`broadcastToConnection\\([^\\n]*type: \\"${event}\\"`), `${event} must be scoped`);
    }
  }
  assert.match(gateway, /app\.post\("\/event", auth, async/);
  assert.match(gateway, /app\.post\("\/heartbeat", auth, async/);
  assert.match(gateway, /app\.post\("\/symbols\/bulk", auth, async/);
  assert.match(gateway, /app\.post\("\/indicators", auth, async/);
});

test("scoped symbol, indicator, and order payloads do not use another connection's store", () => {
  assert.match(gateway, /connSymbolStore/);
  assert.match(gateway, /connIndicatorStore/);
  assert.match(gateway, /connOrderStore/);
  assert.match(gateway, /scopedOrders\.values\(\)/);
});
