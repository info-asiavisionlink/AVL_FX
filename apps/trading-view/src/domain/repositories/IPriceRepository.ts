import type { OHLCBar, Symbol, Timeframe, Tick } from "@/types";

// 価格データのリポジトリインターフェース
// Infrastructure層で実装（MT5 Gateway / Supabase）
export interface IPriceRepository {
  // 指定シンボル・時間足のバーデータを取得
  getBars(
    symbol: Symbol,
    timeframe: Timeframe,
    from: number,
    to: number
  ): Promise<OHLCBar[]>;

  // 最新のTickデータを取得
  getLatestTick(symbol: Symbol): Promise<Tick | null>;

  // リアルタイムTickのサブスクリプション
  subscribeTick(
    symbol: Symbol,
    callback: (tick: Tick) => void
  ): () => void; // unsubscribe関数を返す

  // リアルタイムBarのサブスクリプション
  subscribeBar(
    symbol: Symbol,
    timeframe: Timeframe,
    callback: (bar: OHLCBar) => void
  ): () => void;
}
