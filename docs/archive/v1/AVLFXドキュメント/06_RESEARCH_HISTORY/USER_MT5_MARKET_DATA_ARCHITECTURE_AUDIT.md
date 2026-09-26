# USER_MT5_MARKET_DATA_ARCHITECTURE_AUDIT

作成日: 2026-09-10
調査者: Claude Code (自動監査)
調査方針: 実コードのみ根拠。推測禁止。

---

## 1. EXECUTIVE SUMMARY

AVL-FXのMT5連携は **「共通EA + 単一Railway Gateway + Supabase」** の3層アーキテクチャを設計として採用している。  
ただし現時点での実装は **完全ではなく**、以下の重大な差異が存在する。

- **ダウンロードEA（AVL_FX_Bridge.ex5）は認証なしのシンプルBridgeである**  
  InpServerSecret をHeaderに付けるが、connection_id / connection_token の仕組みは未実装。
  Gateway側の `/bridge/*` エンドポイントは実装されているが、配布EAはそれを使わない。

- **チャートのHistorical DataはAdmin MT5のデータ（Supabaseのbar_data）を共有参照**  
  ユーザー固有のチャートではなく、全ユーザーが同一の管理者MT5データを参照している。

- **EA「起動」ボタンは disabled（未実装）**  
  コードコメントに「STAGE 5 で実装予定」と明記されている。

- **Execution CommandのパスはDB設計まで完成しているが、実際のコマンド発行ロジックは未実装**  
  Strategy Signal → Command Insert の部分が欠落している。

---

## 2. CURRENT USER MT5 FLOW（現状）

```
ユーザー
  └─ /mt5 ページ でEAをダウンロード
  └─ MT5に AVL_FX_Bridge.ex5 を配置
  └─ InpServerURL = Gateway URL を設定
  └─ InpServerSecret = Connection Token を設定（UIから発行）
  └─ EA起動
       ↓
EA（AVL_FX_Bridge.mq5 v3.11）
  POST /connect          → Gateway グローバルstateに eaInfo を書き込み
  POST /tick             → Gateway tickStore (グローバル)
  POST /bar              → Gateway barStore (グローバル) → Supabase bar_data（シンボル:TF keyのみ）
  POST /bars/bulk        → Gateway barStore + Supabase bar_data
  POST /positions        → Gateway グローバル positions[]
  POST /account          → Gateway グローバル account
  POST /heartbeat        → Gateway heartbeatStore (per-symbol)
  POST /indicators       → Gateway indicatorStore (グローバル)
  POST /history/bulk     → Gateway historyStore (グローバル)
  GET  /orders/pending   → orderQueue をポーリング（BUY/SELL実行）

Gateway（Railway、単一インスタンス）
  すべてのデータはグローバルstate（Map/変数）に保存
  connection_idによる分離なし
       ↓
Browser（ユーザー）
  WebSocket /ws → Tick/Bar/Position/Account/Indicator をブロードキャスト受信
                  ← 全接続EAのデータが全ユーザーに流れる
```

**現在のUser MT5 Flowの問題点：**
- GatewayのstateはすべてGlobal（connection_idでnamespaceされていない）
- User AのEAが送ったtickerデータはUser Bにも見える
- AVL_FX_Bridge.ex5はconnection_id / connection_tokenを送信しない

---

## 3. CURRENT ADMIN MT5 FLOW

```
Admin MT5（管理者が運用）
  → AVL_FX_Bridge.mq5 を Gateway に接続
  → bar_data を Supabase に永続化

全ユーザー
  → BacktestService が Supabase bar_data を参照
  → /api/datafeed が Supabase bar_data を参照（TradingView Datafeed）
  → AVLChart が /api/mt5/bars/simple → Gateway barStore を参照（リアルタイム）
```

---

## 4. DOWNLOADED EA FILE

| 項目 | 内容 |
|------|------|
| ダウンロードファイル | `AVL_FX_Bridge.ex5` (54,056 bytes) |
| 配置パス | `/apps/trading-view/public/ea/AVL_FX_Bridge.ex5` |
| 対応ソース | `/ea/AVL_FX_Bridge.mq5` (バージョン v3.11) |
| MT5ページのURL | `/ea/AVL_FX_Bridge.ex5` → `download="AVL_FX_Bridge.ex5"` |
| 実際のDL先 | `apps/trading-view/public/ea/AVL_FX_Bridge.ex5` |

注意: `/ea/` ディレクトリにも同名ファイルが存在するが、Webから配信されるのは `public/ea/` 内のもの。  
ソースは `/ea/AVL_FX_Bridge.mq5` と `/mt5/execution-bridge/AVL_FX_Bridge.mq5` の2箇所にコピーが存在する（内容が同一かは確認していない）。

---

## 5. BRIDGE EA CAPABILITIES

### AVL_FX_Bridge.mq5 v3.11 各機能の実装状況

| 機能 | 状態 | 詳細 |
|------|------|------|
| **AUTH** | PARTIAL | InpServerSecret をBearer Headerに付けて送信する。ただし connection_id / connection_token は送信しない。Bridge EA認証（verifyBridgeAuth）は使用していない |
| **HEARTBEAT** | IMPLEMENTED | `OnTimer()` 毎に `POST /heartbeat` を送信。per-symbol heartbeatStore に記録される |
| **MARKET DATA (Tick)** | IMPLEMENTED | `OnTick()` 毎にスロットリング付きで `POST /tick` 送信。bid/ask/spread/digits/time を送信 |
| **MARKET DATA (Bar)** | IMPLEMENTED | 全8時間足(M1,M5,M15,M30,H1,H4,D1,W1)の現在バーをOnTickで送信。新バー確定時は前バーも送信 |
| **MARKET DATA (Bulk)** | IMPLEMENTED | 起動時 + 600秒毎に `POST /bars/bulk` で過去500本を一括送信 |
| **ACCOUNT** | IMPLEMENTED | `OnTimer()` 毎に login/broker/currency/balance/equity/margin/freeMargin/marginLevel/leverage を `POST /account` |
| **POSITIONS** | IMPLEMENTED | `OnTimer()` 毎に現在シンボルのポジションを `POST /positions`（全口座ではなく現在チャートのシンボルのみ） |
| **DEALS（取引履歴）** | IMPLEMENTED | `OnTimer()` 毎に最大100件の決済Dealを `POST /history/bulk`（30日分、500秒毎） |
| **INDICATORS** | IMPLEMENTED | EMA21/EMA200/ATR14 × H4,H1,M15,M5 を30秒毎に `POST /indicators` |
| **EXECUTION（BUY/SELL）** | IMPLEMENTED | `GET /orders/pending` をポーリングして `CTrade.Buy()/Sell()` を実行。結果を `POST /orders/{id}/result` |
| **EXECUTION（CLOSE）** | NOT IMPLEMENTED | `/orders/pending` のコードはdirection="BUY"|"SELL"のみ対応。CLOSE/MODIFY_SLは未実装 |
| **Bridge認証エンドポイント使用** | NOT IMPLEMENTED | `/bridge/heartbeat`, `/execution-commands/pending` 等の新エンドポイントを使っていない |
| **Connection ID送信** | NOT IMPLEMENTED | X-Connection-Id / X-Connection-Token ヘッダを送信しない |

---

## 6. MARKET DATA UPLOAD

```
EA → Gateway (HTTP POST, InpServerSecret認証)
  POST /tick        → tickStore["SYMBOL"] = Tick（Global）
  POST /bar         → barStore["SYMBOL:TF"] upsert + Supabase（Global）
  POST /bars/bulk   → barStore["SYMBOL:TF"] replace + Supabase（Global）
  POST /indicators  → indicatorStore["SYMBOL"] = Indicators（Global）

Gateway → Supabase
  bar_data テーブル: symbol, timeframe, time_utc, open, high, low, close, volume
  upsert onConflict=(symbol,timeframe,time_utc)
  fire-and-forget（Gatewayレスポンスをブロックしない）

Gateway → Browser (WebSocket broadcast)
  type=TICK, BAR → 全WebSocket clientにbroadcast（User分離なし）
```

---

## 7. ACCOUNT DATA

```
EA
  POST /account → Gateway
    account = { login, broker, currency, balance, equity, margin, freeMargin, marginLevel, leverage }
    （グローバル変数 let account: Account | null）

Gateway
  GET /account (auth必須) → account を返す
  WebSocket broadcast: type=ACCOUNT → 全clientにbroadcast

Browser
  GatewayClient.onAccount() → AccountHandler呼び出し
  → PositionsView.tsx でリアルタイム表示

問題:
  - account はGlobal変数（connection_id不分離）
  - User AのEAが送ったAccountはUser Bにも見える
  - ただし GET /account はBearer認証必須（Secret知っていれば誰でも取得可能）
```

**Bridge経由（新エンドポイント）:**
- `POST /bridge/heartbeat` では connection_id + token + 残高情報を受け取り Supabase mt5_connections を更新する設計
- しかし AVL_FX_Bridge.ex5 はこのエンドポイントを使わない

---

## 8. POSITION / DEAL DATA

```
Position（Current Symbol Only）:
  EA: for(int i=0; i<PositionsTotal(); i++) { if(PositionGetString(POSITION_SYMBOL) != g_Symbol) continue; }
  → 現在チャートのシンボルのポジションのみ送信
  → POST /positions → positions[] グローバル配列
  → WebSocket broadcast: type=POSITIONS

Deal（取引履歴）:
  EA: HistorySelect → DEAL_ENTRY_OUT + DEAL_ENTRY_INOUT のみ → POST /history/bulk
  → historyStore["SYMBOL"] = Map<ticket, Deal>（グローバル）

Bridge経由（新エンドポイント・別パス）:
  POST /bridge/positions → upsertPositions(connectionId, userId, positions[])
    → Supabase live_positions（connection_id, user_id でRLS分離）
  POST /bridge/deals → upsertDeals(connectionId, userId, deals[])
    → Supabase live_deals（connection_id, user_id でRLS分離）
  ← しかし AVL_FX_Bridge.ex5 はこれを使わない
```

---

## 9. EXECUTION

```
現在の実装（Legacy /orders/pending ポーリング方式）:
  1. Browser → POST /orders { direction, symbol, volume, sl, tp, magic }
     → orderQueue[] にpush（Globalキュー）
  2. EA → GET /orders/pending（Bearerのみ認証）
     → pending orders を取得
  3. EA → CTrade.Buy() or CTrade.Sell() 実行
  4. EA → POST /orders/{id}/result { success, retcode, deal, comment }
     → orderStore status 更新 + WebSocket broadcast

設計済みだが未使用の新Execution Bridge:
  execution_commands テーブル（Supabase）
    command_id, connection_id, user_id, strategy_id, magic_number, action, symbol, volume
    status: PENDING → CLAIMED → EXECUTING → FILLED/REJECTED/FAILED/EXPIRED/CANCELLED
  GET /execution-commands/pending (connection_id + token認証)
  POST /execution-commands/:id/claim
  POST /execution-commands/:id/result
  ← AVL_FX_Bridge.ex5 はこれを使わない（専用のAVL_ExecutionBridge.mq5 が設計されているが未配布）
```

---

## 10. CHART CURRENT DATA SOURCE

### AVLChart（/chart ページのメインチャート）

| データ種別 | ソース | ユーザー固有？ |
|------------|--------|--------------|
| Historical（過去バー） | `GET /api/mt5/bars/simple` → Gateway barStore → `GET /bars/:sym/:tf` | **NO** - Globalストア。Admin MT5が送ったデータを全ユーザーが参照 |
| Realtime（リアルタイムバー） | WebSocket `ws://Gateway/ws` → BAR message | **NO** - Globalブロードキャスト |
| Realtime（Tick更新） | WebSocket → TICK message or SYMBOLS message | **NO** - Global |

### /api/datafeed（TradingView UDF）

| 項目 | 内容 |
|------|------|
| Historical source | Supabase `bar_data` テーブル（時刻範囲クエリ） |
| User固有？ | **NO** - bar_data は全ユーザー共有（RLS: `003_bar_data_rls_open.sql` で全認証ユーザーにSELECT許可） |

**結論: チャートデータはユーザー固有ではない。Admin MT5が送ったデータを全ユーザーが参照する。**

---

## 11. BACKTEST CURRENT DATA SOURCE

```
BacktestService.ts → fetchBars() →
  Supabase bar_data テーブル
    SELECT time_utc, open, high, low, close, volume
    WHERE symbol = ? AND timeframe = ?
    （user_idフィルターなし）

つまり:
  - バックテストはAdmin MT5が送ったbar_dataを使用
  - ユーザー自身のMT5は不要
  - bar_dataが存在する期間・シンボルのみバックテスト可能
  - ユーザーのMT5データはバックテストに使われない
```

---

## 12. CALENDAR / NEWS DATA SOURCE

| ページ/機能 | ソース | User MT5依存？ |
|------------|--------|--------------|
| カレンダー（/calendar） | Forex Factory JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json`) → インメモリキャッシュ1時間 | **NO** |
| ニュース（/news） | Yahoo Finance RSS + FXStreet RSS + ForexLive RSS → インメモリキャッシュ5分 | **NO** |
| COT（/api/market/cot） | Supabase `cot_positions` テーブル（週次バッチで取得済み） | **NO** |
| 経済指標（/api/market/economic-events） | Supabase `economic_events` テーブル | **NO** |

---

## 13. EA COMMAND CENTER

```
/ea ページ → EACommandCenter.tsx

「▶ 起動（準備中）」ボタン:
  <button disabled ...>  ← JSX上で disabled属性がハードコード
  title="ライブトレード: 未実装 (STAGE 5 で実装予定)"

処理されること:
  - EA一覧取得: GET /api/strategies → Supabase strategy_registry（User毎）
  - EA削除: DELETE /api/strategies/:id
  - AI EA Builder でEA設計→保存: POST /api/strategies

処理されないこと（未実装）:
  - 「起動」→ MT5でStrategyを実際に稼働させる
  - Signal生成 → execution_commands INSERT
  - Strategy Runtime State の更新
```

注意: EA作成（AIビルダーでの設計・保存）はUser MT5不要。バックテストもUser MT5不要。  
「起動」のみがUser MT5を必要とするが、そのボタン自体が未実装。

---

## 14. USER ISOLATION

### Supabase RLS（Row Level Security）

| テーブル | RLS | 分離単位 |
|---------|-----|--------|
| mt5_connections | ENABLED | user_id = auth.uid() |
| execution_commands | ENABLED | user_id（INSERTはservice_roleのみ） |
| live_positions | ENABLED | user_id = auth.uid() |
| live_deals | ENABLED | user_id = auth.uid() |
| strategy_registry | ENABLED（推定） | user_id |
| bar_data | RLS open（003） | 全認証ユーザーがSELECT可能（分離なし） |

### Gateway（Railway）のUser分離

| データ | 分離状態 | 理由 |
|--------|--------|------|
| barStore | **分離なし** | `Map<"SYMBOL:TF", Bar[]>` - Global |
| tickStore | **分離なし** | `Map<"SYMBOL", Tick>` - Global |
| positions[] | **分離なし** | `let positions: Position[]` - Global変数 |
| account | **分離なし** | `let account: Account` - Global変数 |
| indicatorStore | **分離なし** | `Map<"SYMBOL", Indicators>` - Global |
| historyStore | **分離なし** | `Map<"SYMBOL", Map<ticket, Deal>>` - Global |
| heartbeatStore | シンボル単位のみ | per-symbol（user毎ではない） |
| WebSocket broadcast | **分離なし** | 全clientに全データをbroadcast |

**現在のGatewayはUser分離を一切実装していない。**

---

## 15. GATEWAY ENDPOINTS（全一覧）

### EA → Gateway（認証あり: Bearer MT5_GATEWAY_SECRET）

| METHOD | PATH | 説明 |
|--------|------|------|
| POST | /connect | EA起動通知 |
| POST | /event | EA停止/切断通知 |
| POST | /tick | Tickデータ受信 |
| POST | /bar | リアルタイムバー受信 |
| POST | /bars/bulk | 過去バー一括受信 |
| POST | /positions | ポジション受信 |
| POST | /account | 口座情報受信 |
| POST | /heartbeat | ハートビート |
| POST | /symbols/bulk | Market Watchシンボル一括受信 |
| POST | /orders/stream | 注文ストリーム受信 |
| POST | /indicators | インジケーター受信 |
| POST | /history/bulk | 取引履歴一括受信 |

### Bridge EA → Gateway（認証あり: Bearer + X-Connection-Id + X-Connection-Token）

| METHOD | PATH | 説明 |
|--------|------|------|
| POST | /bridge/heartbeat | Bridge EA Heartbeat + Safety Flags受信 |
| POST | /bridge/disconnect | Bridge EA切断通知 |
| GET | /execution-commands/pending | Pending Command取得（connection_idスコープ） |
| POST | /execution-commands/:id/claim | Command Claim（Atomic） |
| POST | /execution-commands/:id/result | Command Result提出 |
| POST | /bridge/positions | ポジション同期（Supabase live_positions） |
| POST | /bridge/deals | Deal同期（Supabase live_deals） |

### Browser → Gateway（認証なし / 一部Bearer）

| METHOD | PATH | 認証 | 説明 |
|--------|------|------|------|
| GET | /health | なし | ヘルスチェック |
| GET | /bars/:symbol/:tf | なし | 過去バー取得 |
| GET | /tick/:symbol | なし | 最新Tick |
| GET | /symbols | なし | シンボル一覧 |
| GET | /indicators/:symbol | なし | インジケーター取得 |
| GET | /indicators | なし | 全インジケーター |
| GET | /history/:symbol | なし | 取引履歴 |
| GET | /history | なし | 全取引履歴 |
| GET | /positions | Bearer | ポジション一覧 |
| GET | /account | Bearer | 口座情報 |
| GET | /orders/all | Bearer | 全注文一覧 |
| GET | /market-data/status | なし | データカバレッジ状態 |
| GET | /debug/bar-timestamps | なし | タイムスタンプ診断 |
| WebSocket | /ws | なし | リアルタイムストリーム |

### Admin管理

| METHOD | PATH | 認証 |
|--------|------|------|
| DELETE | /admin/bars/:symbol/:tf | なし（要注意）|
| POST | /admin/sync-to-supabase | Bearer |
| GET | /data-commands/pending | Bearer |
| POST | /data-commands/:id/progress | Bearer |
| GET | /orders/pending | Bearer |
| POST | /orders/:id/result | Bearer |
| POST | /orders | なし（！）|

---

## 16. GATEWAY STATE MANAGEMENT

### グローバルstateの構造

```typescript
// --- グローバル変数（connection_id分離なし） ---
const barStore      = new Map<string, Bar[]>();        // "SYMBOL:TF" → Bar[]
const tickStore     = new Map<string, Tick>();          // "SYMBOL" → Tick
let   positions:    Position[] = [];                   // 全EAからの最後のpositions
let   account:      Account | null = null;             // 全EAからの最後のaccount
let   eaInfo:       Record<string, unknown> | null = null; // 最後に接続したEA情報
const indicatorStore = new Map<string, Indicators>(); // "SYMBOL" → Indicators
const historyStore  = new Map<string, Map<number, HistoryDeal>>(); // "SYMBOL" → deals
const symbolStore   = new Map<string, MarketWatchSymbol>(); // "SYMBOL" → symbol
const orderStore    = new Map<number, Order>();        // ticket → Order
const orderQueue:   Array<...> = [];                  // 全EA共通の注文キュー
const heartbeatStore = new Map<string, string>();      // "SYMBOL" → ISO timestamp
```

**マルチユーザー対応状況: 全くない（Single Tenantアーキテクチャ）**

---

## 17. RAILWAY MULTI USER

### 現在の問題

1. **State混在**: User AのEAが `positions` を上書きすると、User Bが見るpositionsもUser Aのものになる
2. **WebSocketブロードキャスト**: 全ユーザーに全データが流れる
3. **account変数**: 最後にPOSTしたEAのアカウント情報のみ保持（上書き）
4. **barStore**: SYMBOLが同じなら全ユーザーのデータが混在・上書き

### Bridge EA エンドポイント（/bridge/*）の設計

新エンドポイント群は `connectionId` と `userId` で完全分離している:
- `upsertPositions(connectionId, userId, positions[])` → Supabase live_positions
- `upsertDeals(connectionId, userId, deals[])` → Supabase live_deals
- `verifyBridgeAuth(connectionId, connectionToken)` → SHA-256 hash照合

ただし **AVL_FX_Bridge.ex5 はこれらのエンドポイントを使わない**。

---

## 18. CONNECTION TOKEN SECURITY

### mt5_connections テーブルスキーマ（016_mt5_connections.sql）

```sql
CREATE TABLE public.mt5_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id),
  connection_token_hash TEXT NOT NULL,  -- SHA-256 hash のみ保存
  broker                TEXT NOT NULL,
  server_name           TEXT NOT NULL,
  mt5_login             BIGINT NOT NULL,
  account_type          TEXT CHECK (account_type IN ('REAL', 'DEMO')),
  account_mode          TEXT CHECK (account_mode IN ('HEDGING', 'NETTING')),
  leverage              INTEGER,
  status                TEXT CHECK (status IN ('DISCONNECTED','CONNECTING','CONNECTED','ERROR')),
  emergency_stop        BOOLEAN DEFAULT false,
  trading_enabled       BOOLEAN DEFAULT false,
  last_heartbeat_at     TIMESTAMPTZ,
  UNIQUE (user_id, mt5_login, server_name)
);
RLS: user_idでSELECT/INSERT/UPDATE/DELETE分離
```

### Token発行フロー

```
1. POST /api/user/mt5-setup
   → randomBytes(32).toString("hex") → connectionToken（64文字hex）
   → SHA-256(connectionToken) → tokenHash → DB保存
   → connectionToken を1回だけレスポンスに含めて返す（平文はDB非保存）

2. EA → Gateway POST /bridge/heartbeat（ヘッダー: X-Connection-Id, X-Connection-Token）
   → SHA-256(token) と DB.connection_token_hash を照合
   → 一致すれば Safety Flags を返す

問題:
   AVL_FX_Bridge.ex5 はX-Connection-Id / X-Connection-Token を送信しない。
   EAはInpServerSecretをBearer Headerに付けるだけ。
   このSecretはGateway全体の共通secret（MT5_GATEWAY_SECRET env var）で、
   ユーザー固有のConnection Tokenとは別物。
```

---

## 19. CURRENT VS PROPOSED ARCHITECTURE 比較

| 観点 | Current（実際） | Proposed（DB設計） | GAP |
|------|---------------|------------------|-----|
| EA種別 | 単一共通Bridge EA（AVL_FX_Bridge.ex5） | 単一共通Bridge EA | 一致（設計通り） |
| EA認証 | InpServerSecret（Gateway共通secret）のみ | connection_id + token hash | **Gap: tokenは未使用** |
| Market Data | Gateway Global barStore → WebSocket broadcast | Supabase bar_data（User毎） | **Gap: 分離なし** |
| Account Data | Gateway Global account変数 | Supabase mt5_connections heartbeat | **Gap: DBに反映されない** |
| Positions | Gateway Global positions[] | Supabase live_positions（User分離） | **Gap: live_positionsは空** |
| Deals | Gateway Global historyStore | Supabase live_deals（User分離） | **Gap: live_dealsは空** |
| Order Execution | orderQueue（Global）→ EA polling | execution_commands（User分離）→ EA polling | **Gap: execution_commandsに命令なし** |
| Chart Data | Admin MT5 shared bar_data | User固有 bar_data | **Gap: 全ユーザー共有** |
| WebSocket | 全Userにbroadcast | 将来: User-scoped channels | **Gap: 分離なし** |

---

## 20. REQUIRED CHANGES

### Priority 1: EA認証の改修（最重要）

AVL_FX_Bridge.mq5 に以下を追加する必要がある:
1. `InpConnectionId` パラメーター追加（MT5接続ページからコピーするUUID）
2. `InpConnectionToken` パラメーター追加（1回だけ表示されるToken）
3. Heartbeatを `POST /bridge/heartbeat` に変更（X-Connection-Id/Token付き）
4. Positionを `POST /bridge/positions` に変更
5. Dealを `POST /bridge/deals` に変更
6. Order実行を `GET /execution-commands/pending` に変更

### Priority 2: Gateway State の分離

GatewayのグローバルstateをUser毎に分離する必要がある:
- barStore: `Map<"USER_ID:SYMBOL:TF", Bar[]>` または per-connection
- tickStore: connection_id でkey化
- positions, account: connection_id で管理
- WebSocket: User毎のチャンネル（subscriptionフィルター）

または Supabase Realtime に移行してDBレベルでRLS分離する。

### Priority 3: EA起動ボタンの実装

- Strategy Runtime State の管理
- Signal生成ロジック
- execution_commands へのINSERT
- EA側での polling + 執行

---

## 21. RISKS

### セキュリティリスク

1. **Data Leakage**: User AのPositionデータがUser BのブラウザのWebSocketに流れる
2. **Account Exposure**: GET /account（Bearer認証あり）だが、secretを知っていれば誰でも口座情報を取得可能
3. **Order Injection**: POST /orders は認証なし（コード: `app.post("/orders", (req, res) => {`）— 誰でも注文キューに追加できる
4. **/admin/bars/:symbol/:tf は認証なし**: 誰でもbarStoreをクリア可能

### 可用性リスク

1. **Single Point of Failure**: Railwayの単一Gateway、再起動でbarStoreが消える（bars.jsonで一応永続化）
2. **EAクラッシュ**: EA再接続時に eaInfo / positions / account が上書きされる

---

## 22. RECOMMENDED ARCHITECTURE

現行の設計思想（1 EA + 1 Railway + Supabase）は正しい方向性。  
以下の順で実装を完成させることを推奨する。

```
Phase A: EA認証改修（AVL_FX_Bridge.mq5）
  - InpConnectionId / InpConnectionToken パラメーター追加
  - /bridge/heartbeat, /bridge/positions, /bridge/deals への切り替え
  - Supabase mt5_connections.last_heartbeat_at の更新 → MT5接続ページのオンライン確認が機能する

Phase B: User-scoped Market Data
  - バーデータ: Admin MT5のbar_dataは全ユーザー共有のままで可
  - ただしリアルタイムTick/Barは User毎のWebSocketチャンネルへ分離

Phase C: Execution
  - EA側で /execution-commands/pending ポーリングを実装
  - Strategy Runtime State の管理ロジック
  - Signal生成 → execution_commands INSERT
  - EA起動ボタンの有効化
```

---

## 23. 最終判定マトリクス

```
DOWNLOADED FILE:                          AVL_FX_Bridge.ex5
DOWNLOADED FILE SOURCE:                   /ea/AVL_FX_Bridge.mq5 (v3.11)
ONE USER EA FILE:                         YES (1 EA for all users, design intent correct)

CURRENT BRIDGE SENDS TICKS:               YES
CURRENT BRIDGE SENDS BARS:               YES (8 timeframes, bulk + realtime)
CURRENT BRIDGE SENDS ACCOUNT:            YES
CURRENT BRIDGE SENDS POSITIONS:          YES (current chart symbol only)
CURRENT BRIDGE EXECUTES ORDERS:          YES (legacy /orders/pending polling)

CURRENT CHART REALTIME SOURCE:           Gateway barStore (in-memory, Admin MT5 data)
CURRENT CHART USER-SPECIFIC:             NO (all users share same barStore)
BACKTEST SOURCE:                         Supabase bar_data (Admin MT5 data)
BACKTEST REQUIRES USER MT5:              NO
EA CREATION REQUIRES USER MT5:           NO
EA START REQUIRES USER MT5:              YES (ただしボタン自体がdisabled・未実装)
CALENDAR REQUIRES USER MT5:             NO (Forex Factory JSON API)
NEWS REQUIRES USER MT5:                 NO (Yahoo Finance + FXStreet + ForexLive RSS)

RAILWAY MULTI-CONNECTION:               PARTIAL
  (Bridge endpoints実装済み、配布EAがそれを使っていない)
MARKET DATA CONNECTION-SCOPED:          NO (Gateway Global state)
ACCOUNT DATA CONNECTION-SCOPED:        NO (Gateway Global state)
EXECUTION CONNECTION-SCOPED:           PARTIAL
  (execution_commands は connection_id でscoped、ただしcommand insertロジックなし)

CROSS-USER DATA ISOLATION:              FAIL
  (Gateway level: 全データがGlobal)
  (Supabase level: live_positions/live_dealsはRLS分離済み、ただしデータが入っていない)
ONE RAILWAY FOR MULTIPLE USERS:        NOT POSSIBLE (current state)
                                        POSSIBLE WITH CHANGES (EA auth改修後)

USER DOWNLOAD→INSTALL→TOKEN→CONNECT:   PARTIAL
  (UI/UXフローは完成、EAがtokenを実際の認証に使っていない)
USER MT5 → USER CHART:                 NOT IMPLEMENTED
  (現在は全ユーザーが同じAdmin MT5のチャートを見ている)
USER MT5 → USER ACCOUNT:              NOT IMPLEMENTED
  (Bridge heartbeatでSB更新は設計済み、EAが使っていない)
TRADING VIEW → USER MT5 ORDER:        NOT IMPLEMENTED
  (execution_commands設計完成、Signal→InsertロジックとEA側polling未実装)

PROPOSED ARCHITECTURE (1 EA / 1 Railway / Multi-user):
                                        POSSIBLE WITH CHANGES
  (EA側の認証改修 + Signal生成ロジック実装が必要)
```
