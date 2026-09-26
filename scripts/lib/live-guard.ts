// Side-effect guard — import FIRST in any script that can write to a real
// Supabase / Management API / Gateway. `.env.local` points at the Production
// Supabase, so a script run "just to try it" mutates Production.
// Safe default: refuse. Opt in explicitly, against a non-production target:
//   AVL_ALLOW_LIVE_SCRIPT=1 npx tsx --env-file=<non-prod env> scripts/<script>.ts
if (process.env.AVL_ALLOW_LIVE_SCRIPT !== "1") {
  console.error(
    "REFUSED: this script can write to real infrastructure. " +
    "Set AVL_ALLOW_LIVE_SCRIPT=1 against a non-production project to run it.",
  );
  process.exit(2);
}
export {};
