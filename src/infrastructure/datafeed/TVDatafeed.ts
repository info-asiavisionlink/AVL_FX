// ==================================================
// TVDatafeed — TradingView Datafeed API 実装
// ==================================================
//
// TradingView Charting Library が期待する IDatafeedChartApi を実装する。
//
// データ取得は IDataProvider に委譲する。
// プロバイダーを差し替えるだけでデータソースを切り替えられる。
//
//   new TVDatafeed(new MockDataProvider())   // 現在
//   new TVDatafeed(new MT5DataProvider(...)) // Phase1
//
// 使用方法:
//   // TradingView Charting Library（ライセンス版）
//   new window.TradingView.widget({ datafeed: new TVDatafeed(provider), ... });
//
//   // lightweight-charts（現在）
//   AVLChart.tsx 内で直接メソッドを呼び出す
// ==================================================

import type { IDataProvider } from "./IDataProvider";
import type {
  IDatafeedChartApi,
  LibrarySymbolInfo,
  ResolutionString,
  PeriodParams,
  DatafeedConfiguration,
  OnReadyCallback,
  SearchSymbolsCallback,
  ResolveCallback,
  HistoryCallback,
  SubscribeBarsCallback,
  ErrorCallback,
  ServerTimeCallback,
} from "./tv-types";

// --------------------------------------------------
// Datafeed 設定定数
// --------------------------------------------------

const DATAFEED_CONFIG: DatafeedConfiguration = {
  supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
  exchanges: [
    { value: "FOREX", name: "Forex", desc: "FX / MT5" },
    { value: "METAL", name: "Metal", desc: "Gold / Silver" },
  ],
  symbols_types: [
    { name: "Forex", value: "forex" },
    { name: "Metal", value: "metal" },
  ],
  supports_search:           true,
  supports_group_request:    false,
  supports_marks:            false,
  supports_timescale_marks:  false,
};

// --------------------------------------------------
// 購読管理レコード
// --------------------------------------------------

interface SubscriberRecord {
  symbolInfo: LibrarySymbolInfo;
  resolution: ResolutionString;
  onRealtime: SubscribeBarsCallback;
  onResetCache: () => void;
  unsubscribe: () => void;
}

// --------------------------------------------------
// TVDatafeed クラス
// --------------------------------------------------

export class TVDatafeed implements IDatafeedChartApi {
  private readonly provider: IDataProvider;
  private subscribers = new Map<string, SubscriberRecord>();

  constructor(provider: IDataProvider) {
    this.provider = provider;
  }

  // --------------------------------------------------
  // 1. onReady
  // --------------------------------------------------
  /**
   * ライブラリ初期化直後に1回呼ばれる。
   * DatafeedConfiguration を callback に渡してサポート機能を通知する。
   * 仕様: callback は非同期（setTimeout 0）で呼ぶこと。
   */
  onReady(callback: OnReadyCallback): void {
    setTimeout(() => callback(DATAFEED_CONFIG), 0);
  }

  // --------------------------------------------------
  // 2. searchSymbols
  // --------------------------------------------------
  /**
   * ユーザーがシンボル検索に文字を入力するたびに呼ばれる。
   * onResultReadyCallback に結果配列を渡す。
   */
  searchSymbols(
    userInput: string,
    exchange: string,
    _symbolType: string,
    onResultReadyCallback: SearchSymbolsCallback
  ): void {
    this.provider
      .searchSymbols(userInput, exchange)
      .then((results) => onResultReadyCallback(results))
      .catch(() => onResultReadyCallback([]));
  }

  // --------------------------------------------------
  // 3. resolveSymbol
  // --------------------------------------------------
  /**
   * シンボル名からシンボル詳細情報（LibrarySymbolInfo）を解決する。
   * 仕様: callback は非同期で呼ぶこと（setTimeout 0 以上）。
   */
  resolveSymbol(
    symbolName: string,
    onSymbolResolvedCallback: ResolveCallback,
    onResolveErrorCallback: ErrorCallback,
    _extension?: Record<string, unknown>
  ): void {
    // "FOREX:EURUSD" 形式も受け付ける
    const name = symbolName.includes(":") ? symbolName.split(":")[1] : symbolName;

    this.provider
      .resolveSymbol(name.toUpperCase())
      .then((info) => {
        if (!info) {
          onResolveErrorCallback(`Symbol not found: ${name}`);
          return;
        }
        // 仕様: 非同期で返すこと
        setTimeout(() => onSymbolResolvedCallback(info), 0);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        onResolveErrorCallback(msg);
      });
  }

  // --------------------------------------------------
  // 4. getBars
  // --------------------------------------------------
  /**
   * 指定期間の過去バーを取得してチャートへ返す。
   *
   * 仕様上の注意:
   *   ・firstDataRequest=true の場合は最新データから countBack 本返す
   *   ・スクロール時（firstDataRequest=false）は from〜to 範囲を返す
   *   ・データがない場合は meta.noData=true を渡す（空配列で呼ぶとエラー）
   *   ・このメソッドはキャンセルできないため、コンポーネントのアンマウント後に
   *     callback が呼ばれる可能性がある点に注意
   */
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onHistoryCallback: HistoryCallback,
    onErrorCallback: ErrorCallback
  ): void {
    const { from, to, countBack, firstDataRequest } = periodParams;

    this.provider
      .getBars({ symbol: symbolInfo.name, resolution, from, to, countBack, firstDataRequest })
      .then(({ bars, noData, nextTime }) => {
        if (noData || bars.length === 0) {
          onHistoryCallback([], { noData: true, nextTime: nextTime ?? null });
          return;
        }
        // ⑤ ログ: getBars が返した最後のバー
        const last = bars[bars.length - 1];
        console.log(`[⑤ getBars] sym=${symbolInfo.name} res=${resolution} bars=${bars.length} last_time=${last.time} open=${last.open} close=${last.close}`);
        onHistoryCallback(bars, { noData: false });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[TVDatafeed] getBars error:", msg);
        onErrorCallback(msg);
      });
  }

  // --------------------------------------------------
  // 5. subscribeBars
  // --------------------------------------------------
  /**
   * リアルタイムバー更新の購読を開始する。
   * getBars が完了した後にライブラリから呼ばれる。
   *
   * onRealtimeCallback は:
   *   ・未確定バー（現在進行中のバー）の更新
   *   ・確定した新バーの追加
   * どちらも同じコールバックで通知する。
   */
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onRealtimeCallback: SubscribeBarsCallback,
    subscriberUID: string,
    onResetCacheNeededCallback: () => void
  ): void {
    // 既存の同 UID 購読があれば解除
    this.unsubscribeBars(subscriberUID);

    const unsubscribe = this.provider.subscribeBar(
      { symbol: symbolInfo.name, resolution, subscriberUID },
      (bar) => onRealtimeCallback(bar)
    );

    this.subscribers.set(subscriberUID, {
      symbolInfo,
      resolution,
      onRealtime:   onRealtimeCallback,
      onResetCache: onResetCacheNeededCallback,
      unsubscribe,
    });
  }

  // --------------------------------------------------
  // 6. unsubscribeBars
  // --------------------------------------------------
  /**
   * subscriberUID に対応するリアルタイム購読を解除する。
   * シンボル・時間足変更時や、チャートウィジェット破棄時に呼ばれる。
   */
  unsubscribeBars(subscriberUID: string): void {
    const sub = this.subscribers.get(subscriberUID);
    if (!sub) return;
    sub.unsubscribe();
    this.subscribers.delete(subscriberUID);
  }

  // --------------------------------------------------
  // getServerTime (オプション)
  // --------------------------------------------------
  /**
   * サーバー時刻を返す（Unix秒）。
   * 実装するとチャート右上のカウントダウンが正確になる。
   */
  getServerTime(callback: ServerTimeCallback): void {
    if (this.provider.getServerTime) {
      this.provider
        .getServerTime()
        .then((t) => callback(t))
        .catch(() => callback(Math.floor(Date.now() / 1000)));
    } else {
      callback(Math.floor(Date.now() / 1000));
    }
  }

  // --------------------------------------------------
  // ユーティリティ: 購読中の subscriberUID 一覧（デバッグ用）
  // --------------------------------------------------
  getActiveSubscribers(): string[] {
    return Array.from(this.subscribers.keys());
  }
}
