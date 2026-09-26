import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkLiveTarget, resolveTargetSupabaseRef } from "../live-target-guard";

const PROD = "bsmofroshpmomjwfxigh";
const DEV = "abcdefghijklmnopqrst";
const url = (ref: string) => `https://${ref}.supabase.co`;
const emptyDir = () => mkdtempSync(path.join(tmpdir(), "avl-guard-"));

test("no opt-in → refused, even for a non-production target", () => {
  const d = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { NEXT_PUBLIC_SUPABASE_URL: url(DEV) }, emptyDir());
  assert.equal(d.allowed, false);
});

test("opt-in + Production ref without acknowledgement → refused", () => {
  const d = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { AVL_ALLOW_LIVE_SCRIPT: "1", NEXT_PUBLIC_SUPABASE_URL: url(PROD) }, emptyDir());
  assert.equal(d.allowed, false);
  assert.match((d as { reason: string }).reason, /PRODUCTION/);
});

test("opt-in + Production ref + wrong acknowledgement → refused", () => {
  for (const ack of ["1", "yes", DEV, PROD.toUpperCase(), ""]) {
    const d = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { AVL_ALLOW_LIVE_SCRIPT: "1", SUPABASE_URL: url(PROD), AVL_ACK_PRODUCTION_MUTATION: ack }, emptyDir());
    assert.equal(d.allowed, false, `ack=${ack}`);
  }
});

test("opt-in + Production ref + exact acknowledgement → allowed and flagged production", () => {
  const d = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { AVL_ALLOW_LIVE_SCRIPT: "1", TV_SUPABASE_URL: url(PROD), AVL_ACK_PRODUCTION_MUTATION: PROD }, emptyDir());
  assert.deepEqual(d, { allowed: true, ref: PROD, production: true });
});

test("opt-in + non-production ref → allowed without acknowledgement", () => {
  const d = checkLiveTarget("AVL_ALLOW_LIVE_DB_INTEGRATION", { AVL_ALLOW_LIVE_DB_INTEGRATION: "1", NEXT_PUBLIC_SUPABASE_URL: url(DEV) }, emptyDir());
  assert.deepEqual(d, { allowed: true, ref: DEV, production: false });
});

test("unknown target is treated as Production (fail closed), even with an acknowledgement", () => {
  const d = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { AVL_ALLOW_LIVE_SCRIPT: "1", AVL_ACK_PRODUCTION_MUTATION: PROD }, emptyDir());
  assert.equal(d.allowed, false);
  assert.match((d as { reason: string }).reason, /could not be determined/);
});

test("target is read from .env.local when the environment has no URL (scripts load it later)", () => {
  const dir = emptyDir();
  writeFileSync(path.join(dir, ".env.local"), `NODE_ENV=development\nNEXT_PUBLIC_SUPABASE_URL="${url(PROD)}"\n`);
  assert.equal(resolveTargetSupabaseRef({}, dir), PROD);
  assert.equal(checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT", { AVL_ALLOW_LIVE_SCRIPT: "1" }, dir).allowed, false);
});

test("environment URL wins over .env.local", () => {
  const dir = emptyDir();
  writeFileSync(path.join(dir, ".env.local"), `NEXT_PUBLIC_SUPABASE_URL=${url(PROD)}\n`);
  assert.equal(resolveTargetSupabaseRef({ NEXT_PUBLIC_SUPABASE_URL: url(DEV) }, dir), DEV);
});
