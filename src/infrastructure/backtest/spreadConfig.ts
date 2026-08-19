// =================================================================
// spreadConfig.ts — Symbol設定 (バックテスト専用固定値)
//
// Historical tick データがないため固定 Spread / Slippage を使用。
// pipValuePerLot は USD 建て口座の近似値（JPY ペアは為替レートなし）。
// =================================================================

export interface SymbolConfig {
  digits:         number;  // 小数桁数 (EURUSD=5, USDJPY=3, XAUUSD=2)
  pipSize:        number;  // 1 pip の価格幅 (EURUSD=0.0001, JPY=0.01)
  pipValuePerLot: number;  // 1 pip あたり USD 価値 (標準ロット 1.0)
  spreadPips:     number;  // 固定スプレッド
  slippagePips:   number;  // 固定スリッページ (片道)
  contractSize:   number;  // 1 lot あたりの契約単位
}

// pip = point × 10 (5-digit broker convention)
// JPY: digits=3 → point=0.001, pip=0.01
// Major: digits=5 → point=0.00001, pip=0.0001
const CONFIGS: Record<string, SymbolConfig> = {
  EURUSD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0, spreadPips: 1.5, slippagePips: 0.3, contractSize: 100_000 },
  GBPUSD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0, spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  AUDUSD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0, spreadPips: 1.8, slippagePips: 0.5, contractSize: 100_000 },
  NZDUSD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0, spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  USDCAD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 7.5,  spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  USDCHF: { digits: 5, pipSize: 0.0001, pipValuePerLot: 11.0, spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  USDJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 1.5, slippagePips: 0.3, contractSize: 100_000 },
  EURJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  GBPJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 3.0, slippagePips: 0.5, contractSize: 100_000 },
  AUDJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  CADJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 2.5, slippagePips: 0.5, contractSize: 100_000 },
  CHFJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 2.5, slippagePips: 0.5, contractSize: 100_000 },
  NZDJPY: { digits: 3, pipSize: 0.01,   pipValuePerLot: 6.7,  spreadPips: 2.5, slippagePips: 0.5, contractSize: 100_000 },
  EURGBP: { digits: 5, pipSize: 0.0001, pipValuePerLot: 12.5, spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000 },
  EURAUD: { digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0, spreadPips: 2.5, slippagePips: 0.5, contractSize: 100_000 },
  // XAUUSD: pip=0.10, 1 pip × 100 oz/lot = $10
  XAUUSD: { digits: 2, pipSize: 0.10,   pipValuePerLot: 10.0, spreadPips: 30,  slippagePips: 5.0, contractSize: 100 },
  GOLD:   { digits: 2, pipSize: 0.10,   pipValuePerLot: 10.0, spreadPips: 30,  slippagePips: 5.0, contractSize: 100 },
};

const DEFAULT_CONFIG: SymbolConfig = {
  digits: 5, pipSize: 0.0001, pipValuePerLot: 10.0,
  spreadPips: 2.0, slippagePips: 0.5, contractSize: 100_000,
};

export function getSymbolConfig(symbol: string): SymbolConfig {
  return CONFIGS[symbol.toUpperCase()] ?? DEFAULT_CONFIG;
}

/** price distance → pips */
export function priceToPips(priceDistance: number, cfg: SymbolConfig): number {
  return priceDistance / cfg.pipSize;
}

/** pips → price distance */
export function pipToPrice(pips: number, cfg: SymbolConfig): number {
  return pips * cfg.pipSize;
}
