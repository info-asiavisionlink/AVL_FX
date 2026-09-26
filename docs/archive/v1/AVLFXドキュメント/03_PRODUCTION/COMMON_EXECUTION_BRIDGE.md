# COMMON EXECUTION BRIDGE
**Status:** ARCHITECTURE CONFIRMED  
**Last Updated:** 2026-09-09  
**Audit:** ONE COMMON EXECUTION EA — 完全実装確認済み

---

## 最重要原則

**ユーザーがTrading Viewで何個EA/Strategyを作っても、MT5に入れるEAは1ファイルだけ。**

```
Trading View上:         MT5上:
EA A (Magic 20001)  ┐
EA B (Magic 20002)  ├→  AVL_ExecutionBridge.mq5
EA C (Magic 20003)  ┘   【1ファイルのみ】
```

---

## 全体フロー

```
Supabase (bar_data) — Admin Market Data Pipeline提供
    ↓
Strategy Runtime (Server-side)
    ↓ StrategySpec + Market Dataで条件評価
strategy_signals (Signal生成)
    ↓ Risk / Execution Engine
execution_commands (取引指示)
    ↓
Gateway (Railway)
    ↓
AVL_ExecutionBridge.mq5 — 1 FILE ONLY
    ↓
MT5 (ユーザーのBroker口座)
```

---

## Strategy識別

同一のCommon EAから複数Strategyを同時稼働:

| Strategy | Magic Number | Symbol | Action |
|---------|-------------|--------|--------|
| Strategy A | 20001 | EURUSD | BUY signal |
| Strategy B | 20002 | USDJPY | SELL signal |
| Strategy C | 20003 | EURUSD | BUY signal |

`strategy_id` + `magic_number` で識別。  
MT5上でもMagic Numberでポジションを区別。

---

## Execution Command Contract

```json
{
  "command_id":    "uuid (Idempotency Key)",
  "strategy_id":  "uuid",
  "connection_id": "uuid (User MT5接続)",
  "magic_number":  20001,
  "action":        "BUY | SELL | CLOSE | MODIFY_SL | MODIFY_TP",
  "symbol":        "EURUSD",
  "volume":        0.01,
  "stop_loss":     1.12345,
  "take_profit":   1.13000,
  "expires_at":    "ISO timestamp"
}
```

---

## AVL_ExecutionBridge の責務

このEAが「する」こと:
- Gateway認証 (connection_id + token)
- Heartbeat送信
- Commandポーリング (Pending)
- Atomic Claim (二重実行防止)
- Expiry確認
- BUY / SELL / CLOSE / MODIFY_SL / MODIFY_TP
- Magic Number設定（Command.magic_numberを使用）
- Position同期 → Gateway
- Deal同期 → Gateway
- Execution Result返却

このEAが「しない」こと:
- EMA/RSI等インジケーター計算
- Strategy条件評価
- バックテスト
- AI判断
- Strategyロジック保持

---

## Hedging / Netting 対応

**Hedging口座（XMはHedging）:**
- 同一SymbolでBUY/SELL両建て可能
- Magic NumberでStrategy分離
- 各Position: `position_ticket + strategy_id + magic_number` で追跡

**Netting口座:**
- 同一Symbolは統合される
- Multi Strategy Conflictに注意
- 反対方向Strategy同時稼働は制限を検討

Account Modeは接続時に自動検出。Hedging前提で設計しない。

---

## User Setup (最終理想)

```
STEP 1: AVL-FXに登録
STEP 2: MT5にAVL_ExecutionBridgeを1回だけインストール
STEP 3: Connection Token入力
STEP 4: 接続完了
          ↓
その後、EA/Strategyを何個追加しても
MT5操作不要
```

---

## EA停止セマンティクス

| 操作 | 意味 |
|------|------|
| 「停止」 | 新規Entry停止。既存PositionはBroker側SL/TP継続 |
| 「決済して停止」 | 対象StrategyのPositionをCloseしてから停止 |

Bridge自体は他のStrategyが動いている限り稼働継続。

---

## Architecture Audit結果 (2026-09-09)

| 項目 | 結果 |
|------|------|
| MQL5生成コード | NOT FOUND ✅ |
| Strategy追加でMQL5生成 | なし ✅ |
| execution_commandsの形式 | strategy_id + magic_number + connection_id ✅ |
| Signal/Command分離 | 完全分離 ✅ |
| User Isolation (API) | 全エンドポイントでuser_id確認 ✅ |
| User Isolation (RLS) | 全テーブルでPolicy実装 ✅ |
| Idempotency | command_id UNIQUE ✅ |
| Magic Number範囲 | 20001〜29999 ✅ |
| Cross-User Execution | BLOCKED ✅ |
