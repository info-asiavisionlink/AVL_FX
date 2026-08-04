// ==================================================
// TradingView Charting Library — Datafeed 公式型定義
// ==================================================
//
// 参照仕様:
//   https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api
//
// ライセンス版ライブラリ取得後は charting_library.d.ts が正式定義となる。
// このファイルはそれと互換性を保つよう設計されている。
// ==================================================

// --------------------------------------------------
// プリミティブ型
// --------------------------------------------------

/** 'D' | 'W' | 'M' または '1' '5' '15' '30' '60' '240' などの文字列 */
export type ResolutionString =
  | "1" | "3" | "5" | "15" | "30" | "60" | "120" | "240" | "360" | "720"
  | "D" | "1D" | "W" | "1W" | "M" | "1M"
  | (string & Record<never, never>); // カスタム解像度を許容しつつ補完を有効に

export type Timezone = "Etc/UTC" | "America/New_York" | "Asia/Tokyo" | (string & Record<never, never>);

// --------------------------------------------------
// Bar (時系列データ)
// --------------------------------------------------

/** TradingView が扱うローソク足 1 本 */
export interface Bar {
  /** Unix タイムスタンプ（秒単位）*/
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// --------------------------------------------------
// getBars コールバック
// --------------------------------------------------

export interface HistoryMetadata {
  /** データが存在しない場合 true */
  noData?: boolean;
  /**
   * noData=true のとき、次にデータが存在する時刻（秒）を渡すとチャートが
   * 自動的にその時刻まで遡る。渡さない場合は遡らない。
   */
  nextTime?: number | null;
}

export type HistoryCallback = (bars: Bar[], meta: HistoryMetadata) => void;

// --------------------------------------------------
// getBars パラメーター
// --------------------------------------------------

export interface PeriodParams {
  /** リクエスト開始時刻（Unix秒）*/
  from: number;
  /** リクエスト終了時刻（Unix秒）*/
  to: number;
  /**
   * チャートが必要とする最低バー本数。
   * from-to の範囲にかかわらず、少なくともこの本数を返すことが望ましい。
   */
  countBack: number;
  /** チャート初期ロード時に true。スクロール時は false。*/
  firstDataRequest: boolean;
}

// --------------------------------------------------
// Symbol 情報
// --------------------------------------------------

/** resolveSymbol で返すシンボル詳細情報 */
export interface LibrarySymbolInfo {
  // --- 必須フィールド ---
  name: string;
  full_name: string;
  description: string;
  /** 'forex' | 'crypto' | 'stock' | 'index' | 'futures' | 'bond' | 'economic' */
  type: string;
  /** '24x7' | '0930-1600' などセッション文字列 */
  session: string;
  timezone: Timezone;
  exchange: string;
  listed_exchange: string;
  /** 'price' | 'volume' */
  format: "price" | "volume";

  // --- 価格精度 ---
  /** 最小価格変動単位の分子。通常 1 */
  minmov: number;
  /** 価格スケール。例: 小数5桁 → 100000 */
  pricescale: number;

  // --- 対応解像度 ---
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly?: boolean;
  intraday_multipliers?: string[];
  supported_resolutions: ResolutionString[];

  // --- オプション ---
  volume_precision?: number;
  /** 'streaming' | 'endofday' | 'pulsed' | 'delayed_streaming' */
  data_status?: "streaming" | "endofday" | "pulsed" | "delayed_streaming";
  minmov2?: number;
  fractional?: boolean;
  currency_code?: string;
  /** Tick サイズ（オプション）*/
  ticker?: string;
}

// --------------------------------------------------
// Symbol 検索結果
// --------------------------------------------------

export interface SearchSymbolResultItem {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  /** 'forex' | 'crypto' | 'stock' など */
  type: string;
  ticker?: string;
}

// --------------------------------------------------
// Datafeed 設定（onReady で返す）
// --------------------------------------------------

export interface Exchange {
  value: string;
  name: string;
  desc: string;
}

export interface SymbolType {
  name: string;
  value: string;
}

export interface DatafeedConfiguration {
  /** サポートする解像度一覧 */
  supported_resolutions?: ResolutionString[];
  exchanges?: Exchange[];
  symbols_types?: SymbolType[];
  /** シンボル検索機能のサポート */
  supports_search?: boolean;
  /** グループリクエストのサポート */
  supports_group_request?: boolean;
  /** チャートマーカーのサポート */
  supports_marks?: boolean;
  /** タイムスケールマーカーのサポート */
  supports_timescale_marks?: boolean;
  currencies?: string[];
}

// --------------------------------------------------
// コールバック型
// --------------------------------------------------

export type OnReadyCallback = (configuration: DatafeedConfiguration) => void;
export type ResolveCallback = (symbolInfo: LibrarySymbolInfo) => void;
export type SearchSymbolsCallback = (items: SearchSymbolResultItem[]) => void;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type ErrorCallback = (reason: string) => void;
export type ServerTimeCallback = (serverTime: number) => void;

// --------------------------------------------------
// IDatafeedChartApi — TradingView が期待する Datafeed インターフェース
// --------------------------------------------------

export interface IDatafeedChartApi {
  /**
   * ライブラリ初期化直後に1回だけ呼ばれる。
   * callback に DatafeedConfiguration を渡してサポート機能を通知する。
   * 非同期でもよいが、できる限り早く呼ぶこと。
   */
  onReady(callback: OnReadyCallback): void;

  /**
   * ユーザーがシンボル検索ボックスに入力するたびに呼ばれる。
   * @param userInput - 検索クエリ文字列
   * @param exchange - 取引所フィルター（空文字は全取引所）
   * @param symbolType - タイプフィルター（空文字は全タイプ）
   */
  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResultReadyCallback: SearchSymbolsCallback
  ): void;

  /**
   * シンボル名からシンボル情報を解決する。
   * @param symbolName - チャートが要求するシンボル名
   */
  resolveSymbol(
    symbolName: string,
    onSymbolResolvedCallback: ResolveCallback,
    onResolveErrorCallback: ErrorCallback,
    extension?: Record<string, unknown>
  ): void;

  /**
   * 指定期間の過去バーデータを取得する。
   * チャートの初期ロード時・スクロール時に呼ばれる。
   * @param periodParams.countBack - チャートが必要とする最低バー本数
   * @param periodParams.firstDataRequest - 初回リクエストかどうか
   */
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onHistoryCallback: HistoryCallback,
    onErrorCallback: ErrorCallback
  ): void;

  /**
   * リアルタイムバー更新の購読を開始する。
   * getBars 完了後に呼ばれる。
   * @param subscriberUID - 購読を識別するユニークID（unsubscribeBars で使用）
   * @param onResetCacheNeededCallback - キャッシュリセットが必要な場合に呼ぶ
   */
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onRealtimeCallback: SubscribeBarsCallback,
    subscriberUID: string,
    onResetCacheNeededCallback: () => void
  ): void;

  /**
   * リアルタイム購読を解除する。
   * @param subscriberUID - subscribeBars で渡した UID
   */
  unsubscribeBars(subscriberUID: string): void;

  /**
   * (オプション) サーバー時刻を返す。
   * 返すと TradingView のカウントダウンタイマーが正確になる。
   */
  getServerTime?(callback: ServerTimeCallback): void;
}
