// =================================================================
// AVL Market Server v3.0  [restart: timestamp normalization fix]
// =================================================================
//
// 設計原則
//   MT5 を唯一のデータソースとする。
//   このサーバーはデータを加工しない。受信→保存→配信のみ。
//
//   価格補正禁止 / 時間補正禁止 / OHLC生成禁止
//
// エンドポイント
//   EA → Server（認証あり）
//     POST /connect          起動通知
//     POST /tick             Tick ストリーム
//     POST /bar              単一バー（リアルタイム）
//     POST /bars/bulk        過去バー一括（起動時）
//     POST /positions        ポジション ストリーム
//     POST /account          口座 ストリーム
//     POST /heartbeat        ハートビート
//     POST /event            切断通知
//
//   Browser → Server（読み取り専用）
//     GET /health            サーバー状態
//     GET /bars/:sym/:tf     過去バー（時刻はEAのまま）
//     GET /tick/:sym         最新 Tick
//     GET /positions         ポジション一覧
//     GET /account           口座情報
//     GET /symbols           シンボル一覧
//
//   WebSocket /ws            リアルタイムストリーム（Tick/BAR/Positions/Account）
//
// 起動: cd gateway && npm run dev
// =================================================================

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import fs   from "fs";
import path from "path";
import { createHash, createHmac, timingSafeEqual } from "crypto"; // STAGE1-04: bridge auth cache
import { sendConsoleMonitoringHeartbeat } from "./console-monitoring";
import {
  upsertBulkBars,
  upsertSingleBar,
  syncBarStoreToSupabase,
  isEnabled as isSupabaseEnabled,
  type BarRecord,
} from "./barDataStore";
import {
  claimNextSyncJob,
  updateSyncJobProgress,
  SUPPORTED_TIMEFRAMES,
  SYNC_JOB_STALE_MS,
} from "./syncJobStore";
import {
  isEnabled as isExecutionEnabled,
  verifyBridgeAuth,
  getPendingCommands,
  claimCommand,
  processExecutionResult,
  updateHeartbeat as updateBridgeHeartbeat,
  markConnectionDisconnected,
  verifyBridgeAuthStatus,
  reconcilePositionSnapshot,
  upsertDeals,
  upsertSymbolSpec,
  type BridgeResultInput,
  type BridgePosition,
  type BridgeDeal,
  type SymbolSpecInput,
} from "./executionStore";
import {
  ConnectionMarketStore,
  connectionBarKey as scopedBarKey,
  connectionTickKey as scopedTickKey,
} from "./connectionMarketStore";
import {
  upsertCustomerBars,
  getLastCustomerBar,
  canonicalizeSymbol,
  SUPPORTED_TIMEFRAMES as CUSTOMER_BAR_TFS,
  type BarIngestionInput,
  type BarSource,
} from "./customerBarDataStore";

void SYNC_JOB_STALE_MS; // suppress unused warning

// -----------------------------------------------------------------
// 型定義 — EA から受け取った値をそのまま保持する
// -----------------------------------------------------------------

/** バー（時刻は rates[i].time のまま＝ブローカー秒） */
interface Bar {
  time:   number; // rates[i].time 秒（EA送信値そのまま）
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

/** Tick（時刻は TimeCurrent() のまま） */
interface Tick {
  symbol: string;
  bid:    number;
  ask:    number;
  spread: number;
  digits: number;
  time:   number; // TimeCurrent() 秒
}

/** ポジション */
interface Position {
  ticket:       number;
  type:         number;
  volume:       number;
  openPrice:    number;
  currentPrice: number;
  sl:           number;
  tp:           number;
  profit:       number;
  swap:         number;
  openTime:     number;
  magic:        number;
}

/** 口座情報 */
interface Account {
  login:       number;
  broker:      string;
  currency:    string;
  balance:     number;
  equity:      number;
  margin:      number;
  freeMargin:  number;
  marginLevel: number;
  leverage:    number;
}

/** Market Watch シンボル（EA から送信される完全データ） */
interface MarketWatchSymbol {
  symbol:       string;
  bid:          number;
  ask:          number;
  spread:       number;   // pips
  changePct:    number;   // 日次変化率 %
  digits:       number;
  point:        number;
  contractSize: number;
  tickValue:    number;
  tickSize:     number;
  high52:       number;
  low52:        number;
  prevClose:    number;
  time:         number;   // ブローカー秒
  receivedAt:   number;   // サーバー受信時刻 ms
}

/** 注文（Pending + Position） */
interface Order {
  ticket:       number;
  symbol:       string;
  type:         number;  // ORDER_TYPE / POSITION_TYPE
  orderType:    "pending" | "position";
  volume:       number;
  openPrice:    number;
  currentPrice?: number;
  sl:           number;
  tp:           number;
  profit:       number;
  swap:         number;
  commission:   number;
  openTime:     number;
  magic:        number;
  comment:      string;
}

/** インジケーター（AI基盤）— 各時間足の拡張インジケーター */
interface TFIndicator {
  ema21:      number;
  ema200:     number;
  sma50:      number;
  atr:        number;
  rsi:        number;
  macd:       number;
  macdSignal: number;
  macdHist:   number;
  adx:        number;
  diPlus:     number;
  diMinus:    number;
  bbUpper:    number;
  bbMid:      number;
  bbLower:    number;
  bbWidth:    number;
  trend:      "UP" | "DOWN" | "FLAT";
}

/** 取引履歴 — 決済 Deal */
interface HistoryDeal {
  ticket:      number;
  symbol:      string;
  type:        number;  // 0=BUY, 1=SELL
  volume:      number;
  closeTime:   number;  // Unix秒
  closePrice:  number;
  profit:      number;
  swap:        number;
  commission:  number;
  magic:       number;
  receivedAt?: number;
}

interface Indicators {
  symbol:     string;
  spread:     number;
  digits:     number;
  brokerTime: number;
  timeframes: Record<string, TFIndicator>; // "H4" | "H1" | "M15" | "M5"
  receivedAt: number; // Gatewayサーバー受信時刻（ms）
  sessions?:  string[]; // Tokyo / London / New York / Sydney
}

// セッション判定（UTC 時刻ベース）
function getTradingSessions(brokerTimeSec: number): string[] {
  const d     = new Date(brokerTimeSec * 1000);
  const hour  = d.getUTCHours();
  const min   = d.getUTCMinutes();
  const t     = hour + min / 60; // 小数時間
  const sess: string[] = [];
  if (t >= 22 || t < 7)   sess.push("Wellington/Sydney");  // 22:00-07:00 UTC
  if (t >= 0  && t < 9)   sess.push("Tokyo");               // 00:00-09:00 UTC
  if (t >= 7  && t < 16)  sess.push("London");              // 07:00-16:00 UTC
  if (t >= 12 && t < 21)  sess.push("New York");            // 12:00-21:00 UTC
  return sess.length > 0 ? sess : ["Market Closed"];
}

/** WebSocket 配信メッセージ */
interface WsMessage {
  type:       string;
  symbol?:    string;
  timeframe?: string;
  data?:      unknown;
  ts:         number; // サーバー受信時刻（ms）
}

// -----------------------------------------------------------------
// Express + HTTP サーバー
// -----------------------------------------------------------------

const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// -----------------------------------------------------------------
// バーストア永続化（再起動してもデータを保持する）
// -----------------------------------------------------------------

const PERSIST_FILE = path.join(process.cwd(), "data", "bars.json");

function persistSave(): void {
  try {
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    const obj: Record<string, Bar[]> = {};
    barStore.forEach((bars, key) => { obj[key] = bars; });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(obj));
  } catch (e) {
    console.warn("[Persist] 保存失敗:", e);
  }
}

function persistLoad(): void {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8")) as Record<string, Bar[]>;
    let total = 0;
    for (const [key, bars] of Object.entries(obj)) {
      barStore.set(key, bars);
      total += bars.length;
    }
    console.log(`[Persist] 復元: ${Object.keys(obj).length}キー, ${total}本`);
  } catch (e) {
    console.warn("[Persist] 読み込み失敗:", e);
  }
}

// 30秒ごとに自動保存
setInterval(persistSave, 30_000);

// -----------------------------------------------------------------
// インメモリストア（加工なし）
// -----------------------------------------------------------------

const MAX_BARS = 10_000; // Gatewayインメモリキャッシュ上限（長期保存はSupabase bar_dataが担う）

/** "EURUSD:H1" → Bar[]  （時刻はブローカー秒、昇順） */
const barStore      = new Map<string, Bar[]>();
/** "EURUSD" → Tick */
const tickStore     = new Map<string, Tick>();

// P0-04: Runtime market state is keyed by connection identity. Legacy global
// stores below remain for compatibility with older public API paths; the
// canonical connection-specific runtime never reads them.
const connectionMarketStore = new ConnectionMarketStore<Tick, Bar>();
// Compatibility names retained for existing structural safety checks and
// migration traceability; both names refer to the same typed scoped store.
const connTickStore = connectionMarketStore;
const connBarStore = connectionMarketStore;
function connBarKey(connectionId: string, symbol: string, timeframe: string): string {
  return scopedBarKey(connectionId, symbol, timeframe);
}
function connTickKey(connectionId: string, symbol: string): string {
  return scopedTickKey(connectionId, symbol);
}

// ── P0-05: Connection-scoped WS clients (connectionId → Set<WebSocket>)
// Used to send EXECUTION_RESULT only to the owning connection's clients.
const connWsClients = new Map<string, Set<WebSocket>>();

function verifyWsAccessToken(token: string, connectionId: string): boolean {
  const secret = SECRET;
  if (!secret || !token || !connectionId) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { connectionId?: string; exp?: number };
    return payload.connectionId === connectionId && Number.isFinite(payload.exp) && payload.exp! > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function broadcastToConnection(connectionId: string, msg: WsMessage): void {
  const clients = connWsClients.get(connectionId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(payload); });
}
/** ポジション配列 */
let   positions:    Position[] = [];
/** 口座情報 */
let   account:      Account | null = null;
/** EA 接続情報 */
let   eaInfo:       Record<string, unknown> | null = null;
/** P3 observability: last bridge heartbeat timestamp (ms).
 * eaConnected in /health derives from this when /connect has not been called
 * since the last Gateway restart.  Does not affect execution semantics. */
let   lastBridgeHeartbeatTs = 0;
/** インジケーターストア（AI基盤）"EURUSD" → Indicators */
const indicatorStore = new Map<string, Indicators>();
const connIndicatorStore = new Map<string, Map<string, Indicators>>();
/** 取引履歴ストア "EURUSD" → HistoryDeal[] （ticket でユニーク管理）*/
const historyStore  = new Map<string, Map<number, HistoryDeal>>();
/** Market Watch シンボルストア "EURUSD" → MarketWatchSymbol */
const symbolStore   = new Map<string, MarketWatchSymbol>();
const connSymbolStore = new Map<string, Map<string, MarketWatchSymbol>>();
/** 注文ストア（Pending + Position）ticket → Order */
const orderStore    = new Map<number, Order>();
const connOrderStore = new Map<string, Map<number, Order>>();
/** 注文キュー（AI → EA 発注用） */
const orderQueue:   Array<Record<string, unknown>> = [];

// Diagnostic timestamps for health endpoint
let lastTickTs:      number = 0;
let lastSymbolTs:    number = 0;
let lastIndicatorTs: number = 0;

/** Per-symbol heartbeat tracking (symbol → ISO timestamp of last heartbeat) */
const heartbeatStore = new Map<string, string>();

// -----------------------------------------------------------------
// STAGE1-04: Bridge Auth キャッシュ（高頻度エンドポイント用 TTL 30s）
// /bridge/ticks と /bridge/bars への毎Tick DB照会を防ぐ
// -----------------------------------------------------------------
const bridgeAuthCache = new Map<string, { tokenHash: string; expiresAt: number }>();
const BRIDGE_AUTH_CACHE_TTL_MS = 30_000; // 30秒

// P0-03: Auth result type — distinguishes "denied" from "backend unavailable"
type AuthCachedResult = "ok" | "denied" | "unavailable";

async function verifyBridgeAuthCached(
  connectionId: string,
  connectionToken: string,
): Promise<AuthCachedResult> {
  // P0-03: FAIL CLOSED — if DB backend is unavailable, reject (not skip)
  if (!isExecutionEnabled()) {
    return "unavailable";
  }

  // Security-sensitive connection endpoints always re-check the backend.
  // A local cache would permit revoked/disabled credentials to survive its TTL.
  const flags = await verifyBridgeAuthStatus(connectionId, connectionToken);
  if (flags === "unavailable") return "unavailable";
  if (flags !== "denied") {
    return "ok";
  }

  bridgeAuthCache.delete(connectionId); // 無効化
  return "denied";
}

// -----------------------------------------------------------------
// Market Watcher — M5確定検知
// -----------------------------------------------------------------

/** Connection-scoped last M5 close time を Supabase へ永続化（fire-and-forget） */
function persistLastM5Time(connectionId: string, symbol: string, barTime: number): void {
  if (!isExecutionEnabled()) return;
  const { createClient: makeSupabase } = require("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const sb = makeSupabase(url, key, { global: { fetch: globalThis.fetch } });
  const gKey = `last_m5_close_time_${connectionId}__${encodeURIComponent(symbol)}`;
  sb.from("gateway_state")
    .upsert({ key: gKey, value: String(barTime), updated_at: new Date().toISOString() }, { onConflict: "key" })
    .then(({ error }: { error: unknown }) => {
      if (error) console.warn(`[M5Persist] upsert error: ${(error as Error).message ?? error}`);
    });
}

/** Gateway 起動時に Supabase から lastM5Time を復元 */
async function restoreLastM5Times(): Promise<void> {
  if (!isExecutionEnabled()) return;
  try {
    const { createClient: makeSupabase } = require("@supabase/supabase-js");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const sb = makeSupabase(url, key, { global: { fetch: globalThis.fetch } });
    const { data } = await sb.from("gateway_state").select("key, value").like("key", "last_m5_close_time_%");
    if (!data) return;
    for (const row of data as Array<{ key: string; value: string }>) {
      const suffix = row.key.replace("last_m5_close_time_", "");
      const delimiter = suffix.indexOf("__");
      const connectionId = delimiter >= 0 ? suffix.slice(0, delimiter) : "";
      const symbol = delimiter >= 0 ? decodeURIComponent(suffix.slice(delimiter + 2)) : suffix;
      const t = parseInt(row.value, 10);
      if (t > 0) {
        connectionMarketStore.setLastM5Time(connectionId, symbol, t);
        console.log(`[M5Restore] ${connectionId}:${symbol} = ${t}`);
      }
    }
  } catch (e) {
    console.warn("[M5Restore] failed:", e instanceof Error ? e.message : e);
  }
}

const WATCHER_APP_URL   = process.env.APP_URL        ?? "";
const WATCHER_SECRET    = process.env.WATCHER_SECRET ?? "";

/** ユーザー別ポジション数を追跡（userId → count） — POSITION_CHANGED検知用 */
const lastPositionCountStore = new Map<string, number>();

/** 任意のトリガーをVercel Market Watcherへ通知（fire-and-forget） */
function notifyWatcher(symbol: string, barTime: number, currentPrice: number, triggerOverride?: string): void {
  if (!WATCHER_APP_URL || !WATCHER_SECRET) return;

  const url = `${WATCHER_APP_URL}/api/watcher/m5-close`;
  fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-watcher-secret": WATCHER_SECRET,
    },
    body: JSON.stringify({
      symbol,
      bar_time:         barTime,
      current_price:    currentPrice,
      trigger_override: triggerOverride ?? null,
    }),
    signal: AbortSignal.timeout(12_000),
  }).then(r => {
    if (!r.ok) console.warn(`[Watcher] notify failed: ${r.status} ${symbol} trigger=${triggerOverride ?? "M5"}`);
    else       console.log(`[Watcher] notified: ${symbol} bar=${barTime} price=${currentPrice} trigger=${triggerOverride ?? "M5_CLOSE"}`);
  }).catch(e => {
    console.warn(`[Watcher] notify error: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** M5バー確定をVercel Market Watcherへ通知（fire-and-forget） */
function notifyM5Close(symbol: string, closedBarTime: number, currentPrice: number): void {
  if (!WATCHER_APP_URL || !WATCHER_SECRET) return;

  const url = `${WATCHER_APP_URL}/api/watcher/m5-close`;
  fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-watcher-secret": WATCHER_SECRET,
    },
    body: JSON.stringify({
      symbol,
      bar_time:      closedBarTime,  // 確定したM5バーのUnix秒
      current_price: currentPrice,
    }),
    signal: AbortSignal.timeout(12_000),
  }).then(r => {
    if (!r.ok) console.warn(`[M5Watcher] notify failed: ${r.status} ${symbol}`);
    else console.log(`[M5Watcher] notified: ${symbol} bar_time=${closedBarTime} price=${currentPrice}`);
  }).catch(e => {
    console.warn(`[M5Watcher] notify error: ${e instanceof Error ? e.message : String(e)}`);
  });
}

// -----------------------------------------------------------------
// WebSocket サーバー /ws
// -----------------------------------------------------------------

const wss     = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws, req) => {
  // Customer sockets must prove the connection identity before they enter the
  // scoped recipient map.  Global gateway credentials are not accepted here.
  const urlObj = new URL(req.url ?? "/", "http://localhost");
  const wsConnId = urlObj.searchParams.get("connectionId") ?? "";
  const wsToken = urlObj.searchParams.get("accessToken") ?? "";
  void (async () => {
    if (!wsConnId || !verifyWsAccessToken(wsToken, wsConnId)) {
      ws.close(1008, "connection authentication required");
      return;
    }
    clients.add(ws);
    if (!connWsClients.has(wsConnId)) connWsClients.set(wsConnId, new Set());
    connWsClients.get(wsConnId)!.add(ws);
    console.log(`[WS] 接続 ${req.socket.remoteAddress} connId=${wsConnId} (計${clients.size})`);
  })().catch(() => ws.close(1011, "authentication unavailable"));

  ws.on("close", () => {
    clients.delete(ws);
    if (wsConnId) connWsClients.get(wsConnId)?.delete(ws);
  });
  ws.on("error", () => {
    clients.delete(ws);
    if (wsConnId) connWsClients.get(wsConnId)?.delete(ws);
  });
});

function safeSend(ws: WebSocket, msg: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: WsMessage): void {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

// -----------------------------------------------------------------
// 認証ミドルウェア（EA → Server 間のみ）
// -----------------------------------------------------------------

const SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

function auth(req: Request, res: Response, next: NextFunction): void {
  if (!SECRET) { res.status(401).json({ error: "Unauthorized: SECRET not configured" }); return; }
  // 1. Authorization: Bearer {secret} または x-gateway-secret: {secret}
  const bearer  = (req.headers.authorization ?? "").replace("Bearer ", "").trim();
  const xSecret = (req.headers["x-gateway-secret"] ?? "") as string;
  const token   = bearer || xSecret;
  if (token === SECRET) { next(); return; }

  // 2. Bridge EA 認証: X-Connection-Id + X-Connection-Token（Bearer不要）
  //    個別エンドポイントで verifyBridgeAuth による二次検証を行う
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;
  if (connectionId && connectionToken) { next(); return; }

  res.status(401).json({ error: "Unauthorized" });
}

/** Customer-scoped endpoints always require the connection credential.
 * The global gateway secret is intentionally not an identity substitute. */
async function enforceConnectionAuth(req: Request, res: Response): Promise<boolean> {
  const connectionId = (req.headers["x-connection-id"] ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;
  // Internal service header is DISABLED for /market-data/* endpoints.
  // All customer-data endpoints must use verified bridge credentials.
  // The x-internal-service-auth bypass is retained only for non-customer-data
  // endpoints (heartbeat, status) and must not be used for identity substitution.
  const isMarketDataPath = (req.path ?? "").startsWith("/market-data/");
  const internalAuth = isMarketDataPath ? "" : (req.headers["x-internal-service-auth"] ?? "") as string;
  if (internalAuth && SECRET && internalAuth === SECRET && connectionId) return true;
  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return false;
  }
  const result = await verifyBridgeAuthCached(connectionId, connectionToken);
  if (result === "unavailable") {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return false;
  }
  if (result === "denied") {
    res.status(401).json({ error: "認証失敗" });
    return false;
  }
  return true;
}

// -----------------------------------------------------------------
// EA → Server: 受信エンドポイント（加工禁止）
// -----------------------------------------------------------------

/** EA 起動通知 */
app.post("/connect", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  eaInfo = req.body as Record<string, unknown>;
  const { symbol, login, broker, serverTime } = eaInfo as Record<string, unknown>;
  console.log(`[EA] 接続: symbol=${symbol} login=${login} broker=${broker} serverTime=${serverTime}`);
  broadcastToConnection(connectionId, { type: "EA_CONNECTED", data: eaInfo, ts: Date.now() });
  res.json({ ok: true });
});

/** EA 停止 / 切断 */
app.post("/event", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const { type, symbol } = req.body as { type: string; symbol: string };
  if (type === "DISCONNECT") {
    eaInfo = null;
    console.log(`[EA] 切断: ${symbol}`);
  }
  broadcastToConnection(connectionId, { type, symbol, ts: Date.now() });
  res.json({ ok: true });
});

/** Tick ストリーム — 受信値をそのまま保存・配信 */
// STAGE1-REMEDIATION: Legacy endpoint — apply same auth as /bridge/ticks
app.post("/tick", auth, async (req, res) => {
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;
  if (!await enforceConnectionAuth(req, res)) return;
  const tick = req.body as Tick;
  // connTickKey(connectionId, tick.symbol) is the canonical identity.
  connectionMarketStore.setTick(connectionId, tick);
  // Legacy tickStore kept in sync for GET /tick/:symbol backward compat (removed Stage 9)
  tickStore.set(tick.symbol.toUpperCase(), tick);
  lastTickTs = Date.now();
  broadcastToConnection(connectionId, { type: "TICK", symbol: tick.symbol, data: tick, ts: Date.now() });
  res.json({ ok: true });
});

/**
 * バー リアルタイム更新 — 受信値をそのまま保存・配信
 * 同 time のバーは上書き（未確定バー更新）、新 time は追記。
 */
// STAGE1-REMEDIATION: Legacy endpoint — apply same auth as /bridge/bars
app.post("/bar", auth, async (req, res) => {
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;
  if (!await enforceConnectionAuth(req, res)) return;
  const bar = req.body as Bar & { symbol: string; timeframe: string };
  if (bar.timeframe === "M1") {
    const norm = normalizeTime(bar.time);
    console.log(`[BAR/M1] raw=${bar.time} norm=${norm} close=${bar.close}`);
  }
  // V1 persistence: detect confirmed bar BEFORE updating store (ordering is critical)
  upsertBar(connectionId, bar.symbol, bar.timeframe, bar);
  const connectionBars = connectionMarketStore.getBars(connectionId, bar.symbol, bar.timeframe);
  connectionMarketStore.upsertBars(
    connectionId,
    bar.symbol,
    bar.timeframe,
    dedupAndSort([...connectionBars, normalizeBar(bar)]),
    MAX_BARS,
  );
  // Legacy barStore kept in sync for GET /bars/:sym/:tf backward compat (removed Stage 9)
  const legKey = storeKey(bar.symbol, bar.timeframe);
  barStore.set(legKey, dedupAndSort([...(barStore.get(legKey) ?? []), normalizeBar(bar)]).slice(-MAX_BARS));
  broadcastToConnection(connectionId, { type: "BAR", symbol: bar.symbol, timeframe: bar.timeframe, data: bar, ts: Date.now() });

  // ── M5確定検知 ──────────────────────────────────────────────────
  if (bar.timeframe === "M5") {
    const symKey  = bar.symbol.toUpperCase();
    const prevTime = connectionMarketStore.getLastM5Time(connectionId, symKey);
    const newTime  = bar.time;

    if (prevTime !== undefined && prevTime !== newTime) {
      console.log(`[M5Watcher] 確定: ${symKey} prev=${prevTime} new=${newTime} price=${bar.close}`);
      notifyM5Close(symKey, prevTime, bar.close);
      persistLastM5Time(connectionId, symKey, newTime);
    }

    connectionMarketStore.setLastM5Time(connectionId, symKey, newTime);
  }

  res.json({ ok: true });
});

/** 過去バー一括受信（EA 起動時） */
// STAGE1-REMEDIATION: Legacy endpoint — apply same auth as /bridge/bars/bulk
app.post("/bars/bulk", auth, async (req, res) => {
  const connId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connToken = (req.headers["x-connection-token"] ?? "") as string;
  if (!await enforceConnectionAuth(req, res)) return;
  const { symbol, timeframe, bars } = req.body as {
    symbol: string; timeframe: string; bars: Bar[];
  };
  if (!symbol || !timeframe || !Array.isArray(bars)) {
    res.status(400).json({ error: "symbol / timeframe / bars が必要です" });
    return;
  }
  const key      = connBarKey(connId, symbol, timeframe);
  const existing = connectionMarketStore.getBars(connId, symbol, timeframe);
  const normalized = bars.map(normalizeBar);

  // タイムスタンプ整合性チェック:
  // bulk最新バーがtickより1時間以上先の場合はチャートキャッシュのTZ不整合と判断してスキップ
  const tick = connectionMarketStore.getTick(connId, symbol);
  if (tick && normalized.length > 0) {
    const sorted0 = dedupAndSort(normalized);
    const lastBulkMs = sorted0[sorted0.length - 1].time;
    const tickMs = normalizeTime(tick.time);
    const diffSec = (lastBulkMs - tickMs) / 1000;
    if (diffSec > 3600) {
      console.warn(`[Bulk] ${key} TZ不整合スキップ: bulk末尾=${lastBulkMs} tick=${tickMs} diff=${Math.floor(diffSec/60)}分`);
      res.json({ ok: true, skipped: "tz_mismatch" });
      return;
    }
  }

  // 既存より本数が多い（新規 or EA 再起動）場合のみ barStore を上書き
  if (!existing || bars.length >= existing.length) {
    const sorted = dedupAndSort(normalized);
    connectionMarketStore.upsertBars(connId, symbol, timeframe, sorted, MAX_BARS);
    // Legacy barStore kept in sync for GET /bars/:sym/:tf and persistSave() (removed Stage 9)
    const legBarsKey = storeKey(symbol, timeframe);
    barStore.set(legBarsKey, sorted.slice(-MAX_BARS));
    console.log(`[Bulk] ${key}: ${sorted.length}本`);
    persistSave(); // Bulk受信は重要データなので即座に保存
  }

  // Supabase への永続化（barStore の結果とは独立して常にupsert）
  // fire-and-forget: Gatewayレスポンスをブロックしない
  if (normalized.length > 0) {
    upsertBulkBars(connId, symbol, timeframe, normalized as BarRecord[]).catch((err: unknown) => {
      console.warn(`[barData] bulk upsert failed ${key}:`, err);
    });
  }

  res.json({ ok: true });
});

// Bridge EA 用エイリアス（/tick /bar /bars/bulk と同じ処理）
// STAGE1-04 AUDIT-021: connection-based 認証時はトークンをキャッシュ付きで検証
app.post("/bridge/ticks", auth, async (req, res) => {
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;

  if (!await enforceConnectionAuth(req, res)) return;

  const tick = req.body as Tick;
  // P0-04: also store in connection-scoped store
  connectionMarketStore.setTick(connectionId, tick);
  // Legacy tickStore kept in sync for GET /tick/:symbol backward compat (removed Stage 9)
  tickStore.set(tick.symbol.toUpperCase(), tick);
  lastTickTs = Date.now();
  broadcastToConnection(connectionId, { type: "TICK", symbol: tick.symbol, data: tick, ts: Date.now() });
  res.json({ ok: true });
});

app.post("/bridge/bars", auth, async (req, res) => {
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;

  if (!await enforceConnectionAuth(req, res)) return;

  const bar = req.body as Bar & { symbol: string; timeframe: string };
  // V1 persistence: detect confirmed bar BEFORE updating store (ordering is critical).
  // upsertBar reads connectionMarketStore to find the previous bar; calling it after
  // upsertBars would make it see the new bar as "last", skipping persistence.
  upsertBar(connectionId, bar.symbol, bar.timeframe, bar);
  const existing = connectionMarketStore.getBars(connectionId, bar.symbol, bar.timeframe);
  connectionMarketStore.upsertBars(
    connectionId,
    bar.symbol,
    bar.timeframe,
    dedupAndSort([...existing, normalizeBar(bar)]),
    MAX_BARS,
  );
  // Legacy barStore kept in sync for GET /bars/:sym/:tf backward compat (removed Stage 9)
  const legBarKey = storeKey(bar.symbol, bar.timeframe);
  barStore.set(legBarKey, dedupAndSort([...(barStore.get(legBarKey) ?? []), normalizeBar(bar)]).slice(-MAX_BARS));
  broadcastToConnection(connectionId, { type: "BAR", symbol: bar.symbol, timeframe: bar.timeframe, data: bar, ts: Date.now() });
  res.json({ ok: true });
});

// STAGE1-REMEDIATION AUDIT-021: add token verification
app.post("/bridge/bars/bulk", auth, async (req, res) => {
  const connectionId    = (req.headers["x-connection-id"]    ?? "") as string;
  const connectionToken = (req.headers["x-connection-token"] ?? "") as string;
  if (!await enforceConnectionAuth(req, res)) return;
  const { symbol, timeframe, bars } = req.body as {
    symbol: string; timeframe: string; bars: Bar[];
  };
  if (!symbol || !timeframe || !Array.isArray(bars)) {
    res.status(400).json({ error: "symbol / timeframe / bars が必要です" });
    return;
  }
  const key      = connBarKey(connectionId, symbol, timeframe);
  const existing = connectionMarketStore.getBars(connectionId, symbol, timeframe);
  const normalized = bars.map(normalizeBar);

  if (!existing || bars.length >= existing.length) {
    const sorted = dedupAndSort(normalized);
    connectionMarketStore.upsertBars(connectionId, symbol, timeframe, sorted, MAX_BARS);
    // Legacy barStore kept in sync for GET /bars/:sym/:tf and persistSave() (removed Stage 9)
    const legBulkKey = storeKey(symbol, timeframe);
    barStore.set(legBulkKey, sorted.slice(-MAX_BARS));
    console.log(`[Bridge/Bulk] ${key}: ${sorted.length}本`);
    persistSave();
  }

  if (normalized.length > 0) {
    upsertBulkBars(connectionId, symbol, timeframe, normalized as BarRecord[]).catch((err: unknown) => {
      console.warn(`[barData] bridge bulk upsert failed ${key}:`, err);
    });
  }

  res.json({ ok: true });
});

/** ポジション ストリーム */
app.post("/positions", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const { positions: pos, symbol } = req.body as { positions: Position[]; symbol: string };
  broadcastToConnection(connectionId, { type: "POSITIONS", symbol, data: pos ?? [], ts: Date.now() });
  res.json({ ok: true });
});

/** 口座情報 ストリーム */
app.post("/account", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  account = req.body as Account;
  broadcastToConnection(connectionId, { type: "ACCOUNT", data: account, ts: Date.now() });
  res.json({ ok: true });
});

/** ハートビート — per-symbol last-seen tracking (Data Phase G) */
app.post("/heartbeat", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const body = req.body as { symbol?: string; serverTime?: number };
  if (body.symbol) {
    heartbeatStore.set(body.symbol.toUpperCase(), new Date().toISOString());
  }
  broadcastToConnection(connectionId, { type: "HEARTBEAT", data: req.body, ts: Date.now() });
  void sendConsoleMonitoringHeartbeat({
    gateway_online: true,
    mt5_connected: Boolean((req.body as { mt5_connected?: unknown }).mt5_connected),
    mt5_account_mode: (req.body as { mt5_account_mode?: "HEDGING" | "NETTING" }).mt5_account_mode ?? null,
    bridge_version: (req.body as { bridge_version?: string }).bridge_version ?? null,
    metadata: { source: "customer-gateway" },
  });
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// Market Watch シンボル一括受信
// -----------------------------------------------------------------

app.post("/symbols/bulk", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const body = req.body as { count?: number; symbols?: MarketWatchSymbol[] };
  if (!Array.isArray(body.symbols)) { res.status(400).json({ error: "symbols が必要です" }); return; }

  const now = Date.now();
  let updated = 0;
  for (const sym of body.symbols) {
    if (!sym.symbol) continue;
    symbolStore.set(sym.symbol.toUpperCase(), { ...sym, receivedAt: now });
    if (!connSymbolStore.has(connectionId)) connSymbolStore.set(connectionId, new Map());
    connSymbolStore.get(connectionId)!.set(sym.symbol.toUpperCase(), { ...sym, receivedAt: now });
    updated++;
  }

  lastSymbolTs = now;
  broadcastToConnection(connectionId, { type: "SYMBOLS", data: Array.from(connSymbolStore.get(connectionId)?.values() ?? []), ts: now });
  res.json({ ok: true, updated });
});

// -----------------------------------------------------------------
// 注文ストリーム（EA から全注文+ポジションを受信）
// -----------------------------------------------------------------

app.post("/orders/stream", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const body = req.body as { count?: number; orders?: Order[] };
  if (!Array.isArray(body.orders)) { res.status(400).json({ error: "orders が必要です" }); return; }

  // Keep the legacy store for compatibility, but stream only this connection's orders.
  orderStore.clear();
  if (!connOrderStore.has(connectionId)) connOrderStore.set(connectionId, new Map());
  const scopedOrders = connOrderStore.get(connectionId)!;
  scopedOrders.clear();
  for (const order of body.orders) {
    if (!order.ticket) continue;
    orderStore.set(order.ticket, order);
    scopedOrders.set(order.ticket, order);
  }

  broadcastToConnection(connectionId, { type: "ORDERS", data: Array.from(scopedOrders.values()), ts: Date.now() });
  res.json({ ok: true, count: scopedOrders.size });
});

/** インジケーターストリーム（AI基盤）— 拡張インジケーター */
app.post("/indicators", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const connectionId = req.headers["x-connection-id"] as string;
  const body = req.body as Omit<Indicators, "receivedAt">;
  if (!body.symbol || !body.timeframes) {
    res.status(400).json({ error: "symbol / timeframes が必要です" });
    return;
  }
  const sessions = getTradingSessions(body.brokerTime);
  const data: Indicators = { ...body, receivedAt: Date.now(), sessions };
  indicatorStore.set(body.symbol.toUpperCase(), data);
  if (!connIndicatorStore.has(connectionId)) connIndicatorStore.set(connectionId, new Map());
  connIndicatorStore.get(connectionId)!.set(body.symbol.toUpperCase(), data);
  lastIndicatorTs = Date.now();
  broadcastToConnection(connectionId, { type: "INDICATORS", symbol: body.symbol, data, ts: Date.now() });
  res.json({ ok: true });
});

/** インジケーター取得 */
app.get("/indicators/:symbol", (_req, res) => {
  const ind = indicatorStore.get(_req.params.symbol.toUpperCase());
  if (!ind) { res.status(404).json({ error: "symbol not found" }); return; }
  res.json(ind);
});

/** 全シンボルのインジケーター取得 */
app.get("/indicators", (_req, res) => {
  const list: Indicators[] = [];
  indicatorStore.forEach((v) => list.push(v));
  res.json(list);
});

// -----------------------------------------------------------------
// 取引履歴ストリーム（History Stream）
// -----------------------------------------------------------------

/** EA → Gateway: 取引履歴一括受信 */
app.post("/history/bulk", auth, (req, res) => {
  const body = req.body as { symbol: string; deals: Omit<HistoryDeal, "symbol" | "receivedAt">[] };
  if (!body.symbol || !Array.isArray(body.deals)) {
    res.status(400).json({ error: "symbol / deals が必要です" });
    return;
  }
  const sym = body.symbol.toUpperCase();
  if (!historyStore.has(sym)) historyStore.set(sym, new Map());
  const symMap = historyStore.get(sym)!;

  let added = 0;
  for (const deal of body.deals) {
    if (!symMap.has(deal.ticket)) {
      symMap.set(deal.ticket, { ...deal, symbol: sym, receivedAt: Date.now() });
      added++;
    }
  }
  console.log(`[History] ${sym}: ${added} 件追加 (合計 ${symMap.size} 件)`);
  res.json({ ok: true, added, total: symMap.size });
});

/** 特定シンボルの履歴取得（新しい順） */
app.get("/history/:symbol", (_req, res) => {
  const sym     = _req.params.symbol.toUpperCase();
  const symMap  = historyStore.get(sym);
  if (!symMap || symMap.size === 0) {
    res.json([]);
    return;
  }
  const list = Array.from(symMap.values())
    .sort((a, b) => b.closeTime - a.closeTime);
  res.json(list);
});

/** 全シンボルの履歴取得 */
app.get("/history", (_req, res) => {
  const list: HistoryDeal[] = [];
  historyStore.forEach((symMap) => symMap.forEach((d) => list.push(d)));
  list.sort((a, b) => b.closeTime - a.closeTime);
  res.json(list);
});

// -----------------------------------------------------------------
// 管理エンドポイント（ローカル限定）
// -----------------------------------------------------------------

/** 特定シンボル・時間足のバーをクリア（異常なタイムスタンプ修正用） */
app.delete("/admin/bars/:symbol/:timeframe", (_req, res) => {
  const key = storeKey(_req.params.symbol, _req.params.timeframe);
  barStore.delete(key);
  console.log(`[Admin] ${key} クリア`);
  res.json({ ok: true, key });
});

// -----------------------------------------------------------------
// Phase4: 注文管理（スタブ）
// -----------------------------------------------------------------

app.get("/orders/pending", auth, (req, res) => {
  const pending = orderQueue.filter((o) => o.status === "pending");
  pending.forEach((o) => { o.status = "acknowledged"; });
  res.json(pending);
});

app.post("/orders/:id/result", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const order = orderQueue.find((o) => o.id === req.params.id);
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  order.status = (req.body as { success: boolean }).success ? "executed" : "failed";
  broadcastToConnection(req.headers["x-connection-id"] as string, { type: "ORDER_RESULT", data: { ...order, result: req.body }, ts: Date.now() });
  res.json({ ok: true });
});

app.post("/orders", auth, async (req, res) => {
  if (!await enforceConnectionAuth(req, res)) return;
  const order = { id: `order_${Date.now()}`, status: "pending", createdAt: Date.now(), ...req.body };
  orderQueue.push(order);
  broadcastToConnection(req.headers["x-connection-id"] as string, { type: "ORDER_QUEUED", data: order, ts: Date.now() });
  res.json({ ok: true, id: order.id });
});

// =================================================================
// STAGE 3-B: Execution Bridge Endpoints
// Bridge EA ↔ Gateway の双方向通信
//
// 認証:
//   Bearer GATEWAY_SECRET (既存 auth ミドルウェア)
//   + X-Connection-Id ヘッダ + X-Connection-Token ヘッダ
//   → executionStore.verifyBridgeAuth() でSHA-256照合
//
// セキュリティ:
//   - X-Connection-Token はログに出力しない
//   - Terminal StateのCommandは更新不可
//   - PENDING以外のClaimはAtomic updateで無効化
// =================================================================

/** Bridge EA: Heartbeat送信 + Safety Flags受信 */
app.post("/bridge/heartbeat", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return;
  }

  // STAGE1-03 AUDIT-078: token検証（口座データ更新前に認証）
  const heartbeatAuthStatus = await verifyBridgeAuthStatus(connectionId, connectionToken);
  if (heartbeatAuthStatus === "unavailable") {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return;
  }
  const heartbeatAuth = heartbeatAuthStatus === "denied" ? null : heartbeatAuthStatus;
  if (!heartbeatAuth) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const body = req.body as {
    mt5Login?:     number;
    broker?:       string;
    accountType?:  "REAL" | "DEMO";
    accountMode?:  "HEDGING" | "NETTING";
    tradeAllowed?: boolean;
    balance?:      number;
    equity?:       number;
    margin?:       number;
    freeMargin?:   number;
    leverage?:     number;
  };

  // STAGE1-REMEDIATION: Schema validation — required fields must be explicitly present.
  // Reject malformed heartbeat: do NOT silently substitute safe-looking defaults.
  const validAccountTypes = ["REAL", "DEMO"];
  const validAccountModes = ["HEDGING", "NETTING"];

  if (!body.accountType || !validAccountTypes.includes(body.accountType)) {
    res.status(400).json({ error: `accountType が無効です: "${body.accountType}". 必須: REAL or DEMO` });
    return;
  }
  if (!body.accountMode || !validAccountModes.includes(body.accountMode)) {
    res.status(400).json({ error: `accountMode が無効です: "${body.accountMode}". 必須: HEDGING or NETTING` });
    return;
  }
  if (typeof body.tradeAllowed !== "boolean") {
    res.status(400).json({ error: "tradeAllowed が必要です" });
    return;
  }

  const numeric = [body.balance, body.equity, body.margin, body.freeMargin, body.leverage];
  if (numeric.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    res.status(400).json({ error: "heartbeat numeric fields are invalid" });
    return;
  }
  const balance = body.balance as number;
  const equity = body.equity as number;
  const margin = body.margin as number;
  const freeMargin = body.freeMargin as number;
  const leverage = body.leverage as number;

  const flags = await updateBridgeHeartbeat(connectionId, {
    accountType:  body.accountType,
    accountMode:  body.accountMode,
    tradeAllowed: body.tradeAllowed,
    balance,
    equity,
    margin,
    freeMargin,
    leverage,
  });

  if (!flags) {
    res.status(401).json({ error: "接続が見つかりません" });
    return;
  }

  // P3: track bridge heartbeat time for eaConnected health derivation
  lastBridgeHeartbeatTs = Date.now();

  res.json({
    ok:             true,
    tradingEnabled: flags.tradingEnabled,
    emergencyStop:  flags.emergencyStop,
    accountType:    flags.accountType,
    accountMode:    flags.accountMode,
    serverTime:     Date.now(),
  });
});

/** Bridge EA: Symbol Specification 送信（起動時・定期更新）
 *  Risk Engine の Lot 計算 / Stop Level 検証の Source of Truth として DB に保存する。
 */
app.post("/bridge/symbol-spec", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.json({ ok: true, note: "Supabase未設定 — symbol_spec は保存されません" });
    return;
  }

  const disconnectAuth = await verifyBridgeAuthStatus(connectionId, connectionToken);
  if (disconnectAuth === "unavailable") {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return;
  }
  if (disconnectAuth === "denied") {
    res.status(401).json({ error: "認証失敗" });
    return;
  }
  const flags = disconnectAuth;

  const body = req.body as {
    brokerSymbol?:      string;
    contractSize?:      number;
    volumeMin?:         number;
    volumeMax?:         number;
    volumeStep?:        number;
    tickSize?:          number;
    tickValue?:         number;
    pointSize?:         number;
    digits?:            number;
    stopsLevelPoints?:  number;
    stopsLevelPrice?:   number;
    currencyProfit?:    string;
    currencyMargin?:    string;
    marginInitial?:     number;
    spreadCurrent?:     number;
  };

  if (!body.brokerSymbol) {
    res.status(400).json({ error: "brokerSymbol が必要です" });
    return;
  }

  // canonical symbol: GOLD#→GOLD, XAUUSD→GOLD, GOLD→GOLD
  const canonical = body.brokerSymbol
    .replace("#", "")
    .replace("XAU", "GOLD")
    .replace("USD", "")
    .replace(/[-_].*/, "")
    .toUpperCase();

  const spec: SymbolSpecInput = {
    connectionId,
    userId:           flags.userId,
    symbol:           canonical,
    brokerSymbol:     body.brokerSymbol,
    contractSize:     body.contractSize  ?? 0,
    volumeMin:        body.volumeMin     ?? 0.01,
    volumeMax:        body.volumeMax     ?? 100,
    volumeStep:       body.volumeStep    ?? 0.01,
    tickSize:         body.tickSize      ?? 0,
    tickValue:        body.tickValue     ?? 0,
    pointSize:        body.pointSize     ?? 0,
    digits:           body.digits        ?? 2,
    stopsLevelPoints: body.stopsLevelPoints ?? 0,
    stopsLevelPrice:  body.stopsLevelPrice  ?? 0,
    currencyProfit:   body.currencyProfit   ?? "USD",
    currencyMargin:   body.currencyMargin   ?? "USD",
    marginInitial:    body.marginInitial    ?? 0,
    spreadCurrent:    body.spreadCurrent    ?? 0,
  };

  const ok = await upsertSymbolSpec(spec);
  res.json({ ok, canonical, brokerSymbol: body.brokerSymbol });
});

/** Bridge EA切断通知 */
// STAGE1-REMEDIATION: verify token before disconnecting + invalidate auth cache
app.post("/bridge/disconnect", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"]    as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return;
  }
  const disconnectStatus = await verifyBridgeAuthStatus(connectionId, connectionToken);
  if (disconnectStatus === "unavailable") {
    res.status(503).json({ error: "認証バックエンド利用不可" });
    return;
  }
  if (disconnectStatus === "denied") {
    res.status(401).json({ error: "認証失敗" });
    return;
  }
  // Invalidate auth cache immediately (token is being retired)
  bridgeAuthCache.delete(connectionId);
  await markConnectionDisconnected(connectionId);
  res.json({ ok: true });
});

/** Bridge EA: Pending Execution Commands取得 */
app.get("/execution-commands/pending", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.json([]);
    return;
  }

  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const commands = await getPendingCommands(connectionId);
  res.json(commands);
});

/** Bridge EA: Command Claim（PENDING → CLAIMED, Atomic） */
app.post("/execution-commands/:commandId/claim", auth, async (req, res) => {
  const { commandId } = req.params;
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }

  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const claimed = await claimCommand(commandId, connectionId);
  if (!claimed) {
    res.status(409).json({ error: "Claim失敗（既に処理中または存在しない）" });
    return;
  }

  res.json({ ok: true, commandId, status: "CLAIMED" });
});

/** Bridge EA: Execution Result提出 */
app.post("/execution-commands/:commandId/result", auth, async (req, res) => {
  const { commandId } = req.params;
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(400).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }

  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }

  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const result = req.body as BridgeResultInput;
  result.commandId = commandId;

  // STAGE1-05 AUDIT-022: connectionId ownership check
  // STAGE1-REMEDIATION: only broadcast if DB update was actually successful
  const { rowsAffected } = await processExecutionResult(result, flags.connectionId);

  if (rowsAffected > 0) {
    // P0-05: EXECUTION_RESULT is connection-scoped — only send to owning connection's WS clients
    const execResultMsg = {
      type: "EXECUTION_RESULT",
      data: {
        commandId,
        status:       result.status,
        success:      result.success,
        orderTicket:  result.orderTicket,
        dealTicket:   result.dealTicket,
      },
      ts: Date.now(),
    };
    const connId = flags.connectionId;
    broadcastToConnection(connId, execResultMsg);
  } else {
    console.warn(`[Gateway] result for commandId=${commandId} matched 0 rows (ownership mismatch or terminal state) — broadcast suppressed`);
  }

  res.json({ ok: true, rowsAffected });
});

/** Bridge EA: Position同期 */
app.post("/bridge/positions", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }
  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }

  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const { positions, snapshot_complete: snapshotComplete } = req.body as { positions?: BridgePosition[]; snapshot_complete?: boolean };
  if (Array.isArray(positions)) {
    // ── ポジション変化検知 (POSITION_CHANGED トリガー) ──
    const userId        = flags.userId;
    const prevCount     = lastPositionCountStore.get(userId) ?? -1;
    const currentCount  = positions.length;
    lastPositionCountStore.set(userId, currentCount);

    if (prevCount >= 0 && prevCount !== currentCount) {
      // ポジション数が変化した → 全ACTIVEトレーダーへ通知
      const primarySymbol = positions.length > 0
        ? (positions[0] as { symbol?: string }).symbol ?? "GOLD#"
        : "GOLD#";
      const primaryPrice  = positions.length > 0
        ? (positions[0] as { currentPrice?: number }).currentPrice ?? 0
        : 0;

      console.log(`[POSITION_CHANGED] userId=${userId} prev=${prevCount} new=${currentCount} sym=${primarySymbol}`);
      notifyWatcher(primarySymbol, 0, primaryPrice, "POSITION_CHANGED");
    }

    try {
      await reconcilePositionSnapshot(connectionId, flags.userId, positions, undefined, { complete: snapshotComplete === true });
    } catch (error) {
      console.error("[Gateway] position reconciliation failed", error);
      res.status(500).json({ ok: false, error: "POSITION_RECONCILIATION_FAILED" });
      return;
    }
  }
  res.json({ ok: true });
});

/** Bridge EA: Deal同期 */
app.post("/bridge/deals", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"] as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;

  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }
  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }

  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const { deals } = req.body as { deals: BridgeDeal[] };
  if (Array.isArray(deals)) {
    await upsertDeals(connectionId, flags.userId, deals);
  }
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// V2 Customer Market Data — EA → Gateway → customer_bar_data
// -----------------------------------------------------------------

interface MarketDataBarPayload {
  symbol:           string;   // broker symbol (e.g., GOLD#, XAUUSD)
  timeframe:        string;
  time:             number;   // bar open time — Unix seconds (broker server time)
  open:             number;
  high:             number;
  low:              number;
  close:            number;
  tick_volume?:     number;
  spread?:          number;
  utc_offset_hours?: number;  // broker server UTC offset (default 0 if EA normalises)
  broker?:          string;
  broker_server?:   string;
}

interface MarketDataBarsBody {
  bars:              MarketDataBarPayload[];
  broker?:           string;
  broker_server?:    string;
  utc_offset_hours?: number;
}

function buildBarIngestionInput(
  payload: MarketDataBarPayload,
  connectionId: string,
  userId: string,
  source: BarSource,
  bodyDefaults: Pick<MarketDataBarsBody, "broker" | "broker_server" | "utc_offset_hours">,
): BarIngestionInput {
  // Validate required string/numeric fields before any conversion
  if (typeof payload.symbol !== "string" || !payload.symbol) throw new Error("bar.symbol must be a non-empty string");
  if (typeof payload.timeframe !== "string" || !payload.timeframe) throw new Error("bar.timeframe must be a non-empty string");
  // OHLC are validated by validateBar after ingestion; here just guard against missing keys
  if (payload === null || typeof payload !== "object") throw new Error("bar payload must be an object");

  const utcOffsetHours = typeof payload.utc_offset_hours === "number" && Number.isFinite(payload.utc_offset_hours)
    ? payload.utc_offset_hours
    : (typeof bodyDefaults.utc_offset_hours === "number" && Number.isFinite(bodyDefaults.utc_offset_hours)
        ? bodyDefaults.utc_offset_hours
        : 0);

  const brokerTimeSec = typeof payload.time === "number" && Number.isFinite(payload.time)
    ? payload.time
    : NaN;

  // Validate Unix second range: must be between 2000-01-01 and 2100-01-01
  const MIN_EPOCH_SEC = 946_684_800;  // 2000-01-01 UTC
  const MAX_EPOCH_SEC = 4_102_444_800; // 2100-01-01 UTC
  const inRange = Number.isFinite(brokerTimeSec)
    && brokerTimeSec >= MIN_EPOCH_SEC
    && brokerTimeSec <= MAX_EPOCH_SEC;

  // Let validateBar reject "invalid" via "not a valid ISO timestamp"
  const timeUtc = inRange
    ? new Date((brokerTimeSec - utcOffsetHours * 3600) * 1000).toISOString()
    : "invalid";

  return {
    connection_id:    connectionId,
    user_id:          userId,
    broker_symbol:    payload.symbol,
    canonical_symbol: canonicalizeSymbol(payload.symbol),
    timeframe:        payload.timeframe,
    time_utc:         timeUtc,
    open:             payload.open,
    high:             payload.high,
    low:              payload.low,
    close:            payload.close,
    tick_volume:      payload.tick_volume,
    spread:           payload.spread,
    source,
    is_confirmed:     true,
    broker:           payload.broker ?? bodyDefaults.broker,
    broker_server:    payload.broker_server ?? bodyDefaults.broker_server,
  };
}

/** V2: Bridge EA sends realtime closed bars */
app.post("/market-data/bars", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"]    as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;
  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }
  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }
  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const body = req.body as MarketDataBarsBody;
  if (!Array.isArray(body.bars) || body.bars.length === 0) {
    res.status(400).json({ error: "bars array is required" });
    return;
  }
  if (body.bars.length > 500) {
    res.status(400).json({ error: "bars batch limit is 500 (use /market-data/backfill for larger batches)" });
    return;
  }

  let inputs: BarIngestionInput[];
  try {
    inputs = body.bars.map((p) =>
      buildBarIngestionInput(p, connectionId, flags.userId, "bridge_realtime", body),
    );
  } catch (e) {
    res.status(400).json({ ok: false, error: `Payload construction failed: ${(e as Error).message}` });
    return;
  }

  const result = await upsertCustomerBars(inputs);
  if (result.db_error) {
    res.status(503).json({ ok: false, error: result.db_error });
    return;
  }
  res.json({ ok: true, accepted: result.accepted, rejected: result.rejected, errors: result.errors });
});

/** V2: Bridge EA sends backfill / recovery bars (gap fill on reconnect) */
app.post("/market-data/backfill", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"]    as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;
  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }
  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }
  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const body = req.body as MarketDataBarsBody;
  if (!Array.isArray(body.bars) || body.bars.length === 0) {
    res.status(400).json({ error: "bars array is required" });
    return;
  }
  if (body.bars.length > 500) {
    res.status(400).json({ error: "backfill batch limit is 500 — send multiple batches" });
    return;
  }

  let inputs: BarIngestionInput[];
  try {
    inputs = body.bars.map((p) =>
      buildBarIngestionInput(p, connectionId, flags.userId, "bridge_recovery", body),
    );
  } catch (e) {
    res.status(400).json({ ok: false, error: `Payload construction failed: ${(e as Error).message}` });
    return;
  }

  const result = await upsertCustomerBars(inputs);
  if (result.db_error) {
    res.status(503).json({ ok: false, error: result.db_error });
    return;
  }
  res.json({ ok: true, accepted: result.accepted, rejected: result.rejected, errors: result.errors });
});

/** V2: Bridge EA gap detection — get last persisted bar time.
 * Requires bridge credentials (connection_id + connection_token).
 * Gateway SECRET alone is not accepted — per market-data isolation requirement. */
app.get("/market-data/last-bar", auth, async (req, res) => {
  const connectionId    = req.headers["x-connection-id"]    as string | undefined;
  const connectionToken = req.headers["x-connection-token"] as string | undefined;
  if (!connectionId || !connectionToken) {
    res.status(401).json({ error: "X-Connection-Id / X-Connection-Token が必要です" });
    return;
  }
  if (!isExecutionEnabled()) {
    res.status(503).json({ error: "Supabase未設定" });
    return;
  }
  const flags = await verifyBridgeAuth(connectionId, connectionToken);
  if (!flags) {
    res.status(401).json({ error: "認証失敗" });
    return;
  }

  const rawSymbol = req.query["symbol"];
  const rawTf     = req.query["timeframe"];

  // Reject array params (e.g., ?symbol[]=GOLD): TypeScript cast won't catch these at runtime
  if (typeof rawSymbol !== "string" || !rawSymbol) {
    res.status(400).json({ error: "symbol must be a non-empty string query parameter" });
    return;
  }
  if (typeof rawTf !== "string" || !rawTf) {
    res.status(400).json({ error: "timeframe must be a non-empty string query parameter" });
    return;
  }

  const symbol    = rawSymbol;
  const timeframe = rawTf;

  if (!symbol) {
    res.status(400).json({ error: "symbol query param is required" });
    return;
  }
  if (!timeframe || !CUSTOMER_BAR_TFS.has(timeframe)) {
    res.status(400).json({ error: `timeframe must be one of: ${[...CUSTOMER_BAR_TFS].join(",")}` });
    return;
  }

  const canonical = canonicalizeSymbol(symbol);
  const result    = await getLastCustomerBar(connectionId, canonical, timeframe);
  if (result.error) {
    res.status(503).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, connection_id: connectionId, symbol: canonical, timeframe, last_bar_utc: result.time_utc });
});

// -----------------------------------------------------------------
// Browser → Server: 読み取り専用 REST API
// -----------------------------------------------------------------

/** ヘルスチェック */
app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  // Convert heartbeatStore Map → plain object for JSON serialisation
  const heartbeats: Record<string, string> = {};
  heartbeatStore.forEach((iso, sym) => { heartbeats[sym] = iso; });
  res.json({
    status:           "ok",
    version:          "3.0",
    ea:               eaInfo ? { symbol: eaInfo.symbol, login: eaInfo.login, version: eaInfo.version } : null,
    eaConnected:      eaInfo !== null || (lastBridgeHeartbeatTs > 0 && Date.now() - lastBridgeHeartbeatTs < 90_000),
    marketWatch:      symbolStore.size,
    tickSymbols:      Array.from(tickStore.keys()),
    barKeys:          Array.from(barStore.keys()),
    indicatorSymbols: Array.from(indicatorStore.keys()),
    openOrders:       orderStore.size,
    clients:          clients.size,
    uptime:           Math.floor(process.uptime()),
    serverTime:       Date.now(),
    lastTickTs,
    lastSymbolTs,
    lastIndicatorTs,
    memoryMB:         Math.round(mem.rss / 1024 / 1024),
    /** Data Phase G: per-symbol heartbeat last-seen (ISO) */
    heartbeats,
  });
});

/** シンボル一覧（Market Watch 全シンボル、なければ Tick ストアから） */
app.get("/symbols", (_req, res) => {
  if (symbolStore.size > 0) {
    res.json(Array.from(symbolStore.values()));
    return;
  }
  // フォールバック: Tick ストア
  const list = Array.from(tickStore.values()).map((t) => ({
    symbol: t.symbol, bid: t.bid, ask: t.ask,
    spread: t.spread, digits: t.digits, time: t.time,
  }));
  res.json(list);
});

/** 注文一覧（Pending + Position）— 認証必須 */
app.get("/orders/all", auth, (_req, res) => {
  res.json(Array.from(orderStore.values()));
});

/** 最新 Tick */
app.get("/tick/:symbol", (req, res) => {
  const tick = tickStore.get(req.params.symbol.toUpperCase());
  if (!tick) { res.status(404).json({ error: "symbol not found" }); return; }
  res.json(tick);
});

/**
 * 過去バー
 * GET /bars/:symbol/:timeframe?count=500
 *
 * 時刻フィルターは使用しない。
 * EAが送る時刻はブローカー秒（rates[i].time）であり、
 * ブラウザのUTC秒とは異なる場合がある。
 * count で最新N本を返すだけ。
 */
app.get("/bars/:symbol/:timeframe", (req, res) => {
  const key   = storeKey(req.params.symbol, req.params.timeframe);
  let   bars  = barStore.get(key) ?? [];
  const count = Number(req.query.count ?? 500);

  // 重複排除・昇順ソート
  bars = dedupAndSort(bars);

  // 最新 count 本
  const result = bars.slice(-count);

  if (result.length > 0) {
    const last = result[result.length - 1];
    console.log(`[GET /bars] ${key} → ${result.length}本 last_time=${last.time} close=${last.close}`);
  }

  res.json(result);
});

// ── connections/:id エイリアス (P0-04: now actually scoped by connectionId) ───────
// execute/analyze/dry-run ルートはこの形式を使用する。
// Connection-scoped store を優先し、なければグローバルへフォールバック。

app.get("/connections/:connectionId/tick/:symbol", auth, async (req, res) => {
  const { connectionId, symbol } = req.params;
  // X-Connection-Id header must match the URL path parameter.
  // Returning without a response body causes a 502 at the proxy level; always
  // send an explicit status code when rejecting.
  if (req.headers["x-connection-id"] !== connectionId) {
    res.status(401).json({ error: "X-Connection-Id header must match URL" });
    return;
  }
  if (!(await enforceConnectionAuth(req, res))) return;
  // connTickStore is connection-scoped; never fall back to global tickStore.
  const tick = connectionMarketStore.getTick(connectionId, symbol);
  if (!tick) { res.status(404).json({ error: "symbol not found" }); return; }
  res.json(tick);
});

// P0-04: add auth to GET bars endpoint (was missing auth middleware)
app.get("/connections/:connectionId/bars/:symbol/:timeframe", auth, async (req, res) => {
  const { connectionId, symbol, timeframe } = req.params;
  if (req.headers["x-connection-id"] !== connectionId) {
    res.status(401).json({ error: "X-Connection-Id header must match URL" });
    return;
  }
  if (!(await enforceConnectionAuth(req, res))) return;
  // connBarStore is connection-scoped; never fall back to global barStore.
  const count = Number(req.query.count ?? 500);
  const bars = dedupAndSort(connectionMarketStore.getBars(connectionId, symbol, timeframe));
  res.json(bars.slice(-count));
});

/** ポジション一覧 — 認証必須（口座情報保護） */
app.get("/positions", auth, (_req, res) => {
  res.json(positions);
});

/** 口座情報 — 認証必須（ログインID・残高保護） */
app.get("/account", auth, (_req, res) => {
  if (!account) { res.status(404).json({ error: "no account data" }); return; }
  res.json(account);
});

// -----------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------

function storeKey(symbol: string, timeframe: string): string {
  return `${symbol.toUpperCase()}:${timeframe.toUpperCase()}`;
}

/** EA は datetime（秒）で送信する。disk データは ms で保存済みのため、秒を ms に統一する */
function normalizeTime(time: number): number {
  return time < 1_000_000_000_000 ? time * 1000 : time;
}

function normalizeBar(b: Bar): Bar {
  return { ...b, time: normalizeTime(b.time) };
}

function dedupAndSort(bars: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of bars) map.set(b.time, b);
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

/** V1 bar_data persistence: detect confirmed bars and persist to Supabase.
 *
 * Reads previous bar from connection-scoped store (not global barStore) to
 * prevent cross-customer contamination. In-memory state management is handled
 * by callers via connectionMarketStore.upsertBars(). This function only
 * handles the V1 Supabase persistence side-effect.
 *
 * Confirmed bar logic:
 *   - New timestamp → previous bar is confirmed → persist to V1 bar_data
 *   - Same timestamp → forming bar update, no persistence
 */
function upsertBar(connectionId: string, symbol: string, timeframe: string, rawBar: Bar & { symbol?: string; timeframe?: string }): void {
  const bars = connectionMarketStore.getBars(connectionId, symbol, timeframe);
  const last = bars[bars.length - 1];
  const bar  = normalizeBar(rawBar);

  if (last && last.time !== bar.time) {
    // New timestamp → previous bar confirmed → persist to V1 bar_data (fire-and-forget)
    upsertSingleBar(connectionId, symbol, timeframe, last as BarRecord).catch((err: unknown) => {
      console.warn(`[barData] confirmed bar upsert failed ${symbol}:${timeframe}:`, err);
    });
  }
  // In-memory state is managed by callers via connectionMarketStore.upsertBars()
}

// -----------------------------------------------------------------
// Market Data ステータス（Backtest Engine / UI から参照）
// GET /market-data/status
// -----------------------------------------------------------------

app.get("/market-data/status", (_req, res) => {
  interface StatEntry {
    count:           number;
    from_utc:        string | null;
    to_utc:          string | null;
    span_days:       number | null;
    last_updated_ms: number;
  }
  const result: Record<string, StatEntry> = {};

  barStore.forEach((bars, key) => {
    if (bars.length === 0) return;
    const sorted = dedupAndSort(bars);
    const first  = sorted[0];
    const last   = sorted[sorted.length - 1];
    const spanMs = last.time - first.time;
    result[key] = {
      count:           sorted.length,
      from_utc:        first.time ? new Date(first.time).toISOString() : null,
      to_utc:          last.time  ? new Date(last.time).toISOString()  : null,
      span_days:       spanMs > 0 ? Math.round(spanMs / 86_400_000 * 10) / 10 : 0,
      last_updated_ms: Date.now(),
    };
  });

  res.json({
    timestamp:            new Date().toISOString(),
    total_symbol_tf:      Object.keys(result).length,
    max_bars_per_tf:      MAX_BARS,
    supabase_enabled:     isSupabaseEnabled(),
    symbols:              result,
  });
});

// -----------------------------------------------------------------
// Timezone診断（開発・検証用）
// GET /debug/bar-timestamps?symbol=EURUSD&timeframe=H4&count=5
// -----------------------------------------------------------------

app.get("/debug/bar-timestamps", (req, res) => {
  const sym = String(req.query.symbol  ?? "EURUSD").toUpperCase();
  const tf  = String(req.query.timeframe ?? "H4").toUpperCase();
  const cnt = Math.min(Number(req.query.count ?? 10), 50);
  const key = storeKey(sym, tf);

  const bars = dedupAndSort(barStore.get(key) ?? []).slice(-cnt);
  const tick = tickStore.get(sym);

  const sample = bars.map(b => ({
    bar_time_ms:  b.time,
    bar_time_utc: new Date(b.time).toISOString(),
    bar_time_sec: Math.round(b.time / 1000),
    mod_300:      Math.round(b.time / 1000) % 300,   // M5 アライメント確認
    mod_14400:    Math.round(b.time / 1000) % 14400,  // H4 アライメント確認
    open:  b.open,
    close: b.close,
  }));

  res.json({
    info: "bar.time は UTC ミリ秒。mod_14400=0 なら H4 は UTC 境界に整列（実証済み）",
    symbol:    sym,
    timeframe: tf,
    bar_count: bars.length,
    tick_time_ms:  tick ? normalizeTime(tick.time) : null,
    tick_time_utc: tick ? new Date(normalizeTime(tick.time)).toISOString() : null,
    note: "tick.time は TimeCurrent()（ブローカー時刻）。bar.time は MqlRates.time（UTC）。両者は timezone 分だけずれる場合がある。",
    bars: sample,
  });
});

// -----------------------------------------------------------------
// 起動時 barStore → Supabase 同期（POST /admin/sync-to-supabase）
// 初回起動時・EA 再起動なしで既存データを同期する際に使用
// -----------------------------------------------------------------

app.post("/admin/sync-to-supabase", auth, (_req, res) => {
  // The legacy global barStore has no connection identity and must never be
  // persisted as customer broker data. Use an authenticated connection feed.
  res.status(409).json({ error: "connection-scoped bar sync required" });
});

// -----------------------------------------------------------------
// Data Phase B — Sync Command API
// -----------------------------------------------------------------

/**
 * GET /data-commands/pending
 *
 * MT5 EA がポーリングして PENDING な Sync Job を取得する。
 * claim_next_sync_job() RPC で PENDING→RUNNING を atomic に遷移。
 * EA の symbol でフィルタリングし、自分が処理可能な job のみを返す。
 *
 * レスポンス:
 *   { "jobs": [] }            — PENDING job なし
 *   { "jobs": [{ id, symbol, timeframe, mode, target_from, target_to }] }
 */
app.get("/data-commands/pending", auth, async (req: Request, res: Response) => {
  const symbol = (req.query["symbol"] as string | undefined)?.toUpperCase() ?? undefined;

  try {
    const job = await claimNextSyncJob(symbol);
    if (!job) {
      res.json({ jobs: [] });
      return;
    }
    res.json({
      jobs: [{
        id:           job.id,
        symbol:       job.symbol,
        timeframe:    job.timeframe,
        mode:         job.mode,
        target_from:  job.target_from,
        target_to:    job.target_to,
        current_from: job.current_from ?? null,  // Resume 起点 (null = 最初から)
      }],
    });
  } catch (err) {
    console.warn("[DataSync] /data-commands/pending error:", err);
    res.json({ jobs: [] }); // EA を止めない
  }
});

/**
 * POST /data-commands/:id/progress
 *
 * EA が Sync Job の進捗・完了・失敗を Gateway 経由で Supabase に書き込む。
 *
 * body: {
 *   status:          "RUNNING" | "COMPLETED" | "FAILED"
 *   progress_pct?:   0〜100
 *   received_bars?:  number
 *   sent_bars?:      number
 *   failed_batches?: number
 *   current_from?:   number (epoch sec)
 *   current_to?:     number (epoch sec)
 *   error_message?:  string
 * }
 */
app.post("/data-commands/:id/progress", auth, async (req: Request, res: Response) => {
  const jobId = req.params["id"];
  if (!jobId) { res.status(400).json({ error: "id required" }); return; }

  const body = req.body as {
    status?:          string;
    progress_pct?:    number;
    received_bars?:   number;
    sent_bars?:       number;
    failed_batches?:  number;
    current_from?:    number;
    current_to?:      number;
    error_message?:   string;
  };

  const validStatuses = ["RUNNING", "COMPLETED", "FAILED"] as const;
  type ValidStatus = typeof validStatuses[number];
  const status = body.status as ValidStatus | undefined;
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: "status must be RUNNING | COMPLETED | FAILED" });
    return;
  }

  // 対応 TF の検証（SUPPORTED_TIMEFRAMES で TF文字列を確認）
  // job id をキーに更新するだけなので TF 検証は不要 (job 作成時に検証済み)

  // Input validation
  const progressPct = body.progress_pct;
  if (progressPct !== undefined && (progressPct < 0 || progressPct > 100 || !Number.isInteger(progressPct))) {
    res.status(400).json({ error: "progress_pct must be integer 0-100" });
    return;
  }
  if (body.received_bars !== undefined && body.received_bars < 0) {
    res.status(400).json({ error: "received_bars must be >= 0" });
    return;
  }
  if (body.sent_bars !== undefined && body.sent_bars < 0) {
    res.status(400).json({ error: "sent_bars must be >= 0" });
    return;
  }
  if (body.failed_batches !== undefined && body.failed_batches < 0) {
    res.status(400).json({ error: "failed_batches must be >= 0" });
    return;
  }

  const ok = await updateSyncJobProgress(jobId, {
    status,
    progress_pct:   body.progress_pct,
    received_bars:  body.received_bars,
    sent_bars:      body.sent_bars,
    failed_batches: body.failed_batches,
    current_from:   body.current_from  ?? null,
    current_to:     body.current_to    ?? null,
    error_message:  body.error_message ?? null,
  });

  if (status === "COMPLETED") {
    console.log(`[DataSync] job=${jobId} COMPLETED recv=${body.received_bars} sent=${body.sent_bars} failed_batches=${body.failed_batches}`);
  } else if (status === "FAILED") {
    console.warn(`[DataSync] job=${jobId} FAILED: ${body.error_message}`);
  }

  res.json({ ok });
});

void SUPPORTED_TIMEFRAMES; // suppress unused import warning

// -----------------------------------------------------------------
// 起動
// -----------------------------------------------------------------

// Railway provides PORT env var. Fall back to MT5_WEBSOCKET_PORT for local dev.
const PORT = parseInt(process.env.PORT ?? process.env.MT5_WEBSOCKET_PORT ?? "8080", 10);

// 起動時にディスクからバーデータを復元
persistLoad();

// ディスクに保存データがない（Railway ephemeral fs 再起動）場合、
// Supabase bar_data から主要シンボルの直近バーを復元する
async function restoreFromSupabase(): Promise<void> {
  // Legacy global barStore rows have no connection identity and are never
  // restored into customer runtime state after Stage 6F.

  const url = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  // GOLD の主要TFを優先復元（Watcher で最低限必要なデータ）
  const RESTORE_TARGETS = [
    { sym: "GOLD#", tf: "M5",  count: 20  },
    { sym: "GOLD#", tf: "H1",  count: 50  },
    { sym: "GOLD#", tf: "H4",  count: 100 },
    { sym: "XAUUSD", tf: "H4", count: 100 },
  ];

  let restored = 0;
  for (const { sym, tf, count } of RESTORE_TARGETS) {
    try {
      // Fetch a larger window to ensure each connection gets `count` bars.
      // Without this, a shared limit would be consumed by the most active connection.
      const fetchLimit = count * 50; // generous headroom for multi-customer deployments
      const res = await fetch(
        `${url}/rest/v1/bar_data?connection_id=not.is.null&symbol=eq.${encodeURIComponent(sym)}&timeframe=eq.${tf}&select=connection_id,time_utc,open,high,low,close,volume&order=time_utc.desc&limit=${fetchLimit}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) }
      );
      if (!res.ok) continue;
      const rows = await res.json() as { connection_id: string; time_utc: string; open: number; high: number; low: number; close: number; volume: number }[];
      if (!rows.length) continue;
      const byConnection = new Map<string, Bar[]>();
      for (const row of rows) {
        if (!row.connection_id) continue;
        const bars = byConnection.get(row.connection_id) ?? [];
        if (bars.length >= count) continue; // per-connection limit
        bars.push({ time: new Date(row.time_utc).getTime(), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
        byConnection.set(row.connection_id, bars);
      }
      for (const [connectionId, bars] of byConnection) {
        // Merge with any bars already received during async startup rather than replacing.
        // bars is in desc order from DB; reverse to asc for merging.
        const restored_asc = bars.reverse();
        const current = connectionMarketStore.getBars(connectionId, sym, tf);
        // Merge: keep all live data, add restored history that fills gaps.
        // Use MAX_BARS as retention limit (not `count`) to avoid truncating live history.
        const merged = current.length > 0
          ? dedupAndSort([...restored_asc, ...current]).slice(-MAX_BARS)
          : restored_asc.slice(-MAX_BARS);
        connectionMarketStore.upsertBars(connectionId, sym, tf, merged, MAX_BARS);
        restored += bars.length;
        console.log(`[Restore] ${connectionId}:${sym}:${tf} → ${bars.length}本復元`);
      }
    } catch (e) {
      console.warn(`[Restore] ${sym}:${tf} 失敗:`, e instanceof Error ? e.message : e);
    }
  }
  if (restored > 0) {
    console.log(`[Restore] Supabase から計 ${restored} 本復元完了`);
  }
}

// 非同期で復元（起動を遅らせない）
void restoreFromSupabase();
// lastM5Time を Supabase から復元（Gateway 再起動時の M5 dedup）
void restoreLastM5Times();

// Railway requires binding to 0.0.0.0
server.listen(PORT, "0.0.0.0", () => {
  console.log("==============================================");
  console.log("  AVL Market Server v3.0");
  console.log("==============================================");
  console.log(`  HTTP REST : http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket : ws://0.0.0.0:${PORT}/ws`);
  console.log(`  Auth      : ${SECRET ? "✓ 有効" : "⚠ 未設定"}`);
  console.log(`  Data      : ${PERSIST_FILE}`);
  console.log(`  Supabase  : ${isSupabaseEnabled() ? "✓ bar_data 永続化有効" : "⚠ 未設定（barStore のみ）"}`);
  console.log(`  Execution : ${isExecutionEnabled() ? "✓ Execution Bridge有効" : "⚠ 未設定"}`);
  console.log("==============================================");

  // 起動時: barStore に既存データがあれば Supabase へ非同期同期
  if (isSupabaseEnabled()) {
    const totalBars = Array.from(barStore.values()).reduce((s, b) => s + b.length, 0);
    if (totalBars > 0) {
      console.log(`[barData] 起動時同期: barStore ${totalBars}本 → Supabase ...`);
      // Unscoped legacy barStore cannot be persisted after Stage 6F.
      console.warn("[barData] startup sync skipped: connection identity required");
    }
  }
});

// シャットダウン時に保存
process.on("SIGTERM", () => { persistSave(); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { persistSave(); server.close(() => process.exit(0)); });
