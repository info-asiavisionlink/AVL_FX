// Two-step opt-in for code that can WRITE to real infrastructure from a
// developer machine (scripts, live integration tests). Not used by the
// deployed app runtime.
//
//   1. `<optInVar>=1`                          — "I mean to touch a real project"
//   2. `AVL_ACK_PRODUCTION_MUTATION=<ref>`     — required in addition when the
//      target Supabase is a known Production project (or cannot be determined).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PRODUCTION_SUPABASE_REFS: readonly string[] = [
  "bsmofroshpmomjwfxigh", // AVL-FX Trading View Production (serves avl-fx.vercel.app)
];

type Env = Record<string, string | undefined>;

const URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "TV_SUPABASE_URL"] as const;

function refFromUrl(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(url?.trim() ?? "");
  return m ? m[1] : null;
}

/** Target project ref from the environment, else from .env.local (scripts load it later). */
export function resolveTargetSupabaseRef(env: Env = process.env, cwd = process.cwd()): string | null {
  for (const v of URL_VARS) {
    const ref = refFromUrl(env[v]);
    if (ref) return ref;
  }
  const file = path.join(cwd, ".env.local");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  for (const v of URL_VARS) {
    const m = new RegExp(`^${v}=["']?([^"'\\s]+)`, "m").exec(text);
    const ref = refFromUrl(m?.[1]);
    if (ref) return ref;
  }
  return null;
}

export type LiveTargetDecision =
  | { allowed: true; ref: string; production: boolean }
  | { allowed: false; reason: string };

export function checkLiveTarget(optInVar: string, env: Env = process.env, cwd = process.cwd()): LiveTargetDecision {
  if (env[optInVar] !== "1") {
    return { allowed: false, reason: `${optInVar}=1 is not set` };
  }
  const ref = resolveTargetSupabaseRef(env, cwd);
  // Unknown target is treated as Production (fail closed).
  const production = ref === null || PRODUCTION_SUPABASE_REFS.includes(ref);
  if (production) {
    const ack = env.AVL_ACK_PRODUCTION_MUTATION;
    if (ref === null || ack !== ref) {
      return {
        allowed: false,
        reason: ref === null
          ? "target Supabase project could not be determined (treated as Production)"
          : `target is the PRODUCTION Supabase project; also set AVL_ACK_PRODUCTION_MUTATION=${ref} after Owner approval`,
      };
    }
  }
  return { allowed: true, ref: ref as string, production };
}
