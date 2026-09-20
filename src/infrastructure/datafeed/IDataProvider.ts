// ==================================================
// IDataProvider — データプロバイダー抽象インターフェース
// ==================================================
//
// TVDatafeed はこのインターフェースを通じてデータを取得する。
// プロバイダーを差し替えることでデータソースを切り替えられる。
//
//   現在: MockDataProvider  (ダミーデータ生成)
//   Phase1: MT5DataProvider (Gateway REST + WebSocket)
//
// TVDatafeed 自体は変更せずに、プロバイダーだけ差し替える。
// ==================================================

import type { Bar, LibrarySymbolInfo, SearchSymbolResultItem } from "./tv-types";

// --------------------------------------------------
// getBars パラメーター（内部用）
// --------------------------------------------------

export interface GetBarsRequest {
  symbol: string;
  resolution: string;
  /** Unix秒 */
  from: number;
  /** Unix秒 */
  to: number;
  /** 必要最低本数 */
  countBack: number;
  firstDataRequest: boolean;
}

export interface GetBarsResponse {
  bars: Bar[];
  /** データが存在しない場合 true */
  noData: boolean;
  /** noData=true の場合、次にデータが存在する時刻（省略可）*/
  nextTime?: number;
}

// --------------------------------------------------
// subscribeBar パラメーター（内部用）
// --------------------------------------------------

export interface SubscribeRequest {
  symbol: string;
  resolution: string;
  subscriberUID: string;
}

export type Unsubscribe = () => void;

// --------------------------------------------------
// IDataProvider
// --------------------------------------------------

export interface IDataProvider {
  /**
   * シンボル検索。検索文字列に一致するシンボル一覧を返す。
   */
  searchSymbols(query: string, exchange?: string): Promise<SearchSymbolResultItem[]>;

  /**
   * シンボル名からシンボル詳細情報を解決する。
   * 存在しない場合は null を返す。
   */
  resolveSymbol(symbolName: string): Promise<LibrarySymbolInfo | null>;

  /**
   * 指定期間の過去バーを取得する。
   */
  getBars(request: GetBarsRequest): Promise<GetBarsResponse>;

  /**
   * リアルタイムバー更新を購読する。
   * 新バー確定・未確定バー更新の両方を onBar で通知する。
   * @returns unsubscribe 関数
   */
  subscribeBar(
    request: SubscribeRequest,
    onBar: (bar: Bar) => void
  ): Unsubscribe;

  /**
   * (オプション) プロバイダーのサーバー時刻を返す（Unix秒）。
   */
  getServerTime?(): Promise<number>;
}
