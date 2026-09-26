import assert from "node:assert/strict";
import test from "node:test";
import { registerToConsole } from "../console-registration";

const payload = { share_code: "1234567890123456", tv_strategy_id: "strategy-1", tv_user_id: null, name: "EA", strategy_type: "TREND", spec: {} };
const response = (status: number, body: unknown = { id: "registry-1", share_code: payload.share_code }) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

for (const status of [201, 400, 401, 403, 404, 409, 500]) {
  test(`HTTP ${status} follows the registration contract`, async () => {
    const result = await registerToConsole("https://console.example", "secret", payload, async () => response(status));
    assert.equal(result.ok, status === 201);
  });
}

test("malformed success response fails closed", async () => {
  const result = await registerToConsole("https://console.example", "secret", payload, async () => response(201, { ok: true }));
  assert.deepEqual(result, { ok: false, reason: "MALFORMED_RESPONSE", status: 201 });
});

test("network and timeout failures fail closed", async () => {
  const result = await registerToConsole("https://console.example", "secret", payload, async () => { throw new Error("network"); });
  assert.deepEqual(result, { ok: false, reason: "NETWORK_ERROR" });
});

test("a duplicate response is not reinterpreted as success", async () => {
  const result = await registerToConsole("https://console.example", "secret", payload, async () => response(409, { error: "duplicate" }));
  assert.equal(result.ok, false);
});
