"use client";

// =================================================================
// useMonitor — AI Monitor モード（バックグラウンドシグナル監視）
// EMA クロス・ATR スパイク・Spread 異常などを検出して通知
// =================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useAIOSStore } from "@/application/stores/aiOSStore";
import { useIndicatorStore, type IndicatorData } from "@/application/stores/indicatorStore";
import { useSettingsStore } from "@/application/stores/settingsStore";

export interface Signal {
  id:        string;
  ts:        number;
  symbol:    string;
  type:      "EMA_CROSS_UP" | "EMA_CROSS_DOWN" | "ATR_SPIKE" | "SPREAD_HIGH" | "TREND_ALIGN";
  timeframe: string;
  message:   string;
  strength:  "weak" | "medium" | "strong";
}

interface MonitorState {
  signals:    Signal[];
  isActive:   boolean;
  checkedAt:  number | null;
}

// 直前の EMA 関係を記録（クロス検出用）
const prevEmaState: Record<string, "above" | "below"> = {};

function detectSignals(ind: IndicatorData, existingSignals: Signal[]): Signal[] {
  const now      = Date.now();
  const cutoff   = now - 60_000; // 1分以内の重複シグナルは無視
  const newSigs: Signal[] = [];

  const recentKeys = new Set(
    existingSignals.filter(s => s.ts > cutoff).map(s => `${s.symbol}_${s.type}_${s.timeframe}`)
  );

  for (const [tf, v] of Object.entries(ind.timeframes)) {
    const key     = `${ind.symbol}_${tf}`;
    const curState: "above" | "below" = v.ema21 > v.ema200 ? "above" : "below";
    const prev    = prevEmaState[key];

    // EMA クロス検出（前回値がある場合のみ）
    if (prev && prev !== curState) {
      const crossType = curState === "above" ? "EMA_CROSS_UP" : "EMA_CROSS_DOWN";
      const sigKey    = `${ind.symbol}_${crossType}_${tf}`;

      if (!recentKeys.has(sigKey)) {
        const strength = tf === "H4" ? "strong" : tf === "H1" ? "medium" : "weak";
        newSigs.push({
          id:        `${now}_${sigKey}`,
          ts:        now,
          symbol:    ind.symbol,
          type:      crossType,
          timeframe: tf,
          message:   curState === "above"
            ? `[${tf}] EMA21 が EMA200 を上抜け（ゴールデンクロス）`
            : `[${tf}] EMA21 が EMA200 を下抜け（デッドクロス）`,
          strength,
        });
      }
    }
    prevEmaState[key] = curState;

    // ATR スパイク（ATR が EMA21-EMA200 差の2倍以上）
    const emaDiff = Math.abs(v.ema21 - v.ema200);
    if (emaDiff > 0 && v.atr > emaDiff * 2) {
      const sigKey = `${ind.symbol}_ATR_SPIKE_${tf}`;
      if (!recentKeys.has(sigKey)) {
        newSigs.push({
          id:        `${now}_${sigKey}`,
          ts:        now,
          symbol:    ind.symbol,
          type:      "ATR_SPIKE",
          timeframe: tf,
          message:   `[${tf}] ATR スパイク検出（ボラティリティ急上昇）`,
          strength:  "medium",
        });
      }
    }
  }

  // Spread 異常（5pips以上）
  if (ind.spread > 5) {
    const sigKey = `${ind.symbol}_SPREAD_HIGH_ALL`;
    if (!recentKeys.has(sigKey)) {
      newSigs.push({
        id:        `${now}_${sigKey}`,
        ts:        now,
        symbol:    ind.symbol,
        type:      "SPREAD_HIGH",
        timeframe: "ALL",
        message:   `スプレッド異常: ${ind.spread.toFixed(1)} pips（取引不推奨）`,
        strength:  "strong",
      });
    }
  }

  // トレンドアライン検出（H4・H1・M15 が同方向）
  const tfs = ["H4", "H1", "M15"] as const;
  const dirs = tfs.map(t => {
    const d = ind.timeframes[t];
    return d ? (d.ema21 > d.ema200 ? "up" : "down") : null;
  }).filter(Boolean);

  if (dirs.length === 3 && dirs.every(d => d === dirs[0])) {
    const dir    = dirs[0];
    const sigKey = `${ind.symbol}_TREND_ALIGN_${dir}`;
    if (!recentKeys.has(sigKey)) {
      newSigs.push({
        id:        `${now}_${sigKey}`,
        ts:        now,
        symbol:    ind.symbol,
        type:      "TREND_ALIGN",
        timeframe: "H4+H1+M15",
        message:   `トレンドアライン: H4/H1/M15 が${dir === "up" ? "上昇" : "下降"}方向に揃った`,
        strength:  "strong",
      });
    }
  }

  return newSigs;
}

// Autonomous モード: AI に分析させて注文を自動送信
async function autonomousExecute(
  sig: Signal,
  ind: IndicatorData,
  settings: { defaultLotSize: number },
  addLog: (text: string, type?: "info"|"ai"|"signal"|"order"|"warn"|"ok", symbol?: string) => void,
  setAgentStatus: (id: string, status: "idle"|"active"|"thinking"|"error", lastAction?: string) => void
) {
  addLog(`[AUTO] ${sig.message} → AI 分析開始`, "signal", sig.symbol);
  setAgentStatus("decision", "thinking", "自律分析中...");

  try {
    // AI に分析させて注文パラメータを生成
    const res = await fetch("/api/ai/autonomous-order", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ signal: sig, indicators: ind }),
    });
    if (!res.ok) throw new Error(`AI 分析失敗: ${res.status}`);

    const order = await res.json() as {
      direction: "BUY"|"SELL"; symbol: string;
      volume: number; sl: number; tp: number; magic: number;
      reason: string;
    };

    // Gateway に注文送信
    const gwUrl = process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "http://127.0.0.1:8080";
    const orderRes = await fetch(`${gwUrl}/orders`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...order, status: "pending", source: "autonomous" }),
    });

    if (orderRes.ok) {
      const { id } = await orderRes.json() as { id: string };
      addLog(`[AUTO ORDER] ${order.direction} ${order.symbol} vol=${order.volume} — ${order.reason} (id:${id})`, "order", sig.symbol);
      setAgentStatus("order", "active", `自律発注: ${order.direction} ${order.symbol}`);
    } else {
      addLog(`[AUTO ORDER] 送信失敗: ${orderRes.status}`, "warn", sig.symbol);
      setAgentStatus("order", "error", "注文送信失敗");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(`[AUTO ERROR] ${msg}`, "warn", sig.symbol);
    setAgentStatus("decision", "error", msg);
  }
}

export function useMonitor() {
  const [state, setState] = useState<MonitorState>({
    signals:   [],
    isActive:  false,
    checkedAt: null,
  });

  const { mode, addLog, setAgentStatus } = useAIOSStore();
  const { indicators }                   = useIndicatorStore();
  const { settings }                     = useSettingsStore();
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoLockRef   = useRef<Set<string>>(new Set()); // 重複自律発注防止
  const isMonitorMode = mode === "monitor" || mode === "assisted" || mode === "autonomous";

  const checkSignals = useCallback(() => {
    if (Object.keys(indicators).length === 0) return;

    let allNew: Signal[] = [];
    for (const ind of Object.values(indicators)) {
      const newSigs = detectSignals(ind, state.signals);
      allNew = [...allNew, ...newSigs];
    }

    if (allNew.length > 0) {
      setState(prev => ({
        ...prev,
        signals:   [...prev.signals.slice(-49), ...allNew],
        checkedAt: Date.now(),
      }));
      allNew.forEach(sig => {
        addLog(`[SIGNAL] ${sig.message}`, "signal", sig.symbol);
        setAgentStatus("analysis", "active", sig.message);

        if (sig.strength === "strong" && "Notification" in window && Notification.permission === "granted") {
          new Notification("AVL AI シグナル", { body: sig.message, icon: "/favicon.ico" });
        }

        // Autonomous モード: 強シグナルを自動発注（5分クールダウン）
        if (mode === "autonomous" && sig.strength === "strong") {
          const lockKey = `${sig.symbol}_${sig.type}`;
          if (!autoLockRef.current.has(lockKey)) {
            autoLockRef.current.add(lockKey);
            setTimeout(() => autoLockRef.current.delete(lockKey), 300_000); // 5分後に解除

            const ind = indicators[sig.symbol.toUpperCase()];
            if (ind) {
              void autonomousExecute(sig, ind, settings, addLog, setAgentStatus);
            }
          }
        }
      });
    }

    setState(prev => ({ ...prev, checkedAt: Date.now() }));
  }, [indicators, state.signals, mode, settings, addLog, setAgentStatus]);

  // モニターモード時に定期チェック
  useEffect(() => {
    if (!isMonitorMode) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setState(prev => ({ ...prev, isActive: false }));
      return;
    }

    setState(prev => ({ ...prev, isActive: true }));
    addLog("[MONITOR] シグナル監視開始", "ok");
    setAgentStatus("market", "active", "監視中");

    // 通知許可リクエスト
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    intervalRef.current = setInterval(checkSignals, 30_000); // 30秒ごと
    checkSignals(); // 即時実行

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      addLog("[MONITOR] シグナル監視停止", "info");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMonitorMode]);

  const clearSignals = useCallback(() => {
    setState(prev => ({ ...prev, signals: [] }));
  }, []);

  return {
    signals:   state.signals,
    isActive:  state.isActive,
    checkedAt: state.checkedAt,
    clearSignals,
  };
}
