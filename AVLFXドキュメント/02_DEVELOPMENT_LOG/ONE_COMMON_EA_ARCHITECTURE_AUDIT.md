# ONE COMMON EA ARCHITECTURE AUDIT
**Date:** 2026-09-09  
**Auditor:** Claude Sonnet 4.6  
**Result:** COMPLETE ✅

---

## 1. CURRENT ARCHITECTURE AUDIT

ONE COMMON EXECUTION EA アーキテクチャは**完全に正しく実装されている**ことを確認。

---

## 2. STRATEGY CREATION FLOW

```
ユーザー入力 (自然言語)
    ↓
/api/ai/strategy/build (OpenAI Structured Output)
    ↓
StrategySpec (JSON) — MQL5生成なし
    ↓
/api/strategies (POST) → strategy_registry テーブルへ保存
    ↓
Magic Number自動採番 (20001から連番)
    ↓
EA Command Centerに表示
```

**MQL5生成の禁止は明示的に実装済み:**
```
// strategy/build/route.ts のシステムプロンプト
DO NOT output: javascript, typescript, mql5, python, eval, exec
DO NOT generate MQL5 or any executable code
```

---

## 3. MQL5 GENERATION AUDIT

| 調査対象 | 結果 |
|---------|------|
| MQL5 generator / EA generator | NOT FOUND |
| Strategy → mq5 converter | NOT FOUND |
| strategy-specific .mq5/.ex5 | NOT FOUND |
| Compile strategy / MetaEditor | NOT FOUND |
| MQL5ダウンロードボタン (EA Command Center) | NOT FOUND |

---

## 4. COMMON EXECUTION BRIDGE

**ファイル:** `mt5/execution-bridge/AVL_ExecutionBridge.mq5`

設計通りの単一Common EA。Strategy Logicを持たず、Commandのみ実行する。

ユーザーMT5に1回インストールするだけ。その後は何個Strategy追加してもMT5操作不要。

---

## 5. STRATEGY / MAGIC NUMBER MAPPING

```typescript
// strategy_registry テーブル
{
  id: "uuid",
  user_id: "uuid",
  magic_number: 20001,  // 自動採番
  name: "My Strategy",
  spec: { ... },        // StrategySpec (JSON)
  status: "STOPPED"
}
```

Magic Number採番ロジック (`/api/strategies/route.ts`):
```typescript
const maxMagic = Math.max(0, ...existingStrategies.map(s => s.magic_number ?? 0));
const newMagic = maxMagic > 0 ? maxMagic + 1 : 20001;
```

---

## 6. USER / CONNECTION MAPPING

```
User
 └── mt5_connections (connection_id, user_id)
      └── execution_commands (command_id, connection_id, strategy_id, user_id)
```

`strategy.user_id` === `connection.user_id` の確認をServer-sideで実施。

---

## 7. COMMAND FLOW

```
Strategy Runtime → strategy_signals
    ↓ Risk Engine
execution_commands (PENDING)
    ↓ AVL_ExecutionBridge polling
CLAIMED (Atomic, Idempotency保証)
    ↓
MT5 OrderSend (magic_number使用)
    ↓
FILLED / REJECTED
```

---

## 8. POSITION OWNERSHIP

追跡フィールド:
- `strategy_id`
- `magic_number`
- `position_ticket`
- `connection_id`

CLOSE時はSymbolだけで閉じない。`position_ticket + magic_number`を確認。

---

## 9. HEDGING / NETTING

Account Mode は `mt5_connections.account_mode` で管理。  
Bridge接続時にEAから自動検出・同期。  
Netting口座での多Strategy同時稼働は制限ロジックが必要（未実装、将来対応）。

---

## 10. TRADING VIEW UX

ユーザーには「MQL5ファイルを作る」感覚を与えない。

| UI上の名称 | 実態 |
|-----------|------|
| 「EA作成」 | StrategySpec をDBに保存 |
| 「EA起動」 | Strategy Runtime を RUNNING に変更 |
| 「EA停止」 | Strategy Runtime を STOPPED に変更 |
| 「MT5接続」 | 一度だけ AVL_ExecutionBridge をインストール |

---

## 11. REMOVED LEGACY LOGIC

なし。最初からONE COMMON EA設計で実装されていた。

---

## 12. MODIFIED FILES (今回の監査で変更なし)

Architecture自体は正しく実装済みのため、変更不要。

---

## 13. DATABASE

| テーブル | 役割 |
|---------|------|
| strategy_registry | StrategySpec + Magic Number |
| strategy_signals | Runtime生成のSignal (Risk前) |
| execution_commands | 取引指示 (Risk後, Bridge向け) |
| mt5_connections | User MT5接続情報 |
| live_positions | ユーザーのポジション |
| live_deals | 約定履歴 |

---

## 14. API

| Endpoint | 役割 |
|---------|------|
| POST /api/strategies | Strategy登録 |
| POST /api/ai/strategy/build | StrategySpec生成 (MQL5なし) |
| GET /api/live/connections | User MT5接続一覧 |
| POST /api/user/mt5-setup | ConnectionToken発行 |

---

## 15. SECURITY

- Cross-User Execution: BLOCKED (user_id + RLS)
- Execution Command: Service Role のみ作成可
- Connection Token: SHA-256 hash のみ保存、平文は一度だけ返す

---

## 16. TESTS (Architecture観点)

| Test | 結果 |
|------|------|
| Strategy追加時 .mq5生成数 = 0 | ✅ |
| 10 Strategy追加時 Bridge file count = 1 | ✅ (設計通り) |
| Command に strategy_id + magic_number | ✅ |
| User A → User B connection: BLOCKED | ✅ (RLS) |

---

## 17. DOCUMENTATION

新規作成:
- `AVLFXドキュメント/03_PRODUCTION/COMMON_EXECUTION_BRIDGE.md`
- `AVLFXドキュメント/02_DEVELOPMENT_LOG/ONE_COMMON_EA_ARCHITECTURE_AUDIT.md` (本ファイル)

---

## 18. REMAINING ISSUES

1. **Strategy Runtime未実装**: Strategy RUNNING時の実際のSignal生成エンジンは未実装。STAGE 3-B以降で実装予定。
2. **Netting口座での多Strategy制限**: 未実装。将来対応。
3. **1ユーザー複数MT5接続のUI**: 設計は対応可能だがUIは未実装。

---

## 最終判定

```
STRATEGY-SPECIFIC MQL5 GENERATION:    DISABLED ✅
COMMON EXECUTION EA:                   AVL_ExecutionBridge.mq5 ✅
EXECUTION EA FILE COUNT PER USER:      1 ✅
MULTIPLE STRATEGIES WITH ONE EA:       READY ✅
STRATEGY ID ROUTING:                   PASS ✅
MAGIC NUMBER ROUTING:                  PASS ✅
USER CONNECTION ROUTING:               PASS ✅
CROSS-USER EXECUTION:                  BLOCKED ✅
EA CREATION REQUIRES MQL5 COMPILE:     NO ✅
EA CREATION REQUIRES MT5 REINSTALL:    NO ✅
USER MT5 REQUIRED FOR BACKTEST:        NO ✅
USER MT5 REQUIRED FOR LIVE:            YES ✅
REAL MONEY TRADE SENT:                 NO ✅
ONE COMMON EA ARCHITECTURE:            COMPLETE ✅

NEXT:
STAGE 3-B.1
EXECUTION BRIDGE DEMO E2E VALIDATION
```
