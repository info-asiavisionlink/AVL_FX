# BACKEND
**Status:** IMPLEMENTED — 全API Routes実装済み  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/app/api/`

---

## 技術スタック

| 項目 | 内容 |
|-----|------|
| Framework | Next.js 15 API Routes (App Router) |
| Runtime | Node.js（Edge Runtimeは未使用） |
| AI | OpenAI API（json_objectモード） |
| DB | Supabase Admin Client（service_role） |
| バリデーション | Zod |

---

## API Routes 一覧

### AI Builder

```
POST /api/ai/strategy/build
  入力: { prompt: string }  (10〜2000文字)
  処理: OpenAI → Strategy Spec JSON → Zodバリデーション
  出力: { success: boolean, spec: StrategySpec }
  モデル: OPENAI_MODEL_STRATEGY env var (デフォルト: GPT-4系)
```

### Strategy CRUD

```
GET  /api/strategies
  出力: { strategies: StrategyRecord[] }  (降順)

POST /api/strategies
  入力: { spec: StrategySpec, raw_prompt?: string }
  処理: Zodバリデーション → magic_number自動採番 → DB INSERT
  出力: { strategy: StrategyRecord }  (201)
  初期値: status="DRAFT", backtest_status="NOT_TESTED", enabled=false

GET  /api/strategies/[id]
  出力: strategy_registry 単体

PUT  /api/strategies/[id]
  入力: 更新フィールド
  出力: 更新後レコード

DELETE /api/strategies/[id]
  出力: 204
```

### Backtest

```
GET  /api/strategies/[id]/backtest
  処理: getLatestBacktest(strategyId)
  出力: 最新バックテスト結果 or NOT_TESTED

POST /api/strategies/[id]/backtest
  入力: { periodLabel?: string }
  処理:
    1. bar_data から OHLC 取得
    2. BacktestEngine 実行
    3. BacktestReporter で統計計算
    4. backtest_jobs / results / trades INSERT
    5. strategy_registry.backtest_status 更新
  出力: { jobId, result: BacktestReport }

GET  /api/backtest/job/[id]
  出力: backtest_jobs の status（ポーリング用）
```

### AI Analysis

```
GET  /api/strategies/[id]/analyze
  出力: { status: "HAS_ANALYSIS" | "NOT_ANALYZED", analysis? }

POST /api/strategies/[id]/analyze
  入力: { jobId?: string }  (省略時: 最新COMPLETED job)
  処理:
    1. Strategy + Backtest結果 + 個別取引を取得
    2. BacktestAnalyzer でコンテキスト構築
    3. OpenAI (json_objectモード) 呼び出し
    4. Fact Integrity チェック
    5. strategy_ai_analyses INSERT
  出力: { analysisId, analysis }
```

### AI Improvement Proposal

```
GET  /api/strategies/[id]/improve
  出力: 最新改善提案

POST /api/strategies/[id]/improve
  処理: AI分析 + Strategy Specから改善案を生成
  出力: 改善後Strategy Spec
```

### Strategy Versions

```
GET  /api/strategies/[id]/versions
  出力: strategy_versions 一覧

GET  /api/strategies/[id]/versions/[version]
  出力: 特定バージョン

POST /api/strategies/[id]/versions
  入力: { changeNote?: string }
  処理: 現在のSpecをバージョンとして保存

POST /api/strategies/[id]/versions/[version]/restore
  処理: 指定バージョンのSpecを現在のStrategyに上書き
```

### Parameter Optimization

```
GET  /api/strategies/[id]/optimize
  出力: 最新最適化ジョブ

POST /api/strategies/[id]/optimize
  入力: { parameterRanges: ParameterRange[] }
  処理:
    1. GridSearch 全組み合わせ
    2. 各パラメーターでBacktest（IS/OOS）
    3. StabilityScore計算
    4. Stable Zone検出
    5. optimization_jobs / candidates INSERT
  出力: { jobId, summary }

GET  /api/strategies/[id]/optimize/[jobId]
  出力: 最適化ジョブ詳細（全候補含む）

POST /api/strategies/[id]/optimize/[jobId]/apply
  処理: 最適パラメーターを strategy_registry に適用
```

### Walk Forward Validation

```
GET  /api/strategies/[id]/walk-forward
  出力: 最新WFジョブ

POST /api/strategies/[id]/walk-forward
  入力: { parameterRanges, walkForwardConfig }
  処理: WalkForwardEngine（IS最適化→OOSテスト×N回）
  出力: { jobId, windows, summary }

GET  /api/strategies/[id]/walk-forward/[jobId]
  出力: WFジョブ詳細
```

### Monte Carlo Simulation

```
GET  /api/strategies/[id]/monte-carlo
  出力: 最新MCシミュレーション

POST /api/strategies/[id]/monte-carlo
  入力: { iterations: number }
  処理: MonteCarloEngine（N回リサンプリング）
  出力: { ruin_probability, ci95_lo, ci95_hi, ... }
```

### Cross-Phase Interpretation

```
GET  /api/strategies/[id]/interpret
  出力: 最新Cross-Phase解釈

POST /api/strategies/[id]/interpret
  処理:
    1. 全研究フェーズ結果を収集
    2. InterpretationEngine でコンテキスト構築
    3. OpenAI で4フェーズ統合解釈
    4. strategy_phase4d_interpretations INSERT
  出力: { interpretation }
```

### Market Data

```
GET  /api/market-data/status
  処理: get_bar_data_status() RPC呼び出し
  出力: シンボル×TF別の統計

GET  /api/market-data/health
  出力: データ健全性チェック結果

GET  /api/market-data/gaps
  出力: bar_data のギャップ検出

POST /api/market-data/history-sync
  処理: market_data_sync_jobs に BACKFILL job を INSERT
  → EA の DataSync が自動実行
```

### MT5 Data Proxy

```
GET  /api/mt5/bars/:sym/:tf     → Gateway から bar_data を取得
GET  /api/mt5/tick/:sym         → Gateway から最新 Tick を取得
GET  /api/mt5/live              → Gateway 接続状態
GET  /api/mt5/positions         → 現在のポジション一覧
GET  /api/mt5/indicators/:sym   → インジケーター値
```

---

## セキュリティ

### AI Builder のセキュリティ

```typescript
// systemPromptに明示:
// ABSOLUTE PROHIBITIONS
// - DO NOT include: javascript, typescript, mql5, python, code, function, eval, exec
// - DO NOT include: file paths, URLs, API keys, environment variables

// Zodホワイトリスト方式
// ALLOWED_INDICATORS, ALLOWED_TIMEFRAMES, ALLOWED_SYMBOLS, ALLOWED_OPERATORS
// これら以外の値は全てZodで拒否
```

### Supabase RLS

```
API Routes: createAdminClient() (service_role) 使用
→ RLS をバイパスして全テーブルアクセス可能

ブラウザ: createClient() (anon key) 使用
→ RLSルールに従った読み取りのみ
```

---

## 未実装のAPI

| エンドポイント | 説明 | 優先度 |
|--------------|------|--------|
| `POST /api/strategies/[id]/research-pipeline` | 全ステップ自動連鎖 | P0 |
| `POST /api/strategies/[id]/generate-ea` | MQL5 EA生成 | P0 |
| `POST /api/strategies/[id]/deploy-mt5` | MT5デプロイ | P0 |
