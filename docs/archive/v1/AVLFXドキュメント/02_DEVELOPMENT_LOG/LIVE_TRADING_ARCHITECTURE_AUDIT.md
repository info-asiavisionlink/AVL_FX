# AVL-FX LIVE TRADING ARCHITECTURE AUDIT
**実施日:** 2026-09-03  
**目的:** 共通Execution Bridge EA方式への移行に向けた現状把握  
**方針:** 実装なし・READ-ONLY監査

---

## 1. CURRENT ARCHITECTURE

```
[MT5 (XM Broker)]
  AVL_DataManager_v2.mq5  ← データ収集専用 (売買なし)
  AVL_FX_Bridge.mq5       ← UI接続専用 (簡略版)
        ↓ HTTP POST
[Gateway (Railway / Express + WebSocket)]
  ← 7 Market Data Streams (Tick/Bar/Indicators/Orders/Positions/Account/History)
  → Order Queue (GET /orders/pending → EA → POST /orders/:id/result)
        ↓ Supabase SDK
[Supabase (PostgreSQL)]
  bar_data / strategy_registry / backtest_* / strategy_*
        ↓
[Next.js (Vercel)]
  AI EA Builder / Backtest Pipeline / Research Engines
```

**現状の性格:** Research & Validation Platform。ライブ執行能力なし。

---

## 2. CURRENT MT5 EA 監査

### 存在するEA一覧

| EA | バージョン | 役割 | Strategy Logic | Command受信 | 注文執行 |
|----|----------|------|---------------|------------|---------|
| AVL_DataManager_v2.mq5 | v4.0 | データ収集専用 | ❌ なし | ✅ Orderポーリング | ✅ CTrade実装 |
| AVL_FX_Bridge.mq5 | v3.11 | UI接続専用 | ❌ なし | ✅ Orderポーリング | ❌ なし |

### AVL_DataManager_v2.mq5 詳細機能判定

| 機能 | 判定 | 詳細 |
|------|------|------|
| Market Data送信 (Tick) | **READY** | 100ms throttle, /tick |
| Market Data送信 (Bar) | **READY** | M1〜W1全8TF, confirmed-bar |
| Market Data送信 (Indicators) | **READY** | EMA/ATR/RSI/MACD/ADX/BB等, 30秒毎 |
| Position送信 | **READY** | 5秒毎, /orders/stream |
| Account送信 | **READY** | 5秒毎, Balance/Equity/Margin |
| Order送信 | **READY** | 5秒毎, Pending+Positions |
| Deal送信 | **READY** | 300秒毎, DEAL_ENTRY_OUT/INOUT |
| Heartbeat | **READY** | /heartbeat |
| Gateway→EA Command受信 | **PARTIAL** | Orderポーリングのみ |
| BUY実行 | **READY** | CTrade.Buy() 実装済み |
| SELL実行 | **READY** | CTrade.Sell() 実装済み |
| CLOSE実行 | **PARTIAL** | 実装あり、Magic Number未対応 |
| SL/TP設定 | **PARTIAL** | Order時に指定可能 |
| Magic Number設定 | **PARTIAL** | 変数あり、動的変更未対応 |
| Command結果返却 | **READY** | POST /orders/:id/result |
| Reconnect | **READY** | 指数バックオフretry (3回) |
| Duplicate Command防止 | **NOT IMPLEMENTED** | command_id チェックなし |
| Error Handling | **PARTIAL** | HTTP errorのみ、MT5エラーコード未処理 |

---

## 3. CURRENT GATEWAY 監査

### 実装エンドポイント

**EA → Gateway (認証あり):**

| エンドポイント | 状態 | 説明 |
|--------------|------|------|
| POST /connect | ✅ | EA起動通知 |
| POST /tick | ✅ | Tick受信 |
| POST /bar | ✅ | 単一バー受信 |
| POST /bars/bulk | ✅ | 過去バー一括 |
| POST /positions | ✅ | ポジション受信 |
| POST /account | ✅ | 口座情報受信 |
| POST /orders/stream | ✅ | 注文ストリーム受信 |
| POST /symbols/bulk | ✅ | Market Watch受信 |
| POST /indicators | ✅ | インジケーター受信 |
| POST /history/bulk | ✅ | 取引履歴受信 |
| POST /heartbeat | ✅ | Heartbeat受信 |
| GET /orders/pending | ✅ | **EA向け注文キュー取得** |
| POST /orders/:id/result | ✅ | **注文実行結果受信** |

**Browser → Gateway:**

| エンドポイント | 状態 |
|--------------|------|
| GET /health | ✅ |
| GET /symbols | ✅ |
| GET /tick/:symbol | ✅ |
| GET /bars/:sym/:tf | ✅ |
| GET /positions | ✅ |
| GET /account | ✅ |
| WebSocket /ws | ✅ |

### Gateway機能判定

| 機能 | 判定 | 詳細 |
|------|------|------|
| MT5→Gateway (Inbound) | **READY** | 7 Streams完全実装 |
| Gateway→MT5 (Outbound) | **PARTIAL** | Order Queue のみ |
| In-Memory Bar Store | **READY** | 最大10,000bars/symbol |
| Supabase自動UPSERT | **READY** | bar_data確定bar保存 |
| Timezone正規化 | **READY** | TZ不整合検出・警告 |
| Command Queue | **PARTIAL** | 基本キューのみ、durable性なし |
| Connection Registry | **PARTIAL** | eaInfo保存あり、lifecycle管理なし |
| Per-symbol Heartbeat | **READY** | heartbeatStore |
| Command認証 | **PARTIAL** | Gateway Secret Tokenのみ |
| Retry / Idempotency | **NOT IMPLEMENTED** | なし |
| Command expiry | **NOT IMPLEMENTED** | なし |

**判定:** **Bidirectional Gateway — PARTIAL**  
Market Data Inbound: READY / Execution Outbound: PARTIAL

---

## 4. CURRENT STRATEGY RUNTIME 監査

| コンポーネント | 判定 | 詳細 |
|--------------|------|------|
| Strategy Spec保存 | **READY** | strategy_registry JSONB |
| Magic Number割当 | **READY** | 20001〜自動連番 |
| Backtest evaluation | **READY** | BacktestEngine完全実装 |
| Realtime evaluation | **NOT IMPLEMENTED** | 存在しない |
| Strategy scheduler | **NOT IMPLEMENTED** | 存在しない |
| ACTIVE strategy loading | **NOT IMPLEMENTED** | 存在しない |
| new-bar detection (Server) | **NOT IMPLEMENTED** | EAのみで実装 |
| Indicator state (Server) | **NOT IMPLEMENTED** | EAのみで実装 |
| Signal generation | **NOT IMPLEMENTED** | 存在しない |
| Duplicate signal prevention | **NOT IMPLEMENTED** | 存在しない |
| Position-aware evaluation | **NOT IMPLEMENTED** | 存在しない |
| Exit evaluation (Live) | **NOT IMPLEMENTED** | 存在しない |

---

## 5. CURRENT EXECUTION ENGINE 監査

| コンポーネント | 判定 | 詳細 |
|--------------|------|------|
| ExecutionEngine | **NOT IMPLEMENTED** | ファイル存在しない |
| OrderService | **NOT IMPLEMENTED** | ファイル存在しない |
| TradingService | **NOT IMPLEMENTED** | ファイル存在しない |
| RiskEngine | **PARTIAL** | 基本チェックのみ (src/infrastructure/) |
| PositionManager | **NOT IMPLEMENTED** | ファイル存在しない |
| Signal→Command変換 | **NOT IMPLEMENTED** | 存在しない |
| AI自律注文 | **PARTIAL** | /api/ai/autonomous-order 存在、未完成 |

---

## 6. CURRENT DATABASE 監査

### 存在するテーブル

| テーブル | 用途 | Live Trading Ready? | 不足 |
|---------|------|-------------------|------|
| bar_data | OHLC蓄積 | ✅ YES | - |
| strategy_registry | Strategy管理 | ✅ YES (magic_number, status) | - |
| backtest_jobs | バックテスト | ✅ YES | - |
| backtest_results | バックテスト結果 | ✅ YES | - |
| backtest_trades | トレード明細 | ✅ YES | - |
| strategy_ai_analyses | AI分析 | ✅ YES | - |
| strategy_improvements | 改善提案 | ✅ YES | - |
| strategy_versions | バージョン履歴 | ✅ YES | - |
| optimization_jobs | 最適化 | ✅ YES | - |
| walk_forward_jobs | WF検証 | ✅ YES | - |
| monte_carlo_results | MC結果 | ✅ YES | - |
| strategy_phase4d_interpretations | 統合解釈 | ✅ YES | - |
| market_data_sync_jobs | DataSync | ✅ YES | - |
| user_subscriptions | サブスク | ✅ YES | - |
| cot_positions | COT | ✅ YES | - |
| **live_orders** | **ライブ注文** | ❌ **NOT EXISTS** | テーブル全体 |
| **live_positions** | **ライブポジション** | ❌ **NOT EXISTS** | テーブル全体 |
| **execution_commands** | **実行コマンド** | ❌ **NOT EXISTS** | テーブル全体 |
| **mt5_connections** | **MT5接続管理** | ❌ **NOT EXISTS** | テーブル全体 |
| **trading_accounts** | **ブローカー口座** | ❌ **NOT EXISTS** | テーブル全体 |
| **strategy_runtime_state** | **Runtime状態** | ❌ **NOT EXISTS** | テーブル全体 |

---

## 7. CURRENT START/STOP 監査

| レイヤー | 実装 | 詳細 |
|---------|------|------|
| UI 起動/停止ボタン | **PARTIAL** | EACommandCenter にUI要素あり |
| DB status変更 API | **READY** | PUT /api/strategies/:id → status更新 |
| Strategy Runtime制御 | **NOT IMPLEMENTED** | Runtimeが存在しないため |
| MT5取引制御 | **NOT IMPLEMENTED** | EA停止コマンドなし |

**現状:** DBのstatusフィールドを変更するだけ。Runtime連動なし。

---

## 8. CURRENT MULTI-STRATEGY SUPPORT 監査

| 機能 | 判定 | 詳細 |
|------|------|------|
| Magic Number割当 | **READY** | 20001〜連番、UNIQUE制約 |
| Strategy別Position追跡 | **NOT IMPLEMENTED** | live_positionsテーブルなし |
| Strategy別Order追跡 | **NOT IMPLEMENTED** | live_ordersテーブルなし |
| Strategy別PnL | **NOT IMPLEMENTED** | 実装なし |
| 同一Symbol複数Strategy | **NOT IMPLEMENTED** | Concurrency制御なし |
| Duplicate Order防止 | **NOT IMPLEMENTED** | 実装なし |
| Race Condition対策 | **NOT IMPLEMENTED** | 実装なし |

---

## 9. CURRENT SECURITY / SAFETY 監査

| 機能 | 判定 | 詳細 |
|------|------|------|
| Command認証 | **PARTIAL** | Gateway Secret Tokenのみ |
| User isolation | **READY** | RLS実装済み |
| Account isolation | **NOT IMPLEMENTED** | mt5_connectionsなし |
| Strategy isolation | **PARTIAL** | magic_numberのみ |
| Replay attack防止 | **NOT IMPLEMENTED** | command_id重複チェックなし |
| Duplicate command防止 | **NOT IMPLEMENTED** | 実装なし |
| Idempotency | **NOT IMPLEMENTED** | 実装なし |
| Command expiry | **NOT IMPLEMENTED** | 実装なし |
| Maximum order size | **NOT IMPLEMENTED** | 実装なし |
| Risk limit | **PARTIAL** | 基本チェックのみ |
| Emergency stop | **NOT IMPLEMENTED** | 実装なし |
| Kill switch | **NOT IMPLEMENTED** | 実装なし |
| Heartbeat timeout検出 | **PARTIAL** | 記録のみ、自動停止なし |
| Connection loss handling | **PARTIAL** | Reconnectのみ |
| Audit log | **NOT IMPLEMENTED** | 実装なし |

---

## 10. TARGET ARCHITECTUREとの差分表

| COMPONENT | CURRENT | TARGET | STATUS | GAP |
|-----------|---------|--------|--------|-----|
| Market Data Bridge | ✅ READY | Live + Backtest | READY | 0% |
| Execution Bridge EA | ❌ NONE | 共通EA 1個 | NOT IMPLEMENTED | 100% |
| Gateway Inbound | ✅ READY | All MT5 data | READY | 0% |
| Gateway Outbound | ⚠️ PARTIAL | Order+Modify+Close | PARTIAL | 60% |
| Strategy Registry | ✅ READY | + runtime_state | READY | 5% |
| Strategy Runtime | ❌ NONE | Realtime evaluator | NOT IMPLEMENTED | 100% |
| Realtime Evaluator | ❌ NONE | Per-tick/bar eval | NOT IMPLEMENTED | 100% |
| Signal Engine | ❌ NONE | Continuous signal | NOT IMPLEMENTED | 100% |
| Risk Engine | ⚠️ PARTIAL | Full validation | PARTIAL | 70% |
| Execution Engine | ❌ NONE | Command生成→送信 | NOT IMPLEMENTED | 100% |
| Command Queue | ⚠️ PARTIAL | Durable+expiry | PARTIAL | 50% |
| MT5 Order Execution | ⚠️ PARTIAL | Bridge EA必要 | PARTIAL | 50% |
| Position Sync | ✅ Stream | Bidirectional | READY | 5% |
| Order Sync | ✅ Stream | Bidirectional | READY | 5% |
| Deal Sync | ✅ Stream | Bidirectional | READY | 5% |
| Account Sync | ✅ Stream | Bidirectional | READY | 5% |
| Heartbeat | ✅ READY | Per-EA | READY | 5% |
| Connection/Auth | ⚠️ PARTIAL | User↔MT5 pairing | PARTIAL | 70% |
| Magic Number | ✅ READY | Used by Bridge EA | READY | 0% |
| Multi Strategy | ❌ NONE | 40+ concurrent | NOT IMPLEMENTED | 100% |
| Start/Stop | ⚠️ DB only | Runtime制御 | PARTIAL | 80% |
| Live Performance | ❌ NONE | Per-strategy PnL | NOT IMPLEMENTED | 100% |
| Audit Log | ❌ NONE | 全Command記録 | NOT IMPLEMENTED | 100% |
| Emergency Stop | ❌ NONE | API+UI+EA | NOT IMPLEMENTED | 100% |

---

## 11. 旧MQL5生成Architectureを前提にしている記述

以下のドキュメントが、「Strategy → MQL5生成 → Compile → Deploy」フローを前提に記述されており、  
新アーキテクチャ（共通Execution Bridge EA + Server-side Runtime）への更新が必要：

| ドキュメント | 変更が必要な記述 | 優先度 |
|-----------|--------------|------|
| AVLFX_MASTER.md | Stage 3: MQL5 EA自動生成を計画している箇所 | 高 |
| DEVELOPMENT_ROADMAP.md | Strategy EA生成・デプロイのStageを全面改訂 | 高 |
| EXECUTION_ENGINE.md | 旧設計のStrategyごとEA前提の記述 | 高 |
| LIVE_TRADING.md | Strategy EA配布フローの記述 | 高 |
| STRATEGY_RUNTIME.md | MQL5テンプレート生成の記述 | 中 |
| AVLFX_MASTER.md | 未実装リスト「MQL5 EA自動生成」の削除/更新 | 中 |

**今回は変更しない。監査結果確認後に更新。**

---

## 12. 再利用可能な既存コード

| コンポーネント | 再利用可能性 | 詳細 |
|--------------|------------|------|
| BacktestEngine | **そのまま再利用可能** | StrategyEvaluatorをLive Runtimeでも使用可能 |
| StrategySpec | **そのまま再利用可能** | entryConditions/exitConditionsの構造をそのまま活用 |
| Indicator計算ロジック | **そのまま再利用可能** | Backtest内のEMA/ATR/RSI等をLiveでも使用 |
| Gateway Order Queue | **軽微なリファクタ** | command_id/expiry追加が必要 |
| AVL_DataManager_v2 | **そのまま再利用可能** | OrderポーリングをBridge EA専用に移植 |
| strategy_registry | **そのまま再利用可能** | magic_number/statusカラム活用 |
| Risk基本チェック | **拡張が必要** | Live用リスクパラメータ追加 |

**BacktestとLiveの共通化:** StrategyEvaluator層はそのまま再利用可能。  
Live RuntimeはHistoricalデータの代わりにリアルタイムBarを注入する形で実装可能。

---

## 13. 新規実装が必要なコンポーネント

優先度順：

### P0 — Live Trading Core
1. **AVL Execution Bridge EA** (MQL5)  
   - 共通EA 1個、Strategyロジックなし  
   - Command受信 (BUY/SELL/CLOSE/MODIFY)  
   - Magic Numberによる注文管理  
   - 実行結果返却

2. **Strategy Runtime (Server-side)**  
   - ACTIVE Strategyの継続評価ループ  
   - 新バー検出 → StrategyEvaluator呼出し  
   - Signal生成 → Command生成

3. **Execution Engine (Server-side)**  
   - Signal → Risk Check → Order Command  
   - Gateway経由でBridge EAへ送信

4. **Live Trading DB Tables**  
   - execution_commands, live_positions, mt5_connections

### P1 — Safety & Operations
5. **Emergency Stop** (API + UI + EA)
6. **Risk Engine強化** (DD上限、日次損失制限)
7. **Audit Log** (全Command記録)
8. **Command Idempotency** (command_id重複チェック)

### P2 — Multi Strategy & Scaling
9. **Multi-Strategy Concurrency制御**
10. **Strategy別PnL追跡**
11. **Connection管理** (user ↔ MT5 pairing)

---

## 14. Production Readiness

| カテゴリ | 完成度 | 根拠 |
|---------|------|------|
| AI Strategy Creation | 98% | AIEABuilder完全実装、Preview・Save・Version管理 |
| Backtest | 95% | 37テストPASS、confirmed-bar安全、全統計実装 |
| Strategy Management | 95% | Registry・magic_number・status・version管理 |
| Market Data Gateway | 90% | 7 Streams・Supabase sync・WebSocket配信 |
| Live Strategy Runtime | 0% | 存在しない |
| Execution Gateway | 50% | Order Queueのみ、durable性・expiry・idempotencyなし |
| MT5 Execution | 40% | DataManagerにCTrade実装あり、Bridge EA未生成 |
| Risk/Safety | 15% | 基本チェックのみ、Emergency Stop・Risk Limitなし |
| Multi Strategy Operation | 5% | magic_number割当のみ |
| **Production Live Trading Overall** | **15%** | 基盤完成、実行層が全体的に未実装 |

---

## 15. 推奨 Implementation Stages

```
STAGE 3-A: Execution Bridge EA (MQL5)
  - 共通EA作成（Strategyロジックなし）
  - BUY/SELL/CLOSE/MODIFY Command受信
  - Magic Number対応
  - 実行結果返却
  推定: 1〜2週間

STAGE 3-B: Gateway強化
  - Command expiry / idempotency追加
  - execution_commandsテーブル追加
  - 認証強化
  推定: 1週間

STAGE 3-C: Strategy Runtime (Server-side)
  - ACTIVE Strategy監視ループ
  - 新バー検出 (Gateway WSから受信)
  - StrategyEvaluator再利用
  - Signal生成
  推定: 2〜3週間

STAGE 3-D: Execution Engine
  - Signal → Risk Check → Command
  - Gateway経由でBridge EAへ送信
  - 実行結果DB保存
  推定: 1〜2週間

STAGE 3-E: Safety Layer
  - Emergency Stop
  - Heartbeat timeout自動停止
  - DD/日次損失リミット
  推定: 1〜2週間

STAGE 4: Multi Strategy & Monitoring
  - Strategy別PnL
  - Live Dashboard
  - Connection管理 (user ↔ MT5)
  推定: 2〜3週間
```

---

## 16. Documentationとコードの矛盾点

| 項目 | ドキュメント | 実コード | 対応 |
|------|-----------|---------|------|
| Magic Number割当 | 「予定」として記載 | **実装済み** (POST /api/strategies) | Doc更新必要 |
| Order Queue | 「未実装」として記載 | **実装済み** (Gateway) | Doc更新必要 |
| Strategy Runtime | 「未実装」 | 未実装 | 一致 |
| MQL5生成 | 「未実装」 | 未実装（新Architectureでは不要化） | Architecture変更に合わせDoc改訂 |

---

## 最終判定

```
COMMON EXECUTION BRIDGE READY:        NO
  → Bridge EA (MQL5) 未生成。DataManagerのCTrade実装は流用可能。

SERVER-SIDE STRATEGY RUNTIME READY:   NO
  → 完全に未実装。StrategyEvaluatorは再利用可能。

BIDIRECTIONAL GATEWAY READY:          PARTIAL
  → Inbound: READY / Outbound: Order Queueのみ実装

MT5 LIVE ORDER EXECUTION READY:       PARTIAL
  → DataManagerにCTrade実装あり。Bridge EA（共通）が必要。

MULTI-STRATEGY READY:                 NO
  → magic_number割当機構のみ。Runtimeも追跡DBも未実装。

LIVE TRADING READY:                   NO
  → End-to-End実行パイプライン未完成。

PRODUCTION READINESS:                 15%
  → Research Platform: 95% / Live Execution: 0〜15%
```
