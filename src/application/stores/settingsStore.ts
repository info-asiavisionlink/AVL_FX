import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// =================================================================
// AVL AI OS — Settings Store
// =================================================================

export interface AVLSettings {
  // AI 設定
  aiModel:          string;  // gpt-4.1 / gpt-5.6-sol / gpt-5.6-terra
  aiTemperature:    number;  // 0.1 - 1.0
  realtimeModel:    string;  // gpt-realtime-2.1

  // リスク管理
  defaultLotSize:   number;  // デフォルトロット数
  maxDailyLossPct:  number;  // 最大日次損失 %
  maxPositions:     number;  // 最大同時ポジション数
  stopOnLoss:       boolean; // 損失上限で自動停止

  // 外部データ
  twelveDataKey:    string;  // Twelve Data API キー

  // 通知
  notifySignals:    boolean; // シグナル通知
  notifyOrders:     boolean; // 注文通知
  notifyWarnSpread: boolean; // Spread 警告
  spreadWarnPips:   number;  // Spread 警告閾値 (pips)

  // UI
  radarSize:        "sm" | "md" | "lg";
  showSparkline:    boolean;
}

const DEFAULTS: AVLSettings = {
  aiModel:          "gpt-5.6-terra",
  aiTemperature:    0.3,
  realtimeModel:    "gpt-realtime-2.1-mini",

  defaultLotSize:   0.01,
  maxDailyLossPct:  2.0,
  maxPositions:     5,
  stopOnLoss:       true,

  twelveDataKey:    "",

  notifySignals:    true,
  notifyOrders:     true,
  notifyWarnSpread: true,
  spreadWarnPips:   5.0,

  radarSize:        "md",
  showSparkline:    true,
};

interface SettingsStore {
  settings: AVLSettings;
  set:      (patch: Partial<AVLSettings>) => void;
  reset:    () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      settings: DEFAULTS,
      set:   (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      reset: ()      => set({ settings: DEFAULTS }),
    }),
    {
      name: "avl_ai_settings",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? localStorage : {
          getItem: () => null, setItem: () => {}, removeItem: () => {},
        }
      ),
    }
  )
);
