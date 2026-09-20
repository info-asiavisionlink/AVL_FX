// ==================================================
// MT5DataProvider — ConnectionManager 経由の MT5 実データプロバイダー
// ==================================================
//
// GatewayClient を通じて以下を提供する:
//   - getBars:      GET /bars/:symbol/:timeframe
//   - subscribeBar: WebSocket /ws の BAR メッセージ
//   - searchSymbols / resolveSymbol: ローカル定義（将来 /symbols から取得）
//
// TVDatafeed に渡すプロバイダー。
// Mock との差し替えは AVLChart.tsx の1行変更のみ。
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
import { ConnectionManager } from "@/infrastructure/connection/ConnectionManager";

// --------------------------------------------------
// シンボル静的定義（Gateway /symbols から取れるようになったら差し替え）
// --------------------------------------------------

const SYMBOL_INFO: Record<string, Omit<LibrarySymbolInfo, "name" | "full_name">> = {
  EURUSD: { description: "Euro / US Dollar",      type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  USDJPY: { description: "US Dollar / Yen",        type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:    1000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  GBPUSD: { description: "Pound / US Dollar",      type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  AUDUSD: { description: "Australian / US Dollar", type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  USDCAD: { description: "US Dollar / Canadian",   type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  NZDUSD: { description: "New Zealand / US Dollar",type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  USDCHF: { description: "US Dollar / Swiss Franc",type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  EURGBP: { description: "Euro / Pound",           type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale: 100000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  EURJPY: { description: "Euro / Yen",             type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:    1000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  GBPJPY: { description: "Pound / Yen",            type: "forex",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:    1000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  XAUUSD: { description: "Gold / US Dollar",       type: "metal",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:     100, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  XAGUSD: { description: "Silver / US Dollar",     type: "metal",  session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:    1000, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
  BTCUSD: { description: "Bitcoin / US Dollar",    type: "crypto", session: "24x7", timezone: "Etc/UTC", exchange: "FOREX", listed_exchange: "FOREX", format: "price", minmov: 1, pricescale:     100, has_intraday: true, has_daily: true, supported_resolutions: ["1","5","15","30","60","240","D","W"], data_status: "streaming" },
};

// TradingView resolution → MT5 Timeframe 文字列
const RESOLUTION_TO_TF: Record<string, string> = {
  "1": "M1", "5": "M5", "15": "M15", "30": "M30",
  "60": "H1", "240": "H4",
  "D": "D1", "1D": "D1",
  "W": "W1", "1W": "W1",
};

// --------------------------------------------------
// MT5DataProvider
// --------------------------------------------------

export class MT5DataProvider implements IDataProvider {

  async searchSymbols(query: string): Promise<SearchSymbolResultItem[]> {
    const q = query.toUpperCase();
    return Object.keys(SYMBOL_INFO)
      .filter((s) => s.includes(q) || SYMBOL_INFO[s].description.toUpperCase().includes(q))
      .map((s) => ({
        symbol:      s,
        full_name:   `FOREX:${s}`,
        description: SYMBOL_INFO[s].description,
        exchange:    "FOREX",
        type:        SYMBOL_INFO[s].type,
        ticker:      s,
      }));
  }

  async resolveSymbol(symbolName: string): Promise<LibrarySymbolInfo | null> {
    const name = symbolName.toUpperCase();
    const info = SYMBOL_INFO[name];
    if (!info) return null;
    return { name, full_name: `FOREX:${name}`, ...info };
  }

  // --------------------------------------------------
  // getBars: GET /bars/:symbol/:timeframe
  // --------------------------------------------------
  async getBars(req: GetBarsRequest): Promise<GetBarsResponse> {
    const client = ConnectionManager.instance.client;
    if (!client) return { bars: [], noData: true };

    const timeframe = RESOLUTION_TO_TF[req.resolution] ?? "H1";
    const rawBars   = await client.getBars(req.symbol, timeframe, req.countBack);

    if (rawBars.length === 0) return { bars: [], noData: true };

    const bars: Bar[] = rawBars.map((b) => ({
      time:   b.time,  // ブローカー秒をそのまま使用
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }));

    return { bars, noData: false };
  }

  // --------------------------------------------------
  // subscribeBar: EA の BAR メッセージのみ使用（MT5 の CopyRates 直値）
  // ティックからの合成は行わない → OHLC・時刻が MT5 と完全一致する
  // --------------------------------------------------
  subscribeBar(req: SubscribeRequest, onBar: (bar: Bar) => void): Unsubscribe {
    const client = ConnectionManager.instance.client;
    if (!client) return () => {};

    const timeframe = RESOLUTION_TO_TF[req.resolution] ?? "H1";

    const unsubBar = client.onBar(req.symbol, timeframe, (gatewayBar) => {
      const bar: Bar = {
        time:   toSecondTs(gatewayBar.time),
        open:   gatewayBar.open,
        high:   gatewayBar.high,
        low:    gatewayBar.low,
        close:  gatewayBar.close,
        volume: gatewayBar.volume,
      };
      // ⑥ ログ: subscribeBars で送った最後のバー
      console.log(`[⑥ subBar ] sym=${req.symbol} tf=${timeframe} time=${bar.time}(ms=${gatewayBar.time}) open=${bar.open} close=${bar.close}`);
      onBar(bar);
    });

    return () => {
      unsubBar();
    };
  }

  async getServerTime(): Promise<number> {
    return Math.floor(Date.now() / 1000);
  }
}

function resolutionToSeconds(resolution: string): number {
  const map: Record<string, number> = {
    "1": 60, "5": 300, "15": 900, "30": 1800,
    "60": 3600, "240": 14400, "D": 86400, "W": 604800,
  };
  return map[resolution] ?? 3600;
}

/**
 * UTC ms / UTC 秒 を自動判別して UTC 秒に変換する。
 * Gateway から文字列・オブジェクト・undefined が来た場合も Number() で変換し、
 * 変換不能な場合は現在時刻（秒）を返す。
 */
function toSecondTs(t: unknown): number {
  const n = typeof t === "number" ? t : Number(t);
  if (!isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  return n > 1_000_000_000_000 ? Math.floor(n / 1000) : n;
}
