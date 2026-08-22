# STRATEGY DETAIL MODAL
**Status:** PRODUCTION_READY — 6タブ全実装済み  
**Last Updated:** 2026-08-22 (全UI日本語化 + ui-labels.ts導入)  
**Source of Truth:** `src/presentation/components/ea/StrategyDetailModal.tsx`（3489行）

> **Note:** 全英語ラベルは `src/lib/ui-labels.ts` で日本語化済み。  
> DB/API内部値（PASSED, BUY, TOKYO等）は変更なし。UI表示層のみ変換。

---

## 6タブ構成

```typescript
type Tab = "OVERVIEW" | "BACKTEST" | "TRADES" | "ANALYSIS" | "VERSIONS" | "OPTIMIZE";
```

---

## Tab 1: OVERVIEW

**状態:** `PRODUCTION_READY`

```
表示内容（全て実DB データ）:
  BASIC INFO:
    - SYMBOL, TIMEFRAME, TYPE, RISK %
  
  ENTRY CONDITIONS:
    - Logic (AND/OR)
    - 条件リスト（indicator, timeframe, period, operator）
  
  FILTERS:
    - MAX SPREAD, SESSION, TREND FILTER, ADX
  
  EXIT CONDITIONS:
    - STOP LOSS (method, multiplier/pips)
    - TAKE PROFIT (method, multiplier/rr_ratio)
  
  STATUS:
    - strategy_registry.status, backtest_status
    - magic_number, created_at
```

---

## Tab 2: BACKTEST

**状態:** `PRODUCTION_READY`

```
[バックテスト実行] ボタン:
  → POST /api/strategies/[id]/backtest
  → polling: GET /api/backtest/job/:id
  → COMPLETED後に結果表示

結果表示:
  VERDICT バッジ（PASSED/CONDITIONAL/FAILED）
  
  統計グリッド:
    Total Trades / Win Rate / Profit Factor
    Total Pips / Avg Pips / Max Drawdown
    Avg Duration
  
  IS / OOS セクション:
    In-Sample bars count
    Out-of-Sample bars count
    OOS PF（もしあれば）
  
  セッション別統計:
    TOKYO / LONDON / NEW_YORK
    各: WR, PF, 取引数
  
  エクイティカーブ:
    lightweight-charts（ラインチャート）
    累積PnL推移

サンプル不足警告:
  N < 30 の場合に表示
```

---

## Tab 3: TRADES

**状態:** `PRODUCTION_READY`

```
backtest_trades テーブルから全取引履歴を表示

カラム:
  #, 方向（BUY/SELL）
  エントリー時刻, エグジット時刻
  エントリー価格, エグジット価格
  PIPS, 結果（WIN/LOSS/BREAKEVEN）
  理由（TP/SL）, セッション
  duration（分）

フィルター: 現状なし（全件表示）
```

---

## Tab 4: ANALYSIS

**状態:** `PRODUCTION_READY`

### AI Analysis セクション

```
[AI分析実行] ボタン → POST /api/strategies/[id]/analyze

結果表示:
  SUMMARY: 総括コメント
  
  FACTS（確認された事実）:
    Backtestデータで検証済み。矛盾はFact Integrity Checkで除去済み。
  
  OBSERVATIONS（観察）
  HYPOTHESES（仮説）
  WEAKNESSES（弱点）
  STRENGTHS（強み）
  SESSION ANALYSIS（セッション別コメント）
  RISK ANALYSIS（リスク分析）
  RECOMMENDATIONS（推奨）
  Confidence Level
```

### AI Improvement セクション

```
[AI改善提案] ボタン → POST /api/strategies/[id]/improve

提案された改善内容:
  - 変更したEntry Conditions
  - 変更理由
  - 改善後のパラメーター

[この改善を適用] → VERSIONSタブに保存
```

### Cross-Phase Interpretation セクション

```
[Cross-Phase解釈実行] → POST /api/strategies/[id]/interpret

4フェーズ横断表示:
  BACKTEST_ANALYSIS: バックテスト評価コメント
  OPTIMIZATION:     最適化安定性コメント
  WALK_FORWARD:     時系列ロバスト性コメント
  MONTE_CARLO:      確率的期待値コメント
```

---

## Tab 5: VERSIONS

**状態:** `PRODUCTION_READY`

```
バージョン一覧（strategy_versionsから）:

  V3 2026-08-20  [現在]
    変更内容: RSI期間を14から10に変更
    [このバージョンに戻す]
  
  V2 2026-08-18
    変更内容: SL倍率を2から3に変更
    [詳細比較] [このバージョンに戻す]
  
  V1 2026-08-15  [初期バージョン]
    raw_prompt: 「EURUSDのH1でRSI反転...」

VersionComparator:
  Spec間の差分を視覚的に表示
  どのフィールドが変わったかハイライト
```

---

## Tab 6: OPTIMIZE

**状態:** `PRODUCTION_READY`

```
3つのサブセクション:

[1] Parameter Optimization
  パラメーター範囲入力（min/max/step）
  [最適化実行] → POST /api/strategies/[id]/optimize
  
  結果:
    IS/OOS PF テーブル（全候補）
    Stability Score
    Stable Zone ハイライト
    [この設定を適用] → 最良パラメーター適用

[2] Walk Forward Validation
  ウィンドウ設定（IS/OOS比率等）
  [Walk Forward実行] → POST /api/strategies/[id]/walk-forward
  
  結果:
    各ウィンドウ: IS期間, OOS期間, IS PF, OOS PF, sampleStatus
    OOS PF 分布チャート
    全体サマリー

[3] Monte Carlo Simulation
  イテレーション数入力（default: 10000）
  シード値（optional）
  [Monte Carlo実行] → POST /api/strategies/[id]/monte-carlo
  
  結果:
    Ruin Probability
    95%信頼区間（CI95 Lo/Hi）
    期待収益分布チャート
    最悪ケース / 最良ケース
```

---

## 未実装のタブ

```
LIVE タブ（未実装）:
  - リアルタイムポジション
  - 実績 vs バックテスト比較
  - 緊急停止ボタン
  → STAGE 5で実装予定
```
