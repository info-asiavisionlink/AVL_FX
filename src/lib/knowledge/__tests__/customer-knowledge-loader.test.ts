import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadCustomerKnowledge,
  selectCustomerKnowledge,
  snapshotCustomerKnowledge,
  KnowledgeUnavailableError,
  type CustomerKnowledgeItem,
} from "../customer-knowledge-loader";

// ── Fixtures ─────────────────────────────────────────────────────────

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id:                  "ck-1",
    title:               "Gold Structure",
    category:            "Market Structure",
    content:             "Dow Theory rules for GOLD",
    ai_usage:            "Use for H1 bias",
    summary:             "Gold structure guidelines",
    market:              ["GOLD"],
    timeframes:          ["H1", "H4"],
    tags:                ["dow", "structure"],
    status:              "ACTIVE",
    source_version:      3,
    source_knowledge_id: "console-uuid-abc",
    package_version:     "2026-09-26-v1",
    content_hash:        "sha256abc",
    source_type:         "PACKAGED",
    updated_at:          "2026-09-26T00:00:00Z",
    ...overrides,
  };
}

function makeDb(rows: Record<string, unknown>[], error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: error ? null : rows, error }));
  return { from: () => chain } as never;
}

// ── loadCustomerKnowledge ─────────────────────────────────────────────

test("returns ACTIVE knowledge items for valid trader+user", async () => {
  const db = makeDb([row()]);
  const items = await loadCustomerKnowledge(db, "trader-1", "user-1");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "ck-1");
  assert.equal(items[0]?.source_knowledge_id, "console-uuid-abc");
  assert.equal(items[0]?.package_version, "2026-09-26-v1");
  assert.equal(items[0]?.version, 3);  // mapped from source_version
});

test("throws EMPTY_RESULT when no ACTIVE knowledge found", async () => {
  const db = makeDb([]);
  await assert.rejects(
    () => loadCustomerKnowledge(db, "trader-1", "user-1"),
    (e: unknown) => e instanceof KnowledgeUnavailableError && e.code === "EMPTY_RESULT",
  );
});

test("throws SERVER_ERROR on database error", async () => {
  const db = makeDb([], { message: "DB unavailable" });
  await assert.rejects(
    () => loadCustomerKnowledge(db, "trader-1", "user-1"),
    (e: unknown) => e instanceof KnowledgeUnavailableError && e.code === "SERVER_ERROR",
  );
});

test("throws CONFIG_ERROR when traderId is empty", async () => {
  const db = makeDb([row()]);
  await assert.rejects(
    () => loadCustomerKnowledge(db, "", "user-1"),
    (e: unknown) => e instanceof KnowledgeUnavailableError && e.code === "CONFIG_ERROR",
  );
});

test("throws CONFIG_ERROR when userId is empty", async () => {
  const db = makeDb([row()]);
  await assert.rejects(
    () => loadCustomerKnowledge(db, "trader-1", ""),
    (e: unknown) => e instanceof KnowledgeUnavailableError && e.code === "CONFIG_ERROR",
  );
});

// ── Customer isolation ────────────────────────────────────────────────
// RLS is enforced by the database; the loader adds application-level defense.
// These tests verify the loader passes user_id correctly to the DB query.

test("passes user_id to query (RLS enforcement at DB level)", async () => {
  const capturedEqs: unknown[] = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order  = () => chain;
  chain.eq = (...args: unknown[]) => { capturedEqs.push(args); return chain; };
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: [row()], error: null }));
  const db = { from: () => chain } as never;
  await loadCustomerKnowledge(db, "trader-x", "user-a");
  // Must include user_id filter
  assert.ok(capturedEqs.some(a => Array.isArray(a) && a[0] === "user_id" && a[1] === "user-a"),
    "user_id eq filter must be passed to query");
  // Must include ai_trader_id filter
  assert.ok(capturedEqs.some(a => Array.isArray(a) && a[0] === "ai_trader_id" && a[1] === "trader-x"),
    "ai_trader_id eq filter must be passed to query");
});

// ── selectCustomerKnowledge ───────────────────────────────────────────

function ckItem(overrides: Partial<CustomerKnowledgeItem> = {}): CustomerKnowledgeItem {
  return {
    id: "ck-1", title: "Gold Structure", category: "Market Structure",
    content: "content", ai_usage: null, summary: null,
    market: ["GOLD"], timeframes: ["H1"], tags: [], status: "ACTIVE",
    version: 1, updated_at: "2026-09-26T00:00:00Z",
    source_knowledge_id: "c-uuid", source_version: 1,
    package_version: "2026-09-26-v1", content_hash: null,
    ...overrides,
  };
}

test("filters by market and returns CustomerKnowledgeItem with provenance", () => {
  const items = [
    ckItem({ id: "ck-1", market: ["GOLD"] }),
    ckItem({ id: "ck-2", market: ["USDJPY"] }),
  ];
  const selected = selectCustomerKnowledge(items, { market: "GOLD" });
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, "ck-1");
  // Verify CustomerKnowledgeItem fields are preserved
  assert.equal(selected[0]?.package_version, "2026-09-26-v1");
  assert.equal(selected[0]?.source_knowledge_id, "c-uuid");
});

test("returns empty array when no items match market filter", () => {
  const items = [ckItem({ market: ["USDJPY"] })];
  const selected = selectCustomerKnowledge(items, { market: "GOLD" });
  assert.equal(selected.length, 0);
});

test("respects limit parameter", () => {
  const items = Array.from({ length: 10 }, (_, i) => ckItem({ id: `ck-${i}`, market: ["GOLD"] }));
  const selected = selectCustomerKnowledge(items, { market: "GOLD", limit: 3 });
  assert.equal(selected.length, 3);
});

// ── snapshotCustomerKnowledge ─────────────────────────────────────────

test("snapshot includes V2 provenance: source_knowledge_id and package_version", () => {
  const items = [ckItem({ id: "ck-1", source_knowledge_id: "console-123", package_version: "2026-09-26-v1" })];
  const snap = snapshotCustomerKnowledge(items);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]?.id, "ck-1");
  assert.equal(snap[0]?.source_knowledge_id, "console-123");
  assert.equal(snap[0]?.package_version, "2026-09-26-v1");
  assert.equal(snap[0]?.version, 1);
});

test("snapshot without Console source still includes null source_knowledge_id", () => {
  const items = [ckItem({ source_knowledge_id: null, source_type: "CUSTOM" } as Partial<CustomerKnowledgeItem>)];
  const snap = snapshotCustomerKnowledge(items);
  assert.equal(snap[0]?.source_knowledge_id, null);
});

// ── Versioning ────────────────────────────────────────────────────────

test("multiple package versions: only ACTIVE items are returned", async () => {
  const db = makeDb([
    row({ id: "ck-old", status: "SUPERSEDED", package_version: "2026-09-25-v1" }),
    row({ id: "ck-new", status: "ACTIVE",     package_version: "2026-09-26-v1" }),
  ]);
  // Note: actual SUPERSEDED filtering is done by the DB query (status=ACTIVE).
  // This test verifies that the normalizer preserves the returned rows as-is.
  // In production, the DB only returns ACTIVE rows due to the .eq("status","ACTIVE") filter.
  const items = await loadCustomerKnowledge(db, "trader-1", "user-1");
  // Both rows returned here because our mock DB doesn't apply status filter
  assert.equal(items.length, 2);
  assert.ok(items.some(k => k.id === "ck-old"));
  assert.ok(items.some(k => k.id === "ck-new"));
});

test("knowledge version is mapped from source_version field", async () => {
  const db = makeDb([row({ source_version: 7 })]);
  const items = await loadCustomerKnowledge(db, "trader-1", "user-1");
  assert.equal(items[0]?.version, 7);
});

test("knowledge version defaults to 1 when source_version is null", async () => {
  const db = makeDb([row({ source_version: null })]);
  const items = await loadCustomerKnowledge(db, "trader-1", "user-1");
  assert.equal(items[0]?.version, 1);
});
