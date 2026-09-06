export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }
export interface SwingPoint { time: number; price: number; type: 'high' | 'low'; label: 'HH'|'HL'|'LH'|'LL'|'H'|'L'; }
export interface SRLevel { price: number; strength: number; type: 'support'|'resistance'|'pivot'; source: string; }
export interface CandlePattern { name: string; direction: 'bullish'|'bearish'|'neutral'; strength: number; tf: string; }
export interface ChartPattern { name: string; direction: 'bullish'|'bearish'|'neutral'; confidence: number; }
export type Direction = 'BUY' | 'SELL' | 'NEUTRAL';
export interface ModuleResult { score: number; direction: Direction; summary: string; details: Record<string, unknown>; }

export interface FullAnalysisResult {
  symbol: string;
  timestamp: number;
  tick: { bid: number; ask: number; spread: number; };
  marketEnvironment: ModuleResult & { session: string[]; economicEvents: unknown[]; news: unknown[]; };
  dowTheory: ModuleResult & { trend: 'UPTREND'|'DOWNTREND'|'RANGE'; swingPoints: SwingPoint[]; };
  multiTF: ModuleResult & { timeframes: Record<string, {trend:string; score:number; signals:string[]}>; };
  technicalIndicators: ModuleResult & { byTimeframe: Record<string, unknown>; };
  supportResistance: ModuleResult & { levels: SRLevel[]; nearestSupport: number; nearestResistance: number; };
  candlestickPatterns: ModuleResult & { patterns: CandlePattern[]; };
  chartPatterns: ModuleResult & { patterns: ChartPattern[]; };
  correlation: ModuleResult & { markets: Record<string, unknown>; };
  overall: { confidence: number; direction: Direction; tradeable: boolean; threshold: number; };
  tradeSetup: { direction: Direction; entry: number; sl: number; tp1: number; tp2: number; rrRatio1: string; rrRatio2: string; confidence: number; } | null;
  aiSynthesis: string;
}
