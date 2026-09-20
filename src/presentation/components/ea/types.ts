// EA ステータス（Live Trading実装時に使用）
export type EAStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';

// Strategy 種別
export type StrategyType = 'SCALPING' | 'DAY_TRADE' | 'SWING' | 'HEDGING';
