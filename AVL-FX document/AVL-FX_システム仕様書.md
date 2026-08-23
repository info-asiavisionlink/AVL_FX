# AVL-FX システム仕様書
**最終更新: 2026-08-22**
**バージョン: Phase 8-A完了時点**

---

## 目次

1. [システム概要](#1-システム概要)
2. [全体アーキテクチャ](#2-全体アーキテクチャ)
3. [現在できること（実装済み機能）](#3-現在できること実装済み機能)
4. [現在できないこと（未実装）](#4-現在できないこと未実装)
5. [Market Data Layer（データ収集）](#5-market-data-layerデータ収集)
6. [Strategy / EA Research Layer（戦略研究）](#6-strategy--ea-research-layer戦略研究)
7. [Web UI 詳細](#7-web-ui-詳細)
8. [API エンドポイント一覧](#8-api-エンドポイント一覧)
9. [データベース構成](#9-データベース構成)
10. [対応シンボル](#10-対応シンボル)
11. [研究フェーズ実績（Phase 5〜8）](#11-研究フェーズ実績phase-58)
12. [技術スタック](#12-技術スタック)
13. [環境変数](#13-環境変数)
14. [既知の制約・注意事項](#14-既知の制約注意事項)
15. [ロードマップ（次に実装すべきもの）](#15-ロードマップ次に実装すべきもの)

---

## 1. システム概要

AVL-FX（AVL AI FX Trading OS）は、MetaTrader 5（MT5）と連携する **AI支援型FXトレーディング研究プラットフォーム**。

### 主な役割

| レイヤー | 役割 |
|---------|------|
| **Market Data Layer** | MT5から市場データを収集・蓄積する |
| **Strategy Research Layer** | 自然言語から戦略を設計し、バックテスト・AI分析・最適化・ウォークフォワード・モンテカルロを実行する |
| **Web UI** | 上記を統合したダッシュボードUI |

### 一言で言うと

> 「自然言語で戦略を記述 → AI がStrategy Specに変換 → バックテストから統計検証・AI分析・パラメーター最適化まで一貫して実行できる研究OS」

### 現在のフェーズ

- **完成している部分**: データ収集〜バックテスト〜AI分析〜最適化〜Walk Forward〜Monte Carlo〜Cross-Phase Interpretation までの研究パイプライン全体
- **未完成の部分**: 研究結果からMQL5 EAを自動生成し、MT5へデプロイする部分

---

## 2. 全体アーキテクチャ

```
【MT5 側】
┌─────────────────────────────────────────────────────┐
│  AVL_DataManager_v2.mq5 (Data Manager EA)          │
│  - Tick Stream / OHLC Stream / Market Watch        │
│  - Indicators / Orders / Account / History         │
│  - History Sync / DataSync (過去データ一括取得)       │
│                                                     │
│  AVL_FX_Bridge.mq5 (UI接続専用)                    │
└───────────────────────┬─────────────────────────────┘
                        │ HTTP POST (WebSocket)
                        ↓
【Gateway】
┌─────────────────────────────────────────────────────┐
│  gateway/src/index.ts (Express + WebSocket)        │
│  - barDataStore.ts: Supabase bar_data UPSERT       │
│  - syncJobStore.ts: DataSync Job管理               │
└───────────────────────┬─────────────────────────────┘
                        │
                        ↓
【Supabase (PostgreSQL + RLS)】
┌─────────────────────────────────────────────────────┐
│  bar_data                    ← 市場データ OHLC      │
│  strategy_registry           ← Strategy定義        │
│  strategy_versions           ← Version履歴         │
│  backtest_jobs               ← バックテストJOB      │
│  backtest_results            ← バックテスト統計     │
│  backtest_trades             ← 個別取引履歴         │
│  strategy_ai_analyses        ← AI分析結果          │
│  strategy_improvements       ← AI改善提案          │
│  optimization_jobs/candidates ← 最適化結果         │
│  walk_forward_jobs           ← WF結果              │
│  monte_carlo_results         ← MC結果              │
│  strategy_phase4d_interpretations ← AI総合解釈     │
│  market_data_sync_jobs       ← DataSync管理        │
└───────────────────────┬─────────────────────────────┘
                        │
                        ↓
【Next.js Web App】
┌─────────────────────────────────────────────────────┐
│  /src/app/api/*          ← API Routes              │
│  /src/infrastructure/*   ← Research Engines        │
│  /src/presentation/*     ← UI Components           │
└─────────────────────────────────────────────────────┘
```

---

## 3. 現在できること（実装済み機能）

### 3-1. 市場データ収集

| 機能 | 状態 | 詳細 |
|-----|------|------|
| リアルタイムTick受信 | ✅ 実装済み | MT5 → Gateway → WebSocket配信 |
| OHLCバー受信（8時間足） | ✅ 実装済み | M1/M5/M15/M30/H1/H4/D1/W1 |
| 過去データ一括取得 (History Sync) | ✅ 実装済み | 最大60ヶ月、チャンク分割送信 |
| インクリメンタル同期 (DataSync) | ✅ 実装済み | FORWARD/BACKFILL、任意シンボル対応 |
| Supabase永続化 | ✅ 実装済み | bar_data テーブル、UTC タイムスタンプ |
| Market Watchデータ | ✅ 実装済み | 全MW symbolのbid/ask/spread |
| ポジション・注文・口座情報 | ✅ 実装済み | リアルタイム配信 |
| インジケーター配信 | ✅ 実装済み | EMA21/200, SMA50, ATR, RSI, MACD, ADX, BB |

**現在DBに蓄積されているEURUSD H1データ:**
- 期間: 2025-01-08 〜 2026-08-21
- 本数: 10,067本（約590日分）
- H4: 2020-03-18 〜 2026-08-21（2,347日分、10,016本）

---

### 3-2. AI EA Builder（戦略設計）

**フロー:**
```
自然言語入力（日本語/英語）
↓
POST /api/ai/strategy/build（OpenAI）
↓
StrategySpec JSON生成（Zodバリデーション）
↓
PREVIEWステップ（確認画面）
↓
POST /api/strategies（DB保存）
↓
strategy_registry に DRAFT として登録
```

**生成されるStrategy Spec の内容:**

```json
{
  "name": "RSI Reversal EURUSD",
  "strategy_type": "DAY_TRADE",
  "symbols": ["EURUSD"],
  "timeframes": ["H1"],
  "entry_conditions": {
    "logic": "AND",
    "conditions": [
      { "indicator": "EMA", "timeframe": "H1", "period": 21, "operator": "PRICE_ABOVE" },
      { "indicator": "RSI", "timeframe": "H1", "period": 14, "operator": "CROSS_UP", "threshold": 30 }
    ]
  },
  "exit_conditions": {
    "stop_loss":   { "method": "ATR", "period": 14, "multiplier": 2.0 },
    "take_profit": { "method": "ATR", "period": 14, "multiplier": 3.0 }
  },
  "filters": {
    "sessions": ["LONDON", "NEW_YORK"],
    "max_spread_pips": 2
  },
  "risk": { "risk_per_trade": 1.0 }
}
```

**ホワイトリスト（AIが使用できる値）:**

| 種類 | 許可値 |
|-----|--------|
| Indicators | RSI, EMA, SMA, MACD, ADX, ATR, BOLLINGER_BANDS, STOCHASTIC, PRICE_ACTION, MARKET_STRUCTURE, SUPPORT_RESISTANCE |
| Timeframes | M1, M5, M15, M30, H1, H4, D1, W1 |
| Strategy Types | SCALPING, DAY_TRADE, SWING |
| Sessions | TOKYO, LONDON, NEW_YORK, SYDNEY |
| SL Methods | ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE |
| TP Methods | ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE |

---

### 3-3. バックテスト（Backtest Engine）

**実行経路:**
```
POST /api/strategies/[id]/backtest
↓
BacktestService → bar_dataからOHLC取得
↓
BacktestEngine（evaluatorOverride対応）
↓
BacktestReporter（統計計算）
↓
backtest_jobs / backtest_results / backtest_trades に保存
```

**計算される統計:**

| 指標 | 内容 |
|-----|------|
| Total Trades | 総取引数 |
| Win Rate | 勝率 (%) |
| Profit Factor | 利益率 (粗利 / 粗損) |
| Total Pips | 総損益 (pips) |
| Avg Pips / Trade | 取引あたり平均損益 |
| Max Drawdown | 最大ドローダウン (%, pips, 金額) |
| Max Consecutive Wins/Losses | 最大連勝・連敗 |
| Avg Duration | 平均保有時間 (分) |
| Session Stats | 東京・ロンドン・NY別の統計 |
| Best/Worst Session | 最良・最悪セッション |
| IS / OOS Split | In-Sample / Out-of-Sample 分割 |

**Verdict（判定）:**
- `PASSED`: trades ≥ 30件 かつ PF ≥ 1.0 かつ totalPips > 0
- `CONDITIONAL`: サンプル数不足 or 条件弱め
- `FAILED`: PF < 1.0 または trades不足

**注意:** `PASSED` = Backtest結果がプラスだったというだけ。Walk Forward・Monte Carloを通過した意味ではない。

---

### 3-4. AI Analysis（AI分析）

**実行経路:**
```
POST /api/strategies/[id]/analyze
↓
BacktestAnalyzer（コンテキスト構築）
↓
OpenAI API（json_object mode）
↓
Fact Integrity チェック（Backtestデータと矛盾する事実を除去）
↓
strategy_ai_analyses に保存
```

**AI分析の出力項目:**

| 項目 | 内容 |
|-----|------|
| Summary | 戦略の総括コメント |
| Facts | Backtestデータで確認された事実（矛盾チェック済み） |
| Observations | 観察された傾向 |
| Hypotheses | 仮説（未確認） |
| Weaknesses | 弱点 |
| Strengths | 強み |
| Session Analysis | セッション別コメント |
| Risk Analysis | リスク分析 |
| Recommendations | 推奨アクション |
| Confidence | 分析信頼度 |

---

### 3-5. AI Improvement Proposal（改善提案）

```
POST /api/strategies/[id]/improve
→ strategy_improvements テーブルに改善案保存
→ StrategySpec の改定バージョンを提案
→ ユーザーが承認すればVersion として保存可能
```

---

### 3-6. Strategy Version 管理

```
GET  /api/strategies/[id]/versions    → バージョン一覧
GET  /api/strategies/[id]/versions/[v] → 特定バージョン取得
POST /api/strategies/[id]/versions/[v]/restore → ロールバック
```

- 各バックテスト実行・AI改善後に Version が自動/手動保存
- VersionComparator でバージョン間のSpec差分を視覚表示

---

### 3-7. Parameter Optimization（パラメーター最適化）

```
POST /api/strategies/[id]/optimize
↓
OptimizationEngine（グリッドサーチ）
↓
各候補パラメーターでBacktest実行
↓
IS/OOS分割での安定性評価
↓
Stable Zone検出
↓
optimization_jobs / optimization_candidates に保存
```

**最適化機能:**
- グリッドサーチ（全組み合わせ）
- IS（In-Sample）での最良候補抽出
- OOS（Out-of-Sample）での検証
- 安定ゾーン（Stable Zone）検出: PFが安定する範囲を特定
- Stability Score（0〜1）算出

---

### 3-8. Walk Forward Validation

```
POST /api/strategies/[id]/walk-forward
↓
WalkForwardEngine
↓
時系列を複数ウィンドウに分割
各ウィンドウ: IS最適化 → OOSでテスト
↓
walk_forward_jobs に保存
```

**Walk Forward の意味:**
単一期間のBacktestやOptimizationは過去への過学習（カーブフィッティング）の危険がある。Walk Forwardは複数の時系列ウィンドウで繰り返しIS→OOS検証を行い、「様々な相場環境でも機能するか」を確認する。

**出力:**
- 各ウィンドウのIS/OOS PF
- OOS PFの分布
- 全体的なロバスト性スコア

---

### 3-9. Monte Carlo Simulation

```
POST /api/strategies/[id]/monte-carlo
↓
MonteCarloEngine（N回シミュレーション）
↓
取引結果をランダムリサンプリング
↓
monte_carlo_results に保存
```

**出力:**
- Final Balance の95%信頼区間
- Ruin Probability（資金破綻確率）
- Expected Returns の分布
- 最悪ケース・最良ケース

**意味:** 取引順序の偶然性を排除し、戦略の期待値の分布を統計的に推定する。

---

### 3-10. Cross-Phase AI Interpretation（総合AI解釈）

```
POST /api/strategies/[id]/interpret
↓
InterpretationEngine
↓
Backtest + Optimization + Walk Forward + Monte Carlo の全結果を統合
↓
OpenAI が総合的な判断を出力
↓
strategy_phase4d_interpretations に保存
```

**4つのフェーズを横断した総合判定:**
- BACKTEST_ANALYSIS: バックテスト単体の評価
- OPTIMIZATION: 最適化の安定性評価
- WALK_FORWARD: 時系列ロバスト性評価
- MONTE_CARLO: 統計的期待値評価

---

### 3-11. Strategy Detail UI（6タブ）

| タブ | 内容 | データソース |
|-----|------|-------------|
| OVERVIEW | Strategy Spec全表示（条件、フィルター、EXIT） | strategy_registry（REAL） |
| BACKTEST | バックテスト実行・結果表示・エクイティカーブ | backtest_jobs/results/trades（REAL） |
| TRADES | 個別取引履歴一覧 | backtest_trades（REAL） |
| ANALYSIS | AI分析・改善提案・Cross-Phase解釈 | strategy_ai_analyses等（REAL） |
| VERSIONS | バージョン履歴・比較・ロールバック | strategy_versions（REAL） |
| OPTIMIZE | パラメーター最適化・Walk Forward・Monte Carlo | optimization_jobs等（REAL） |

---

### 3-12. Research Scriptsライブラリ（Phase 5〜7）

直接UIから実行するのではなく、Claude Codeから `npx tsx --env-file=.env.local scripts/XXX.ts` で実行するResearchスクリプト群。

**Phaseごとのスクリプト:**

| Script | 内容 |
|--------|------|
| `phase5f_anatomy.ts` | Trade Anatomy Analysis（MFE/MAE解剖） |
| `phase6a_screening.ts` | 3仮説スクリーニング（Breakout/Momentum/MeanRev） |
| `phase6b_audit.ts` | Execution/Exit Audit（Same-bar SL問題検出） |
| `phase6c_exit_validation.ts` | Exit Model検証（ATR倍率最適化） |
| `phase6d_tf_validation.ts` | 時間足別検証（H1/H4比較） |
| `phase6e_hypothesis_discovery.ts` | 4仮説比較 |
| `phase6f_directional_audit.ts` | 方向性非対称性監査（LONG vs SHORT） |
| `phase6g_regime_confirmation.ts` | Regime仮説確認（DOWN_REGIME × LONG） |
| `phase7a_price_structure_edge.ts` | OHLC価格構造エッジ探索（6シグナルファミリー） |
| `phase7b_candidate_confirmation.ts` | 候補エッジ確認（vol-matched bootstrap） |
| `phase8a_cross_asset_audit.ts` | クロスアセットデータ可用性監査 |

---

## 4. 現在できないこと（未実装）

| 機能 | 状態 | 備考 |
|-----|------|------|
| MQL5コード自動生成 | ❌ 未実装 | Strategy Spec → .mq5ファイル変換 |
| MT5への自動デプロイ | ❌ 未実装 | 生成したEAをMT5に配備する仕組み |
| ライブトレード実行 | ❌ 未実装 | Strategy EAによる実際の発注 |
| 研究パイプライン自動連鎖 | ❌ 未実装 | Backtest→AI分析→最適化の自動順次実行 |
| 最終判定ステータス | ❌ 未実装 | VALIDATED/REJECTED/ROBUST等の高度なstatus |
| Cross-Asset研究 | ❌ データ不足 | DXY連続/US10Y: XMブローカー非対応 |
| EAコマンドセンター上部パネル | ❌ MOCK | 5件の固定MOCKデータ使用中 |
| EA種別分類 | ❌ 未実装 | 「EA対象」vs「関連市場参照」のフラグなし |
| バックテストの自動再実行 | ❌ 未実装 | Spec変更後の自動再テスト |
| リアルタイムシグナル生成 | ❌ 未実装 | Strategy Specからリアルタイムシグナル配信 |

---

## 5. Market Data Layer（データ収集）

### 5-1. AVL_DataManager_v2.mq5

**役割:** MT5から全市場データをGatewayへ送信するData Manager。売買ロジックは一切持たない。

**ストリーム構成:**

```
Stream 1: Tick Stream        — OnTick毎（100msスロットリング）
Stream 2: OHLC Stream        — OnTick毎（全8時間足、確定バー検出）
Stream 3: Market Watch       — OnTimer 3秒毎（全MW symbolのtick）
Stream 4: Indicators         — OnTimer 30秒毎（拡張インジケーター）
Stream 5: Orders/Positions   — OnTimer 5秒毎
Stream 6: Account            — OnTimer 5秒毎
Stream 7: History            — OnTimer 5分毎（過去30日の取引履歴）
Stream 8: Heartbeat          — OnTimer毎
```

**History Sync（過去データ一括）:**
```
InpHistorySyncEnabled = true にすると起動時に実行
InpHistorySyncMonths  = 取得月数（最大60ヶ月）
InpHistorySyncTFs     = 対象TF（例: "H1,H4"）
チャンク単位（28日）で分割送信
```

**DataSync（増分同期）:**
```
Supabaseのmarket_data_sync_jobsテーブルを30秒毎にポーリング
PENDING → RUNNING → COMPLETED/FAILED
任意シンボル・任意TF・FORWARD/BACKFILLモード対応
DataSync_Execute(symbol, tf, ...) — g_Symbolに依存しない
```

### 5-2. Gateway (gateway/src/index.ts)

**役割:** EAからHTTP/WebSocketで受信し、Supabaseに保存・WebSocketでブラウザ配信。

**エンドポイント:**
```
EA → Gateway:
  POST /connect       起動通知
  POST /tick          Tick受信
  POST /bar           単一バー（確定バー）
  POST /bars/bulk     過去バー一括
  POST /positions     ポジション
  POST /account       口座情報
  POST /heartbeat     ハートビート

Browser → Gateway:
  GET /bars/:sym/:tf  過去バー取得
  GET /tick/:sym      最新Tick
  GET /symbols        シンボル一覧
  WS /ws              リアルタイムストリーム
```

**UTC タイムスタンプ保証:**
- MqlRates.timeはUTC秒（ブローカー時刻ではない）
- H4バーが14400秒倍数（UTC境界）に整列していることで検証済み

---

## 6. Strategy / EA Research Layer（戦略研究）

### 6-1. BacktestEngine

**ファイル:** `src/infrastructure/backtest/BacktestEngine.ts`

**特徴:**
- `_evaluatorOverride`: 任意のシグナル評価ロジックを注入可能（Research scripts用）
- 単一シンボル設計（`BacktestService.spec.symbols.length === 1` を要求）
- confirmed-bar安全（look-ahead禁止）: `getLastConfirmedBarIndex()`を使用
- コスト考慮: spread + slippage（`spreadConfig.ts`から取得）
- 5,000本 ≈ 14ms の高速処理

**evaluator.ts のシグナル定義:**

```typescript
type SignalResult = "BUY" | "SELL" | "SKIP";

interface EvaluationContext {
  spec:                   StrategySpec;
  evaluationTime:         number;         // 評価時刻（UTC ms）
  barsByTimeframe:        Record<string, Bar[]>;
  indicatorsByTimeframe:  Record<string, PrecomputedIndicators>;
}
```

### 6-2. indicators.ts

事前計算インジケーター:
```
ema1 (デフォルト21期), ema2 (デフォルト200期)
atr (デフォルト14期)
```

`precomputeIndicators(bars)` でO(N)計算。研究スクリプトでも直接利用可能。

### 6-3. spreadConfig.ts

シンボル別スプレッド・スリッページ設定:
```typescript
getSymbolConfig("EURUSD") → { spreadPips: 1.5, slippagePips: 0.3 }
```

---

## 7. Web UI 詳細

### 7-1. ページ構成

| URL | ページ | 内容 |
|-----|--------|------|
| `/` | Dashboard | 市場概況・価格一覧 |
| `/ea` | EA Command Center | Strategy管理・AI EA Builder |
| `/chart` | Chart | MT5リアルタイムチャート |
| `/ai` | AI Chat | AI市場分析チャット |
| `/calendar` | Calendar | 経済指標カレンダー |
| `/history` | History | 取引履歴 |
| `/logs` | Logs | システムログ |

### 7-2. EA Command Center（/ea）詳細

**上部パネル（現状MOCK）:**
- EA合計・推奨数・警戒数カウンター → `MOCK_EA_PROFILES`（5件固定）
- AIセレクター（EURUSD最適EA表示）→ MOCK
- 損失パターン分析 → MOCK

**下部パネル（DB実データ）:**
- `+ EA追加`ボタン → AI EA Builder モーダル
- strategy_registryから取得したStrategyCardリスト（REAL）
- 各Cardから StrategyDetailModal を開く

### 7-3. Strategy Detail Modal（6タブ）

詳細は [3-11](#3-11-strategy-detail-ui6タブ) 参照。

---

## 8. API エンドポイント一覧

### Strategy CRUD
```
GET  /api/strategies                              一覧取得
POST /api/strategies                              新規作成（AI Builder後に呼ぶ）
GET  /api/strategies/[id]                         単体取得
PUT  /api/strategies/[id]                         更新
DELETE /api/strategies/[id]                       削除
```

### Research Pipeline
```
GET  /api/strategies/[id]/backtest                最新バックテスト結果取得
POST /api/strategies/[id]/backtest                バックテスト実行
GET  /api/strategies/[id]/analyze                 最新AI分析取得
POST /api/strategies/[id]/analyze                 AI分析実行
GET  /api/strategies/[id]/improve                 最新改善提案取得
POST /api/strategies/[id]/improve                 AI改善提案実行
GET  /api/strategies/[id]/interpret               最新解釈取得
POST /api/strategies/[id]/interpret               Cross-Phase解釈実行
GET  /api/strategies/[id]/optimize                最新最適化結果取得
POST /api/strategies/[id]/optimize                最適化実行
GET  /api/strategies/[id]/optimize/[jobId]        特定Job取得
POST /api/strategies/[id]/optimize/[jobId]/apply  最適化パラメーター適用
GET  /api/strategies/[id]/walk-forward            最新WF結果取得
POST /api/strategies/[id]/walk-forward            WF実行
GET  /api/strategies/[id]/walk-forward/[jobId]    特定Job取得
GET  /api/strategies/[id]/monte-carlo             最新MC結果取得
POST /api/strategies/[id]/monte-carlo             MC実行
GET  /api/strategies/[id]/versions                バージョン一覧
POST /api/strategies/[id]/versions                バージョン保存
GET  /api/strategies/[id]/versions/[v]            特定バージョン取得
POST /api/strategies/[id]/versions/[v]/restore    ロールバック
```

### AI Builder
```
POST /api/ai/strategy/build    自然言語 → Strategy Spec（OpenAI）
```

### Market Data
```
GET  /api/market-data/status   bar_data全体の統計
GET  /api/market-data/health   データ健全性チェック
GET  /api/market-data/gaps     ギャップ検出
POST /api/market-data/history-sync  History Sync Job作成
```

### MT5 接続
```
GET  /api/mt5/bars/:sym/:tf    指定シンボル・TFのバー取得
GET  /api/mt5/tick/:sym        最新Tick
GET  /api/mt5/live             リアルタイム状態
GET  /api/mt5/positions        ポジション一覧
GET  /api/mt5/indicators/:sym  インジケーター値
```

---

## 9. データベース構成

### Migration 一覧

| Migration | テーブル | 内容 |
|-----------|---------|------|
| 001 | cot_positions | COTデータ |
| 002 | bar_data | 市場OHLCデータ（汎用、任意symbol） |
| 003 | bar_data RLS | 読み取り開放 |
| 004 | strategy_registry | Strategy定義 |
| 005 | backtest_jobs/results/trades | バックテスト |
| 007 | strategy_ai_analyses | AI分析 |
| 008 | strategy_improvements | AI改善提案 |
| 009 | strategy_versions | バージョン管理 |
| 010 | optimization_jobs/candidates | 最適化 |
| 011 | walk_forward_jobs | Walk Forward |
| 012 | monte_carlo_results | Monte Carlo |
| 013 | strategy_phase4d_interpretations | Cross-Phase解釈 |
| 014 | market_data_sync_jobs | DataSync Job管理 |
| 015 | sync_job_recovery | stale Job回復 |

### bar_data テーブル（最重要）

```sql
CREATE TABLE public.bar_data (
  symbol     TEXT        NOT NULL,
  timeframe  TEXT        NOT NULL,
  time_utc   TIMESTAMPTZ NOT NULL,
  open       NUMERIC(12,5),
  high       NUMERIC(12,5),
  low        NUMERIC(12,5),
  close      NUMERIC(12,5),
  volume     INTEGER,
  PRIMARY KEY (symbol, timeframe, time_utc)
);
```

- **完全汎用**: symbolはTEXT型。DXY/US10Yも追加可能（ブローカーが提供すれば）
- **UTC保証**: H4バー14400秒倍数整列で検証済み
- **スキーマ変更不要**: Cross-Asset研究に対応済み

### strategy_registry ステータス

```
status:
  DRAFT    → 作成直後（デフォルト）
  ACTIVE   → (手動変更のみ、UIから変更機能は現状なし)
  PAUSED   → (同上)
  ARCHIVED → (同上)

backtest_status:
  NOT_TESTED → 初期値
  TESTING    → 実行中
  PASSED     → verdict=PASSED かつ totalPips > 0
  FAILED     → それ以外
```

**注意:** `PASSED` はBacktestが黒字だったことを意味するだけ。Walk Forward・Monte Carloを通過した意味ではない。

---

## 10. 対応シンボル

### Strategy 設計対象（ALLOWED_SYMBOLS）

**FX ペア:**
```
EURUSD, USDJPY, GBPUSD, AUDUSD, USDCAD
USDCHF, NZDUSD, EURJPY, GBPJPY, AUDJPY
CADJPY, CHFJPY, NZDJPY, EURGBP, EURAUD
```

**貴金属:**
```
GOLD (= XAUUSD), SILVER (= XAGUSD)
```

**株価指数 (Strategy対象):**
```
US30CASH, US500CASH, US100CASH
```

**コモディティ (Strategy対象):**
```
OILCASH, BRENTCASH
```

### 関連市場参照（bar_dataには蓄積済み、Strategy Specには使用不可）

```
GER40CASH, UK100CASH, FRA40CASH, SWI20CASH, JP225CASH
VIX-AUG26（先物）, USDX-SEP26（DXY先物）
```

### DXY / US10Y 状況（Phase 8-A監査結果）

| アセット | ブローカーシンボル | H1カバレッジ | 問題 |
|---------|-----------------|------------|------|
| DXY | USDX-SEP26（先物） | 35日のみ | 先物のみ・連続データなし |
| US10Y | 存在せず | N/A | XMブローカー非対応 |

→ Cross-Asset研究のためには外部データプロバイダーの決定が必要。

---

## 11. 研究フェーズ実績（Phase 5〜8）

Phase 5〜8では、Claude Codeを使って実際の市場データに対してAlgorithmic Trading研究を実施した。全て `scripts/` ディレクトリのResearch scriptsとして記録。

### Phase 5: EMA21 Pullback仮説

| Phase | 内容 | 結果 |
|-------|------|------|
| 5-A〜C | EMA21プルバック仮説（LONG/SHORT対称） | WEAK |
| 5-D | RSI CROSS_UP/DOWN 50モメンタム | REJECTED |
| 5-E | RSIステートフィルター仮説 | FAILED |
| 5-F | Trade Anatomy分析（MFE/MAE） | WR=20.3%, WEAK |
| 5-G | 環境フィルター検証（EMA21仮説） | TERMINATED |

**Phase 5 結論:** EMA21プルバック仮説を実データで棄却。

---

### Phase 6: Mean Reversion / Breakout / Momentum系

| Phase | 内容 | 結果 |
|-------|------|------|
| 6-A | 3仮説スクリーニング（Breakout/Momentum/MeanRev） | ALL REJECTED（PF 0.28〜0.33） |
| 6-B | Execution/Exit監査 | Same-bar SL=64%問題発見 |
| 6-C | Exit Model再設計（SL=3×ATR） | PF=0.811（シグナル不足） |
| 6-D | H1/H4時間足検証 | H1 OOS PF=1.054（際どい） |
| 6-E | 4仮説比較 | LONG/SHORT非対称発見（LONG PF=1.100 > SHORT PF=0.765） |
| 6-F | 方向性監査（LONG vs SHORT） | TEMPORARY_REGIME_EFFECT（2025 UP相場依存） |
| 6-G | Regime仮説確認（DOWN_REGIME × LONG） | Strategy PF=1.114 vs Random PF=1.292 → NO_EDGE |

**Phase 6 結論:** Regime自体のバイアスがシグナルエッジを偽装。H1 Mean Reversion方向仮説終了。

---

### Phase 7: OHLC価格構造エッジ探索

| Phase | 内容 | 結果 |
|-------|------|------|
| 7-A | 6ファミリー×2方向=12仮説のRAW EDGE探索 | S6 BULL STRONG_CANDIDATE（+5.2%）、S4 BULL H4確認通過 |
| 7-B | S4/S6候補のVol-matched Bootstrap確認 | S4: +0.8%（vol-matched後）/ H4=-3.1% → NO_EDGE、S6: MARKET_BIAS_ONLY |

**Phase 7 結論:** EURUSD H1 OHLCのみを使った技術的アプローチで再現可能なエッジは発見できなかった。Phase 7 terminated。

---

### Phase 8: Cross-Asset研究準備

| Phase | 内容 | 結果 |
|-------|------|------|
| 8-A | データ可用性監査（EURUSD × DXY × US10Y） | INSUFFICIENT（DXY先物35日のみ、US10Y非対応） |

**Phase 8-A 結論:** bar_dataスキーマは汎用対応済みでスキーマ変更不要。ただしDXY連続データとUS10Yは外部プロバイダーが必要。

---

## 12. 技術スタック

| 領域 | 技術 |
|-----|------|
| フロントエンド | Next.js 15 (App Router), React 19, TypeScript |
| スタイリング | Tailwind CSS, カスタムNeon UIデザイン |
| チャート | lightweight-charts |
| バックエンド | Next.js API Routes, Node.js |
| データベース | Supabase (PostgreSQL), Row Level Security |
| AI | OpenAI API (json_object mode), Claude Sonnet 4.6 (Claude Code) |
| バリデーション | Zod |
| MT5連携 | MQL5 (AVL_DataManager_v2.mq5, AVL_FX_Bridge.mq5) |
| Gateway | Express.js + WebSocket (ws) |
| Research Scripts | tsx (TypeScript直接実行) |
| テスト | Jest (backtest系ユニットテスト37+件) |
| デプロイ | Vercel (Next.js), Supabase (DB), ローカルGateway |

---

## 13. 環境変数

```bash
# Next.js Web App
NEXT_PUBLIC_SUPABASE_URL=         # Supabase プロジェクトURL
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # 公開用匿名キー
SUPABASE_SERVICE_ROLE_KEY=        # サービスロールキー（サーバーサイド）
OPENAI_API_KEY=                   # OpenAI APIキー
OPENAI_MODEL_STRATEGY=            # Strategy Builder用モデル（省略可）

# Gateway
SUPABASE_URL=                     # Supabase URL（Gatewayから）
SUPABASE_SERVICE_KEY=             # サービスロールキー（Gatewayから）
SUPABASE_BATCH_SIZE=500           # バッチサイズ（省略可）
SUPABASE_BATCH_DELAY_MS=50        # バッチ間隔ms（省略可）
```

---

## 14. 既知の制約・注意事項

### データ制約

1. **EURUSD H1データは2025-01-08から**（約1.5年分）。3年以上のデータがある研究では結果の信頼性が低い。
2. **DXYはUSDX-SEP26（先物）のみ**。連続DXYは未収集。
3. **US10YはXMブローカーから取得不可**。
4. **H1データが短い**ため、Walk Forwardのウィンドウ数が限られる。

### 研究制約

5. **Phase 7-B の重要発見**: ATRバケットマッチングなしのランダムコントロールは過大評価される。Phase 7-A のS4+4.7%は、vol-matched後+0.8%に縮小した。
6. **S6のクラスタリング問題**: rawN=795でも独立サンプルは258のみ（67.6%が5bar以内にクラスター）。シグナルカウントの見た目より実際のサンプル数は少ない。
7. **2025年EURUSDの強い方向バイアス**（+1438pip UP）が多くの研究結果を歪めていた。

### システム制約

8. **BacktestEngineは単一シンボル設計**。複数シンボルを同時に扱う戦略はエンジン変更が必要。
9. **研究パイプラインは手動**。各ステップを順番にUI操作する必要がある。
10. **EAコマンドセンター上部パネルはMOCK**。5件のハードコードプロフィールが表示されている。

### セキュリティ

11. **AI EA BuilderはMQL5コード生成を明示的に禁止**。AIプロンプトに記載済み。
12. **全AIアウトプットはZodスキーマで検証**される（ホワイトリスト方式）。

---

## 15. ロードマップ（次に実装すべきもの）

### Priority 0（ワークフロー完成に必須）

```
□ 研究パイプラインの自動連鎖
  Backtest完了 → AI Analysis自動起動 → Optimize → Walk Forward → Monte Carlo → Interpret
  UIで「Full Research実行」ボタン1つで全ステップを順次実行

□ Final Research Verdict ステータス
  strategy_registry.statusに VALIDATED / REJECTED / ROBUST を追加
  全ステップ通過後の総合判定を自動付与
```

### Priority 1（体験品質）

```
□ EAコマンドセンター上部パネルのMOCK廃止
  MOCK_EA_PROFILES → 実DBデータへの置き換え

□ statusフィールドのUI制御
  ACTIVE/PAUSED/ARCHIVEDへのUI経由での変更機能

□ 外部データプロバイダー統合
  連続DXY: Alpha Vantage / Polygon.io
  US10Y: FRED（Federal Reserve、無料API）
  → Phase 8-B Cross-Asset Lead/Lag研究が可能になる
```

### Priority 2（将来フェーズ）

```
□ MQL5 EA自動生成
  Strategy Spec → .mq5ファイル生成
  
□ MT5 Live Deployment
  magic_numberをMT5のStrategy EAに渡す仕組み

□ 別シンボル / 別仮説研究
  USDJPY, GBPJPYでの同様のPhase研究
  Session-based patterns（ロンドンオープン等の固定時刻エントリー）
  
□ 長期H1データ収集
  現在の1.5年をさらに延長（3年以上が理想）
```

---

## 付録: Research Scriptsの実行方法

```bash
# 環境設定
cd /Users/tanakayoshiki/Desktop/AVL_FX

# Scriptの実行（例）
npx tsx --env-file=.env.local scripts/phase8a_cross_asset_audit.ts

# Gatewayの起動
cd gateway && npm run dev

# Web Appの起動
npm run dev  # http://localhost:3000
```

---

*このドキュメントはAVL-FXの実装状況を正確に反映しています。*
*最終更新: 2026-08-22（Phase 8-A完了時点）*
