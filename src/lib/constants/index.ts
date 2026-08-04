import type { Timeframe } from "@/types";

export const TIMEFRAMES: { label: string; value: Timeframe }[] = [
  { label: "M1",  value: "M1"  },
  { label: "M5",  value: "M5"  },
  { label: "M15", value: "M15" },
  { label: "M30", value: "M30" },
  { label: "H1",  value: "H1"  },
  { label: "H4",  value: "H4"  },
  { label: "D1",  value: "D1"  },
  { label: "W1",  value: "W1"  },
  { label: "MN",  value: "MN"  },
];

export const DEFAULT_SYMBOLS = [
  "EURUSD",
  "USDJPY",
  "GBPUSD",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "USDCHF",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "XAUUSD",
  "XAGUSD",
];

// TradingView のシンボルマッピング（MT5シンボル -> TV表示名）
export const TV_SYMBOL_MAP: Record<string, string> = {
  EURUSD: "FX:EURUSD",
  USDJPY: "FX:USDJPY",
  GBPUSD: "FX:GBPUSD",
  AUDUSD: "FX:AUDUSD",
  XAUUSD: "OANDA:XAUUSD",
};

export const IMPACT_COLORS: Record<number, string> = {
  5: "#ef4444", // red-500
  4: "#f97316", // orange-500
  3: "#eab308", // yellow-500
  2: "#6b7280", // gray-500
  1: "#6b7280", // gray-500
};

export const IMPACT_STARS: Record<number, string> = {
  5: "★★★★★",
  4: "★★★★",
  3: "★★★",
  2: "★★",
  1: "★",
};
