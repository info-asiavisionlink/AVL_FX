// =================================================================
// timeframe.ts — TF関連のPure Utilities
//
// StrategyEvaluator が Multi-Timeframe アライメントに使用する。
// =================================================================

import type { Bar } from "@/infrastructure/analysis/types";

// ------------------------------------------------------------------
// 時間足 → ミリ秒マップ
// ------------------------------------------------------------------

export const TF_MS: Record<string, number> = {
  M1:  60_000,
  M5:  300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1:  3_600_000,
  H4:  14_400_000,
  D1:  86_400_000,
  W1:  604_800_000,
};

// ------------------------------------------------------------------
// 確定バーインデックス取得（Look-ahead Bias 防止の核心）
//
// 定義:
//   bar.time = バー開始時刻 (ms)
//   bar.time + TF_MS[tf] = バー確定時刻 (ms)
//
//   evalMs 時点で "確定済み" のバー:
//     bar.time + TF_MS[tf] <= evalMs
//
// 例: evalMs = 10:40:00 UTC (M5 10:35バーが閉じた瞬間)
//   H1 10:00バー → 確定時刻 11:00:00 → 未確定 ✗
//   H1 09:00バー → 確定時刻 10:00:00 → 確定済み ✓
//
// Binary Search O(log n)。bars は time 昇順ソート済みを前提とする。
// ------------------------------------------------------------------

/**
 * evalMs 時点で確定済みの最後のバーの index を返す。
 * 1本も確定していなければ -1 を返す。
 *
 * @param bars    TF別の全バー（time 昇順ソート済み）
 * @param tf      時間足文字列（"H1", "H4" 等）
 * @param evalMs  評価基準時刻 (ms) — 通常は「直前の確定バーの終了時刻」
 */
export function getLastConfirmedBarIndex(
  bars: Bar[],
  tf:   string,
  evalMs: number,
): number {
  const periodMs = TF_MS[tf] ?? 0;
  let lo = 0, hi = bars.length - 1, result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time + periodMs <= evalMs) {
      result = mid;
      lo     = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// セッション判定（UTC固定ウィンドウ）
//
// DST 非対応（Phase 2-B)。将来 DST 対応が必要な場合は
// UTC オフセットをシンボル or ブローカーから取得して調整する。
//
// 参考: 既存 gateway/src/index.ts getTradingSessions() と同一定義
// ------------------------------------------------------------------

export const SESSION_UTC: Record<string, { start: number; end: number }> = {
  TOKYO:    { start: 0,  end: 9  },
  LONDON:   { start: 7,  end: 16 },
  NEW_YORK: { start: 12, end: 21 },
  SYDNEY:   { start: 21, end: 24 },  // + 0-2 を別扱いするよりシンプルに
};

/**
 * evalMs 時点のアクティブセッション一覧を返す。
 * セッションは重複する（London と NY の両方が active な時間帯あり）。
 */
export function getSessionsAtTime(evalMs: number): string[] {
  const d    = new Date(evalMs);
  const h    = d.getUTCHours() + d.getUTCMinutes() / 60;
  const sessions: string[] = [];

  if (h >= 0  && h < 9)  sessions.push("TOKYO");
  if (h >= 7  && h < 16) sessions.push("LONDON");
  if (h >= 12 && h < 21) sessions.push("NEW_YORK");
  // Sydney は 21-24 かつ 0-2 をカバー
  if (h >= 21 || h < 2)  sessions.push("SYDNEY");

  return sessions;
}

/**
 * 指定セッションリストのうち1つでも evalMs にアクティブなら true。
 * sessions が空（未指定）なら常に true（制限なし）。
 */
export function isWithinSessions(
  sessions: string[],
  evalMs:   number,
): boolean {
  if (sessions.length === 0) return true;
  const active = getSessionsAtTime(evalMs);
  return sessions.some(s => active.includes(s));
}
