import type { Bar, SwingPoint, ModuleResult } from "./types";

// ── ZigZag swing detection ──────────────────────────────────────
// lookback: 各サイドの確認バー数。高時間足は5、低時間足は3
function detectSwings(bars: Bar[], lookback = 2): SwingPoint[] {
  const highs: SwingPoint[] = [];
  const lows:  SwingPoint[] = [];

  for (let i = lookback; i < bars.length - lookback; i++) {
    const win  = bars.slice(i - lookback, i + lookback + 1);
    const maxH = Math.max(...win.map(b => b.high));
    const minL = Math.min(...win.map(b => b.low));

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

// ── Lower-TF (M5/M1) Dow structure for scalping context ─────────
export interface ScalpingStructure {
  tf:        string;
  trend:     'UPTREND' | 'DOWNTREND' | 'RANGE';
  lastSwing: SwingPoint | null;
  pullback:  boolean;    // 短期プルバック中かどうか
  summary:   string;
}

export function analyzeScalpingStructure(bars: Bar[], tf: string): ScalpingStructure {
  try {
    const lookback = tf === 'M1' ? 2 : 3;
    const swings   = detectSwings(bars, lookback);
    const highs    = swings.filter(s => s.type === 'high');
    const lows     = swings.filter(s => s.type === 'low');
    const trend    = classifyTrend(highs, lows);
    const lastSwing = swings.length > 0 ? swings[swings.length - 1] : null;

    // プルバック検出: 上昇トレンド中に直近バーが下落している
    const recentBars = bars.slice(-5);
    const recentDown = recentBars.length >= 2 &&
      recentBars[recentBars.length - 1].close < recentBars[0].close;
    const recentUp   = recentBars.length >= 2 &&
      recentBars[recentBars.length - 1].close > recentBars[0].close;
    const pullback   = (trend === 'UPTREND' && recentDown) || (trend === 'DOWNTREND' && recentUp);

    return {
      tf, trend, lastSwing, pullback,
      summary: `${tf}: ${trend}${pullback ? ' (pullback)' : ''}. Swings: ${swings.length}`,
    };
  } catch {
    return { tf, trend: 'RANGE', lastSwing: null, pullback: false, summary: `${tf}: error` };
  }
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
