// ==================================================
// ConnectionManager — ブローカー接続の集約管理
// ==================================================
//
// 責務:
//   ・アクティブな接続を1つ保持する（Phase1）
//   ・将来の複数ブローカー対応への拡張ポイント
//   ・GatewayClient インスタンスを外部（TVDatafeed など）へ公開
//
// アーキテクチャ:
//   UI → connectionStore（Zustand）→ ConnectionManager → GatewayClient
//   TVDatafeed → ConnectionManager.instance.client → GatewayClient
//
// シングルトンパターンで、どこからでも同一インスタンスを参照できる。
// ==================================================

import { GatewayClient } from "./GatewayClient";
import type {
  MT5GatewayConfig,
  AnyConnectionConfig,
  ConnectionResult,
  ConnectionStatus,
} from "./types";

type StatusListener = (status: ConnectionStatus) => void;
type Unsubscribe    = () => void;

export class ConnectionManager {
  // --------------------------------------------------
  // シングルトン
  // --------------------------------------------------
  private static _instance: ConnectionManager | null = null;

  static get instance(): ConnectionManager {
    if (!ConnectionManager._instance) {
      ConnectionManager._instance = new ConnectionManager();
    }
    return ConnectionManager._instance;
  }

  private constructor() {}

  // --------------------------------------------------
  // 状態
  // --------------------------------------------------
  private _status: ConnectionStatus = "disconnected";
  private _activeConfig: AnyConnectionConfig | null = null;
  private _client: GatewayClient | null = null;
  private _statusListeners = new Set<StatusListener>();

  // --------------------------------------------------
  // Getter
  // --------------------------------------------------

  /** 現在のアクティブな GatewayClient（未接続なら null）*/
  get client(): GatewayClient | null {
    return this._client;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get activeConfig(): AnyConnectionConfig | null {
    return this._activeConfig;
  }

  // --------------------------------------------------
  // 接続
  // --------------------------------------------------

  /**
   * 指定の設定でブローカーへ接続する。
   * 既存の接続があれば切断してから再接続する。
   *
   * 現在は MT5 Gateway のみサポート。
   * 将来: config.type によって適切なクライアントを生成する。
   */
  async connect(config: AnyConnectionConfig): Promise<ConnectionResult> {
    // 既存接続を切断
    this.disconnect();

    this.setStatus("connecting");

    try {
      switch (config.type) {
        case "mt5_gateway":
          return await this.connectMT5Gateway(config);

        // 将来のブローカー
        case "binance":
        case "bybit":
        case "oanda":
        case "ctrader":
          return { success: false, error: `${config.type} は未実装です。` };

        default:
          return { success: false, error: "不明なブローカータイプです。" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error");
      return { success: false, error: message };
    }
  }

  /**
   * アクティブな接続を切断する。
   */
  disconnect(): void {
    this._client?.disconnect();
    this._client       = null;
    this._activeConfig = null;
    this.setStatus("disconnected");
  }

  // --------------------------------------------------
  // 状態変化の購読
  // --------------------------------------------------

  /**
   * 接続状態の変化を購読する。
   * @returns unsubscribe 関数
   */
  onStatusChange(listener: StatusListener): Unsubscribe {
    this._statusListeners.add(listener);
    // 現在の状態を即時通知
    listener(this._status);
    return () => this._statusListeners.delete(listener);
  }

  // --------------------------------------------------
  // 内部: MT5 Gateway 接続処理
  // --------------------------------------------------

  private async connectMT5Gateway(config: MT5GatewayConfig): Promise<ConnectionResult> {
    const client = new GatewayClient(config);

    // ① HTTP 疎通確認
    const alive = await client.ping();
    if (!alive) {
      this.setStatus("error");
      return {
        success: false,
        error: `Gateway へ接続できません。\nURL: ${config.gatewayUrl}\nGateway が起動しているか確認してください。`,
      };
    }

    // ② WebSocket 接続
    await client.connect();

    // ③ GatewayClient の状態変化を ConnectionManager に伝播
    client.onStatusChange((status) => this.setStatus(status));

    this._client       = client;
    this._activeConfig = config;
    this.setStatus("connected");

    return { success: true };
  }

  // --------------------------------------------------
  // 内部: 状態更新
  // --------------------------------------------------

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this._statusListeners.forEach((listener) => listener(status));
  }
}
