// READ-ONLY production health check used around credential rotation.
// Sends only GETs and deliberately-wrong secrets (which must be rejected with
// 401 before any work starts). Never triggers a cron/watcher run, never writes.
//   npx tsx scripts/rotation/prod-health-check.ts
const TV = "https://avl-fx.vercel.app";
const CONSOLE = "https://avl-fx-console.vercel.app";
const GATEWAY = "https://remarkable-cooperation-production-7341.up.railway.app";
const WRONG = "rotation-health-check-invalid-secret";

type Check = { name: string; url: string; init?: RequestInit; expect: number[] };
const checks: Check[] = [
  { name: "TV login page",                 url: `${TV}/login`, expect: [200] },
  { name: "TV API rejects anonymous",      url: `${TV}/api/traders`, expect: [401] },
  { name: "Console responds",              url: `${CONSOLE}/`, expect: [200, 307, 308] },
  { name: "Gateway /health",               url: `${GATEWAY}/health`, expect: [200] },
  { name: "Cron h1 rejects wrong secret",  url: `${TV}/api/cron/h1-strategy`, init: { method: "POST", headers: { "x-cron-secret": WRONG, authorization: `Bearer ${WRONG}` } }, expect: [401] },
  { name: "Cron watch-traders rejects",    url: `${TV}/api/cron/watch-traders`, init: { headers: { authorization: `Bearer ${WRONG}` } }, expect: [401] },
  { name: "Watcher m5-close rejects",      url: `${TV}/api/watcher/m5-close`, init: { method: "POST", headers: { "x-watcher-secret": WRONG, "content-type": "application/json" }, body: "{}" }, expect: [401] },
];

(async () => {
  let failed = 0;
  for (const c of checks) {
    try {
      const r = await fetch(c.url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...c.init });
      const ok = c.expect.includes(r.status);
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(32)} HTTP ${r.status} (expect ${c.expect.join("/")})`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${c.name.padEnd(32)} ${(e as Error).message}`);
    }
  }
  console.log(failed ? `HEALTH: ${failed} FAILED` : "HEALTH: ALL PASS");
  process.exit(failed ? 1 : 0);
})();
