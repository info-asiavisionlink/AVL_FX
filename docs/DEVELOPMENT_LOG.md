# AVL-FX Trading View — Development Log

## 2026-09-24: Stage 5A — Order expiry UTC normalization

AUDIT-011を解決した。`COMMAND_EXPIRY_SECONDS=300`を共通UTC expiry helperへ集約し、Risk/Runtimeのexecution command生成を絶対UTC ISO timestampへ統一した。ExecutionBridgeは期限欠落・不正値をfail closedし、`now >= expires_at`を期限切れとして扱う。固定JST +9時間補正はexecution expiry pathから除去した。

検証: Task 5A expiry tests 4 PASS、Stage 1 48/48、Stage 4/Gateway regression 16 PASS、Trading View/Gateway typecheck PASS、Trading View/Gateway build PASS。EA compilerは環境にないためstatic verificationを実施した。Production DB/deploy/ENV変更、migration追加、MT5注文は行っていない。`demo_execution_enabled=false`を維持した。

## 2026-09-24: Stage 4 documentation synchronization

Stage 4を **COMPLETE — LOCAL PRODUCTION-PATH CORE RUNTIME VERIFIED** としてMASTERへ反映した。Primary Production-path Lifecycle、Safety 25/25、Fresh/Upgrade migrations、Stage 1〜4回帰、Trading View/Gateway typecheck/buildの検証結果を記録した。Initial Auditの83件とAUDIT IDは履歴として保持し、Stage 1〜4で解決した項目にはRESOLVED/Resolved Stageを付記した。

Production DB変更、Production deploy、Production ENV変更、MT5注文は行っていない。`demo_execution_enabled=false`を維持した。Console packageはStage 4 workspaceに存在せず、Console typecheck/buildは未検証。Stage 5はNOT STARTED。

## 2026-09-23: Stage 4 Core Runtime implementation

Added server-side runtime primitives for closed-bar gating, canonical runtime
states, scenario/position-review idempotency keys, and position decision
validation. H1 processing now runs independently per Trader, uses the latest
closed H1 bar, correlates the Trader Version, and does not copy scenarios across
same-market Traders. M5 watcher input rejects forming/missing bars; Gateway M5
deduplication is connection-scoped. Position review is dispatched from the
position watcher, includes selected Knowledge, records AI log snapshots, and
uses stable management idempotency keys. Filled commands update the correlated
`ai_positions` row, while complete MT5 position snapshots reconcile stale
`live_positions` rows, including empty snapshots.

Migration `031_stage4_runtime_idempotency.sql` adds runtime correlation columns
and uniqueness constraints. Tests/typechecks are local/mock only; no
Production DB, deploy, or MT5 order was used.

Stage 4 closure work added `RuntimeService` production primitives and a
production-service integration harness. Migration `032_stage4_atomic_scenario.sql`
adds a transaction-locked, idempotent H1 Scenario RPC. A disposable local
PostgreSQL fresh chain through 032 applied successfully; duplicate H1 calls
returned one Scenario and one active row. Full Next/Gateway/Supabase multi-service
E2E was verification pending at this historical entry; it was subsequently closed by the 4D-1 and 4D-2 production-path verification recorded above.

---

## 2026-09-23: Stage 3 Console Knowledge → Trading View Integration

Consoleの`/api/trading-knowledge`をmiddlewareのinteractive login redirect対象から分離し、handlerで`KNOWLEDGE_API_SECRET`をtiming-safe比較するserver-to-server認証へ統一した。未設定、未提示、誤secretはfail closedし、runtime responseはACTIVE Knowledgeだけを返す。

Trading Viewにはserver-side専用Knowledge clientとdeterministic selectorを追加した。market、timeframe、trigger、Traderのselected knowledge IDsを使って候補を絞り、H1とindividual analysisが同じselectorを使用する。Console取得失敗、timeout、invalid response、0 ACTIVE resultはofflineの空配列へ変換せず、主要analysisを明示的にunavailableとして停止する。

分析promptへKnowledge title/category/version、AI usage、summary、contentを投入し、`ai_analysis_logs.knowledge_snapshot`へ分析時点のid/version/title/categoryを保存する。H1 scenarioにも同じsnapshot metadataを保存する。migration `030_knowledge_snapshot.sql`を追加した。

検証: Knowledge client tests 4 PASS、Console secret tests 1 PASS、Schema tests 5 PASS、Stage 1 regression 48 PASS、Gateway/Trading View/Console typecheck PASS。Production変更・deploy・MT5注文は行っていない。

---

## 2026-09-23: Stage 2 Database Schema Completion

Stage 2の対象をTrading View Customer DBに限定し、Console Supabaseの`ea_registry`や`get_bar_stats()`は別境界として複製しない。migration inventoryとApplicationの`.from()`参照を照合した結果、fresh chainで`015_user_isolation_rls.sql`が前提とする`trade_history`、`economic_events`、`news_items`のCREATE不足を確認した。

追加migration:

- `006_shared_runtime_tables.sql`: historical RLS migrationより前に共有runtime/history tablesを作成
- `029_stage2_schema_completion.sql`: `ai_trader_scenarios`のversion/correlation列、`ai_analysis_logs`、`trade_audit_log`、相関index、RLSを追加

`INVALIDATED`をScenarioのcanonical runtime statusとして許容し、既存の`INVALID`も後方互換で保持した。Scenario versionは既存行を作成順にbackfillしてからunique indexを作成する。AI analysis journalはユーザー向けrationaleとtelemetryだけを保存し、raw chain-of-thoughtは保存しない。

`docs/DATABASE_SCHEMA.md`とmigration schema testsを追加した。Production Supabaseへの適用、Production deploy、データ変更、MT5注文は行わない。

最終Fresh Migration Verificationでは、Supabase CLI/Dockerが利用できないため、権限昇格した一時localhost PostgreSQLを使用した。Supabase互換の最小role/schemaを一時DB内だけに作成し、空DBへ全31 migrationを順番に適用してPASS。別の空DBへ001〜028を適用後、029を適用するupgrade pathもPASSした。主要table、Stage 2列、FK、RLS、unique index、`INVALID`/`INVALIDATED` compatibilityをread-only queryとrollback-only insertで確認した。

Stage 2 status: **COMPLETE**。Production Supabase変更・Production deploy・MT5注文は行っていない。

---

## 2026-09-23: Stage 1 Final Remediation (Codex implementation)

実装対象は直前の独立監査で確認したStage 1 blockerに限定した。新規EntryはCommon Execution Serviceを経由し、evaluate-strategiesとexecuteで最終Market Data検証を実施する。Risk Engineはprofile/trader/lot計算値をfinite/type検証し、NaN/Infinityを拒否する。

Gatewayはconnection tokenを全connection-scoped read/writeで必須化し、認証バックエンド停止時は503でfail closedとした。Market Data storeとWebSocket配信はconnection単位に分離し、customer-sensitive eventのglobal broadcastを削除した。Heartbeatは必須schemaとnumeric finite検証を行い、EAのMODIFY_SLは方向、stops_level、既存SLより不利な拡大、丸め後0を拒否する。AI logのscenario/trader/command/position関連はowner整合を確認する。

独立Hard Emergency SL保険レイヤーはMASTER上でStage 4のCR-005/GAP-005へ正式配置した。Stage 1ではBroker-side SL Guardを必須とし、Stage 4機能を未実装のままStage 1成果として表現しない。

本番デプロイ・本番DB変更・実MT5注文は行っていない。`demo_execution_enabled=false`を維持する。

検証結果: production validation/Risk/Execution経路を使用するStage 1テスト48 PASS / 0 FAIL、Gateway `tsc -p gateway/tsconfig.json --noEmit --incremental false` PASS、Trading View `tsc --noEmit --incremental false` PASS。ローカルbuildはGoogle Fonts取得がネットワーク制限で失敗したため、コードエラーとは分離して記録する。

---

## 2026-09-23: Stage 1 Codex 2回目監査 Structural Remediation

### 背景
2回目の Codex 独立監査で以下が判定された:
- 局所的な Safety Gate では Stage 1 を閉じられない
- 全自動新規Entry経路の Common Risk Engine への統一が必要
- Gateway 口座分離（P0-04）および FAIL CLOSED auth（P0-03）が未完成

### アーキテクチャ変更

#### 新規 `src/lib/ai-trader/execution-service.ts`
- `runCommonRiskCheck()`: DB/Gateway からアカウント・Symbol Spec・Tick を取得して Risk Engine を実行
- `createEntryExecutionCommand()`: Risk Engine 承認後のみ execution_commands を INSERT
- `buildStrategyRiskEngineTrader()`: EA Builder ストラテジーを Risk Engine に接続するアダプター
- `buildDefaultRiskEngineProfile()`: デフォルトリスクプロファイル

#### `src/lib/ai-trader/risk-engine.ts` 根本バグ修正
- Check 1: `"AUTO"` → `"DEMO_AUTONOMOUS"` （DB スキーマと整合。旧コードは常に DENIED だった）
- 全 numeric input に `Number.isFinite()` バリデーション追加（NaN/Infinity = DENIED）

#### `src/app/api/traders/[id]/execute/route.ts` P0-02 修正
- `tick.time ? tick.time * 1000 : Date.now()` を廃止
- tick.time なし/NaN/0 → liveQuote = null → Risk Engine DENY（FAIL CLOSED）

#### `src/app/api/cron/evaluate-strategies/route.ts` P0-01 修正
- 直接 INSERT + 独自 Safety Gate を廃止
- `runCommonRiskCheck()` + `createEntryExecutionCommand()` に統一

#### `src/app/api/traders/[id]/decide/route.ts` P1-04 修正
- 手動承認でも Risk Engine を経由（人間承認と Risk Validation は別責務）
- `runCommonRiskCheck()` + `createEntryExecutionCommand()` に統一

#### `gateway/src/index.ts` 構造的修正
- P0-03: `verifyBridgeAuthCached` が `"ok" | "denied" | "unavailable"` を返すよう変更
- P0-03: `isExecutionEnabled()=false` → 503 返却（auth skip 禁止）
- P0-04: `connBarStore` / `connTickStore` を追加（connection-scoped）
- P0-04: `/connections/:id/tick/:symbol` / `/connections/:id/bars/...` が connection-scoped store を使用
- P0-04: GET bars エンドポイントに auth 追加
- P0-05: `connWsClients` Map で WS を connection 別管理
- P0-05: EXECUTION_RESULT は `broadcastToConnection()` で所有 connection の WS にのみ送信
- `broadcastToConnection()` 関数を追加

### テスト（全書き直し）
- production 関数 (`runRiskEngine`, `validateBarsForEntry`, etc.) を直接 import
- Mock DB で実 Risk Engine ロジックを呼び出し
- 欠陥を再導入すると対応テストが FAIL する mutation resistance を確認
- **48 テスト PASS / 0 FAIL**

### 安全性確認
- MT5 orders sent: 0
- demo_execution_enabled: false 維持
- 本番デプロイ: 未実施

---

## 2026-09-23: Stage 1 Codex 独立監査 Remediation

### 背景
初回 Stage 1 COMPLETE 報告後、Codex による独立監査で以下が判定された:
- Stage 1 総合: **FAIL**
- 新たな P0 3 件（evaluate-strategies 迂回 / 0バーでENTER / MODIFY_SL→0消失）
- 既存修正の PARTIAL: AUDIT-021, 022, 024, 078

### 変更ファイル（Remediation）

#### 1. 新規 `src/lib/ai-trader/market-data-validator.ts`
- 純粋バリデーション関数（テスト・production 双方から import 可能）
- `validateBarsForEntry`, `validateCurrentPrice`, `validateTickForEntry`, `validateModifySL`
- `isValidBrokerTimestamp`: missing/zero/NaN は INVALID（Date.now() 補完禁止）

#### 2. `src/app/api/cron/evaluate-strategies/route.ts` (P0-1)
- 直接 execution_commands INSERT 前に最低限安全ゲート追加
- Global kill switch / DEMO アカウントのみ / SL 必須 / 接続鮮度チェック

#### 3. `src/app/api/traders/[id]/analyze/route.ts` (P0-2)
- `validateBarsForEntry` を import して primary TF の bars を検証
- 0バー・invalid バーで AI が ENTER 決定しても WAIT に上書き（FAIL CLOSED）

#### 4. `src/app/api/traders/[id]/manage-positions/route.ts` (P0-3)
- MODIFY_SL 命令前に `validateModifySL` でバリデーション
- 無効な SL（null/NaN/Infinity/0化/方向不正）はコマンド未作成

#### 5. `ea/AVL_ExecutionBridge.mq5` (P0-3)
- Execute_MODIFY: NormalizeDouble 後に applyingSL <= 0 なら発注拒否（MODIFY_SL_ROUNDS_TO_ZERO）

#### 6. `gateway/src/executionStore.ts`
- `submitCommandResult`: `rowsAffected` を返すよう変更（0行=所有権不一致）

#### 7. `gateway/src/index.ts`
- `/tick`, `/bar`, `/bars/bulk`: legacy エンドポイントに `verifyBridgeAuthCached` を追加
- `/bridge/bars/bulk`: 認証強化
- `/bridge/disconnect`: `verifyBridgeAuth` + `bridgeAuthCache.delete` 追加
- `/execution-commands/result`: `rowsAffected > 0` のときのみ broadcast
- `/bridge/heartbeat`: accountType/accountMode/tradeAllowed の schema validation 追加（空 `{}` を DEMO/HEDGING に変換しない）

#### 8. `src/app/api/logs/trader-activity/route.ts`
- ai_traders JOIN に user_id を含め、trader.user_id !== user.id の Scenario を除外

#### 9. TypeScript fix
- `@types/ws` を devDependencies に追加
- `integration.test.ts` の WS ポリフィルを正しい型で書き直し
- TV / Gateway ともに typecheck clean

#### 10. テスト（書き直し）
- production 関数 `validateBarsForEntry` 等を直接 import
- 44 テスト PASS / 0 FAIL
- 欠陥を再導入すると対応テストが FAIL する構造

### 安全性確認
- `demo_execution_enabled`: 変更なし（false 維持）
- Kill Switch: 変更なし
- 本番デプロイ: 未実施
- MT5 注文: 0 件

---

## 2026-09-23: Stage 1 — P0 Safety / Security 緊急修正（初回）

### 目的
P0 CORE RUNTIME の前提として取引安全性とセキュリティの最低限を確保した。
Demo 自動実行を有効にする前にこれらを完了する必要がある。

### 変更ファイル

#### 1. `src/app/api/watcher/m5-close/route.ts`
- **STAGE1-01 (AUDIT-005)**: `confirmEntryTiming` の catch が `enter: true` を返していた → `enter: false, reason: "AI_RECHECK_FAILED"` に修正
- **STAGE1-01 (AUDIT-006)**: M5/M1 バーが 5 本未満でも `enter: true` だった → `enter: false, reason: "INSUFFICIENT_MARKET_DATA"` に修正
- **STAGE1-01**: プロンプトの「迷ったらENTER（機会損失を避ける）」を削除し、WAIT 推奨に変更
- **STAGE1-01**: AI decision の `?? "ENTER"` デフォルトを廃止。`=== "ENTER"` の明示的チェックに変更
- **STAGE1-02 (AUDIT-004)**: `canAutoExecute` を常に `false` に固定。Risk Engine を迂回する M5 直接注文ブロックを永続的に到達不能化

#### 2. `src/app/api/logs/trader-activity/route.ts`
- **STAGE1-06 (AUDIT-024)**: ai_trader_scenarios クエリに `.eq("user_id", user.id)` 追加。他ユーザーのシナリオが AI Log に混入しない

#### 3. `gateway/src/executionStore.ts`
- **STAGE1-05 (AUDIT-022)**: `submitCommandResult` に `connectionId: string` パラメータを追加。`.eq("connection_id", connectionId)` 条件で自接続のコマンドのみ更新可能に制限

#### 4. `gateway/src/index.ts`
- **STAGE1-03 (AUDIT-078)**: `/bridge/heartbeat` に `verifyBridgeAuth` 呼出しを追加。口座データ更新前に token SHA-256 照合が必須
- **STAGE1-04 (AUDIT-021)**: `verifyBridgeAuthCached` 関数を追加（30秒 TTL キャッシュ）。`/bridge/ticks`, `/bridge/bars` で token 検証を実施。Supabase 未設定時はスキップ
- **STAGE1-05 (AUDIT-022)**: `submitCommandResult(result, flags.connectionId)` — connectionId を呼出し側から渡す

#### 5. `ea/AVL_ExecutionBridge.mq5`
- **STAGE1-07 (AUDIT-076)**: `Execute_BUY`/`Execute_SELL` で SL=0 クリアを禁止。SL が 0 または stops_level 違反の場合は `Send_Failed` で拒否し `return false`

### テスト
```
npx tsx src/infrastructure/trading/__tests__/stage1-safety.test.ts
→ 22 passed, 0 failed
MT5 orders sent: 0
```

### TypeScript build
- Gateway: clean (エラーなし)
- Trading View: 既存の `integration.test.ts` エラーのみ（今回の変更と無関係）

### 安全性確認
- `demo_execution_enabled`: 変更なし（false を維持）
- Kill Switch: 変更なし
- 本番デプロイ: 未実施
- MT5 注文: 0 件
## 2026-09-24: Stage 5B — MODIFY結果の ai_positions SL/TP 同期（AUDIT-014）

### 実装
- Gateway `processExecutionResult()` / `submitCommandResult()`で、成功した`MODIFY_SL`・`MODIFY_TP`のbroker resultを、owner・connection・position相関付きでcanonical `ai_positions.stop_loss` / `take_profit`へ同期。
- 同期はbroker成功後のみ実行し、失敗・保留・重複・CLOSED positionはmirrorを変更しない。
- 後から到着した古いmodify resultが新しいconfirmed値を巻き戻さないよう、同一position/actionのcommand作成順を確認。
- 同期失敗は明示的なGateway errorとして返す。

### 検証
- Gateway MODIFY sync tests: 8/8 PASS（SL/TP成功、失敗/保留/CLOSED、stale順序、owner scope、next-review read、sync failure）。
- Stage 5A expiry regression: PASS。
- Stage 4 lifecycle/safety、Gateway DI、Stage 1 safety 48/48: PASS。
- Trading View/Gateway typecheck、Trading View/Gateway build: PASS。
- New migrations / production DB / deploy / ENV changes: NONE。MT5 orders: 0。`demo_execution_enabled=false`。

AUDIT-014 = **RESOLVED — Stage 5B**。AUDIT-013（live_positions CLOSED同期）とAUDIT-015（SL有利方向制約）はOPENのまま。Stage 5はIN PROGRESS。

## 2026-09-24: Stage 5C — SL有利方向強制（AUDIT-015）

既存Positionの`MODIFY_SL`に、current SLを基準とするServer側の決定論的validatorを追加した。BUY/LONGはSLを下げられず、SELL/SHORTはSLを上げられない。current/new SLの無効値はfail closedとし、tick-size正規化後に比較する。初期Entry SLの検証は変更していない。

ExecutionBridgeは実際の`POSITION_SL`と`POSITION_TYPE`を再取得し、同じ方向制約を`PositionModify`前に適用する。broker SLが0/不正の場合は通常のAI MODIFYを拒否し、拒否結果は成功扱いにしない。

検証: Stage 5C validator/EA static tests 5/5 PASS、Stage 5A/5B、Stage 4 lifecycle/safety、Gateway DI、Stage 1 safety 48/48、Trading View/Gateway typecheck/build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。

AUDIT-015 = **RESOLVED — Stage 5C**。AUDIT-013（live_positions CLOSED同期）はOPENのまま。Stage 5はIN PROGRESS。

## 2026-09-24: Stage 5D — live_positions完全snapshot CLOSED同期（AUDIT-013）

MT5の全broker-managed position列挙を`/bridge/positions`の`"snapshot_complete":true`で明示し、Gateway `upsertPositions()`で完全snapshotだけをmissing-position reconciliation対象にした。present rowsをupsertして成功確認後、同一user/connectionのOPEN `live_positions`でsnapshotにないticketのみCLOSEDへ更新する。empty complete snapshotは正常な全決済として扱い、partial/unknown/invalid/error snapshotはmass closeしない。read/upsert/close failureは明示エラー、行削除は行わない。

検証: Task 5D reconciliation tests 7/7 PASS。Stage 5A/5B/5C、Stage 4 lifecycle/safety/Gateway DI、Stage 1 safety 48/48、Trading View/Gateway typecheck/build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。

Stage 5（Task 5A〜5D）= **COMPLETE**。AUDIT-011/013/014/015 = RESOLVED。Stage 6 = NOT STARTED。
## 2026-09-24: Stage 6B — Gateway runtime market-data store isolation

Task 6B implemented a small typed `ConnectionMarketStore` and connected the production Gateway tick, bar, latest-price, and M5 deduplication paths to connection-scoped keys (`connectionId:symbol` and `connectionId:symbol:timeframe`). Same-symbol/two-connection, timeframe, unknown-connection, no-fallback, update-independence, and M5 deduplication tests pass.

Stage 1 safety: 48/48 PASS. Stage 4 production lifecycle/safety, Gateway DI, and Stage 5A–5D regressions PASS. Trading View and Gateway typecheck PASS. Trading View and Gateway builds PASS. No migration, Production DB/deploy/ENV change, or MT5 order was made; `demo_execution_enabled=false` remains unchanged.

The legacy/global stores and REST paths remain for the later 6C API cutover. Existing `bar_data` persistence is written from connection-specific bridge feeds without a connection key; no migration was added, and its schema decision remains open. AUDIT-019 therefore remains PARTIAL; AUDIT-018 and AUDIT-020 remain PARTIAL. Stage 6 remains IN PROGRESS. Task 6C, 6D, 6E, and Stage 7 were not started.

## 2026-09-24: Stage 6C — Connection-scoped REST/API and Trading View proxy cutover

Trading View customer market-data proxies now authenticate the requested connection owner through `mt5_connections.user_id` and call the canonical Gateway endpoints `GET /connections/:connectionId/tick/:symbol` and `GET /connections/:connectionId/bars/:symbol/:timeframe`. The prior plural tick path and global bars path were removed from the customer production path; ownership lookup failures, unknown connections, Gateway failures, and unavailable scoped data fail closed without a global fallback.

`GatewayClient` now uses the server-side Trading View proxies for ticks, bars, positions, and account, so bridge tokens and Gateway secrets are not exposed to browser code. WebSocket authentication/routing remains Task 6D. Persistent `bar_data` remains symbol/timeframe keyed and is no longer used as the customer proxy fallback; a future connection-scoped schema migration would require separate approval.

Verification: Stage 6C proxy/AI cutover tests 6/6 PASS; Stage 6B store tests and Stage 1/4/5/Gateway regressions PASS; Trading View/Gateway typecheck and builds PASS. No migration, Production DB/deploy/ENV change, or MT5 order was made; `demo_execution_enabled=false` remains unchanged. AUDIT-018 is resolved for customer REST/proxy market-data paths, AUDIT-019 remains PARTIAL for persistent/legacy state, AUDIT-020 remains PARTIAL for Task 6D, and GAP-012 remains IN PROGRESS. Task 6D, Task 6E, and Stage 7 were not started.

## 2026-09-24: Stage 6D — WebSocket authentication and connection-scoped routing

The Trading View WebSocket path now obtains a 60-second server-issued HMAC-signed access credential from `/api/live/connection/ws-token`. The server validates the authenticated user's ownership of the requested connection before issuing it; the browser never receives the EA connection token, Gateway secret, or Supabase service-role key. Gateway `/ws` validates the signature, expiry, and exact connection ID before registering the socket, and reconnects obtain a fresh credential.

The previous `SUBSCRIBE_CONNECTION` message mismatch was removed. A socket is bound to one authorized connection. TICK, BAR, ACCOUNT, POSITIONS, ORDERS, EXECUTION_RESULT, EA_CONNECTED, HEARTBEAT, DISCONNECT, SYMBOLS, and INDICATORS are delivered through `broadcastToConnection`; streamed symbol, indicator, and order payloads use connection-scoped maps. Sensitive global broadcast call sites are zero.

Verification: WebSocket isolation tests 4/4 PASS; Stage 6C proxy tests 6/6 PASS; Stage 6B, Stage 5A–5D, Stage 4 lifecycle/safety/Gateway DI, and Stage 1 safety 48/48 PASS. Trading View/Gateway typecheck and builds PASS. No migration, Production DB/deploy/ENV change, or MT5 order was made; `demo_execution_enabled=false` remains unchanged. AUDIT-020 is resolved for authenticated scoped WebSocket routing, GAP-012 remains IN PROGRESS, Task 6E and Stage 7 were not started.

## 2026-09-24: Stage 6F-PROD / 6F-V — Production PostgreSQL bar_data isolation validation

Migration `034_bar_data_connection_isolation.sql` was applied once to the approved Production Supabase project after a read-only preflight. Existing `bar_data` rows were preserved with `connection_id IS NULL`; no ownership was guessed or backfilled. Production upgrade validation (033 → 034), schema metadata, the `mt5_connections` foreign key with `ON DELETE CASCADE`, connection-scoped uniqueness and indexes, RLS policies, and authenticated user isolation all passed. Fresh 001 → 034 application was intentionally **not run on Production** by design.

Temporary, uniquely marked test users/connections/rows verified same-symbol GOLD M5 and H1 coexistence, independent upserts, foreign-key rejection, cascade behavior, anonymous denial, and exclusion of legacy NULL rows. All temporary data was removed; existing customer data was unchanged. Stage 6F focused tests, Stage 6E two-customer verification, Stage 6B–6D and Stage 5A–5D regressions, Stage 4 lifecycle/safety/runtime/Gateway DI, Stage 1 safety 48/48, Trading View/Gateway typecheck, and builds passed.

Task 6F-V = **COMPLETE — ACTUAL PRODUCTION POSTGRESQL VALIDATION VERIFIED**. Task 6F = **COMPLETE — PERSISTENT BAR_DATA CONNECTION ISOLATION**. Task 6E = **COMPLETE — TWO-CUSTOMER ISOLATION VERIFIED**. Stage 6 = **COMPLETE — TWO-CUSTOMER ISOLATION VERIFIED**. AUDIT-018, AUDIT-019, AUDIT-020, and GAP-012 are RESOLVED. Production deploy, Production ENV changes, and real MT5 orders: NONE/0. `demo_execution_enabled=false`. Stage 7 remains NOT STARTED. This validation does not claim Production Ready and does not apply any fresh destructive migration to Production.

## 2026-09-24: Stage 7A — AI Trader full audit / design freeze

監査のみを実施し、Production code、EA、migration、Production DB、ENV、deployは変更していない。Stage 1〜6の既存回帰は維持され、Stage 1 safety 48/48、Stage 4 lifecycle/safety/runtime/Gateway DI、Stage 5A〜5D、Stage 6B〜6F、Trading View/Gateway typecheck/buildはPASS。MT5 ordersは0、`demo_execution_enabled=false`、Stage 7は実装未開始。

Current code evidence:
- AI Trader Builder UI (`AITraderBuilder.tsx`) と `/api/ai/trader/build` は存在し、OpenAI JSON出力をZod検証して `ai_traders` / `ai_trader_versions` へ保存する経路がある。Builderは `strategy_id` / `strategy_registry` と未接続で、出力の部分復旧と数値・意味検証は限定的。
- Manual approval (`/api/traders/[id]/decide`) はowner確認、ENTER_LONG/ENTER_SHORT→BUY/SELL、Common Risk、Common Executionを通る。decision→commandの監査相関はmetadata中心で、AI Logの承認イベントは独立記録されない。
- Risk EngineはSL方向、finite値、鮮度、spread、lot step、margin（`marginInitial > 0`時）、exposure、expiryを検査する。一方、Profileの`minimum_rr`と`max_positions`はRisk Engineの決定論的入力ではなく、TP方向・minimum RR検査も存在しない。これはStage 7の安全修正対象である。
- Position ReviewはM5経路から起動し、HOLD/CLOSE/MODIFY_SL/EXTEND_TPを処理するが、TP/SL接近を分ける専用candidate triggerはなく、`EXTEND_TP`が`MODIFY_TP`へ変換される。Hard Emergency SLは独立している。
- H1、Entry Recheck、Position Review、execution result等の`ai_analysis_logs`保存は存在するが、Timeline APIはScenario/FILLED/CLOSED中心で全判断を返さない。Knowledge failure、Risk rejection、manual approval、AI errorの一貫した表示は未完了。
- CLOSED検知後のTrade Reviewは存在するが、Watcherが`review_dispatched=true`を先に保存してfire-and-forgetで呼び出す。失敗時の再試行保証はなく、Review JSONのschema validationとDBエラーの明示処理も不足する。

Frozen implementation order: 7B Builder contract/persistence completion → 7C manual approval/correlation → 7D Profile/Risk deterministic enforcement → 7E TP/SL candidate watcher → 7F complete AI Log timeline → 7G Trade Review delivery/retry/idempotency → 7H full Stage 7 production-path verification. No Stage 7 migration is approved by this audit; schema needs are to be assessed per task before implementation.

Task 7A = **AUDIT COMPLETE — IMPLEMENTATION NOT STARTED**. Stage 7 remains NOT STARTED. No P0 direct execution bypass was found: new-entry writers use `createEntryExecutionCommand` after Common Risk; the position-management writer is a scoped, deterministic MODIFY/CLOSE support path. The current TP/RR/profile and review reliability gaps are frozen as Stage 7 work, not silently closed.

## 2026-09-24: Task 7B — AI Trader Builder contract / validation / persistence

既存のAI Trader Builder UI/APIを再利用し、Builder専用のstrict Zod contractと決定論的normalizerを追加した。必須profile項目、対応市場（GOLD）、対応時間足、enum、finite/range/integer値、未知キーをserver-sideで検証し、以前のpartial profile recoveryを削除した。`/api/traders`も同一validatorで再検証し、新規TraderはDRAFTかつ`ANALYSIS_ONLY`で保存する。`strategy_id`は既存Phase 1設計どおりNULLを維持し、strategy_registry行は生成しない。

Version 1およびKnowledge snapshotの後続保存に失敗した場合は、作成済みTraderを補償削除して成功を返さない。Builderはexecution command、Gateway、MT5 orderを作成しない。Focused tests 14/14 PASS。Stage 1 safety 48/48、Stage 4 lifecycle/safety/runtime/Gateway DI、Stage 5A〜5D、Stage 6B〜6F、Trading View/Gateway typecheck、Trading View/Gateway build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。

Task 7B = **COMPLETE — AI TRADER BUILDER CONTRACT/PERSISTENCE**。Stage 7 = **IN PROGRESS**。Task 7C以降、Stage 8〜10は未開始。

## 2026-09-24: Task 7C — Manual Approval atomicity / correlation / idempotency

`POST /api/traders/[id]/decide`に、`trade_decisions`の`PENDING`行を対象とした単一のcompare-and-set claimを追加した。承認競合時は1リクエストだけがRisk/Executionへ進み、後続要求は既存status/command相関を返して新commandを作らない。却下もatomic claimでterminal化し、期限切れ・owner不一致・未知actionはfail closedとした。

承認監査は既存`ai_analysis_logs`へ`MANUAL_APPROVAL`として保存し、user/trader/version/scenario/decision/connection/command相関を保持する。Risk拒否、Risk例外、command作成失敗、監査ログ失敗はcommandを作らずREJECTEDへ閉じる。Common RiskとCommon Executionは従来どおり必須で、Gateway/MT5直接経路は追加していない。command metadataにも不足していたversion/scenario相関を追加した。

Task 7C focused tests 5/5、Task 7B 14/14、Stage 1 safety 48/48、Stage 4 15/15、Stage 5A〜5D、Stage 6B〜6F、typecheck、Trading View/Gateway build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。Task 7D以降とStage 8〜10は未開始。
## 2026-09-24: Task 7D — AI Trader Profile / Risk deterministic enforcement

Common Risk (`src/lib/ai-trader/risk-engine.ts`) now enforces the server-side AI Trader version profile at every AI entry boundary. BUY/SELL TP direction is deterministic, minimum RR uses normalized reward/risk distances with inclusive boundary comparison, and `max_positions` limits the owner/trader-scoped OPEN/PENDING count. Position-count query failures fail closed. Missing or invalid persisted profile limits are rejected without permissive defaults.

Margin validation now requires an authoritative positive `margin_initial` and valid free margin for AI Trader execution; insufficient or unavailable margin is denied. Lot normalization floors at arbitrary broker volume precision (including 0.0001) without rounding risk upward. `ANALYSIS_ONLY` cannot execute, `MANUAL_APPROVAL` requires the explicit approval context, and only canonical `DEMO_AUTONOMOUS` is eligible for autonomous Risk evaluation; legacy `AUTO` is rejected.

The existing Common Risk/Common Execution path remains the sole entry path. No EA, Gateway, migration, Production DB/deploy/ENV change, or MT5 order was made; `demo_execution_enabled=false` remains unchanged. Task 7D focused tests 8/8, Task 7B 14/14, Task 7C 5/5, Stage 1 safety 48/48, Stage 4 and Stage 5A–5D, Stage 6B–6F regressions, typecheck, and builds pass. Stage 7 remains IN PROGRESS; Task 7E–7H remain NOT STARTED.
## 2026-09-24: Task 7E — TP/SL candidate watcher and dedicated AI recheck triggers

追加した`position-candidate-detector.ts`は、Open positionのentry/SL/TP/current priceだけを受け取る純粋な決定論的detectorである。entryからTP/SLまでの進捗が最終20%（`POSITION_CANDIDATE_PROGRESS = 0.8`）に入った場合だけ、LONG/SHORT対称に`TP_RECHECK`または`SL_RECHECK`を返す。無効値、非有限値、無効geometry、曖昧な候補はfail closedし、broker-side Hard Emergency SLには触れない。

既存`handleManagePositions`は`POSITION_REVIEW`時にdetectorを通し、候補がある場合だけ既存`RuntimeService.positionReview()`へ専用triggerを渡す。HOLD/CLOSE/MODIFY_SL/EXTEND_TP、Stage 5C favorable SL validator、既存position command writer、`positionReviewIdempotencyKey`を再利用し、同一position/bar/triggerのAI review・command重複を防ぐ。AI logは既存runtime writerにより`TP_RECHECK`/`SL_RECHECK`として保存される。

Task 7E focused tests 9/9 PASS（候補対称性、無効geometry、HOLD、CLOSE、MODIFY、EXTEND、AI failure、重複、同一ticketのconnection分離）。Task 7B/7C/7D、Stage 1 safety 48/48、Stage 4、Stage 5A〜5D、Stage 6B〜6F、typecheck/build PASS。Migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。Task 7F以降とStage 8〜10は未開始。

## 2026-09-24: Task 7F — AI Log full timeline / complete decision audit trail

Timelineの一次ソースを`ai_analysis_logs`へ統一し、Scenario/FILLED/CLOSEDの別イベントを混在させないowner-safe APIへ切り替えた。`user_id`とTrader ownerをサーバー側で検証し、DBエラーは明示的な5xx、認証失敗は401、空の成功は空配列として区別する。既存の`command_id`、Trader/Version、Scenario、Position相関に加え、allowlistした`connection_id`・decision相関metadataだけを返し、secret・raw provider response・chain-of-thoughtは返さない。

H1、Entry WAIT/ENTER、Position HOLD/CLOSE/MODIFY、TP_RECHECK、SL_RECHECK、MANUAL_APPROVAL、Risk/AI失敗ログを同じTimeline契約で表示できる。Runtime command生成時はAI Logへ`command_id`を保存し、WAIT/HOLDにはcommandを作らない。UIは日本語の判断表示、空状態と取得失敗の分離、AbortController付き30秒bounded polling、重複fetch抑止を備える。

Task 7F focused tests 7/7 PASS、Task 7B/7C/7D/7E、Stage 1 safety 48/48、Stage 4〜6 regressions、Trading View/Gateway typecheck、Trading View/Gateway build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。AUDIT-048〜052 = RESOLVED。Task 7G/7H、Stage 8〜10はNOT STARTED、Stage 7はIN PROGRESS。

## 2026-09-24: Task 7G — Trade Review reliability / fire-and-confirm remediation

Trade Reviewのcanonical entry pointを`POST /api/traders/[id]/review`として維持し、CLOSEDかつowner一致の`ai_positions`と`trade_outcomes`だけを対象にした。AI応答は厳格なZod contract（必須文字列、confidence 1〜5、unknown field拒否）で検証し、AI失敗・malformed JSON・DB保存失敗は完了扱いにしない。`trade_reviews`のinsert結果と相関値をread-back確認し、unique競合は既存reviewとしてidempotentに返す。

Watcher側は既存`runtime_idempotency_claims`でreview試行をclaimし、review endpointを`await`する。`review_dispatched`は`review_id`または`already_reviewed`の確認後にのみ更新し、AI/HTTP/marker更新失敗時はclaimを解放して安全に再試行できる。Review経路はexecution_commands、Gateway、MT5を呼ばず、positionを再オープンしない。

Task 7G focused tests 16/16 PASS、Task 7B〜7F、Stage 1 safety 48/48、Stage 4〜6 regressions、Trading View/Gateway typecheck/build PASS。New migration、Production DB/deploy/ENV変更なし。MT5 orders 0、`demo_execution_enabled=false`。AUDIT-046/047 = RESOLVED。Task 7HとStage 8〜10はNOT STARTED、Stage 7はIN PROGRESS。

## 2026-09-24: Task 7H — Full Stage 7 integrated verification / final freeze

Builderのstrict GOLD profileから、H1 Scenario、M5 Entry WAIT/ENTER、Common Risk、Manual Approval、Common Executionのmocked command、PENDING_OPEN→OPEN、Position Review、TP_RECHECK/SL_RECHECK、CLOSE、Trade Outcome、Trade Review、AI Log相関までを決定論的integration harnessで再確認した。Builderは`ANALYSIS_ONLY`を既定とし、AUTO/LIVE_AUTONOMOUSを受け付けない。WAIT/HOLD、Risk拒否、無効geometry、provider/schema失敗ではcommandを作らない。

Task 7B〜7Gの既存focused suiteとStage 1〜6回帰を再実行し、Stage 1 safety 48/48、Stage 4 lifecycle/safety/runtime/Gateway DI、Stage 5A〜5D、Stage 6B〜6F、Trading View/Gateway typecheck/buildをPASSした。新しいmigration、Production DB/deploy/ENV変更はなく、MT5 ordersは0、`demo_execution_enabled=false`を維持した。Stage 7の統合検証を完了し、AUDIT-027〜030、033〜035、046〜052を現行コード証拠に基づきRESOLVEDとした。

Task 7H = **COMPLETE — STAGE 7 INTEGRATED VERIFICATION PASSED**。Stage 7 = **COMPLETE — AI TRADER INTEGRATED VERIFICATION PASSED**。Stage 8〜10はNOT STARTED。Production Ready、real MT5 E2E、Customer 001 E2E、LIVE_AUTONOMOUS readinessは意味しない。

## 2026-09-25: Stage 9A — Trading View completion audit / design freeze

Stage 9A is read-only. The repository and current Vercel mapping were
verified. The mounted `/chart` path is the connection-scoped `AVLChart`; the
legacy TradingView widget/datafeed and mock provider are not mounted. Genuine
MT5 live data, chart bars, positions, account state, history, AI Trader
scenario/decision/log paths, and frozen Stage 8 Gateway health are present.

The product is not yet a complete customer-facing Jarvis-style experience:
the central AVL AI chat surface, voice controls, unified AI tool dispatcher,
complete execution/order UX, and unified dependency/offline surfaces are
missing or partial. No P0 safety/isolation regression was found. AUDIT-067,
legacy `customers.tv_password` schema cleanup, and migration-history
reconciliation remain deferred non-blocking debt. No Production mutation,
deployment, ENV change, token operation, or trading action was performed by
Stage 9A.
