# STAGE 1 STEP 04 — UI 日本語表記統一
**Date:** 2026-08-22
**Stage:** STAGE 1 Step 04（UI/UX整備）
**Author:** 田中慶樹
**Status:** COMPLETED

## Objective

ユーザーに表示されるUI全体の英語固定ラベルを日本語に統一する。
機能・ロジック・API・DB・BacktestEngineは一切変更しない。

## Starting State

- `src/lib/ui-labels.ts` に基本ラベルマップ（VERDICT, STRATEGY_TYPE, SESSION, TAB, PHASE等）が存在
- `StrategyDetailModal.tsx` の OVERVIEW タブのみ部分的に日本語化済み
- 残りのコンポーネントは英語固定文字列が多数残存

## Implementation

### 日本語化の基本方針

1. **内部値は変更しない**: `PASSED`, `FAILED`, `BUY`, `SELL`, `DRAFT` 等のDB/API値はそのまま維持
2. **表示層のみ変換**: `labelOf(MAP, key)` ヘルパーまたは直接日本語文字列で変換
3. **共通ラベルは `ui-labels.ts` で集中管理**: 各コンポーネントでのハードコード禁止
4. **金融・技術用語はそのまま**: EMA, RSI, ATR, PIPS, PF, H1, H4 等

### ui-labels.ts 追加ラベル

| マップ名 | 用途 |
|---------|------|
| `DATA_STATUS_LABELS` | データステータス（live/stale/ind_only/no_data）|
| `CONNECTION_LABELS` | 接続ステータス（connected/disconnected等） |
| `ANALYSIS_SECTION_LABELS` | AI分析セクション（FACTS/OBSERVATIONS等） |
| `BACKTEST_ACTION_LABELS` | バックテスト実行ボタン状態 |
| `NAV_LABELS` | ナビゲーションラベル |

### 変更ファイル一覧と主な変更点

#### `src/presentation/components/ea/AIEABuilder.tsx`
- `BACKTEST RESULT` → `バックテスト結果`
- `TOTAL PIPS` → `合計 PIPS`
- `TRADES` / `WINS` / `LOSSES` → `取引数` / `勝ち` / `負け`
- `WIN RATE` → `勝率`
- `MAX DD` → `最大DD`
- `AVG PIPS` → `平均PIPS`
- `RISK` → `リスク`
- `SESSION` → `セッション別`
- `RESULT` (step badge) → `結果`
- verdictLabel(): PASSED→合格, CONDITIONAL→条件付, FAILED→不合格

#### `src/presentation/components/ea/EACommandCenter.tsx`
- `BACKTEST` (ラベル) → `バックテスト`
- `TOTAL PIPS` → `合計 PIPS`
- `WIN RATE` → `勝率`
- `MAX DD` → `最大DD`
- `NOT TESTED` → `未検証`
- `LIVE PERFORMANCE` → `ライブ運用成績`
- `NO LIVE TRADES YET` → `まだライブ取引はありません`
- `MY STRATEGIES` → `マイ戦略`
- Verdict表示: PASSED→合格, CONDITIONAL→条件付, それ以外→不合格

#### `src/presentation/components/ea/StrategyDetailModal.tsx`
- 一部日本語化済みの継続 + 残存英語ラベルを修正
- Cross-Phase セクションのラベル（CONVERGENCE等）を日本語化
- Walk Forward → ウォークフォワード
- Monte Carlo → モンテカルロ
- STABLE ZONE → 安定ゾーン
- PHASE OBSERVATIONS → フェーズ別観察
- AI分析セクション各ヘッダー日本語化

#### `src/presentation/components/layout/Sidebar.tsx`
- MARKETS → マーケット
- CHART → チャート
- CALENDAR → カレンダー
- NEWS → ニュース
- POSITIONS → ポジション
- HISTORY → 取引履歴
- DATA → データ
- SYS LOGS → ログ
- SETTINGS → 設定

#### `src/presentation/components/layout/Header.tsx`
- 英語固定文字列を日本語化（接続状態など）

#### `src/presentation/components/os/AIBrainCommandCenter.tsx`
- AI BRAIN ダッシュボードの英語ラベル日本語化
- 各スキャン・判断項目のラベル

#### `src/presentation/components/os/AIBrainPanel.tsx`
- AI Brain パネルの状態表示・説明文日本語化

#### `src/presentation/components/positions/PositionsView.tsx`
- ポジション一覧の列ヘッダー等

#### `src/presentation/components/history/HistoryView.tsx`
- 取引履歴画面のラベル

#### `src/presentation/components/logs/LogsView.tsx`
- ログ画面のフィルター・ラベル

### 意図的に英語のまま維持した用語

| 用語 | 理由 |
|------|------|
| EURUSD, USDJPY 等 | 通貨ペア（国際標準） |
| H1, H4, M5 等 | 時間足（国際標準） |
| EMA, RSI, ATR, ADX | インジケーター略称 |
| PIPS, PF, RR | 業界標準略語 |
| MT5, EA, Gateway | 固有製品名・技術用語 |
| DRY RUN | テクニカルモードのバッジ（開発者向け） |
| HEALTHY/WARNING/CRITICAL（MarketDataCoverage） | 技術的診断ラベル |

## Files Added

なし

## Files Changed

- `src/lib/ui-labels.ts`（5マップ追加）
- `src/presentation/components/ea/AIEABuilder.tsx`
- `src/presentation/components/ea/EACommandCenter.tsx`
- `src/presentation/components/ea/StrategyDetailModal.tsx`
- `src/presentation/components/layout/Sidebar.tsx`
- `src/presentation/components/layout/Header.tsx`
- `src/presentation/components/os/AIBrainCommandCenter.tsx`
- `src/presentation/components/os/AIBrainPanel.tsx`
- `src/presentation/components/positions/PositionsView.tsx`
- `src/presentation/components/history/HistoryView.tsx`
- `src/presentation/components/logs/LogsView.tsx`

## Database Changes

なし（内部値は変更していない）

## API Changes

なし

## Tests

- TypeScript: エラーなし
- Build: 成功（全53ページ生成）
- 内部enum値（PASSED/FAILED/BUY/SELL等）の変更なし確認済み

## Final Result

AVL-FXのユーザー向けUIが日本語中心の一貫した表示に統一された。

## Next Stage

STAGE 3-A: 研究パイプライン自動連鎖
