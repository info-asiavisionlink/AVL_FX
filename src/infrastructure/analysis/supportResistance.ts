import type { Bar, SRLevel, ModuleResult } from "./types";

function clusterLevels(prices: number[], threshold = 0.001): number[] {
  if (prices.length === 0) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    const avg  = last.reduce((a, b) => a + b, 0) / last.length;
    if (Math.abs(sorted[i] - avg) / avg < threshold) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length);
}

export function analyzeSupportResistance(
  h4Bars: Bar[],
  d1Bars: Bar[],
  w1Bars: Bar[],
  currentPrice: number,
): ModuleResult & { levels: SRLevel[]; nearestSupport: number; nearestResistance: number } {
  try {
    const levels: SRLevel[] = [];

    // Pivot Points from most recent D1 bar
    if (d1Bars.length >= 2) {
      const prev = d1Bars[d1Bars.length - 2];
      const pp   = (prev.high + prev.low + prev.close) / 3;
      const r1   = 2 * pp - prev.low;
      const r2   = pp + (prev.high - prev.low);
      const s1   = 2 * pp - prev.high;
      const s2   = pp - (prev.high - prev.low);

      levels.push({ price: pp, strength: 3, type: 'pivot',     source: 'Pivot PP' });
      levels.push({ price: r1, strength: 2, type: 'resistance', source: 'Pivot R1' });
      levels.push({ price: r2, strength: 2, type: 'resistance', source: 'Pivot R2' });
      levels.push({ price: s1, strength: 2, type: 'support',    source: 'Pivot S1' });
      levels.push({ price: s2, strength: 2, type: 'support',    source: 'Pivot S2' });

      // Previous D1 High/Low
      levels.push({ price: prev.high, strength: 3, type: 'resistance', source: 'D1 High' });
      levels.push({ price: prev.low,  strength: 3, type: 'support',    source: 'D1 Low'  });
    }

    // Previous W1 High/Low
    if (w1Bars.length >= 2) {
      const prevW = w1Bars[w1Bars.length - 2];
      levels.push({ price: prevW.high, strength: 4, type: 'resistance', source: 'W1 High' });
      levels.push({ price: prevW.low,  strength: 4, type: 'support',    source: 'W1 Low'  });
    }

    // Swing Highs/Lows from H4 bars — cluster nearby
    const swingHighs: number[] = [];
    const swingLows:  number[] = [];
    for (let i = 2; i < h4Bars.length - 2; i++) {
      const win = h4Bars.slice(i - 2, i + 3);
      const maxH = Math.max(...win.map(b => b.high));
      const minL = Math.min(...win.map(b => b.low));
      if (h4Bars[i].high === maxH) swingHighs.push(h4Bars[i].high);
      if (h4Bars[i].low  === minL) swingLows.push(h4Bars[i].low);
    }

    const clusteredHighs = clusterLevels(swingHighs, 0.001);
    const clusteredLows  = clusterLevels(swingLows,  0.001);

    for (const price of clusteredHighs) {
      const touches = swingHighs.filter(h => Math.abs(h - price) / price < 0.001).length;
      levels.push({ price, strength: touches, type: 'resistance', source: 'H4 Swing High' });
    }
    for (const price of clusteredLows) {
      const touches = swingLows.filter(l => Math.abs(l - price) / price < 0.001).length;
      levels.push({ price, strength: touches, type: 'support', source: 'H4 Swing Low' });
    }

    // Deduplicate
    const unique: SRLevel[] = [];
    for (const lv of levels) {
      const dup = unique.find(u => Math.abs(u.price - lv.price) / lv.price < 0.0005);
      if (dup) {
        dup.strength = Math.max(dup.strength, lv.strength);
      } else {
        unique.push({ ...lv });
      }
    }
    unique.sort((a, b) => a.price - b.price);

    const NEAR = 0.0015;
    const supports    = unique.filter(l => l.price < currentPrice);
    const resistances = unique.filter(l => l.price > currentPrice);

    const nearestSupport    = supports.length    ? supports[supports.length - 1].price    : currentPrice * 0.99;
    const nearestResistance = resistances.length ? resistances[0].price                   : currentPrice * 1.01;

    const isNearSupport    = (currentPrice - nearestSupport)    / currentPrice < NEAR;
    const isNearResistance = (nearestResistance - currentPrice) / currentPrice < NEAR;

    let score: number;
    let direction: 'BUY'|'SELL'|'NEUTRAL';
    if (isNearSupport)    { score = 75; direction = 'BUY';  }
    else if (isNearResistance) { score = 75; direction = 'SELL'; }
    else { score = 50; direction = 'NEUTRAL'; }

    const topLevels = unique.filter(l => l.strength >= 2).length;
    score = Math.min(score + topLevels * 3, 95);

    return {
      score,
      direction,
      levels: unique,
      nearestSupport,
      nearestResistance,
      summary: `${unique.length} S/R levels. Near ${isNearSupport ? 'support' : isNearResistance ? 'resistance' : 'no key level'}.`,
      details: { supports: supports.length, resistances: resistances.length },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', levels: [], nearestSupport: currentPrice * 0.99, nearestResistance: currentPrice * 1.01,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
