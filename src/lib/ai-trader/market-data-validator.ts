// =================================================================
// market-data-validator.ts
// Purpose: Pure validation functions for market data before entry decisions
// Design:  Fail Closed — invalid/missing data = NO ENTRY
//          NEVER substitute Date.now() for missing timestamps
// Used by: analyze route, watcher route, execute route, tests
// =================================================================

export interface ValidationResult {
  valid:  boolean;
  reason: string;
}

export interface Bar {
  time:   number;   // broker epoch seconds
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface TickData {
  bid:     number;
  ask:     number;
  spread:  number;
  time:    number;  // broker epoch seconds
}

// Maximum staleness by timeframe (seconds)
export const MAX_BAR_STALE_SECONDS: Readonly<Record<string, number>> = {
  M1:  120,     // 2 min
  M5:  600,     // 10 min
  M15: 1800,    // 30 min
  M30: 3600,    // 1 hour
  H1:  7200,    // 2 hours
  H4:  28800,   // 8 hours
  D1:  172800,  // 2 days
  W1:  864000,  // 10 days
};

export const MAX_TICK_STALE_SECONDS = 30;

// -----------------------------------------------------------------
// Core helpers
// -----------------------------------------------------------------

/**
 * Validate a broker-second timestamp.
 * IMPORTANT: A missing/zero/NaN timestamp is INVALID.
 * Do NOT substitute Date.now() — unknown timestamp = STALE/INVALID.
 */
export function isValidBrokerTimestamp(ts: number | null | undefined): boolean {
  if (ts === null || ts === undefined) return false;
  if (typeof ts !== "number") return false;
  if (!isFinite(ts) || isNaN(ts)) return false;
  if (ts <= 0) return false;
  // Reject anything more than 5 seconds in the future
  const nowSeconds = Date.now() / 1000;
  if (ts > nowSeconds + 5) return false;
  return true;
}

/**
 * Validate OHLC values: finite, positive, proper high >= low,
 * high >= open/close, low <= open/close.
 */
export function isValidOHLC(
  open: number,
  high: number,
  low:  number,
  close: number,
): boolean {
  if ([open, high, low, close].some((v) => !isFinite(v) || isNaN(v) || v <= 0)) return false;
  if (high < low)   return false;
  if (high < open)  return false;
  if (high < close) return false;
  if (low > open)   return false;
  if (low > close)  return false;
  return true;
}

// -----------------------------------------------------------------
// Entry validation guards
// -----------------------------------------------------------------

/**
 * Validate an array of bars before using them in an entry decision.
 * Fail Closed: 0 bars, too few bars, invalid timestamps, invalid OHLC,
 * or stale bars all return { valid: false }.
 */
export function validateBarsForEntry(
  bars:      Bar[],
  timeframe: string,
  minCount = 5,
): ValidationResult {
  if (!bars || bars.length === 0) {
    return { valid: false, reason: `BARS_EMPTY tf=${timeframe}` };
  }
  if (bars.length < minCount) {
    return {
      valid: false,
      reason: `BARS_INSUFFICIENT count=${bars.length} min=${minCount} tf=${timeframe}`,
    };
  }

  // Validate recent bars (check last min(10, length) bars)
  const checkFrom = Math.max(0, bars.length - 10);
  for (let i = checkFrom; i < bars.length; i++) {
    const b = bars[i];
    if (!b) {
      return { valid: false, reason: `BAR_NULL at=${i} tf=${timeframe}` };
    }
    if (!isValidBrokerTimestamp(b.time)) {
      return {
        valid: false,
        reason: `BAR_TIMESTAMP_INVALID time=${b.time} at=${i} tf=${timeframe}`,
      };
    }
    if (!isValidOHLC(b.open, b.high, b.low, b.close)) {
      return {
        valid: false,
        reason: `BAR_OHLC_INVALID o=${b.open} h=${b.high} l=${b.low} c=${b.close} at=${i} tf=${timeframe}`,
      };
    }
  }

  // Staleness check on most recent bar
  const latestBar      = bars[bars.length - 1]!;
  const maxStale       = MAX_BAR_STALE_SECONDS[timeframe] ?? 7200;
  const nowSeconds     = Date.now() / 1000;
  const ageSeconds     = nowSeconds - latestBar.time;
  if (ageSeconds > maxStale) {
    return {
      valid: false,
      reason: `BARS_STALE age=${Math.round(ageSeconds)}s max=${maxStale}s tf=${timeframe}`,
    };
  }

  return { valid: true, reason: "OK" };
}

/**
 * Validate current price for entry.
 */
export function validateCurrentPrice(price: number | null | undefined): ValidationResult {
  if (price === null || price === undefined) {
    return { valid: false, reason: "PRICE_MISSING" };
  }
  if (!isFinite(price) || isNaN(price) || price <= 0) {
    return { valid: false, reason: `PRICE_INVALID price=${price}` };
  }
  return { valid: true, reason: "OK" };
}

/**
 * Validate a tick for use in an entry decision.
 * IMPORTANT: missing timestamp = INVALID (do NOT substitute Date.now()).
 */
export function validateTickForEntry(
  tick:          TickData | null | undefined,
  maxAgeSeconds = MAX_TICK_STALE_SECONDS,
): ValidationResult {
  if (!tick) {
    return { valid: false, reason: "TICK_MISSING" };
  }
  if (typeof tick.bid !== "number" || !Number.isFinite(tick.bid) || tick.bid <= 0) {
    return { valid: false, reason: `TICK_PRICE_INVALID bid=${tick.bid}` };
  }
  if (typeof tick.ask !== "number" || !Number.isFinite(tick.ask) || tick.ask <= 0) {
    return { valid: false, reason: `TICK_PRICE_INVALID ask=${tick.ask}` };
  }
  if (tick.ask < tick.bid) {
    return { valid: false, reason: `TICK_PRICE_INVALID ask_lt_bid ask=${tick.ask} bid=${tick.bid}` };
  }
  if (typeof tick.spread !== "number" || !Number.isFinite(tick.spread) || tick.spread < 0) {
    return { valid: false, reason: `TICK_SPREAD_INVALID spread=${tick.spread}` };
  }
  if (!isValidBrokerTimestamp(tick.time)) {
    return { valid: false, reason: `TICK_TIMESTAMP_INVALID time=${tick.time}` };
  }
  const nowSeconds = Date.now() / 1000;
  const ageSeconds = nowSeconds - tick.time;
  if (ageSeconds > maxAgeSeconds) {
    return {
      valid: false,
      reason: `TICK_STALE age=${Math.round(ageSeconds)}s max=${maxAgeSeconds}s`,
    };
  }
  return { valid: true, reason: "OK" };
}

/**
 * Validate a MODIFY_SL proposed value.
 * Rules: positive finite, doesn't round to 0, correct direction, minimum distance.
 *
 * @param newSl        - Proposed new SL price
 * @param currentPrice - Current market price (ask for BUY, bid for SELL)
 * @param side         - Position side "BUY" or "SELL"
 * @param minDistance  - Broker stops_level in price (minimum distance from price)
 * @param digits       - Symbol digits for rounding (e.g. 2 for GOLD)
 */
export function validateModifySL(
  newSl:         number | null | undefined,
  currentPrice:  number,
  side:          "BUY" | "SELL",
  minDistance:   number,
  digits:        number,
): ValidationResult {
  if (newSl === null || newSl === undefined) {
    return { valid: false, reason: "MODIFY_SL_MISSING" };
  }
  if (!isFinite(newSl) || isNaN(newSl)) {
    return { valid: false, reason: `MODIFY_SL_NOT_FINITE newSl=${newSl}` };
  }
  if (newSl <= 0) {
    return { valid: false, reason: `MODIFY_SL_NOT_POSITIVE newSl=${newSl}` };
  }

  // Check rounding doesn't collapse to 0
  const factor  = Math.pow(10, digits);
  const rounded = Math.round(newSl * factor) / factor;
  if (rounded <= 0) {
    return {
      valid: false,
      reason: `MODIFY_SL_ROUNDS_TO_ZERO newSl=${newSl} digits=${digits} rounded=${rounded}`,
    };
  }

  if (!isFinite(currentPrice) || isNaN(currentPrice) || currentPrice <= 0) {
    return { valid: false, reason: `MODIFY_SL_PRICE_INVALID currentPrice=${currentPrice}` };
  }

  if (side === "BUY") {
    // BUY SL must be strictly below current price
    if (rounded >= currentPrice) {
      return {
        valid: false,
        reason: `MODIFY_SL_WRONG_DIRECTION_BUY sl=${rounded} price=${currentPrice}`,
      };
    }
    if (minDistance > 0 && currentPrice - rounded < minDistance) {
      return {
        valid: false,
        reason: `MODIFY_SL_TOO_CLOSE_BUY sl=${rounded} price=${currentPrice} min=${minDistance}`,
      };
    }
  } else {
    // SELL SL must be strictly above current price
    if (rounded <= currentPrice) {
      return {
        valid: false,
        reason: `MODIFY_SL_WRONG_DIRECTION_SELL sl=${rounded} price=${currentPrice}`,
      };
    }
    if (minDistance > 0 && rounded - currentPrice < minDistance) {
      return {
        valid: false,
        reason: `MODIFY_SL_TOO_CLOSE_SELL sl=${rounded} price=${currentPrice} min=${minDistance}`,
      };
    }
  }

  return { valid: true, reason: "OK" };
}

/**
 * Deterministic protection rule for an existing position. A stop may only
 * move toward less risk; an absent/invalid current stop is fail-closed.
 */
export function validateFavorableStopLossMove(
  newSl: number | null | undefined,
  currentSl: number | null | undefined,
  side: "BUY" | "SELL",
  digits = 2,
  tickSize?: number,
): ValidationResult {
  if (newSl === null || newSl === undefined || typeof newSl !== "number" || !Number.isFinite(newSl) || newSl <= 0) {
    return { valid: false, reason: "MODIFY_SL_NEW_INVALID" };
  }
  if (currentSl === null || currentSl === undefined || typeof currentSl !== "number" || !Number.isFinite(currentSl) || currentSl <= 0) {
    return { valid: false, reason: "MODIFY_SL_CURRENT_INVALID" };
  }
  const normalize = (value: number) => {
    if (tickSize !== undefined && Number.isFinite(tickSize) && tickSize > 0) return Math.round(value / tickSize) * tickSize;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const normalizedNew = normalize(newSl);
  const normalizedCurrent = normalize(currentSl);
  if (!Number.isFinite(normalizedNew) || !Number.isFinite(normalizedCurrent) || normalizedNew <= 0 || normalizedCurrent <= 0) {
    return { valid: false, reason: "MODIFY_SL_NORMALIZED_INVALID" };
  }
  if (side === "BUY" && normalizedNew < normalizedCurrent) {
    return { valid: false, reason: `MODIFY_SL_UNFAVORABLE_BUY new=${normalizedNew} current=${normalizedCurrent}` };
  }
  if (side === "SELL" && normalizedNew > normalizedCurrent) {
    return { valid: false, reason: `MODIFY_SL_UNFAVORABLE_SELL new=${normalizedNew} current=${normalizedCurrent}` };
  }
  return { valid: true, reason: "OK" };
}
