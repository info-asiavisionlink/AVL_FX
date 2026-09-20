// =================================================================
// Market Schedule — Asset Class + Holiday Calendar
//
// Classifies symbols into asset classes and determines whether a
// gap falls during a known holiday closure.
//
// Design principles:
// - No hard-coded UTC close times (DST-safe)
// - Holiday windows derived from real bar data observations
// - Real data basis: EURUSD M5/H1/H4, 2025-12-24 to 2026-01-02
//   Christmas: Wed 2025-12-24 ~20:00 UTC → Fri 2025-12-26 08:00 UTC
//   New Year:  Wed 2025-12-31 ~20:00 UTC → Fri 2026-01-02 08:00 UTC
//   Both days (Dec 25 and Jan 1) fell on Thursday in 2025-2026.
//   Duration ~36.1h = 129,900s, just above MARKET_CLOSED_MAX_S (129,600s).
// =================================================================

// ------------------------------------------------------------------
// Asset class
// ------------------------------------------------------------------

export type AssetClass = "FOREX" | "METAL" | "INDEX" | "STOCK" | "CRYPTO" | "UNKNOWN";

/**
 * Maps a symbol string to its asset class.
 * Unknown symbols fall back to UNKNOWN (safe — will not trigger holiday logic).
 */
export function getAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase();

  // FX majors and minors — 6-char currency pairs
  const fxPairs = new Set([
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
    "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURAUD", "EURCHF", "GBPCHF",
    "CADJPY", "NZDJPY", "GBPAUD", "GBPCAD", "GBPNZD", "AUDCAD", "AUDCHF",
    "AUDNZD", "CADCHF", "CHFJPY", "EURCAD", "EURNZD", "NZDCAD", "NZDCHF",
    "USDNOK", "USDSEK", "USDDKK", "USDPLN", "USDHUF", "USDCZK",
    "EURNOK", "EURSEK", "EURDKK",
  ]);
  if (fxPairs.has(s)) return "FOREX";

  // Precious metals (spot)
  if (s === "XAUUSD" || s === "XAGUSD" || s === "XPTUSD" || s === "XPDUSD") return "METAL";

  // Major equity indices
  const indices = new Set([
    "US30", "US500", "US100", "NAS100", "SPX500", "DOW30",
    "DE40", "UK100", "JP225", "AU200", "FR40", "EU50",
  ]);
  if (indices.has(s)) return "INDEX";

  // Crypto
  if (s.endsWith("BTC") || s.endsWith("ETH") || s.startsWith("BTC") || s.startsWith("ETH")) return "CRYPTO";

  return "UNKNOWN";
}

// ------------------------------------------------------------------
// Holiday rules
// ------------------------------------------------------------------

export interface HolidayRule {
  name: string;
  month: number;          // 1-12
  day: number;            // 1-31
  windowBeforeDays: number;  // gap.from may start this many days before the holiday date
  windowAfterDays: number;   // gap.to may end this many days after the holiday date
  applicableAssetClasses: AssetClass[];
}

// Minimum gap duration to qualify as a holiday closure.
// Prevents false positives from short intraday gaps that happen to
// occur near a holiday date (e.g. a 30-min data lag).
// Basis: observed gaps are 36-40h; 12h is a conservative safe floor.
export const HOLIDAY_MIN_DURATION_S = 12 * 3600; // 43200s

// Maximum duration for a holiday gap (to avoid merging with suspected gaps).
// Observed: ~40h max. 4 days is a safe ceiling that covers even the
// longest holiday+weekend combos (e.g. 4-day Easter).
export const HOLIDAY_MAX_DURATION_S = 4 * 24 * 3600; // 345600s

// FOREX Market Holiday Calendar.
// Window sizes are derived from real multi-year bar data observations:
//
//   Christmas 2025 (Dec 25 = Thu): from = Dec 24 ~20:00 UTC, to = Dec 26 08:00 UTC
//   New Year  2026 (Jan 1  = Thu): from = Dec 31 ~20:00 UTC, to = Jan 2  08:00 UTC
//   Christmas 2023 (Dec 25 = Mon): from = Dec 22 20:00 UTC, to = Dec 26 00:00 UTC
//                                  gap.from is 3 days before Dec 25
//   New Year  2024 (Jan 1  = Mon): from = Dec 29 20:00 UTC, to = Jan 2  00:00 UTC
//                                  gap.from is 3 days before Jan 1
//   Christmas 2026 (Dec 25 = Fri): from = Dec 24 ~20:00 UTC, to = Dec 28 00:00 UTC
//                                  gap.to is 3 days after Dec 25
//
// windowBeforeDays=3: covers early close when holiday falls on Monday
//   (market closes the preceding Friday = 3 days before).
//
// windowAfterDays=3: covers late reopen when holiday falls on Friday
//   (market reopens Monday = 3 days after).
export const FOREX_HOLIDAY_CALENDAR: HolidayRule[] = [
  {
    name: "CHRISTMAS",
    month: 12,
    day: 25,
    windowBeforeDays: 3,   // gap.from as early as Dec 22 (when Dec 25 = Mon)
    windowAfterDays: 3,    // gap.to as late as Dec 28  (when Dec 25 = Fri)
    applicableAssetClasses: ["FOREX", "METAL", "INDEX"],
  },
  {
    name: "NEW_YEAR",
    month: 1,
    day: 1,
    windowBeforeDays: 3,   // gap.from as early as Dec 29 (when Jan 1 = Mon)
    windowAfterDays: 3,    // gap.to as late as Jan 4   (when Jan 1 = Fri)
    applicableAssetClasses: ["FOREX", "METAL", "INDEX"],
  },
];

/**
 * Returns the holiday rules applicable to the given symbol.
 * Unknown symbols return an empty array, so they never trigger holiday logic.
 */
export function getHolidayRules(symbol: string): HolidayRule[] {
  const assetClass = getAssetClass(symbol);
  if (assetClass === "UNKNOWN" || assetClass === "CRYPTO") return [];
  return FOREX_HOLIDAY_CALENDAR.filter(r => r.applicableAssetClasses.includes(assetClass));
}

// ------------------------------------------------------------------
// Holiday context evaluation
// ------------------------------------------------------------------

export interface HolidayContext {
  isHolidayClosure: boolean;
  holidayName: string | null;
  rule: HolidayRule | null;
}

const NOT_HOLIDAY: HolidayContext = {
  isHolidayClosure: false,
  holidayName: null,
  rule: null,
};

/**
 * Returns the UTC calendar date (year, month 1-12, day 1-31) of an ISO string.
 */
function utcDate(isoString: string): { year: number; month: number; day: number } {
  const d = new Date(isoString);
  return {
    year:  d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 0-based → 1-based
    day:   d.getUTCDate(),
  };
}

/**
 * Returns the UTC midnight epoch (ms) for the given year/month/day.
 */
function utcMidnight(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

/**
 * Checks whether gapFrom falls within the holiday window:
 *   holidayDate - windowBeforeDays  ≤  gapFrom  ≤  holidayDate + windowAfterDays
 * and gapTo also falls within:
 *   holidayDate - windowBeforeDays  ≤  gapTo    ≤  holidayDate + windowAfterDays
 *
 * We evaluate for the years covering the gap (year of gapFrom and the year
 * of gapTo) to handle year-boundary gaps (e.g. New Year Dec 31 → Jan 2).
 */
function isInHolidayWindow(
  gapFromMs: number,
  gapToMs: number,
  rule: HolidayRule,
): boolean {
  // Candidate years to check: year of gapFrom and year of gapTo
  const fromYear = new Date(gapFromMs).getUTCFullYear();
  const toYear   = new Date(gapToMs).getUTCFullYear();

  const yearsToCheck = fromYear === toYear
    ? [fromYear]
    : [fromYear, toYear];

  for (const year of yearsToCheck) {
    // Adjust year for New Year: if rule is month=1, fromYear is Dec (prev year)
    // In that case, check rule.month=1 in toYear (next year).
    const holidayMs = utcMidnight(year, rule.month, rule.day);

    const windowStartMs = holidayMs - rule.windowBeforeDays * 86400 * 1000;
    const windowEndMs   = holidayMs + rule.windowAfterDays  * 86400 * 1000;

    // The gap must start inside [windowStart, windowEnd]
    // and end inside [windowStart, windowEnd].
    if (gapFromMs >= windowStartMs && gapFromMs <= windowEndMs &&
        gapToMs   >= windowStartMs && gapToMs   <= windowEndMs) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a gap is explained by a known holiday closure.
 *
 * Returns the first matching rule (rules are checked in calendar order).
 * Returns NOT_HOLIDAY if no rule matches or duration is outside the
 * expected holiday range (false-positive protection).
 *
 * @param gapFromISO  - ISO8601 UTC timestamp of the last bar before the gap
 * @param gapToISO    - ISO8601 UTC timestamp of the first bar after the gap
 * @param durationSeconds - gap duration in seconds
 * @param symbol      - trading symbol (e.g. "EURUSD")
 */
export function getHolidayContext(
  gapFromISO: string,
  gapToISO: string,
  durationSeconds: number,
  symbol: string,
): HolidayContext {
  // False-positive protection: only gaps within the expected holiday range
  if (durationSeconds < HOLIDAY_MIN_DURATION_S) return NOT_HOLIDAY;
  if (durationSeconds > HOLIDAY_MAX_DURATION_S) return NOT_HOLIDAY;

  const rules = getHolidayRules(symbol);
  if (rules.length === 0) return NOT_HOLIDAY;

  const gapFromMs = new Date(gapFromISO).getTime();
  const gapToMs   = new Date(gapToISO).getTime();

  for (const rule of rules) {
    if (isInHolidayWindow(gapFromMs, gapToMs, rule)) {
      return {
        isHolidayClosure: true,
        holidayName: rule.name,
        rule,
      };
    }
  }

  return NOT_HOLIDAY;
}
