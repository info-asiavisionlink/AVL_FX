// ==================================================
// connectionStore — MT5 接続状態の Zustand ストア
// ==================================================
//
// 役割:
//   ・接続設定を localStorage へ永続化（zustand/middleware persist）
//   ・接続アクション（connect / disconnect）を提供
//   ・ConnectionManager を通じて GatewayClient を操作
//
// LocalStorage キー: "avl_fx_mt5_config"
//   保存対象: config のみ（status / error は保存しない）
// ==================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ConnectionManager } from "@/infrastructure/connection/ConnectionManager";
import type {
  MT5GatewayConfig,
  ConnectionStatus,
  ConnectionResult,
  STORAGE_KEY_MT5_CONFIG,
} from "@/infrastructure/connection/types";
import { STORAGE_KEY_MT5_CONFIG as STORAGE_KEY } from "@/infrastructure/connection/types";

// --------------------------------------------------
// ストア型
// --------------------------------------------------

interface ConnectionStore {
  // ---- State ----
  /** 保存済みの接続設定（localStorage に永続化）*/
  config: MT5GatewayConfig | null;
  /** 現在の接続状態（localStorage には保存しない）*/
  status: ConnectionStatus;
  /** 最後のエラーメッセージ */
  error: string | null;
  /** 接続確立時刻（Unix ms）*/
  connectedAt: number | null;

  // ---- Actions ----
  /**
   * Gateway へ接続する。
   * 設定を localStorage へ保存してから ConnectionManager を呼ぶ。
   */
  connect: (config: MT5GatewayConfig) => Promise<ConnectionResult>;
  /**
   * 接続を切断する。
   * 設定は残す（次回起動時の自動接続用）。
   */
  disconnect: () => void;
  /**
   * 設定のみ更新する（接続は行わない）。
   */
  saveConfig: (config: MT5GatewayConfig) => void;
  /**
   * 接続状態を手動更新する（ConnectionManager からのコールバック用）。
   */
  setStatus: (status: ConnectionStatus, error?: string) => void;
}

// --------------------------------------------------
// ストア実装
// --------------------------------------------------

export const useConnectionStore = create<ConnectionStore>()(
  persist(
    (set, _get) => ({
      // 初期値
      config:      null,
      status:      "disconnected",
      error:       null,
      connectedAt: null,

      // ---- connect ----
      connect: async (config: MT5GatewayConfig): Promise<ConnectionResult> => {
        set({ status: "connecting", error: null });

        const result = await ConnectionManager.instance.connect(config);

        if (result.success) {
          set({
            config,
            status:      "connected",
            error:       null,
            connectedAt: Date.now(),
          });
        } else {
          set({
            status: "error",
            error:  result.error ?? "接続に失敗しました。",
          });
        }

        return result;
      },

      // ---- disconnect ----
      disconnect: () => {
        ConnectionManager.instance.disconnect();
        set({
          status:      "disconnected",
          error:       null,
          connectedAt: null,
        });
      },

      // ---- saveConfig ----
      saveConfig: (config: MT5GatewayConfig) => {
        set({ config });
      },

      // ---- setStatus ----
      setStatus: (status: ConnectionStatus, error?: string) => {
        set({ status, error: error ?? null });
      },
    }),

    // ---- persist 設定 ----
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => {
        // SSR（サーバーサイドレンダリング）でエラーにならないよう安全に処理
        if (typeof window === "undefined") {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return localStorage;
      }),
      // localStorage に保存するのは config のみ（status / error は揮発性）
      partialize: (state) => ({ config: state.config }),
    }
  )
);

// --------------------------------------------------
// ConnectionManager の状態変化 → ストアへ伝播
// --------------------------------------------------
// Note: ストア生成後に1回だけ登録する
// "connected" → "disconnected" のような予期せぬ切断をストアに反映させる

if (typeof window !== "undefined") {
  ConnectionManager.instance.onStatusChange((status) => {
    // 現在のストア状態と異なる場合のみ更新（ループ防止）
    const current = useConnectionStore.getState().status;
    if (current !== status) {
      useConnectionStore.getState().setStatus(status);
    }
  });
}
