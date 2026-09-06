import type { ModuleResult } from "./types";

interface EconomicEvent { event_time: string; currency: string; impact: number; title: string; forecast?: string | null; }
interface NewsItem { published_at: string; title: string; source: string; }

export interface EnvIndicators {
  timeframes: Record<string, { atr: number; [k: string]: unknown }>;
  sessions?: string[];
}

function detectSessions(utcHour: number): string[] {
  const sessions: string[] = [];
  if (utcHour >= 0 && utcHour < 9)   sessions.push('Tokyo');
  if (utcHour >= 7 && utcHour < 17)  sessions.push('London');
  if (utcHour >= 12 && utcHour < 21) sessions.push('New York');
  return sessions.length ? sessions : ['Off-hours'];
}

function riskLevel(events: EconomicEvent[]): 'HIGH'|'MEDIUM'|'LOW' {
  const now = Date.now();
  for (const ev of events) {
    const t = new Date(ev.event_time).getTime();
    const diffH = (t - now) / 3_600_000;
    if (ev.impact === 3 && diffH >= 0 && diffH < 4)  return 'HIGH';
    if (ev.impact === 3 && diffH >= 0 && diffH < 8)  return 'MEDIUM';
    if (ev.impact >= 2 && diffH >= 0 && diffH < 4)   return 'MEDIUM';
  }
  return 'LOW';
}

export function analyzeMarketEnvironment(
  indicators: EnvIndicators | null,
  economicEvents: EconomicEvent[],
  news: NewsItem[],
  nowUtc: Date,
): ModuleResult & { session: string[]; economicEvents: unknown[]; news: unknown[] } {
  try {
    const utcHour  = nowUtc.getUTCHours();
    const sessions = indicators?.sessions ?? detectSessions(utcHour);

    const risk = riskLevel(economicEvents);

    // Base score
    let score = 70;
    if (risk === 'HIGH')   score -= 25;
    if (risk === 'MEDIUM') score -= 10;

    // Session bonus: overlaps are higher-liquidity
    const isOverlap = sessions.filter(s => s !== 'Off-hours').length >= 2;
    if (isOverlap) score += 10;

    // Volatility from H4 ATR
    const h4Ind = indicators?.timeframes?.H4;
    const h1Ind = indicators?.timeframes?.H1;
    const baseAtr = h4Ind?.atr ?? 0;
    const atrContext = baseAtr > 0 && h1Ind?.atr
      ? (h1Ind.atr > baseAtr * 1.5 ? 'HIGH' : h1Ind.atr < baseAtr * 0.5 ? 'LOW' : 'NORMAL')
      : 'UNKNOWN';

    score = Math.max(20, Math.min(95, score));

    return {
      score,
      direction: 'NEUTRAL',
      session: sessions,
      economicEvents,
      news,
      summary: `Sessions: ${sessions.join('+')}. Risk: ${risk}. Volatility: ${atrContext}.`,
      details: { risk, isOverlap, atrContext, eventCount: economicEvents.length, newsCount: news.length },
    };
  } catch (err) {
    return {
      score: 50, direction: 'NEUTRAL', session: [], economicEvents: [], news: [],
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    };
  }
}
