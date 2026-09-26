// Side-effect guard — import FIRST in any script that can write to a real
// Supabase / Management API / Gateway. `.env.local` points at the Production
// Supabase, so a script run "just to try it" would mutate Production.
// Safe default: refuse. Opt in explicitly:
//   AVL_ALLOW_LIVE_SCRIPT=1 npx tsx --env-file=<non-prod env> scripts/<script>.ts
// A Production target additionally needs AVL_ACK_PRODUCTION_MUTATION=<project ref>.
import { checkLiveTarget } from "../../src/lib/safety/live-target-guard";

const decision = checkLiveTarget("AVL_ALLOW_LIVE_SCRIPT");
if (!decision.allowed) {
  console.error(`REFUSED: this script can write to real infrastructure — ${decision.reason}.`);
  process.exit(2);
}
if (decision.production) {
  console.error(`WARNING: running against PRODUCTION Supabase ${decision.ref} (acknowledged).`);
}
export {};
