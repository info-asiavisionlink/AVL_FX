// =================================================================
// ui-labels.ts — UI表示用日本語ラベルマップ
//
// 設計原則:
//   - 内部enum値（DB/API）は変更しない
//   - UI表示層でのみこのマップを使用する
//   - 二重実装禁止：各コンポーネントでハードコードしない
// =================================================================

// ── バックテスト判定 ──────────────────────────────────────────────
export const VERDICT_LABELS: Record<string, string> = {
  PASSED:       "合格",
  CONDITIONAL:  "条件付",
  FAILED:       "不合格",
  ROBUST:       "堅牢",
  OVERFIT:      "過学習",
  INCONCLUSIVE: "判定不能",
  IMPROVED:     "改善",
  REGRESSION:   "悪化",
};

// ── バックテストステータス ────────────────────────────────────────
export const BACKTEST_STATUS_LABELS: Record<string, string> = {
  NOT_TESTED: "未検証",
  TESTING:    "実行中",
  PASSED:     "合格",
  FAILED:     "不合格",
};

// ── Strategyステータス ────────────────────────────────────────────
export const STRATEGY_STATUS_LABELS: Record<string, string> = {
  DRAFT:    "下書き",
  ACTIVE:   "有効",
  PAUSED:   "一時停止",
  ARCHIVED: "アーカイブ",
};

// ── Strategy種別 ─────────────────────────────────────────────────
export const STRATEGY_TYPE_LABELS: Record<string, string> = {
  SCALPING:  "スキャルピング",
  DAY_TRADE: "デイトレード",
  SWING:     "スイング",
};

// ── 方向 ─────────────────────────────────────────────────────────
export const DIRECTION_LABELS: Record<string, string> = {
  BUY:  "買い",
  SELL: "売り",
  LONG:  "ロング",
  SHORT: "ショート",
};

// ── 取引結果 ─────────────────────────────────────────────────────
export const TRADE_RESULT_LABELS: Record<string, string> = {
  WIN:         "勝",
  LOSS:        "負",
  BREAKEVEN:   "引分",
  END_OF_DATA: "期末",
};

// ── 決済理由 ─────────────────────────────────────────────────────
export const EXIT_REASON_LABELS: Record<string, string> = {
  TP:          "利確",
  SL:          "損切",
  END_OF_DATA: "期末",
};

// ── EAステータス ─────────────────────────────────────────────────
export const EA_STATUS_LABELS: Record<string, string> = {
  RUNNING:  "稼働中",
  STOPPED:  "停止中",
  STARTING: "起動中",
  STOPPING: "停止中",
  ERROR:    "エラー",
};

// ── セッション ────────────────────────────────────────────────────
export const SESSION_LABELS: Record<string, string> = {
  TOKYO:    "東京",
  LONDON:   "ロンドン",
  NEW_YORK: "NY",
  SYDNEY:   "シドニー",
  OVERLAP:  "重複",
  OFF:      "時間外",
};

// ── タブ ─────────────────────────────────────────────────────────
export const TAB_LABELS: Record<string, string> = {
  OVERVIEW:  "概要",
  BACKTEST:  "バックテスト",
  TRADES:    "取引履歴",
  ANALYSIS:  "AI分析",
  VERSIONS:  "バージョン",
  OPTIMIZE:  "最適化",
};

// ── ウォークフォワード判定 ────────────────────────────────────────
export const WF_VERDICT_LABELS: Record<string, string> = {
  ROBUST:       "堅牢",
  CONDITIONAL:  "条件付",
  OVERFIT:      "過学習",
  INCONCLUSIVE: "判定不能",
};

// ── Cross-Phase 判定フェーズ ──────────────────────────────────────
export const PHASE_LABELS: Record<string, string> = {
  BACKTEST_ANALYSIS: "バックテスト分析",
  OPTIMIZATION:      "最適化",
  WALK_FORWARD:      "ウォークフォワード",
  MONTE_CARLO:       "モンテカルロ",
};

// ── ヘルパー：ラベル変換（fallback付き） ─────────────────────────
export function labelOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
