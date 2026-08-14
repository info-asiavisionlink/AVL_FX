export type EAStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
export type AIRecommendation = 'RECOMMENDED' | 'CAUTION' | 'NOT_RECOMMENDED';
export type StrategyType = 'SCALPING' | 'DAY_TRADE' | 'SWING' | 'HEDGING';

export interface EAPerformance {
  totalTrades: number;
  winRate: number;
  totalPips: number;
  profitFactor: number;
  avgPips: number;
  maxDrawdown: number;
}

export interface SessionPerformance {
  session: 'TOKYO' | 'LONDON' | 'NEW_YORK';
  winRate: number;
  pips: number;
}

export interface LossPattern {
  name: string;
  lossRate: number;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface AIRecommendationData {
  recommendation: AIRecommendation;
  marketCompatibility: number; // 0-100
  reasons: string[];
}

export interface EAProfile {
  id: string;
  name: string;
  status: EAStatus;
  strategyType: StrategyType;
  symbols: string[];
  timeframes: string[];
  magicNumber: number;
  aiRecommendation: AIRecommendationData;
  performance: EAPerformance;
  sessionPerformance: SessionPerformance[];
  lossPatterns: LossPattern[];
}
