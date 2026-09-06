// ==================================================
// AVL FX v2 - TradingView Charting Library Datafeed
// ==================================================
//
// TradingView の IDatafeedChartApi を実装する。
// データソース: MT5 Gateway (HTTP + WebSocket)
//
// 参考: https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api
// ==================================================

// --------------------------------------------------
// TradingView 型定義（ライブラリ本体に含まれる型の簡易定義）
// ライブラリ配置後は charting_library/charting_library.d.ts が使用される
// --------------------------------------------------

export interface TVBar {
  time: number; // UNIX ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TVSymbolInfo {
  name: string;
  full_name: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: string;
  pricescale: number;
  minmov: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  volume_precision: number;
  data_status: string;
}

type OnReadyCb = (config: Record<string, unknown>) => void;
type SearchCb = (results: TVSymbolSearchResult[]) => void;
type ResolveCb = (info: TVSymbolInfo) => void;
type ErrorCb = (err: string) => void;
type HistoryCb = (bars: TVBar[], meta: { noData: boolean }) => void;
type RealtimeCb = (bar: TVBar) => void;

interface TVSymbolSearchResult {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  type: string;
}

interface PeriodParams {
  from: number;
  to: number;
  firstDataRequest: boolean;
  countBack?: number;
}

interface SubscriberRecord {
  symbolName: string;
  resolution: string;
  onRealtime: RealtimeCb;
  onReset: () => void;
  lastBar: TVBar | null;
}

// --------------------------------------------------
// サポートシンボル一覧（Watchlist と同期すること）
// --------------------------------------------------

const SUPPORTED_SYMBOLS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD",
  "USDCAD", "NZDUSD", "USDCHF", "EURGBP",
  "EURJPY", "GBPJPY", "XAUUSD", "XAGUSD",
];

// TradingView の resolution → AVL FX timeframe 変換
const RESOLUTION_TO_TF: Record<string, string> = {
  "1":   "M1",
  "5":   "M5",
  "15":  "M15",
  "30":  "M30",
  "60":  "H1",
  "240": "H4",
  "D":   "D1",
  "W":   "W1",
  "M":   "MN",
};

// --------------------------------------------------
// TVDatafeed クラス
// --------------------------------------------------

export class TVDatafeed {
  private ws: WebSocket | null = null;
  private subscribers = new Map<string, SubscriberRecord>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;

  constructor(
    private readonly gatewayWsUrl: string,
    private readonly gatewayHttpUrl: string,
    private readonly onStatusChange?: (status: "connected" | "disconnected") => void
  ) {
    this.connectWS();
  }

  // --------------------------------------------------
  // WebSocket 接続管理
  // --------------------------------------------------

  private connectWS() {
    try {
      this.ws = new WebSocket(this.gatewayWsUrl);

      this.ws.onopen = () => {
        this.reconnectCount = 0;
        this.onStatusChange?.("connected");
        console.log("[TVDatafeed] Gateway WS connected");
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            symbol?: string;
            timeframe?: string;
            data?: Record<string, number>;
            timestamp?: number;
          };
          this.handleMessage(msg);
        } catch {
          // 不正なメッセージは無視
        }
      };

      this.ws.onclose = () => {
        this.onStatusChange?.("disconnected");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.onStatusChange?.("disconnected");
      };
    } catch (err) {
      console.warn("[TVDatafeed] WS connection failed:", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectCount >= 20) return;
    const delay = Math.min(3000 * (this.reconnectCount + 1), 30000);
    this.reconnectCount++;
    this.reconnectTimer = setTimeout(() => this.connectWS(), delay);
  }

  destroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  // --------------------------------------------------
  // リアルタイムメッセージ処理
  // --------------------------------------------------

  private handleMessage(msg: {
    type: string;
    symbol?: string;
    timeframe?: string;
    data?: Record<string, number>;
  }) {
    if (msg.type === "BAR" && msg.symbol && msg.timeframe && msg.data) {
      this.subscribers.forEach((sub) => {
        if (
          sub.symbolName === msg.symbol &&
          RESOLUTION_TO_TF[sub.resolution] === msg.timeframe
        ) {
          const bar: TVBar = {
            time: (msg.data!.time as number) * 1000,
            open: msg.data!.open as number,
            high: msg.data!.high as number,
            low: msg.data!.low as number,
            close: msg.data!.close as number,
            volume: msg.data!.volume as number,
          };
          sub.lastBar = bar;
          sub.onRealtime(bar);
        }
      });
    }

    // TICK: 現在のバーの close / high / low をリアルタイム更新
    if (msg.type === "TICK" && msg.symbol && msg.data) {
      this.subscribers.forEach((sub) => {
        if (sub.symbolName !== msg.symbol) return;
        if (!sub.lastBar) return;

        const bid = msg.data!.bid as number;
        const now = Math.floor(Date.now() / 1000);
        const barDuration = resolutionToSeconds(sub.resolution);
        const barTime = Math.floor(now / barDuration) * barDuration;

        const updatedBar: TVBar = {
          time: barTime * 1000,
          open: sub.lastBar.time === barTime * 1000 ? sub.lastBar.open : bid,
          high: Math.max(sub.lastBar.high, bid),
          low: Math.min(sub.lastBar.low, bid),
          close: bid,
          volume: sub.lastBar.volume + 1,
        };

        sub.lastBar = updatedBar;
        sub.onRealtime(updatedBar);
      });
    }
  }

  // --------------------------------------------------
  // TradingView Datafeed API 実装
  // --------------------------------------------------

  onReady(callback: OnReadyCb) {
    setTimeout(() =>
      callback({
        supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
        supports_group_request: false,
        supports_marks: false,
        supports_search: true,
        supports_timescale_marks: false,
        exchanges: [{ value: "FOREX", name: "Forex", desc: "MT5" }],
        symbols_types: [{ name: "Forex", value: "forex" }],
      }),
    0);
  }

  searchSymbols(
    userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: SearchCb
  ) {
    const query = userInput.toUpperCase();
    const results = SUPPORTED_SYMBOLS.filter((s) => s.includes(query)).map(
      (s) => ({
        symbol: s,
        full_name: s,
        description: s,
        exchange: "FOREX",
        type: "forex",
      })
    );
    onResult(results);
  }

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCb,
    onError: ErrorCb
  ) {
    const name = symbolName.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(name)) {
      onError(`Symbol not found: ${name}`);
      return;
    }

    // JPY 系・貴金属は小数点3桁、それ以外は5桁
    const isJPY = name.includes("JPY");
    const isXAG = name === "XAGUSD";
    const digits = isJPY || isXAG ? 3 : 5;

    setTimeout(() =>
      onResolve({
        name,
        full_name: name,
        description: name,
        type: "forex",
        session: "24x7",
        timezone: "Etc/UTC",
        exchange: "FOREX",
        listed_exchange: "FOREX",
        format: "price",
        pricescale: Math.pow(10, digits),
        minmov: 1,
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
        volume_precision: 0,
        data_status: "streaming",
      }),
    0);
  }

  async getBars(
    symbolInfo: TVSymbolInfo,
    resolution: string,
    periodParams: PeriodParams,
    onHistory: HistoryCb,
    onError: ErrorCb
  ) {
    const { from, to } = periodParams;
    const timeframe = RESOLUTION_TO_TF[resolution] ?? "H1";

    try {
      const params = new URLSearchParams({
        symbol: symbolInfo.name,
        timeframe,
        from: String(from),
        to: String(to),
      });

      const res = await fetch(`${this.gatewayHttpUrl}/bars?${params}`);
      if (!res.ok) throw new Error(`Gateway HTTP ${res.status}`);

      const rawBars = (await res.json()) as Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>;

      if (!rawBars || rawBars.length === 0) {
        onHistory([], { noData: true });
        return;
      }

      const bars: TVBar[] = rawBars.map((b) => ({
        time: b.time * 1000, // TradingView は ms 単位
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      onHistory(bars, { noData: false });
    } catch (err) {
      console.error("[TVDatafeed] getBars error:", err);
      onError(String(err));
    }
  }

  subscribeBars(
    symbolInfo: TVSymbolInfo,
    resolution: string,
    onRealtime: RealtimeCb,
    subscriberUID: string,
    onReset: () => void
  ) {
    this.subscribers.set(subscriberUID, {
      symbolName: symbolInfo.name,
      resolution,
      onRealtime,
      onReset,
      lastBar: null,
    });
  }

  unsubscribeBars(subscriberUID: string) {
    this.subscribers.delete(subscriberUID);
  }
}

// --------------------------------------------------
// ユーティリティ
// --------------------------------------------------

function resolutionToSeconds(resolution: string): number {
  const map: Record<string, number> = {
    "1": 60, "5": 300, "15": 900, "30": 1800,
    "60": 3600, "240": 14400, "D": 86400, "W": 604800,
  };
  return map[resolution] ?? 3600;
}
