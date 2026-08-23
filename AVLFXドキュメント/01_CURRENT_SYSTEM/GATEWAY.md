# GATEWAY
**Status:** PRODUCTION_READY  
**Last Updated:** 2026-08-22  
**Source of Truth:** `gateway/src/index.ts`, `gateway/src/barDataStore.ts`, `gateway/src/syncJobStore.ts`

---

## 概要

Gateway は MT5（EA）と Supabase の橋渡しをする Node.js Express サーバー。  
デフォルトポート: **8080**

---

## 起動

```bash
cd gateway
npm run dev   # 開発
npm start     # 本番
```

---

## 環境変数（gateway/.env または gateway/.env.local）

```bash
SUPABASE_URL=
SUPABASE_SERVICE_KEY=    # または SUPABASE_SERVICE_ROLE_KEY
SUPABASE_BATCH_SIZE=500
SUPABASE_BATCH_DELAY_MS=50
```

---

## エンドポイント

### EA → Gateway（認証あり: InpServerSecret）

```
POST /connect        EA起動通知
POST /tick           Tick受信 → メモリに保存 + WS配信
POST /bar            確定バー → Supabase INSERT + WS配信
POST /bars/bulk      過去バー一括 → Supabase BULK UPSERT
POST /positions      ポジション → メモリ更新 + WS配信
POST /account        口座情報 → メモリ更新 + WS配信
POST /heartbeat      ハートビート → タイムスタンプ更新
POST /event          切断通知
POST /indicators     インジケーター → メモリ更新 + WS配信
POST /history        取引履歴
POST /symbols/bulk   Market Watch全シンボル
```

### Browser → Gateway

```
GET /bars/:sym/:tf   過去バー（barStore from memory）
GET /tick/:sym       最新Tick
GET /symbols         Market Watch一覧
GET /health          サーバー状態（barStore件数等）
WS  /ws              リアルタイムストリーム
```

### DataSync（EA polling用）

```
GET  /data-commands/pending           PENDING job 1件取得（claim_next_sync_job RPC）
POST /data-commands/:id/progress      進捗更新
```

---

## barDataStore.ts

```typescript
// bar_dataへのSupabase操作を管理
upsertBulkBars(symbol, timeframe, bars[])
// → BATCH_SIZE=500 件ずつ分割
// → UPSERT (onConflict: "symbol,timeframe,time_utc", ignoreDuplicates: true)
// → BATCH_DELAY_MS=50ms 間隔

upsertSingleBar(symbol, timeframe, bar)
// → 単一バー確定時（ignoreDuplicates: false = 値上書き可）

syncBarStoreToSupabase(barStore)
// → Gateway起動時の初回一括同期
```

**fire-and-forget:** エラー時も Gateway の通常処理をブロックしない。

---

## syncJobStore.ts

```typescript
// market_data_sync_jobs の読み書き
claimNextSyncJob(symbol?)
// → PostgreSQL のFOR UPDATE SKIP LOCKEDで atomic claim
// → PENDING → RUNNING に遷移

updateSyncJobProgress(jobId, update)
// → status/progress_pct/current_from 等を更新
```

---

## メモリ構造（Gateway in-memory）

```typescript
// barStore: 時間足ごとのバーキャッシュ
Map<"EURUSD:H1", Bar[]>  // 最新N件

// tickStore
Map<"EURUSD", Tick>

// positionStore
Position[]

// indicatorStore
Map<"EURUSD", Indicators>
```

**Supabase が Source of Truth** — Gateway のメモリはキャッシュに過ぎない。  
Gateway 再起動時は Supabase からリロードする設計。

---

## WebSocket メッセージ形式

```typescript
interface WsMessage {
  type:       string;   // "TICK" | "BAR" | "POSITIONS" | "ACCOUNT" | etc.
  symbol?:    string;
  timeframe?: string;
  data?:      unknown;
  ts:         number;   // サーバー受信時刻（UTC ms）
}
```

---

## 制約・注意事項

- **ローカル実行前提**: `http://127.0.0.1:8080` - MT5とNext.jsが同一マシン上
- **セッション境界**: UTCベースで計算（getTradingSessions関数で確認）
- **Supabase UPSERT**: `time_utc` の精度はミリ秒（TIMESTAMPTZ）
