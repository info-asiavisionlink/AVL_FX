# STAGE 1 STEP 04 — EA Command Center Production UI Cleanup
**Date:** 2026-08-23
**Stage:** STAGE 1 Step 04
**Author:** 田中慶樹
**Status:** COMPLETED

## Objective

EA Command Centerから全モックデータ・テストEAを削除し、
本番データのみを表示するProduction UIへ完全移行する。

## Starting State

- 上部: MOCK_EA_PROFILES（5件ハードコード）が表示されていた
- 下部: AI EA セレクター（モック）+ 損失パターン・モック分析 が表示されていた
- ヘッダー: 「モック・デモ」バッジが表示されていた
- strategy_registry: 11件のテスト戦略が存在していた

## Implementation

### 1. DBクリーンアップ

削除対象（全11件 — magic_number 20001-20011、全てDRAFT）:

| 名前 | magic | 削除方法 |
|------|-------|---------|
| EURUSD RSI Reversal Scalping | 20001 | strategy_registry DELETE → CASCADE |
| USDJPY H1 EMA Trend Follow | 20002 | → |
| EURUSD Multi-TF EMA21 Pullback v1 | 20003 | → |
| EURUSD Multi-TF EMA21 Pullback v2 LONG | 20004 | → |
| EURUSD Multi-TF EMA21 Pullback v2 SHORT | 20005 | → |
| EURUSD Multi-TF EMA21 Pullback v3 LONG | 20006 | → |
| EURUSD Multi-TF EMA21 Pullback v3 SHORT | 20007 | → |
| EURUSD Multi-TF EMA21 Pullback v4 LONG | 20008 | → |
| EURUSD Multi-TF EMA21 Pullback v4 SHORT | 20009 | → |
| E2E Test EURUSD H1 RSI Reversal | 20010 | → |
| EURUSD H1 EMA RSI | 20011 | → |

削除順序:
1. `optimization_candidates` (strategy_id FK が CASCADE なしのため先に削除)
2. `strategy_registry` WHERE magic_number IN 20001-20011
   → CASCADE: backtest_jobs, backtest_results, backtest_trades, strategy_ai_analyses,
               strategy_improvements, strategy_versions, optimization_jobs,
               walk_forward_jobs, monte_carlo_results, strategy_phase4d_interpretations

削除後の全テーブル状態:
- strategy_registry: 0
- backtest_jobs: 0
- optimization_candidates: 0
- strategy_versions: 0
- strategy_ai_analyses: 0
- strategy_improvements: 0
- monte_carlo_results: 0
- walk_forward_jobs: 0
- strategy_phase4d_interpretations: 0

### 2. EACommandCenter.tsx 完全リライト

**削除したコンポーネント:**
- `MOCK_EA_PROFILES`, `MOCK_AI_SELECTOR_SYMBOL` インポート
- `EACard` コンポーネント（MOCK専用）
- `recColor`, `recLabel`, `impactColor`, `impactLabel` ヘルパー関数
- `statuses` state（モックEAのためだけのもの）
- `handleStart`, `handleStop`（モックEAのためだけのもの）
- `totalRecommended`, `totalNotRec`, `selectorList`, `allLossPatterns` 変数
- AI EA セレクターセクション（全モックデータ）
- 損失パターン・モック分析セクション（全モックデータ）
- モック・デモバッジ

**追加した機能:**
- `EmptyState` コンポーネント（EA 0件時）
- `loading` state（初期読み込み中表示）
- 統計バーを実DB件数駆動に変更
- `StrategyDraftCard` を唯一のEAカード形式に統一

**維持した機能（壊さなかったもの）:**
- AI EA Builder モーダル（+ EA 追加）
- StrategyDetailModal
- `GET /api/strategies` による実データ取得
- `GET /api/strategies/[id]/backtest` によるバックテスト結果取得
- 起動ボタン: disabled状態維持（Live Trading 未実装）

### 3. ファイル削除/整理

- `mockData.ts` 削除
- `types.ts`: EAProfile, EAPerformance, SessionPerformance, LossPattern, AIRecommendationData, AIRecommendation の不要型を削除（EAStatus, StrategyType のみ残す）

## Files Added

なし

## Files Changed

- `src/presentation/components/ea/EACommandCenter.tsx`（完全リライト）
- `src/presentation/components/ea/types.ts`（不要型削除）

## Files Deleted

- `src/presentation/components/ea/mockData.ts`

## Database Changes

`strategy_registry` 全11件削除（関連テーブル CASCADE 削除）

## API Changes

なし（既存APIは全て維持）

## Tests

| テスト | 結果 |
|-------|------|
| TypeScript --noEmit | ✅ PASS（エラーなし）|
| Production Build | ✅ PASS（53ページ生成）|
| strategy_registry 0件 | ✅ 確認済み |
| mockData.ts 削除 | ✅ 確認済み |
| EACard コンポーネント削除 | ✅ 確認済み |
| AI EA セレクター削除 | ✅ 確認済み |
| 損失パターン削除 | ✅ 確認済み |
| モック・デモバッジ削除 | ✅ 確認済み |
| EA合計 = DB件数 | ✅ 実装済み |
| Empty State | ✅ 実装済み |
| EA追加CTA → AI EA Builder起動 | ✅ 実装済み |
| Live Trading 起動 disabled | ✅ 維持 |

## Remaining Mock Audit（リポジトリ全体）

| 場所 | 分類 | 説明 |
|------|------|------|
| `optimize/route.ts`: `in_sample_ratio`, `sample_status` 等 | B | IS/OOS（In-Sample/Out-of-Sample）の技術用語 — 変更禁止 |
| `BacktestAnalyzer.ts`, `InterpretationEngine.ts`: `sampleSizeWarning` | B | バックテスト統計指標 — 変更禁止 |
| `market/external/route.ts`: `demoData()` 関数 | C | 外部マーケットデータAPI不応答時のフォールバック。Marketsページの価格表示に使用。レスポンスのsourceフィールドが"demo"のため、UIで明示可能。EA Command Centerとは無関係。 |
| テストファイル内の mock | B | テストコードとして正当 |

**Category C の対応:** `market/external/route.ts` の demoData は Markets価格取得のフォールバック。将来的に実外部APIへの移行またはフォールバック時の「データ取得不可」表示への変更が望ましい。今回のスコープ外。

## Final Result

EA Command Center が Production UIへ完全移行。
- EA 0件のEmpty Stateが正式実装
- 全表示データがDB駆動
- モックEA（RSI SCALPER等）は画面に一切表示されない
- AI EA BuilderでEA追加 → 即時DB反映・カード表示が正常動作

## Next Stage

STAGE 3-A: 研究パイプライン自動連鎖
