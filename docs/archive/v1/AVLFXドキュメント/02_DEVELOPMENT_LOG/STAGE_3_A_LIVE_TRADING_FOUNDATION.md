# STAGE 3-A: Live Trading Foundation
**完了日:** 2026-09-03  
**目的:** 共通Execution Bridge EA方式に向けた共通データモデル・Contract・Runtime State基盤の確立  
**実装モード:** Data Model Only — リアル注文ゼロ

---

## 1. PRE-IMPLEMENTATION CASE判定

| コンポーネント | CASE | 判断根拠 |
|--------------|------|---------|
| Gateway Order Queue | **C** | in-memoryで状態管理なし・idempotencyなし。既存エンドポイントを維持しつつ新Execution Command層を新設 |
| strategy_registry | **A** | magic_number/status/user_id既存。拡張のみ |
| 既存domain types (TradeProposal等) | **A** | AI Brain用として共存。Live Trading用を新設 |
| Supabase RLS | **A** | 既存パターン（user_id = auth.uid()）を踏襲 |

---

## 2. CURRENT ORDER QUEUEとの関係

**既存エンドポイント（維持）:**
- `GET /orders/pending` — in-memory Queue。DataManagerがポーリング
- `POST /orders/:id/result` — 実行結果受信
- `POST /orders` — 注文追加

**新しい層（追加）:**
- `execution_commands` テーブル — DB永続化・状態機械・idempotency
- STAGE 3-Bで Bridge EA → 新エンドポイントへ移行予定
- 既存エンドポイントは後方互換のため即座には削除しない

---

## 3. 新規作成ファイル

### Database Migrations
| ファイル | 内容 |
|---------|------|
| `supabase/migrations/016_mt5_connections.sql` | MT5接続管理テーブル |
| `supabase/migrations/017_execution_commands.sql` | 注文Contract・State Machine |
| `supabase/migrations/018_strategy_signals.sql` | Signal記録・監査証跡 |
| `supabase/migrations/019_strategy_runtime_state.sql` | Runtime実行状態 |
| `supabase/migrations/020_live_positions_deals.sql` | Position/Deal Mirror |

### TypeScript Domain
| ファイル | 内容 |
|---------|------|
| `src/domain/live-trading/types.ts` | 全Domain Types |
| `src/domain/live-trading/schemas.ts` | Zodバリデーションスキーマ |
| `src/domain/live-trading/commandStateMachine.ts` | State Machine実装 |
| `src/domain/live-trading/__tests__/commandStateMachine.test.ts` | 59テスト |
| `src/domain/live-trading/__tests__/schemas.test.ts` | 31テスト |

### API Routes（Read-Only / Foundation）
| エンドポイント | 説明 |
|--------------|------|
| `GET /api/live/connections` | MT5接続一覧 |
| `POST /api/live/connections` | 接続登録（Connection Token発行） |
| `GET /api/live/strategies/[id]/runtime` | Runtime State取得 |
| `GET /api/live/positions` | Live Position一覧（OPENのみ） |

---

## 4. 新規テーブル

### mt5_connections
```
id, user_id, connection_token_hash, broker, server_name, mt5_login,
account_currency, account_type (REAL/DEMO), account_mode (HEDGING/NETTING),
leverage, status, emergency_stop, trading_enabled,
last_heartbeat_at, connected_at, disconnected_at, created_at, updated_at
UNIQUE: (user_id, mt5_login, server_name)
```

### execution_commands
```
id, command_id (UNIQUE, Idempotency Key),
user_id, connection_id, strategy_id, magic_number, signal_id,
action (BUY/SELL/CLOSE/MODIFY_SL/MODIFY_TP), symbol, volume,
requested_price, stop_loss, take_profit, position_ticket, order_ticket,
status (state machine), created_at, expires_at, claimed_at, executed_at, completed_at,
attempt_count, broker_order_ticket, broker_deal_ticket, broker_position_ticket,
execution_price, executed_volume, error_code, error_message, metadata
```

### strategy_signals
```
id, strategy_id, connection_id, symbol, timeframe, direction,
signal_time, bar_time, reference_price, suggested_sl, suggested_tp,
execution_status, command_id, reason, metadata, created_at
```

### strategy_runtime_state
```
strategy_id (PK), connection_id, runtime_status,
started_at, stopped_at, last_evaluated_at, last_signal_at, last_bar_time,
last_error, runtime_version, created_at, updated_at
```

### live_positions
```
id, user_id, connection_id, strategy_id, magic_number,
position_ticket, symbol, direction, volume, open_price, current_price,
stop_loss, take_profit, unrealized_pnl, commission, swap,
opened_at, closed_at, status, open_command_id, close_command_id, last_synced_at
UNIQUE: (connection_id, position_ticket)
```

### live_deals
```
id, user_id, connection_id, strategy_id, magic_number,
deal_ticket, order_ticket, position_ticket, symbol, deal_type, entry_type,
volume, price, profit, commission, swap, deal_time, command_id, synced_at
UNIQUE: (connection_id, deal_ticket)
```

---

## 5. Execution Command Contract

```typescript
// BUY/SELL: volume必須
// CLOSE: positionTicket必須
// MODIFY_SL: positionTicket + stopLoss必須
// MODIFY_TP: positionTicket + takeProfit必須

interface CreateExecutionCommandInput {
  commandId:       string;   // UUIDv4 (Idempotency Key)
  connectionId:    string;
  strategyId:      string;
  magicNumber:     number;   // 20001〜29999
  action:          "BUY" | "SELL" | "CLOSE" | "MODIFY_SL" | "MODIFY_TP";
  symbol:          string;   // 英大文字のみ (例: "EURUSD")
  volume?:         number;   // > 0
  stopLoss?:       number;
  takeProfit?:     number;
  positionTicket?: number;
  expiresAt:       string;   // ISO (必須、未来であること)
}
```

---

## 6. Command State Machine

```
PENDING → CLAIMED, EXPIRED, CANCELLED
CLAIMED → EXECUTING, FAILED, REJECTED, CANCELLED
EXECUTING → FILLED, FAILED, REJECTED

Terminal States（再遷移不可）:
  FILLED / REJECTED / FAILED / EXPIRED / CANCELLED
```

---

## 7. Idempotency

- `command_id` に DB UNIQUE制約 → 同一コマンドの二重登録不可
- Terminal Stateに到達したCommandへの遷移を`canTransition()`でreject
- Gateway/EAが同一`command_id`を再取得しても、DB状態確認により再注文しない設計

---

## 8. Expiry

- `expires_at` 必須フィールド
- `isExpired()` / `shouldExpire()` でPENDING + 期限切れを検出
- Bridge EAは`expires_at`確認後、期限切れなら MT5へ送信せずEXPIREDと返却

---

## 9. Source of Truth の明確化

| データ | Source of Truth |
|-------|-----------------|
| Market Price | MT5 |
| Account / Position / Order / Deal | MT5 / Broker |
| Strategy Definition | AVL-FX strategy_registry |
| Strategy Runtime State | AVL-FX strategy_runtime_state |
| Signal | AVL-FX strategy_signals |
| Execution Command | AVL-FX execution_commands |
| Live DB Position | MT5 Position の Mirror（定期同期が必要） |

---

## 10. Security / RLS

| テーブル | RLS方針 |
|---------|---------|
| mt5_connections | user_idで完全分離。connection_token_hashのみ保存（平文なし） |
| execution_commands | 認証ユーザーは直接作成不可（Service Role経由のみ） |
| strategy_signals | 自分のStrategyのSignalのみ参照可 |
| strategy_runtime_state | 自分のStrategyのStateのみ参照可 |
| live_positions / live_deals | user_idで完全分離 |

---

## 11. テスト結果

```
State Machine Tests: 59/59 PASS
Schema Tests:        31/31 PASS
Backtest Regression: 37/37 PASS（既存テスト）
Live Order Sent:     0件（意図通り）
```

---

## 12. STAGE 3-B へのギャップ

STAGE 3-Bで実装が必要なもの：

1. **AVL Execution Bridge EA（MQL5）**
   - Command受信（GET /execution-commands/pending）
   - BUY/SELL/CLOSE実行（CTrade）
   - Magic Number設定
   - 実行結果返却（POST /execution-commands/:id/result）
   - Expiry確認ロジック
   - command_id重複防止

2. **Gateway拡張**
   - `/execution-commands/pending` エンドポイント追加
   - `/execution-commands/:id/result` エンドポイント追加
   - execution_commandsをDBから取得（現在のin-memory Queueを置換）

3. **Bridge EA認証**
   - Connection Token → connection_token_hash 照合
   - MT5 AccountとAVL Userのpairing確認

---

## 最終判定

```
LIVE TRADING DATA MODEL:      READY
EXECUTION COMMAND CONTRACT:   READY
EXECUTION RESULT CONTRACT:    READY
MT5 CONNECTION MODEL:         READY
STRATEGY RUNTIME STATE:       READY
IDEMPOTENCY FOUNDATION:       READY
MULTI-STRATEGY DATA MODEL:    READY
EMERGENCY STOP FOUNDATION:    READY (emergency_stop フラグ + trading_enabled)
LIVE ORDER SENT:              NO（意図通り）
STAGE 3-A:                    COMPLETE
NEXT:                         STAGE 3-B — AVL EXECUTION BRIDGE EA (MQL5)
```
