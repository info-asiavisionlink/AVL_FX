import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// =================================================================
// AVL AI OS — Mode & Agent State Store
// =================================================================

export type AIMode =
  | "analysis"    // 分析のみ
  | "monitor"     // 24h 監視・条件成立時のみ通知
  | "assisted"    // AI提案 → 人が承認 → EA注文
  | "autonomous"; // AI完全自律（将来実装）

export type AgentStatus = "idle" | "active" | "thinking" | "error";

export interface AgentState {
  id:          string;
  name:        string;
  description: string;
  status:      AgentStatus;
  lastAction?: string;
  metric?:     string;
}

const DEFAULT_AGENTS: AgentState[] = [
  { id: "market",   name: "Market Agent",    description: "価格・EMA・ATR 監視",   status: "idle" },
  { id: "analysis", name: "Analysis Agent",  description: "テクニカル分析",         status: "idle" },
  { id: "decision", name: "Decision Agent",  description: "売買判断・提案",         status: "idle" },
  { id: "order",    name: "Order Agent",     description: "注文・リスク管理",       status: "idle" },
  { id: "voice",    name: "Voice Agent",     description: "音声インターフェース",   status: "idle" },
];

interface AILog {
  id:      string;
  ts:      number;
  text:    string;
  type:    "info" | "ai" | "signal" | "order" | "warn" | "ok";
  symbol?: string;
}

interface AIOSStore {
  mode:          AIMode;
  agents:        AgentState[];
  aiLogs:        AILog[];
  activeSymbol:  string;

  setMode:       (mode: AIMode) => void;
  setAgentStatus:(id: string, status: AgentStatus, lastAction?: string) => void;
  addLog:        (text: string, type?: AILog["type"], symbol?: string) => void;
  clearLogs:     () => void;
}

export const useAIOSStore = create<AIOSStore>()(
  persist(
    (set) => ({
      mode:         "assisted",
      agents:       DEFAULT_AGENTS,
      aiLogs:       [],
      activeSymbol: "EURUSD",

      setMode: (mode) => set({ mode }),

      setAgentStatus: (id, status, lastAction) =>
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === id ? { ...a, status, ...(lastAction ? { lastAction } : {}) } : a
          ),
        })),

      addLog: (text, type = "info", symbol) =>
        set((s) => ({
          aiLogs: [
            ...s.aiLogs.slice(-99),
            { id: `${Date.now()}_${Math.random()}`, ts: Date.now(), text, type, symbol },
          ],
        })),

      clearLogs: () => set({ aiLogs: [] }),
    }),
    {
      name: "avl_ai_os_state",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? localStorage : {
          getItem: () => null, setItem: () => {}, removeItem: () => {},
        }
      ),
      partialize: (s) => ({ mode: s.mode }),
    }
  )
);
