import type { Bar, ModuleResult } from "./types";

interface TFIndicator {
  ema21: number; ema200: number; sma50: number; atr: number; rsi: number;
  macd: number; macdSignal: number; macdHist: number;
  adx: number; diPlus: number; diMinus: number;
  bbUpper: number; bbMid: number; bbLower: number; bbWidth: number;
  trend: string;
}

function calcStochastic(bars: Bar[], k = 14): number {
  if (bars.length < k) return 50;
  const win = bars.slice(-k);
  const highestHigh = Math.max(...win.map(b => b.high));
  const lowestLow   = Math.min(...win.map(b => b.low));
  const denom = highestHigh - lowestLow || 0.00001;
  return ((bars[bars.length - 1].close - lowestLow) / denom) * 100;
}

function calcCCI(bars: Bar[], period = 14): number {
  if (bars.length < period) return 0;
  const win = bars.slice(-period);
  const typicals = win.map(b => (b.high + b.low + b.close) / 3);
  const sma = typicals.reduce((a, b) => a + b, 0) / period;
  const meanDev = typicals.reduce((a, b) => a + Math.abs(b - sma), 0) / period || 0.00001;
  return (typicals[typicals.length - 1] - sma) / (0.015 * meanDev);
}

function calcMomentum(bars: Bar[], period = 10): number {
  if (bars.length <= period) return 0;
  return bars[bars.length - 1].close - bars[bars.length - 1 - period].close;
}

function scoreTF(ind: TFIndicator, bars: Bar[], currentPrice: number): { score: number; direction: 'BUY'|'SELL'|'NEUTRAL'; signals: string[] } {
  const signals: string[] = [];
  const trending = ind.adx > 25;
  const ranging  = ind.adx < 20;
  const stoch    = calcStochastic(bars);
  const cci      = calcCCI(bars);

  type WeightKey = 'ema'|'macd'|'rsi'|'bb'|'stoch';
  let weights: Record<WeightKey, number>;
  if (trending) {
    weights = { ema: 0.40, macd: 0.30, rsi: 0.15, bb: 0.15, stoch: 0 };
  } else if (ranging) {
    weights = { ema: 0.10, macd: 0.0,  rsi: 0.35, bb: 0.25, stoch: 0.30 };
  } else {
    weights = { ema: 0.25, macd: 0.20, rsi: 0.25, bb: 0.20, stoch: 0.10 };
  }

  // EMA signal [-1, 1]
  let emaSignal = 0;
  if (ind.ema21 > ind.ema200) { emaSignal = 1;  signals.push('EMA21>EMA200 BUY'); }
  else                         { emaSignal = -1; signals.push('EMA21<EMA200 SELL'); }

  // RSI signal
  let rsiSignal = 0;
  if (ind.rsi < 30)      { rsiSignal = 1;  signals.push(`RSI ${ind.rsi.toFixed(0)} oversold`); }
  else if (ind.rsi > 70) { rsiSignal = -1; signals.push(`RSI ${ind.rsi.toFixed(0)} overbought`); }
  else                    { signals.push(`RSI ${ind.rsi.toFixed(0)} neutral`); }

  // MACD signal
  let macdSignal = 0;
  if (ind.macdHist > 0)  { macdSignal = 1;  signals.push('MACD hist positive'); }
  else if (ind.macdHist < 0) { macdSignal = -1; signals.push('MACD hist negative'); }

  // BB signal
  let bbSignal = 0;
  if (currentPrice <= ind.bbLower) { bbSignal = 1;  signals.push('Price at BB lower'); }
  else if (currentPrice >= ind.bbUpper) { bbSignal = -1; signals.push('Price at BB upper'); }

  // Stoch signal
  let stochSignal = 0;
  if (stoch < 20)       { stochSignal = 1;  signals.push(`Stoch ${stoch.toFixed(0)} oversold`); }
  else if (stoch > 80)  { stochSignal = -1; signals.push(`Stoch ${stoch.toFixed(0)} overbought`); }

  // CCI
  if (cci < -100) signals.push(`CCI ${cci.toFixed(0)} oversold`);
  else if (cci > 100) signals.push(`CCI ${cci.toFixed(0)} overbought`);

  const raw =
    emaSignal   * weights.ema   +
    macdSignal  * weights.macd  +
    rsiSignal   * weights.rsi   +
    bbSignal    * weights.bb    +
    stochSignal * weights.stoch;

  const score = Math.round(50 + raw * 40);
  const direction: 'BUY'|'SELL'|'NEUTRAL' = score > 60 ? 'BUY' : score < 40 ? 'SELL' : 'NEUTRAL';

  return { score: Math.max(0, Math.min(100, score)), direction, signals };
}

const TF_WEIGHTS: Record<string, number> = { H4: 0.35, H1: 0.30, M15: 0.20, M5: 0.15 };

export function analyzeIndicators(
  indicators: { timeframes: Record<string, TFIndicator> },
  barsByTf: Record<string, Bar[]>,
  currentPrice: number,
): ModuleResult & { byTimeframe: Record<string, unknown> } {
  try {
    const byTimeframe: Record<string, unknown> = {};
    let weightedScore = 0;
    let totalWeight   = 0;
    const dirVotes: Record<string, number> = { BUY: 0, SELL: 0, NEUTRAL: 0 };

    for (const tf of ['H4', 'H1', 'M15', 'M5']) {
      const ind  = indicators.timeframes[tf];
      const bars = barsByTf[tf] ?? [];
      if (!ind) continue;

      const res = scoreTF(ind, bars, currentPrice);
      byTimeframe[tf] = { score: res.score, direction: res.direction, signals: res.signals };

      const w = TF_WEIGHTS[tf] ?? 0.1;
      weightedScore += res.score * w;
      totalWeight   += w;
      dirVotes[res.direction] = (dirVotes[res.direction] ?? 0) + w;
    }

    const finalScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 50;
    const direction: 'BUY'|'SELL'|'NEUTRAL' =
      dirVotes.BUY > dirVotes.SELL && dirVotes.BUY > dirVotes.NEUTRAL ? 'BUY' :
      dirVotes.SELL > dirVotes.BUY && dirVotes.SELL > dirVotes.NEUTRAL ? 'SELL' : 'NEUTRAL';

    return {
      score: finalScore,
      direction,
      byTimeframe,
      summary: `Weighted indicator score ${finalScore}. Direction: ${direction}.`,
      details: { dirVotes },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', byTimeframe: {},
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
