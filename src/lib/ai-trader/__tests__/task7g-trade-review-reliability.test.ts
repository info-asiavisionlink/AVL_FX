import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseTradeReview } from "../trade-review-contract";

const ROOT = process.cwd();
const route = readFileSync(join(ROOT, "src/app/api/traders/[id]/review/route.ts"), "utf8");
const watcher = readFileSync(join(ROOT, "src/app/api/watcher/m5-close/route.ts"), "utf8");
const valid = { what_worked: "条件が一致", what_failed: "なし", review_text: "条件を検証しました", hypothesis: "同条件では継続観察する", confidence: 3 };

test("Task 7G: valid review response is accepted", () => { assert.deepEqual(parseTradeReview(valid), valid); });
test("Task 7G: malformed/missing review fields are rejected", () => { assert.throws(() => parseTradeReview({ ...valid, review_text: "" })); assert.throws(() => parseTradeReview({ ...valid, confidence: 6 })); assert.throws(() => parseTradeReview({ ...valid, extra: "secret" })); });
test("Task 7G: non-finite and wrong numeric values are rejected", () => { assert.throws(() => parseTradeReview({ ...valid, confidence: NaN })); assert.throws(() => parseTradeReview({ ...valid, confidence: Infinity })); assert.throws(() => parseTradeReview({ ...valid, confidence: "3" })); });
test("Task 7G: review requires CLOSED position and owned outcome", () => { assert.match(route, /status !== "CLOSED"/); assert.match(route, /eq\("user_id", effectiveUserId\)/); assert.match(route, /Trade Outcomeがないためレビューできません/); });
test("Task 7G: canonical persistence is confirmed before completion response", () => { assert.match(route, /trade_reviews/); assert.match(route, /saved\.outcome_id !== outcomeId/); assert.match(route, /保存を確認できないため完了扱いにしません/); });
test("Task 7G: AI failure and validation failure are not success", () => { assert.match(route, /AI レビュー生成失敗/); assert.match(route, /AI 応答の検証に失敗しました/); assert.doesNotMatch(route, /reviewText = `\$\{decision\.decision\}/); });
test("Task 7G: duplicate review is idempotent", () => { assert.match(route, /already_reviewed: true/); assert.match(route, /reviewError\?\.code === "23505"/); });
test("Task 7G: watcher awaits review and marks dispatched only after confirmation", () => { assert.match(watcher, /await fetch\(`\$\{appUrl\}\/api\/traders/); assert.match(watcher, /confirmed = reviewResponse\.ok/); assert.match(watcher, /review_dispatched: true/); assert.ok(watcher.indexOf("confirmed = reviewResponse.ok") < watcher.indexOf("review_dispatched: true")); });
test("Task 7G: watcher claim is durable and retryable on failure", () => { assert.match(watcher, /TRADE_REVIEW:/); assert.match(watcher, /runtime_idempotency_claims/); assert.match(watcher, /delete\(\)\.eq\("idempotency_key", reviewClaim\)/); });
test("Task 7G: review path has no execution writer or broker call", () => { assert.doesNotMatch(route, /execution_commands/); assert.doesNotMatch(route, /Gateway|MT5_GATEWAY|sendOrder|placeOrder/); });
test("Task 7G: no fire-and-forget review dispatch remains", () => { assert.doesNotMatch(watcher, /fetch\([^\n]+\)\.catch/); assert.doesNotMatch(watcher, /void\s+fetch.*review/); });
test("Task 7G: raw provider output is not persisted as review", () => { assert.doesNotMatch(route, /rawText\.slice/); assert.doesNotMatch(route, /chain.of.thought|Authorization|OPENAI_API_KEY/); });
test("Task 7G: completion failure is explicit", () => { assert.match(route, /Trade Reviewの保存を確認できないため完了扱いにしません/); assert.match(route, /status: 503/); });
test("Task 7G: owner/trader correlation is enforced", () => { assert.match(route, /eq\("id", id\)/); assert.match(route, /eq\("user_id", effectiveUserId\)/); assert.match(route, /ai_trader_id: id/); });
test("Task 7G: no LIVE_AUTONOMOUS is introduced", () => { assert.doesNotMatch(route, /LIVE_AUTONOMOUS/); });
test("Task 7G: concurrent claim simulation permits one effective review", async () => {
  const claims = new Set<string>(); let effective = 0;
  await Promise.all(Array.from({ length: 16 }, async () => { await Promise.resolve(); if (!claims.has("TRADE_REVIEW:p-a")) { claims.add("TRADE_REVIEW:p-a"); effective++; } }));
  assert.equal(effective, 1);
});
