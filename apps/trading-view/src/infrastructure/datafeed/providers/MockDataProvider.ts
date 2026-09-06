// ==================================================
// MockDataProvider — モックデータプロバイダー
// ==================================================
//
// 特徴:
//   ・決定論的シード乱数を使用するため、同一バー時刻は常に同一 OHLC を返す
//   ・スクロールしても値が変わらないため、チャートが自然に見える
//   ・1秒ごとに現在バーをリアルタイム更新し、MT5 Tick 相当の動きを再現
//
// MT5DataProvider への差し替え:
//   TVDatafeed の生成箇所で MockDataProvider → MT5DataProvider に変えるだけ。
// ==================================================

import type {
  Bar,
  LibrarySymbolInfo,
  SearchSymbolResultItem,
} from "../tv-types";
import type {
  IDataProvider,
  GetBarsRequest,
  GetBarsResponse,
  SubscribeRequest,
  Unsubscribe,
} from "../IDataProvider";

// --------------------------------------------------
// シンボルカタログ
// --------------------------------------------------

interface SymbolConfig {
  description: string;
  type: "forex" | "metal";
  basePrice: number;
  /** H1 あたりのボラティリティ（価格単位）*/
  volatility: number;
  /** 小数点桁数 */
  digits: number;
  pricescale: number;
}

const SYMBOL_CATALOG: Record<string, SymbolConfig> = {
  EURUSD: { description: "Euro / US Dollar",     type: "forex", basePrice: 1.08620, volatility: 0.00080, digits: 5, pricescale: 100000 },
  USDJPY: { description: "US Dollar / Yen",       type: "forex", basePrice: 149.850, volatility: 0.12000, digits: 3, pricescale:    1000 },
  GBPUSD: { description: "Pound / US Dollar",     type: "forex", basePrice: 1.27150, volatility: 0.00100, digits: 5, pricescale: 100000 },
  AUDUSD: { description: "Australian / US Dollar",type: "forex", basePrice: 0.65380, volatility: 0.00070, digits: 5, pricescale: 100000 },
  USDCAD: { description: "US Dollar / Canadian",  type: "forex", basePrice: 1.36220, volatility: 0.00080, digits: 5, pricescale: 100000 },
  NZDUSD: { description: "New Zealand / US Dollar",type:"forex", basePrice: 0.60150, volatility: 0.00065, digits: 5, pricescale: 100000 },
  USDCHF: { description: "US Dollar / Swiss Franc",type:"forex", basePrice: 0.89510, volatility: 0.00070, digits: 5, pricescale: 100000 },
  EURGBP: { description: "Euro / Pound",          type: "forex", basePrice: 0.85430, volatility: 0.00050, digits: 5, pricescale: 100000 },
  EURJPY: { description: "Euro / Yen",            type: "forex", basePrice: 162.740, volatility: 0.15000, digits: 3, pricescale:    1000 },
  GBPJPY: { description: "Pound / Yen",           type: "forex", basePrice: 190.450, volatility: 0.20000, digits: 3, pricescale:    1000 },
  XAUUSD: { description: "Gold / US Dollar",      type: "metal", basePrice: 2345.500, volatility: 3.5000, digits: 2, pricescale:     100 },
  XAGUSD: { description: "Silver / US Dollar",    type: "metal", basePrice:   29.150, volatility: 0.2000, digits: 3, pricescale:    1000 },
};

// resolution → 秒数
const RESOLUTION_SECONDS: Record<string, number> = {
  "1": 60, "3": 180, "5": 300, "15": 900, "30": 1800,
  "60": 3600, "120": 7200, "240": 14400, "360": 21600, "720": 43200,
  "D": 86400, "1D": 86400,
  "W": 604800, "1W": 604800,
  "M": 2592000, "1M": 2592000,
};

// H1 あたりのボラティリティを他の時間足に換算するスケール係数
function volScale(resolution: string): number {
  const sec = RESOLUTION_SECONDS[resolution] ?? 3600;
  return Math.sqrt(sec / 3600);
}

// --------------------------------------------------
// 決定論的シード乱数（Mulberry32）
// 同一 seed → 常に同一乱数列
// --------------------------------------------------

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

/** 文字列から数値 seed を生成 */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --------------------------------------------------
// バー生成ロジック
// --------------------------------------------------

/**
 * 指定バー時刻の OHLC を決定論的に生成する。
 * 前バーの close を open として使うランダムウォーク。
 * seed は (symbol + resolution + barTime) から生成するため再現性がある。
 */
function generateBar(
  symbol: string,
  resolution: string,
  barTime: number,
  prevClose: number,
  config: SymbolConfig
): Bar {
  const seed = hashSeed(`${symbol}:${resolution}:${barTime}`);
  const rng = mulberry32(seed);

  const vol = config.volatility * volScale(resolution);
  const digits = config.digits;

  const open = round(prevClose, digits);

  // ランダムウォーク（やや上方バイアス: 0.48 にすることで外為の長期上昇傾向を再現）
  const drift = (rng() - 0.48) * vol * 2;
  const close = round(open + drift, digits);

  const wickVol = vol * (0.3 + rng() * 0.7);
  const high = round(Math.max(open, close) + rng() * wickVol, digits);
  const low  = round(Math.min(open, close) - rng() * wickVol, digits);

  return {
    time: barTime,
    open,
    high,
    low,
    close,
    volume: Math.floor(rng() * 7000) + 300,
  };
}

function round(v: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(v * factor) / factor;
}

// --------------------------------------------------
// MockDataProvider 実装
// --------------------------------------------------

export class MockDataProvider implements IDataProvider {
  /** バーキャッシュ: key → "EURUSD:60" */
  private barCache = new Map<string, Bar[]>();

  // --------------------------------------------------
  // searchSymbols
  // --------------------------------------------------

  async searchSymbols(
    query: string,
    _exchange?: string
  ): Promise<SearchSymbolResultItem[]> {
    const q = query.toUpperCase();
    return Object.entries(SYMBOL_CATALOG)
      .filter(([sym, cfg]) => sym.includes(q) || cfg.description.toUpperCase().includes(q))
      .map(([sym, cfg]) => ({
        symbol:      sym,
        full_name:   `FOREX:${sym}`,
        description: cfg.description,
        exchange:    "FOREX",
        type:        cfg.type,
        ticker:      sym,
      }));
  }

  // --------------------------------------------------
  // resolveSymbol
  // --------------------------------------------------

  async resolveSymbol(symbolName: string): Promise<LibrarySymbolInfo | null> {
    const name = symbolName.toUpperCase();
    const cfg = SYMBOL_CATALOG[name];
    if (!cfg) return null;

    const supported: string[] = ["1","5","15","30","60","240","D","W"];

    return {
      name,
      full_name:        `FOREX:${name}`,
      description:      cfg.description,
      type:             cfg.type,
      session:          "24x7",
      timezone:         "Etc/UTC",
      exchange:         "FOREX",
      listed_exchange:  "FOREX",
      format:           "price",
      minmov:           1,
      pricescale:       cfg.pricescale,
      has_intraday:     true,
      has_daily:        true,
      has_weekly_and_monthly: true,
      intraday_multipliers:   ["1","5","15","30","60","240"],
      supported_resolutions:  supported,
      volume_precision: 0,
      data_status:      "streaming",
    };
  }

  // --------------------------------------------------
  // getBars
  // --------------------------------------------------

  async getBars(req: GetBarsRequest): Promise<GetBarsResponse> {
    const { symbol, resolution, from, to, countBack } = req;
    const cfg = SYMBOL_CATALOG[symbol.toUpperCase()];
    if (!cfg) return { bars: [], noData: true };

    const tfSec = RESOLUTION_SECONDS[resolution] ?? 3600;
    const cacheKey = `${symbol}:${resolution}`;

    // キャッシュに十分な量があれば再利用（初回生成時のみ計算）
    const needed = Math.max(countBack + 50, Math.ceil((to - from) / tfSec) + 50);
    if (!this.barCache.has(cacheKey) || this.barCache.get(cacheKey)!.length < needed) {
      this.barCache.set(cacheKey, this.buildBars(symbol, resolution, cfg, tfSec, needed + 200));
    }

    const allBars = this.barCache.get(cacheKey)!;

    // from〜to でフィルター
    let filtered = allBars.filter((b) => b.time >= from && b.time <= to);

    // countBack に満たない場合は末尾から補う
    if (filtered.length < countBack) {
      const toIdx = allBars.findLastIndex((b) => b.time <= to);
      if (toIdx >= 0) {
        const startIdx = Math.max(0, toIdx - countBack + 1);
        filtered = allBars.slice(startIdx, toIdx + 1);
      }
    }

    if (filtered.length === 0) {
      return { bars: [], noData: true };
    }

    return { bars: filtered, noData: false };
  }

  // --------------------------------------------------
  // subscribeBar
  // --------------------------------------------------

  subscribeBar(
    { symbol, resolution }: SubscribeRequest,
    onBar: (bar: Bar) => void
  ): Unsubscribe {
    const cfg = SYMBOL_CATALOG[symbol.toUpperCase()];
    const tfSec = RESOLUTION_SECONDS[resolution] ?? 3600;
    const cacheKey = `${symbol}:${resolution}`;

    const timer = setInterval(() => {
      const bars = this.barCache.get(cacheKey);
      if (!bars || bars.length === 0 || !cfg) return;

      const last = bars[bars.length - 1];
      const now = Math.floor(Date.now() / 1000);
      const currentBarTime = Math.floor(now / tfSec) * tfSec;

      const vol = cfg.volatility * volScale(resolution) * 0.15; // Tick 更新は小さめ

      if (last.time < currentBarTime) {
        // 新しいバー確定
        const newBar = generateBar(symbol, resolution, currentBarTime, last.close, cfg);
        bars.push(newBar);
        onBar(newBar);
      } else {
        // 現在バーの close / high / low をリアルタイム更新
        const move = (Math.random() - 0.5) * vol * 2;
        const newClose = round(last.close + move, cfg.digits);
        const updated: Bar = {
          ...last,
          close:  newClose,
          high:   round(Math.max(last.high,  newClose), cfg.digits),
          low:    round(Math.min(last.low,   newClose), cfg.digits),
          volume: (last.volume ?? 0) + Math.floor(Math.random() * 5),
        };
        bars[bars.length - 1] = updated;
        onBar(updated);
      }
    }, 1000);

    return () => clearInterval(timer);
  }

  // --------------------------------------------------
  // getServerTime
  // --------------------------------------------------

  async getServerTime(): Promise<number> {
    return Math.floor(Date.now() / 1000);
  }

  // --------------------------------------------------
  // 内部: バー列の生成
  // --------------------------------------------------

  private buildBars(
    symbol: string,
    resolution: string,
    cfg: SymbolConfig,
    tfSec: number,
    count: number
  ): Bar[] {
    const bars: Bar[] = [];
    const now = Math.floor(Date.now() / 1000);
    // 最新バーの時刻を現在の時間足に揃える
    const latestTime = Math.floor(now / tfSec) * tfSec;
    const startTime = latestTime - (count - 1) * tfSec;

    let prevClose = cfg.basePrice;

    for (let i = 0; i < count; i++) {
      const barTime = startTime + i * tfSec;
      const bar = generateBar(symbol, resolution, barTime, prevClose, cfg);
      bars.push(bar);
      prevClose = bar.close;
    }

    return bars;
  }
}
