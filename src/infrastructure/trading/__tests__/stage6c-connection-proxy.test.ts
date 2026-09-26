import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ticks = readFileSync(join(ROOT, "src/app/api/live/connection/ticks/route.ts"), "utf8");
const bars = readFileSync(join(ROOT, "src/app/api/live/connection/bars/route.ts"), "utf8");
const client = readFileSync(join(ROOT, "src/infrastructure/connection/GatewayClient.ts"), "utf8");
const chart = readFileSync(join(ROOT, "src/presentation/components/chart/AVLChart.tsx"), "utf8");
const marketContext = readFileSync(join(ROOT, "src/infrastructure/ai/market-context.ts"), "utf8");
const aiAnalyze = readFileSync(join(ROOT, "src/app/api/ai/analyze/route.ts"), "utf8");
const aiChat = readFileSync(join(ROOT, "src/app/api/ai/chat/route.ts"), "utf8");
const aiFull = readFileSync(join(ROOT, "src/app/api/ai/analysis/full/route.ts"), "utf8");

test("customer tick proxy verifies owner and calls singular scoped Gateway endpoint", () => {
  assert.match(ticks, /\.eq\("user_id", user\.id\)/);
  assert.match(ticks, /\/connections\/\$\{encodeURIComponent\(conn\.id\)\}\/tick\//);
  assert.match(ticks, /x-internal-service-auth/);
  assert.match(ticks, /x-connection-id/);
  assert.doesNotMatch(ticks, /\/connections\/\$\{conn\.id\}\/(?:ticks)/);
  assert.doesNotMatch(ticks, /\/tick\/\$\{symbol/);
});

test("customer bars proxy verifies owner, uses scoped Gateway bars, and has no global fallback", () => {
  assert.match(bars, /\.eq\("user_id", user\.id\)/);
  assert.match(bars, /\/connections\/\$\{encodeURIComponent\(conn\.id\)\}\/bars\//);
  assert.match(bars, /x-internal-service-auth/);
  assert.match(bars, /x-connection-id/);
  assert.doesNotMatch(bars, /\$\{GATEWAY_URL\}\/bars\//);
  assert.doesNotMatch(bars, /createClient/);
  assert.match(bars, /Gateway market data unavailable/);
});

test("browser GatewayClient uses server-side scoped proxies for customer market state", () => {
  assert.match(client, /\/api\/live\/connection\/ticks\?symbol=/);
  assert.match(client, /\/api\/live\/connection\/bars\?symbol=/);
  assert.match(client, /\/api\/live\/positions/);
  assert.match(client, /\/api\/live\/connection\/account/);
  assert.doesNotMatch(client, /this\.httpUrl\}\/tick\//);
  assert.doesNotMatch(client, /this\.httpUrl\}\/bars\//);
});

test("proxy source has explicit fail-closed ownership and Gateway error responses", () => {
  assert.match(ticks, /Connection ownership unavailable/);
  assert.match(bars, /Connection ownership unavailable/);
  assert.match(ticks, /status: 503/);
  assert.match(bars, /status: 503/);
});

test("Trading View chart does not fall back to a global bars endpoint", () => {
  assert.match(chart, /p\.set\("connection_id", connectionId\)/);
  assert.match(chart, /\/api\/live\/connection\/bars\?/);
  assert.doesNotMatch(chart, /\/api\/mt5\/bars\/simple/);
});

test("customer AI market context requires an owned connection and scoped tick/bars", () => {
  assert.match(marketContext, /buildMarketContext\(symbol: string, connectionId: string\)/);
  assert.match(marketContext, /scoped\(`\/tick\/\$\{sym\}`\)/);
  assert.match(marketContext, /scoped\(`\/bars\/\$\{sym\}\/H1/);
  assert.doesNotMatch(marketContext, /fetchJSON<Tick>\(`\/tick\//);
  assert.match(aiAnalyze, /\.eq\("user_id", user\.id\)/);
  assert.match(aiChat, /\.eq\("user_id", user\.id\)/);
  assert.match(aiFull, /user!\.id|internalAuth/);
  assert.match(aiFull, /\/connections\/\$\{encodeURIComponent\(connection\.id\)\}\/tick/);
  assert.match(aiFull, /\/connections\/\$\{encodeURIComponent\(connection\.id\)\}\/bars/);
  assert.doesNotMatch(aiFull, /fetchJSON<Tick>\(`\/tick\//);
});
