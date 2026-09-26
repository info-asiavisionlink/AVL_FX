# STAGE 3-B: AVL Execution Bridge EA
**完了日:** 2026-09-03  
**目的:** 共通Execution Bridge EAによるMT5 Demo注文実行パイプラインの完成

---

## 1. PRE-IMPLEMENTATION AUDIT

**CASE判定: CASE B** — AVL_DataManager_v2.mq5はMarket Data専用として維持し、`AVL_ExecutionBridge.mq5`を新規作成。

理由:
- DataManagerは7 Streams + HistorySync + DataSyncで責務が大きく、Execution Bridgeを混在させると責務が不明確になる
- Execution Bridgeを別EAにすることで、両者を独立してデプロイ・テスト・デバッグできる
- 既存DataManagerの`OrderStream_Poll()`は簡易版（Idempotencyなし・Expiry未対応）なので、新しいContractに適合しない

---

## 2. Bridge Architecture

```
AVL-FX Server
  ↓ execution_commands (DB)
  ↓
Gateway (Railway)
  ← POST /bridge/heartbeat      ← Bridge EA
  → GET  /execution-commands/pending → Bridge EA
  ← POST /execution-commands/:id/claim
  ← POST /execution-commands/:id/result
  ← POST /bridge/positions
  ← POST /bridge/deals
  ↓
Supabase
  execution_commands / live_positions / live_deals / mt5_connections
  ↓
AVL-FX (ダッシュボード)
```

---

## 3. 新規ファイル

| ファイル | 役割 |
|---------|------|
| `ea/AVL_ExecutionBridge.mq5` | 共通Execution Bridge EA（Strategyロジックなし） |
| `gateway/src/executionStore.ts` | Supabase連携モジュール（認証・Command管理・同期） |
| `scripts/dev-create-test-command.ts` | Demo E2Eテスト用コマンド作成ユーティリティ |

## 4. 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `gateway/src/index.ts` | Execution Bridge専用エンドポイント追加（7エンドポイント） |

---

## 5. Safety Design決定事項

| 状態 | BUY/SELL | CLOSE | MODIFY |
|------|---------|-------|--------|
| `trading_enabled=false` | ❌ 停止 | ❌ 停止 | ❌ 停止 |
| `emergency_stop=true` | ❌ 停止 | ✅ 許可 | ✅ 許可 |
| 通常 | ✅ | ✅ | ✅ |

**理由:** emergency_stopは「新規リスクを止める」ものであり、既存ポジションのCLOSEを禁止するとリスクが増大する。trading_enabled=false は完全な取引停止（メンテナンスモード）。

---

## 6. Gateway新規エンドポイント

| Method | Path | 役割 |
|--------|------|------|
| POST | /bridge/heartbeat | Safety flags更新・返却 |
| POST | /bridge/disconnect | 切断通知 |
| GET | /execution-commands/pending | PENDING Command取得 |
| POST | /execution-commands/:id/claim | Atomic Claim（PENDING→CLAIMED） |
| POST | /execution-commands/:id/result | Result提出 |
| POST | /bridge/positions | live_positions Upsert |
| POST | /bridge/deals | live_deals Upsert |

---

## 7. Authentication

| レイヤー | 内容 |
|---------|------|
| Layer 1 | `Authorization: Bearer <MT5_GATEWAY_SECRET>` |
| Layer 2 | `X-Connection-Id` + SHA-256(`X-Connection-Token`) = `mt5_connections.connection_token_hash` |

- Connection Tokenは平文でDB保存しない
- ログにConnection Tokenを出力しない
- 認証失敗時はCommandを一切返さない

---

## 8. Idempotency

- **In-memory cache:** 処理済み `command_id` をEAセッション中保持（最大1000件、FIFO）
- **Atomic Claim:** `UPDATE WHERE status='PENDING'` — 0行更新 = 既に別プロセスがClaim
- **DB Status確認:** ClaimがTrueでもDBのStatusを信頼

---

## 9. E2Eテストシナリオ手順

DEMO口座でテストする手順:

```bash
# 1. Connection登録（AVL-FX UIまたはAPI）
# → connectionId, connectionToken を取得

# 2. テストコマンド作成
npx tsx scripts/dev-create-test-command.ts \
  --connection-id <UUID> \
  --strategy-id   <UUID> \
  --action        BUY \
  --symbol        EURUSD \
  --magic         20001 \
  --volume        0.01 \
  --sl            1.08000 \
  --tp            1.09000

# 3. Bridge EA起動（MT5 DEMO口座にアタッチ）
# → 5秒以内にCommandが処理される

# 4. 結果確認
# Supabase: SELECT * FROM execution_commands WHERE command_id = '...';
# Supabase: SELECT * FROM live_positions;
# Supabase: SELECT * FROM live_deals;

# 5. CLOSE テスト
npx tsx scripts/dev-create-test-command.ts \
  --connection-id <UUID> \
  --strategy-id   <UUID> \
  --action        CLOSE \
  --symbol        EURUSD \
  --magic         20001 \
  --position-ticket <ticket>
```

---

## 10. STAGE 3-C へのギャップ

| コンポーネント | 状態 | STAGE 3-C必要事項 |
|--------------|------|----------------|
| Server-side Strategy Runtime | ❌ 未実装 | リアルタイム評価ループ |
| Signal Engine | ❌ 未実装 | StrategyEvaluator → Signal生成 |
| Execution Engine | ❌ 未実装 | Signal → Risk → Command |
| Runtime自動起動 | ❌ 未実装 | Strategy ACTIVE → Runtime起動 |

---

## 最終判定

```
AVL EXECUTION BRIDGE:         READY
COMMAND POLLING:               READY
COMMAND CLAIM (Atomic):        READY
BUY EXECUTION:                 READY
SELL EXECUTION:                READY
CLOSE EXECUTION:               READY (position_ticket + magic確認)
MAGIC NUMBER:                  READY
IDEMPOTENCY:                   READY (in-memory + Atomic Claim)
EXPIRY:                        READY
EMERGENCY STOP:                READY (BUY/SELL停止・CLOSE許可)
POSITION SYNC:                 READY
DEAL SYNC:                     READY
EXECUTION RESULT RETURN:       READY
DEMO E2E:                      READY TO RUN（MT5 DEMOへのアタッチが必要）
REAL MONEY TRADE SENT:         NO
STAGE 3-B:                     COMPLETE
NEXT:                          STAGE 3-C — SERVER-SIDE STRATEGY RUNTIME
```
