# RESEARCH ENGINE
**Status:** IMPLEMENTED — 7エンジン全て実装済み  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/infrastructure/backtest/`  
**Related Components:** API Routes /api/strategies/[id]/*, StrategyDetailModal

---

## 概要

Research Engineは `src/infrastructure/backtest/` に配置された7つのTypeScriptエンジン群。  
各エンジンは独立して動作し、APIルート経由で呼び出される。

---

## 1. BacktestEngine.ts

**役割:** OHLC バーデータ + Strategy Spec → 取引シミュレーション → 統計

### 設計原則

```typescript
// 任意シグナルロジックを外部注入可能
interface BacktestInput {
  spec:            StrategySpec;
  symbol:          string;
  mainTimeframe:   string;
  barsByTimeframe: Record<string, Bar[]>;
  _evaluatorOverride?: (ctx: EvaluationContext) => SignalResult;  // Research用
  overrideSpreadPips?:    number;  // コスト診断用
  overrideSlippagePips?:  number;
}
```

### confirmed-bar 安全

```typescript
// look-ahead防止: 評価時点で確定済みのバーのみ使用
function getLastConfirmedBarIndex(
  bars: Bar[],
  timeframe: string,
  evaluationTime: number  // UTCミリ秒
): number
```

### 重要制約

- **単一シンボル設計**: `spec.symbols.length !== 1` は例外
- **コスト込み**: `spreadConfig.ts` から spread + slippage を自動取得
- **速度**: 5,000本 ≈ 14ms（Jest で計測済み）

---

## 2. BacktestService.ts

**役割:** API Route と BacktestEngine の橋渡し

```
1. Supabase から Strategy Spec を取得
2. bar_data テーブルから全TFのOHLCを取得
3. BacktestEngine を呼び出す
4. BacktestReporter で統計計算
5. backtest_jobs / results / trades に保存
6. strategy_registry.backtest_status を更新
```

### IS/OOS分割

```typescript
// デフォルト: 70% IS / 30% OOS
// cutoffTime = 全データの70%地点（Unix ms）
// OOS期間のバーのみでも別途統計を計算
```

---

## 3. BacktestReporter.ts

**役割:** 取引リスト → 統計計算 → Verdict判定

### 計算指標

```typescript
interface BacktestReport {
  totalTrades:          number;
  wins:                 number;
  losses:               number;
  breakevens:           number;
  winRate:              number;     // %
  totalPips:            number;
  avgPips:              number;
  grossProfit:          number;     // pips
  grossLoss:            number;     // pips
  profitFactor:         number | null;
  maxDrawdown:          number;     // 金額
  maxDrawdownPct:       number;     // %
  maxDrawdownPips:      number;
  maxConsecutiveWins:   number;
  maxConsecutiveLosses: number;
  avgDurationMin:       number;
  sessionStats:         Record<string, SessionStat>;
  bestSession:          string | null;
  worstSession:         string | null;
  sampleSizeWarning:    boolean;    // N < minRecommendedTrades(30)
  verdict:              "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:        string;
}
```

### Verdict判定ロジック

```typescript
// PASSED: N >= 30 AND PF >= 1.0 AND totalPips > 0
// CONDITIONAL: N < 30 OR (PF >= 1 だが注意点あり)
// FAILED: PF < 1.0 OR N が著しく不足
```

---

## 4. BacktestAnalyzer.ts

**役割:** バックテスト結果 → AI分析用コンテキスト構築

```typescript
// AI分析に渡す情報を整理する
function buildAnalysisContext(
  report: BacktestReport,
  trades: TradeForAnalysis[],
  spec:   StrategySpec
): AnalysisContext

// システムプロンプトとユーザープロンプトを生成
function buildAnalysisPrompt(ctx: AnalysisContext): {
  systemPrompt: string;
  userPrompt:   string;
}

// OpenAIレスポンスをパース
function parseAnalysisResponse(rawText: string): { ok: boolean; analysis?: ... }

// Fact検証（Backtestデータと矛盾する事実を除去）
function validateFactIntegrity(
  facts:   AnalysisFact[],
  context: AnalysisContext
): { violations: string[]; cleanFacts: AnalysisFact[] }
```

---

## 5. OptimizationEngine.ts

**役割:** パラメーター範囲 → グリッドサーチ → IS/OOS安定性評価

```typescript
interface ParameterRange {
  name:   string;    // "atrPeriod", "slMultiplier" etc.
  min:    number;
  max:    number;
  step:   number;
}

interface OptimizationResult {
  parameters:      Record<string, number>;
  isBars:          number;
  oosBars:         number;
  isPF:            number;     // In-Sample Profit Factor
  oosPF:           number;     // Out-of-Sample Profit Factor
  stabilityScore:  number;     // 0〜1 (近傍パラメーターとの差分から計算)
  sampleStatus:    "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
}
```

### Stable Zone検出

```
隣接パラメーター値でも同様のOOS PFを持つ範囲 = Stable Zone
単一のベストパラメーターより、Stable Zoneを優先する
```

---

## 6. WalkForwardEngine.ts

**役割:** 時系列を複数ウィンドウに分割し、IS最適化→OOSテストを繰り返す

```
データ全体:
[──IS──|──OOS──][──IS──|──OOS──][──IS──|──OOS──]
  window1         window2         window3

各ウィンドウ:
  IS期間: パラメーター最適化
  OOS期間: 最適パラメーターでテスト
```

**意義:** 「このパラメーターは偶然ではなく、様々な期間で機能するか」を検証

---

## 7. MonteCarloEngine.ts

**役割:** 取引結果のランダムリサンプリング → 確率分布推定

```
実際の取引結果リスト:
  [+10p, -5p, +8p, -3p, +12p, ...]

Nイテレーション（例: 10,000回）:
  各回: 同数の取引をランダムに並び替えて累積損益を計算

出力:
  Final Balance の95%信頼区間
  Ruin Probability（資金破綻確率）
  Expected Value
```

**意義:** 取引順序の「運」の影響を排除し、戦略の真の期待値分布を推定

---

## 8. InterpretationEngine.ts

**役割:** 全研究フェーズの結果を統合してOpenAIで最終解釈

```
入力:
  - Backtest結果
  - AI Analysis
  - Optimization結果
  - Walk Forward結果
  - Monte Carlo結果

処理:
  → InterpretationEngine でコンテキスト構築
  → OpenAI に4フェーズ横断の最終解釈を依頼

出力（4フェーズ）:
  BACKTEST_ANALYSIS: バックテスト評価
  OPTIMIZATION: 最適化安定性評価
  WALK_FORWARD: 時系列ロバスト性評価
  MONTE_CARLO: 確率的期待値評価
```

---

## Research Scripts（Phase 5〜8）

`scripts/` ディレクトリの手動実行スクリプト群。  
これらは `BacktestEngine._evaluatorOverride` を使ってResearch専用ロジックを注入する。

```bash
# 実行方法
npx tsx --env-file=.env.local scripts/phase7b_candidate_confirmation.ts
```

| Script | 内容 | 結論 |
|--------|------|------|
| phase5f_anatomy.ts | MFE/MAE解剖 | WEAK |
| phase6a_screening.ts | 3仮説比較 | ALL REJECTED |
| phase6f_directional_audit.ts | LONG vs SHORT | TEMPORARY_REGIME_EFFECT |
| phase6g_regime_confirmation.ts | Regime仮説確認 | NO_EDGE |
| phase7a_price_structure_edge.ts | 6 OHLC families | S6 STRONG_CANDIDATEだが市場バイアス |
| phase7b_candidate_confirmation.ts | Vol-matched確認 | BOTH FAILED |
| phase8a_cross_asset_audit.ts | Cross-Assetデータ監査 | INSUFFICIENT |

---

## indicators.ts

```typescript
interface PrecomputedIndicators {
  ema1: (number | undefined)[];   // デフォルト period=21
  ema2: (number | undefined)[];   // デフォルト period=200
  atr:  (number | undefined)[];   // デフォルト period=14
}

function precomputeIndicators(
  bars:   Bar[],
  params?: { ema1Period?: number; ema2Period?: number; atrPeriod?: number }
): PrecomputedIndicators
```

---

## timeframe.ts

```typescript
// UTC境界に整列したconfirmed barのインデックスを返す
function getLastConfirmedBarIndex(
  bars:            Bar[],
  timeframe:       string,
  evaluationTime:  number  // UTC ms
): number

const TF_MS: Record<string, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000, W1: 604_800_000,
};
```

---

## spreadConfig.ts

```typescript
interface SymbolConfig {
  spreadPips:   number;
  slippagePips: number;
}

function getSymbolConfig(symbol: string): SymbolConfig
// EURUSD: { spreadPips: 1.5, slippagePips: 0.3 }
```
