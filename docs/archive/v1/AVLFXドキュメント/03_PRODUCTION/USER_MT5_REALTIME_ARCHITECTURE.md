# USER MT5 REALTIME ARCHITECTURE
**Status:** IMPLEMENTED (Phase A完了)  
**Last Updated:** 2026-09-10  
**Version:** Multi-User Namespace v1.0

---

## 概要

1つのRailway GatewayでUser AとUser Bのデータを完全に分離するアーキテクチャ。

```
USER A MT5
  └── AVL_FX_Bridge.ex5
        ├── Connection ID A
        └── Token A
              ↓
RAILWAY GATEWAY
  └── connections[A] = { ticks, bars, account, positions }
              ↓
AVLFX Trading View
  └── User A のみ表示

USER B MT5
  └── AVL_FX_Bridge.ex5
        ├── Connection ID B
        └── Token B
              ↓
同じ RAILWAY GATEWAY
  └── connections[B] = { ticks, bars, account, positions }
              ↓
AVLFX Trading View
  └── User B のみ表示
```

---

## データソース正式仕様

| データ | Source | User MT5必要？ |
|--------|--------|--------------|
| Realtime Tick/Bar | User 自身の MT5 | **YES** |
| Realtime Account | User 自身の MT5 | **YES** |
| Positions/Deals | User 自身の MT5 | **YES** |
| Backtest Historical | Admin MT5 → Supabase bar_data | NO |
| Calendar | Forex Factory API | NO |
| News | RSS (Yahoo/FXStreet/ForexLive) | NO |
| EA作成・AI Builder | — | NO |
| EA起動・自動売買 | — | **YES** |

---

## User Bridge (AVL_FX_Bridge.ex5) v4.0

### ユーザー配布ファイル
```
Source: ea/AVL_FX_Bridge.mq5 (v4.0)
Distribution: apps/trading-view/public/ea/AVL_FX_Bridge.ex5
※ v4.0のex5を生成するにはMetaEditorでのコンパイルが必要
```

### 入力パラメーター
| パラメーター | 説明 | 取得方法 |
|------------|------|---------|
| `InpServerURL` | Gateway URL | /mt5ページから |
| `InpServerSecret` | Gateway Secret | 管理者から |
| `InpConnectionId` | Connection ID (UUID) | /mt5ページから |
| `InpConnectionToken` | Connection Token (hex) | /mt5ページで発行（一度のみ表示） |

### 認証ヘッダー（全リクエスト）
```
Authorization: Bearer {InpServerSecret}
X-Connection-Id: {InpConnectionId}
X-Connection-Token: {InpConnectionToken}
```

### Bridgeが送信するデータ
| ストリーム | エンドポイント | 頻度 |
|-----------|-------------|------|
| Tick | POST /bridge/ticks | OnTick (throttle 100ms) |
| Bar (realtime) | POST /bridge/bars | OnTick (新バー確定時) |
| Bar (bulk) | POST /bridge/bars/bulk | 起動時 + 10分ごと |
| Account | POST /bridge/account | 5秒ごと |
| Positions (全シンボル) | POST /bridge/positions | 5秒ごと |
| Deals | POST /bridge/deals | 5分ごと + 起動時 |
| Heartbeat + account | POST /bridge/heartbeat | 5秒ごと |
| Indicators | POST /indicators | 30秒ごと |

### Bridgeが受信するコマンド
| アクション | エンドポイント | 対応 |
|-----------|-------------|------|
| BUY / SELL | GET /execution-commands/pending | ✅ |
| CLOSE | GET /execution-commands/pending | ✅ |
| MODIFY_SL / MODIFY_TP | GET /execution-commands/pending | ✅ |

### WebRequest許可リスト設定
MT5で必須: `ツール → オプション → EA → WebRequest許可リスト`に Gateway URLを追加

---

## Gateway Connection Namespace

### 変更内容
従来のグローバルstate（全User共通）を廃止し、per-connection stateを追加。

```typescript
// Before（全User共通 → 危険）
const tickStore   = new Map<string, Tick>();     // "EURUSD" → Tick
let   account     = Account | null;             // 最後のEAのデータ

// After（per-connection → 安全）
const connections = new Map<string, ConnectionState>();
// connections["user-a-uuid"]["ticks"]["EURUSD"] = Tick A
// connections["user-b-uuid"]["ticks"]["EURUSD"] = Tick B
```

### ConnectionState構造
```typescript
interface ConnectionState {
  connectionId:    string;
  userId:          string;
  ticks:           Map<string, Tick>;       // symbol → Tick
  bars:            Map<string, Bar[]>;      // "SYMBOL:TF" → Bar[]
  account:         Account | null;
  positions:       Position[];
  indicators:      Map<string, Indicators>;
  lastHeartbeatAt: number;
  isOnline:        boolean;
}
```

### 新規Bridgeエンドポイント
| Method | Path | 認証 | 用途 |
|--------|------|------|------|
| POST | /bridge/ticks | Bearer + X-Connection-Id + X-Connection-Token | User Tick受信 |
| POST | /bridge/bars | Bearer + X-Connection-Id + X-Connection-Token | User Bar受信 |
| POST | /bridge/bars/bulk | Bearer + X-Connection-Id + X-Connection-Token | User Bars一括受信 |
| POST | /bridge/account | Bearer + X-Connection-Id + X-Connection-Token | User Account受信 |

### 新規読み取りエンドポイント（Trading View API用）
| Method | Path | 認証 | 用途 |
|--------|------|------|------|
| GET | /connections | Bearer | 全接続一覧 |
| GET | /connections/:id/status | Bearer | 接続状態 |
| GET | /connections/:id/ticks/:symbol | Bearer | User Tick取得 |
| GET | /connections/:id/bars/:symbol/:tf | Bearer | User Bars取得 |
| GET | /connections/:id/account | Bearer | User Account取得 |
| GET | /connections/:id/positions | Bearer | User Positions取得 |

### WebSocket Connection-Scoped Subscribe
```javascript
// ブラウザから接続IDをSubscribe
ws.send(JSON.stringify({ type: "SUBSCRIBE_CONNECTION", connectionId: "xxx" }));
// → Connection xのTick/Bar/AccountのみこのWS clientに届く
```

### Stale Cleanup
- 2分間Heartbeatなし → `isOnline = false`
- 10分間Heartbeatなし → in-memoryから削除（DB履歴は保持）

### Admin Endpointは維持
旧エンドポイント（/tick, /bar, /account, /positions等）はAdmin DataManager用に維持。
Backtest用bar_dataパイプラインは変更なし。

---

## Trading View API（新規）

| Path | 説明 |
|------|------|
| GET /api/live/connection/status | User接続状態（Supabase + Gateway合成） |
| GET /api/live/connection/account | User口座情報（Gateway proxy） |
| GET /api/live/connection/ticks?symbol= | UserのTick（Gateway proxy） |

全API: Supabase sessionでUser認証 → connection ownership確認 → Gateway proxy

---

## MT5接続ゲート

MT5未接続では以下の機能がLOCK:

| 機能 | 状態 |
|------|------|
| リアルタイムチャート (/chart) | LOCKED - MT5接続が必要 |
| ポジション・口座 (/positions) | LOCKED - MT5接続が必要 |
| EA起動・自動売買 | LOCKED（EA起動ボタン disabled + MT5必須） |

以下はMT5なしで利用可能:

| 機能 | 状態 |
|------|------|
| EA作成・AI Builder | AVAILABLE |
| バックテスト | AVAILABLE (Supabase bar_data) |
| カレンダー | AVAILABLE |
| ニュース | AVAILABLE |
| Research | AVAILABLE |

---

## Multi-User Isolation Test

```bash
# Gatewayをローカルで起動後:
npx tsx scripts/gateway-multi-connection-test.ts
```

テスト内容:
1. Tick Isolation — User AのBid 1.1000 が User Bに漏れないこと
2. Account Isolation — User AのBalance 10000 が User Bに漏れないこと
3. Bar Isolation — User AのChartデータが User Bに漏れないこと
4. Connection Status — 各ConnectionのStatusが独立していること
5. Connection List — /connectionsで両接続が見えること
6. Admin Global State — 旧エンドポイントが動作すること

---

## Security

| 脅威 | 対策 |
|------|------|
| Cross-user tick exposure | Gateway: connection_id namespace分離 |
| Cross-user account exposure | Trading View API: Server-side ownership確認 |
| Cross-user command injection | execution_commands: connection_id + user_id照合 |
| Token replay | SHA-256 hash storage / 一度のみ平文表示 |
| Unauthorized gateway access | Bearer + X-Connection-Token 二重認証 |

---

## 現在の制限事項

1. **.ex5の再コンパイル必要**: v4.0 .mq5ソースはあるが、MetaEditorでのコンパイルが必要。現在public/ea/のex5はv3.11。
2. **WebSocket User Channel**: Subscribe後のFilter実装済みだが、Supabase sessionによるSubscription認可なし（ConnectionIdは半公開）
3. **Horizontal Scaling**: In-memory state（connections Map）はGateway1インスタンスのみ対応。水平スケール時はRedis等の共有stateが必要。
4. **EA起動ボタン**: disabled状態維持（STAGE 5で実装予定）

---

## 次フェーズ: STAGE 3-B.1 DEMO E2E

実際のMT5でBridge v4.0（コンパイル後）を接続し:
- User固有のTick/Bar/Account/Positionが届くことを確認
- MT5接続ゲートが正しく機能することを確認
- 複数ユーザー同時接続の実証テスト
