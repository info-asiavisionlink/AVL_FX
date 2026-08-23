# SYSTEM ARCHITECTURE
**Status:** IMPLEMENTED — reflects current codebase  
**Last Updated:** 2026-08-22  
**Source of Truth:** gateway/src/, ea/*.mq5, supabase/migrations/, src/infrastructure/

---

## データフロー全体図

```
MT5 (XM Broker)
     │
     │  HTTP POST / WebSocket
     ↓
Gateway [Node.js Express]  ←→  Browser (WebSocket)
     │
     │  Supabase SDK (UPSERT)
     ↓
Supabase [PostgreSQL + RLS]
     │
     │  Supabase SDK (SELECT/INSERT)
     ↓
Next.js API Routes
     │
     │  Function call
     ↓
Research Engines [TypeScript]
```

---

## 1. MT5 Layer

### ファイル構成

| ファイル | 役割 |
|---------|------|
| `ea/AVL_DataManager_v2.mq5` | メインData Manager EA。売買ロジックなし |
| `ea/AVL_FX_Bridge.mq5` | UIリアルタイム表示専用 |

### AVL_DataManager_v2.mq5 — 8ストリーム

```
Stream 1: Tick        → POST /tick        （100msスロットリング）
Stream 2: OHLC        → POST /bar         （確定バー）
                      → POST /bars/bulk   （起動時・再送）
Stream 3: MarketWatch → POST /symbols/bulk （全MW symbol、3sec）
Stream 4: Indicators  → POST /indicators  （30sec）
Stream 5: Orders      → POST /positions   （5sec）
Stream 6: Account     → POST /account     （5sec）
Stream 7: History     → POST /history     （30日分、5min）
Stream 8: Heartbeat   → POST /heartbeat
```

### History Sync / DataSync

```
HistorySync（起動時）:
  InpHistorySyncEnabled = true → 任意月数の過去OHLC一括取得
  対象: g_Symbol のみ（チャートシンボル）
  チャンク分割（InpHistorySyncChunkDays = 28日）

DataSync（インクリメンタル）:
  30秒毎にSupabase market_data_sync_jobs をポーリング
  DataSync_Execute(symbol, tf, ...) 任意シンボル対応
  CopyRates(symbol, tf, from, to, rates) → 任意MT5シンボル
  FORWARD / BACKFILL モード両対応
```

### 重要制約

- `g_Symbol = Symbol()` = チャートにアタッチしたシンボルのみリアルタイムOHLC
- 複数シンボルのリアルタイム収集には複数EA（複数チャート）が必要
- DataSyncは任意シンボルをサポート（ブローカーのMarket Watchにあれば）

### UTC タイムスタンプ保証

```
MqlRates.time → UTC秒 (ブローカー時刻ではない)
検証済み: H4バーが 14400秒倍数(UTC境界) に整列
→ barDataStore.ts: new Date(bar.time).toISOString() で直接保存
```

---

## 2. Gateway Layer

**ファイル:** `gateway/src/index.ts`  
**起動:** `cd gateway && npm run dev` → Port 8080

### 受信エンドポイント（EA → Gateway）

```
POST /connect       起動通知
POST /tick          Tick受信
POST /bar           単一確定バー
POST /bars/bulk     過去バー一括（最大5000本/TF）
POST /positions     ポジション
POST /account       口座情報
POST /heartbeat     ハートビート
POST /event         切断通知
```

### 配信エンドポイント（Browser → Gateway）

```
GET  /bars/:sym/:tf    過去バー（全件）
GET  /tick/:sym        最新Tick
GET  /symbols          Market Watch全シンボル
GET  /health           サーバー状態
WS   /ws               リアルタイムストリーム
```

### DataSync エンドポイント（Gateway → EA polling時）

```
GET  /data-commands/pending            PENDING job取得
POST /data-commands/:id/progress      進捗更新
```

### barDataStore.ts

```typescript
upsertBulkBars(symbol, timeframe, bars[])  // 起動時一括
upsertSingleBar(symbol, timeframe, bar)    // 確定バー単体
syncBarStoreToSupabase(barStore)           // 初回同期

// symbol.toUpperCase() 正規化
// BATCH_SIZE=500, BATCH_DELAY_MS=50ms
// fire-and-forget (Gatewayをブロックしない)
```

---

## 3. Supabase Layer

### 接続

```typescript
// サーバーサイド (API Routes, Research Engines)
createAdminClient() → SUPABASE_SERVICE_ROLE_KEY使用

// クライアントサイド
createClient() → SUPABASE_ANON_KEY使用
```

### RLS設定

```
bar_data:
  SELECT: authenticated ✅
  INSERT/UPDATE: service_role only ✅

strategy_registry / backtest_*:
  RLS無効（Phase 1〜現在は認証ユーザー全員アクセス可）
  ※ユーザー別分離は未実装
```

### 主要テーブル（全15 migrations）

詳細は [DATABASE.md](../01_CURRENT_SYSTEM/DATABASE.md) 参照。

---

## 4. Next.js API Layer

**構成:** `src/app/api/`  
**Runtime:** `export const runtime = "nodejs"` （Edge Runtimeは未使用）

### Strategy研究APIグループ

```
/api/ai/strategy/build          自然言語→Strategy Spec (OpenAI)
/api/strategies                 Strategy CRUD
/api/strategies/[id]/backtest   バックテスト
/api/strategies/[id]/analyze    AI分析
/api/strategies/[id]/improve    AI改善提案
/api/strategies/[id]/versions   バージョン管理
/api/strategies/[id]/optimize   パラメーター最適化
/api/strategies/[id]/walk-forward   Walk Forward
/api/strategies/[id]/monte-carlo    Monte Carlo
/api/strategies/[id]/interpret  Cross-Phase解釈
```

### Market Data APIグループ

```
/api/market-data/status         bar_data統計
/api/market-data/health         データ健全性
/api/market-data/gaps           ギャップ検出
/api/market-data/history-sync   HistorySync Job作成
```

---

## 5. Research Engine Layer

**ファイル:** `src/infrastructure/backtest/`

### エンジン一覧

| ファイル | 役割 | 状態 |
|---------|------|------|
| `BacktestEngine.ts` | シグナル評価→ポジション管理→統計 | IMPLEMENTED |
| `BacktestService.ts` | DB読み込み→Engine呼び出し→DB保存 | IMPLEMENTED |
| `BacktestReporter.ts` | 統計計算・verdict判定 | IMPLEMENTED |
| `BacktestAnalyzer.ts` | AI分析コンテキスト構築 | IMPLEMENTED |
| `OptimizationEngine.ts` | グリッドサーチ + Stable Zone | IMPLEMENTED |
| `WalkForwardEngine.ts` | IS/OOS時系列分割検証 | IMPLEMENTED |
| `MonteCarloEngine.ts` | Nイテレーション確率シミュレーション | IMPLEMENTED |
| `InterpretationEngine.ts` | 全フェーズ統合AI解釈 | IMPLEMENTED |
| `evaluator.ts` | シグナル評価ロジック（EvaluationContext） | IMPLEMENTED |
| `indicators.ts` | EMA/ATR事前計算 | IMPLEMENTED |
| `PositionManager.ts` | ポジション管理・PnL計算 | IMPLEMENTED |
| `spreadConfig.ts` | シンボル別spread/slippage設定 | IMPLEMENTED |
| `timeframe.ts` | confirmed-bar時刻計算 | IMPLEMENTED |

### BacktestEngine の設計原則

```
1. _evaluatorOverride: 任意シグナルロジック注入可能
2. confirmed-bar安全: getLastConfirmedBarIndex() でlook-ahead防止
3. 単一シンボル設計: spec.symbols.length === 1 必須
4. コスト込み: spread + slippage を entry/exit価格に反映
5. 高速: 5,000本 ≈ 14ms
```

---

## 6. UI Layer

**ファイル:** `src/presentation/components/`

### コンポーネント構成

```
/ea/
  EACommandCenter.tsx    メイン画面（MOCK上部 + REAL下部）
  AIEABuilder.tsx        自然言語→Spec→Preview→Save モーダル
  StrategyDetailModal.tsx  6タブ詳細画面（3489行）
  mockData.ts            MOCK_EA_PROFILES（5件ハードコード）
  types.ts               EAProfile型定義

/layout/
  DashboardShell.tsx     サイドバー付きレイアウト

/chart/, /markets/, /watchlist/ etc.
  → リアルタイムデータ表示系
```

---

## 7. データ流れ詳細図（Strategy研究フロー）

```
[USER] 自然言語入力
   │
   ↓ POST /api/ai/strategy/build
[OpenAI] JSON生成 → ZodValidation
   │
   ↓ POST /api/strategies
[Supabase] strategy_registry INSERT (status=DRAFT)
   │
   ↓ POST /api/strategies/[id]/backtest
[BacktestService] bar_data SELECT → BacktestEngine
   → backtest_jobs/results/trades INSERT
   │
   ↓ POST /api/strategies/[id]/analyze
[OpenAI] Fact-based分析 → strategy_ai_analyses INSERT
   │
   ↓ POST /api/strategies/[id]/optimize
[OptimizationEngine] GridSearch → optimization_jobs/candidates INSERT
   │
   ↓ POST /api/strategies/[id]/walk-forward
[WalkForwardEngine] IS/OOS分割 → walk_forward_jobs INSERT
   │
   ↓ POST /api/strategies/[id]/monte-carlo
[MonteCarloEngine] N iterations → monte_carlo_results INSERT
   │
   ↓ POST /api/strategies/[id]/interpret
[InterpretationEngine] 全結果統合 → strategy_phase4d_interpretations INSERT
   │
   ↓ [手動判断] または [未実装: 自動判定]
[VALIDATED / REJECTED]
```

---

*Architecture変更時は必ずこのファイルを更新すること。*
