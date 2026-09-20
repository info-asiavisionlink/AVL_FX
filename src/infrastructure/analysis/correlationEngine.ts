import type { ModuleResult } from "./types";

interface CorrelationEntry { symbol: string; relationship: 'positive'|'negative'; weight: number; }

const CORRELATIONS: Record<string, CorrelationEntry[]> = {
  EURUSD: [
    { symbol:'GBPUSD',   relationship:'positive', weight:0.8  },
    { symbol:'USDJPY',   relationship:'negative', weight:0.7  },
    { symbol:'XAUUSD',   relationship:'negative', weight:0.5  },
    { symbol:'USDX-SEP26', relationship:'negative', weight:0.9 },
  ],
  USDJPY: [
    { symbol:'USDX-SEP26', relationship:'positive', weight:0.9 },
    { symbol:'US30Cash', relationship:'positive', weight:0.6  },
    { symbol:'XAUUSD',   relationship:'negative', weight:0.5  },
  ],
  GBPUSD: [
    { symbol:'EURUSD',   relationship:'positive', weight:0.8  },
    { symbol:'USDX-SEP26', relationship:'negative', weight:0.85 },
  ],
  AUDUSD: [
    { symbol:'USDX-SEP26', relationship:'negative', weight:0.8 },
    { symbol:'XAUUSD',   relationship:'positive', weight:0.65 },
    { symbol:'NZDUSD',   relationship:'positive', weight:0.85 },
  ],
  NZDUSD: [
    { symbol:'AUDUSD',   relationship:'positive', weight:0.85 },
    { symbol:'USDX-SEP26', relationship:'negative', weight:0.75 },
  ],
  USDCAD: [
    { symbol:'OILCash',  relationship:'negative', weight:0.7  },
    { symbol:'USDX-SEP26', relationship:'positive', weight:0.8 },
  ],
  XAUUSD: [
    { symbol:'USDX-SEP26', relationship:'negative', weight:0.85 },
    { symbol:'EURUSD',   relationship:'positive', weight:0.6  },
  ],
};

interface TickData { bid: number; ask: number; prevBid?: number; }

export function analyzeCorrelation(
  symbol: string,
  primaryDirection: 'BUY'|'SELL'|'NEUTRAL',
  ticks: Record<string, TickData>,
  prevTicks: Record<string, TickData>,
): ModuleResult & { markets: Record<string, unknown> } {
  try {
    const sym = symbol.toUpperCase();
    const correlations = CORRELATIONS[sym] ?? [];
    const markets: Record<string, unknown> = {};

    if (correlations.length === 0 || primaryDirection === 'NEUTRAL') {
      return {
        score: 50, direction: 'NEUTRAL', markets,
        summary: 'No correlation data available.',
        details: {},
      };
    }

    let confirming = 0;
    let total = 0;
    let totalWeight = 0;
    let confirmingWeight = 0;

    for (const corr of correlations) {
      const tick = ticks[corr.symbol];
      const prev = prevTicks[corr.symbol];
      if (!tick || !prev) continue;

      const corrMoved = tick.bid > prev.bid ? 'UP' : tick.bid < prev.bid ? 'DOWN' : null;
      if (!corrMoved) continue;

      const expectedPrimary = primaryDirection === 'BUY' ? 'UP' : 'DOWN';
      const expectedCorr = corr.relationship === 'positive' ? expectedPrimary : (expectedPrimary === 'UP' ? 'DOWN' : 'UP');
      const confirms = corrMoved === expectedCorr;

      markets[corr.symbol] = { relationship: corr.relationship, moved: corrMoved, confirms, weight: corr.weight };

      total++;
      totalWeight += corr.weight;
      if (confirms) {
        confirming++;
        confirmingWeight += corr.weight;
      }
    }

    if (total === 0) {
      return {
        score: 50, direction: primaryDirection, markets,
        summary: 'Insufficient tick history for correlation.',
        details: {},
      };
    }

    const pct = confirmingWeight / totalWeight;
    const score = Math.round(40 + pct * 55);

    return {
      score,
      direction: score >= 60 ? primaryDirection : 'NEUTRAL',
      markets,
      summary: `${confirming}/${total} correlated markets confirm ${primaryDirection} (${(pct * 100).toFixed(0)}% weight).`,
      details: { confirming, total, pct },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', markets: {},
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
