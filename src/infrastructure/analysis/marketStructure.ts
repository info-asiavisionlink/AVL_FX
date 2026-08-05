import type { Bar, SwingPoint, ModuleResult } from "./types";

function detectSwings(bars: Bar[]): SwingPoint[] {
  const highs: SwingPoint[] = [];
  const lows:  SwingPoint[] = [];

  for (let i = 2; i < bars.length - 2; i++) {
    const window = bars.slice(i - 2, i + 3);
    const maxH = Math.max(...window.map(b => b.high));
    const minL = Math.min(...window.map(b => b.low));

    if (bars[i].high === maxH) {
      highs.push({ time: bars[i].time, price: bars[i].high, type: 'high', label: 'H' });
    }
    if (bars[i].low === minL) {
      lows.push({ time: bars[i].time, price: bars[i].low, type: 'low', label: 'L' });
    }
  }

  const labeledHighs: SwingPoint[] = highs.map((h, i) => {
    if (i === 0) return h;
    return { ...h, label: h.price > highs[i - 1].price ? 'HH' : 'LH' };
  });

  const labeledLows: SwingPoint[] = lows.map((l, i) => {
    if (i === 0) return l;
    return { ...l, label: l.price > lows[i - 1].price ? 'HL' : 'LL' };
  });

  return [...labeledHighs, ...labeledLows].sort((a, b) => a.time - b.time);
}

function classifyTrend(highs: SwingPoint[], lows: SwingPoint[]): 'UPTREND'|'DOWNTREND'|'RANGE' {
  const lastHighs = highs.slice(-3);
  const lastLows  = lows.slice(-3);

  const hhCount = lastHighs.filter(h => h.label === 'HH').length;
  const lhCount = lastHighs.filter(h => h.label === 'LH').length;
  const hlCount = lastLows.filter(l => l.label === 'HL').length;
  const llCount = lastLows.filter(l => l.label === 'LL').length;

  if (hhCount >= 2 && hlCount >= 2) return 'UPTREND';
  if (lhCount >= 2 && llCount >= 2) return 'DOWNTREND';
  return 'RANGE';
}

function trendScore(highs: SwingPoint[], lows: SwingPoint[], trend: 'UPTREND'|'DOWNTREND'|'RANGE'): number {
  if (trend === 'RANGE') return 50;

  const lastHighs = highs.slice(-3);
  const lastLows  = lows.slice(-3);

  let score = 50;
  if (trend === 'UPTREND') {
    const hhCount = lastHighs.filter(h => h.label === 'HH').length;
    const hlCount = lastLows.filter(l => l.label === 'HL').length;
    score = 50 + hhCount * 15 + hlCount * 10;
  } else {
    const lhCount = lastHighs.filter(h => h.label === 'LH').length;
    const llCount = lastLows.filter(l => l.label === 'LL').length;
    score = 50 + lhCount * 15 + llCount * 10;
  }
  return Math.min(score, 98);
}

export function analyzeMarketStructure(
  h4Bars: Bar[],
  d1Bars: Bar[],
): ModuleResult & { trend: 'UPTREND'|'DOWNTREND'|'RANGE'; swingPoints: SwingPoint[] } {
  try {
    const h4Swings = detectSwings(h4Bars);
    const h4Highs  = h4Swings.filter(s => s.type === 'high');
    const h4Lows   = h4Swings.filter(s => s.type === 'low');
    const h4Trend  = classifyTrend(h4Highs, h4Lows);
    const h4Score  = trendScore(h4Highs, h4Lows, h4Trend);

    let d1Trend: 'UPTREND'|'DOWNTREND'|'RANGE' = 'RANGE';
    if (d1Bars.length >= 6) {
      const d1Swings = detectSwings(d1Bars);
      const d1Highs  = d1Swings.filter(s => s.type === 'high');
      const d1Lows   = d1Swings.filter(s => s.type === 'low');
      d1Trend = classifyTrend(d1Highs, d1Lows);
    }

    const direction = h4Trend === 'UPTREND' ? 'BUY' : h4Trend === 'DOWNTREND' ? 'SELL' : 'NEUTRAL';
    const confirmedByD1 = d1Trend === h4Trend;
    const finalScore = confirmedByD1 ? Math.min(h4Score + 5, 99) : h4Score;

    return {
      score: finalScore,
      direction,
      trend: h4Trend,
      swingPoints: h4Swings.slice(-20),
      summary: `${h4Trend} on H4${confirmedByD1 ? ', confirmed by D1' : ', D1 diverges'}.`,
      details: { h4Trend, d1Trend, h4SwingCount: h4Swings.length },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', trend: 'RANGE', swingPoints: [],
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
