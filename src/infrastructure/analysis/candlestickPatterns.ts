import type { Bar, CandlePattern, ModuleResult } from "./types";

function body(b: Bar): number { return Math.abs(b.close - b.open); }
function range(b: Bar): number { return b.high - b.low || 0.00001; }
function upperWick(b: Bar): number { return b.high - Math.max(b.open, b.close); }
function lowerWick(b: Bar): number { return Math.min(b.open, b.close) - b.low; }
function isBull(b: Bar): boolean { return b.close >= b.open; }

function detectPatterns(bars: Bar[], tf: string): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  if (bars.length < 3) return patterns;

  const c = bars[bars.length - 1];
  const p = bars[bars.length - 2];
  const pp = bars[bars.length - 3];

  const cBody = body(c); const cRange = range(c);
  const pBody = body(p); const pRange = range(p);

  // Doji
  if (cBody < 0.1 * cRange) {
    patterns.push({ name: 'Doji', direction: 'neutral', strength: 50, tf });
  }

  // Pin Bar Bullish
  if (lowerWick(c) > 2 * cBody && upperWick(c) < cBody && Math.min(c.open, c.close) > c.low + 0.6 * cRange) {
    patterns.push({ name: 'Pin Bar Bullish', direction: 'bullish', strength: 80, tf });
  }

  // Pin Bar Bearish
  if (upperWick(c) > 2 * cBody && lowerWick(c) < cBody && Math.max(c.open, c.close) < c.low + 0.4 * cRange) {
    patterns.push({ name: 'Pin Bar Bearish', direction: 'bearish', strength: 80, tf });
  }

  // Bullish Engulfing
  if (isBull(c) && !isBull(p) && c.open < p.close && c.close > p.open && cBody > pBody) {
    patterns.push({ name: 'Bullish Engulfing', direction: 'bullish', strength: 85, tf });
  }

  // Bearish Engulfing
  if (!isBull(c) && isBull(p) && c.open > p.close && c.close < p.open && cBody > pBody) {
    patterns.push({ name: 'Bearish Engulfing', direction: 'bearish', strength: 85, tf });
  }

  // Hammer (bullish pin after downtrend: lowerWick > 2×body, small upper)
  const recentClose = bars.slice(-6, -1).map(b => b.close);
  const downTrend = recentClose.length >= 2 && recentClose[0] > recentClose[recentClose.length - 1];
  const upTrend   = recentClose.length >= 2 && recentClose[0] < recentClose[recentClose.length - 1];

  if (downTrend && lowerWick(c) > 2 * cBody && upperWick(c) < 0.5 * cBody) {
    patterns.push({ name: 'Hammer', direction: 'bullish', strength: 75, tf });
  }

  // Shooting Star (after uptrend)
  if (upTrend && upperWick(c) > 2 * cBody && lowerWick(c) < 0.5 * cBody) {
    patterns.push({ name: 'Shooting Star', direction: 'bearish', strength: 75, tf });
  }

  // Morning Star
  if (bars.length >= 3 && !isBull(pp) && pBody < 0.3 * pRange && isBull(c) && c.close > (pp.open + pp.close) / 2) {
    patterns.push({ name: 'Morning Star', direction: 'bullish', strength: 90, tf });
  }

  // Evening Star
  if (bars.length >= 3 && isBull(pp) && pBody < 0.3 * pRange && !isBull(c) && c.close < (pp.open + pp.close) / 2) {
    patterns.push({ name: 'Evening Star', direction: 'bearish', strength: 90, tf });
  }

  // Bullish Harami
  if (!isBull(p) && isBull(c) && c.open > Math.min(p.open, p.close) && c.close < Math.max(p.open, p.close) && cBody < pBody) {
    patterns.push({ name: 'Bullish Harami', direction: 'bullish', strength: 60, tf });
  }

  // Bearish Harami
  if (isBull(p) && !isBull(c) && c.open < Math.max(p.open, p.close) && c.close > Math.min(p.open, p.close) && cBody < pBody) {
    patterns.push({ name: 'Bearish Harami', direction: 'bearish', strength: 60, tf });
  }

  return patterns;
}

export function analyzeCandlestickPatterns(
  barsByTf: Record<string, Bar[]>,
): ModuleResult & { patterns: CandlePattern[] } {
  try {
    const allPatterns: CandlePattern[] = [];
    for (const tf of ['H4', 'H1', 'M15']) {
      const bars = barsByTf[tf];
      if (bars && bars.length >= 3) {
        allPatterns.push(...detectPatterns(bars.slice(-10), tf));
      }
    }

    const bullish = allPatterns.filter(p => p.direction === 'bullish');
    const bearish = allPatterns.filter(p => p.direction === 'bearish');

    let direction: 'BUY'|'SELL'|'NEUTRAL' = 'NEUTRAL';
    let score = 50;

    if (bullish.length > bearish.length) {
      direction = 'BUY';
      score = 50 + Math.min(bullish.length * 10, 40);
    } else if (bearish.length > bullish.length) {
      direction = 'SELL';
      score = 50 + Math.min(bearish.length * 10, 40);
    }

    return {
      score,
      direction,
      patterns: allPatterns,
      summary: allPatterns.length === 0
        ? 'No significant candlestick patterns.'
        : `${allPatterns.map(p => p.name).join(', ')}.`,
      details: { bullishCount: bullish.length, bearishCount: bearish.length },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', patterns: [],
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
