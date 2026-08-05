import type { Bar, ChartPattern, ModuleResult } from "./types";

function linReg(ys: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumXX - sumX * sumX || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function findPeaks(bars: Bar[], minDist = 5): number[] {
  const peaks: number[] = [];
  for (let i = minDist; i < bars.length - minDist; i++) {
    const win = bars.slice(i - minDist, i + minDist + 1);
    if (bars[i].high === Math.max(...win.map(b => b.high))) peaks.push(i);
  }
  return peaks;
}

function findTroughs(bars: Bar[], minDist = 5): number[] {
  const troughs: number[] = [];
  for (let i = minDist; i < bars.length - minDist; i++) {
    const win = bars.slice(i - minDist, i + minDist + 1);
    if (bars[i].low === Math.min(...win.map(b => b.low))) troughs.push(i);
  }
  return troughs;
}

export function analyzeChartPatterns(
  h4Bars: Bar[],
): ModuleResult & { patterns: ChartPattern[] } {
  try {
    const bars = h4Bars.slice(-100);
    const patterns: ChartPattern[] = [];

    const peaks   = findPeaks(bars);
    const troughs = findTroughs(bars);

    // Double Top
    if (peaks.length >= 2) {
      const [p1, p2] = peaks.slice(-2);
      const h1 = bars[p1].high, h2 = bars[p2].high;
      if (p2 > p1 && Math.abs(h1 - h2) / h1 < 0.003) {
        patterns.push({ name: 'Double Top', direction: 'bearish', confidence: 75 });
      }
    }

    // Double Bottom
    if (troughs.length >= 2) {
      const [t1, t2] = troughs.slice(-2);
      const l1 = bars[t1].low, l2 = bars[t2].low;
      if (t2 > t1 && Math.abs(l1 - l2) / l1 < 0.003) {
        patterns.push({ name: 'Double Bottom', direction: 'bullish', confidence: 75 });
      }
    }

    // Head & Shoulders
    if (peaks.length >= 3) {
      const [s1, head, s2] = peaks.slice(-3);
      const h1 = bars[s1].high, hh = bars[head].high, h2 = bars[s2].high;
      if (hh > h1 && hh > h2 && Math.abs(h1 - h2) / h1 < 0.01) {
        patterns.push({ name: 'Head & Shoulders', direction: 'bearish', confidence: 80 });
      }
    }

    // Inverse Head & Shoulders
    if (troughs.length >= 3) {
      const [s1, head, s2] = troughs.slice(-3);
      const l1 = bars[s1].low, lh = bars[head].low, l2 = bars[s2].low;
      if (lh < l1 && lh < l2 && Math.abs(l1 - l2) / l1 < 0.01) {
        patterns.push({ name: 'Inverse H&S', direction: 'bullish', confidence: 80 });
      }
    }

    // Ascending / Descending Triangle and Wedges (linear regression on swing highs/lows)
    if (peaks.length >= 3 && troughs.length >= 3) {
      const recentPeaks   = peaks.slice(-5);
      const recentTroughs = troughs.slice(-5);

      const highSlope  = linReg(recentPeaks.map(i => bars[i].high)).slope;
      const lowSlope   = linReg(recentTroughs.map(i => bars[i].low)).slope;

      const highFlat   = Math.abs(highSlope) < 0.00005;
      const lowFlat    = Math.abs(lowSlope)  < 0.00005;

      if (highFlat && lowSlope > 0) {
        patterns.push({ name: 'Ascending Triangle', direction: 'bullish', confidence: 70 });
      } else if (lowFlat && highSlope < 0) {
        patterns.push({ name: 'Descending Triangle', direction: 'bearish', confidence: 70 });
      } else if (highSlope > 0 && lowSlope > 0 && highSlope < lowSlope) {
        patterns.push({ name: 'Rising Wedge', direction: 'bearish', confidence: 65 });
      } else if (highSlope < 0 && lowSlope < 0 && highSlope > lowSlope) {
        patterns.push({ name: 'Falling Wedge', direction: 'bullish', confidence: 65 });
      }
    }

    const bullish = patterns.filter(p => p.direction === 'bullish');
    const bearish = patterns.filter(p => p.direction === 'bearish');

    let direction: 'BUY'|'SELL'|'NEUTRAL' = 'NEUTRAL';
    let score = 50;

    if (bullish.length > bearish.length) {
      direction = 'BUY';
      score = Math.max(...bullish.map(p => p.confidence));
    } else if (bearish.length > bullish.length) {
      direction = 'SELL';
      score = Math.max(...bearish.map(p => p.confidence));
    }

    return {
      score,
      direction,
      patterns,
      summary: patterns.length === 0
        ? 'No chart patterns detected.'
        : patterns.map(p => p.name).join(', ') + '.',
      details: { patternCount: patterns.length },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', patterns: [],
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
