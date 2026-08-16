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
import {
  upsertBulkBars,
  upsertSingleBar,
  syncBarStoreToSupabase,
  isEnabled as isSupabaseEnabled,
  type BarRecord,
} from "./barDataStore";

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
/** ポジション配列 */
let   positions:    Position[] = [];
/** 口座情報 */
let   account:      Account | null = null;
/** EA 接続情報 */
let   eaInfo:       Record<string, unknown> | null = null;
/** インジケーターストア（AI基盤）"EURUSD" → Indicators */
const indicatorStore = new Map<string, Indicators>();
/** 取引履歴ストア "EURUSD" → HistoryDeal[] （ticket でユニーク管理）*/
const historyStore  = new Map<string, Map<number, HistoryDeal>>();
/** Market Watch シンボルストア "EURUSD" → MarketWatchSymbol */
const symbolStore   = new Map<string, MarketWatchSymbol>();
/** 注文ストア（Pending + Position）ticket → Order */
const orderStore    = new Map<number, Order>();
/** 注文キュー（AI → EA 発注用） */
const orderQueue:   Array<Record<string, unknown>> = [];

// Diagnostic timestamps for health endpoint
let lastTickTs:      number = 0;
let lastSymbolTs:    number = 0;
let lastIndicatorTs: number = 0;

// -----------------------------------------------------------------
// WebSocket サーバー /ws
// -----------------------------------------------------------------

const wss     = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws, req) => {
  clients.add(ws);
  console.log(`[WS] 接続 ${req.socket.remoteAddress} (計${clients.size})`);

  // 接続直後に現在の EA 状態を通知
  if (eaInfo)    safeSend(ws, { type: "EA_CONNECTED", data: eaInfo,  ts: Date.now() });
  if (account)   safeSend(ws, { type: "ACCOUNT",      data: account, ts: Date.now() });
  // Market Watch と注文の現在状態を送信
  if (symbolStore.size > 0) {
    const syms = Array.from(symbolStore.values());
    safeSend(ws, { type: "SYMBOLS", data: syms, ts: Date.now() });
  }
  if (orderStore.size > 0) {
    safeSend(ws, { type: "ORDERS", data: Array.from(orderStore.values()), ts: Date.now() });
  }

  ws.on("close", () => { clients.delete(ws); });
  ws.on("error", () => { clients.delete(ws); });
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
  if (!SECRET) { next(); return; }
  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  if (token !== SECRET) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

// -----------------------------------------------------------------
// EA → Server: 受信エンドポイント（加工禁止）
// -----------------------------------------------------------------

/** EA 起動通知 */
app.post("/connect", auth, (req, res) => {
  eaInfo = req.body as Record<string, unknown>;
  const { symbol, login, broker, serverTime } = eaInfo as Record<string, unknown>;
  console.log(`[EA] 接続: symbol=${symbol} login=${login} broker=${broker} serverTime=${serverTime}`);
  broadcast({ type: "EA_CONNECTED", data: eaInfo, ts: Date.now() });
  res.json({ ok: true });
});

/** EA 停止 / 切断 */
app.post("/event", auth, (req, res) => {
  const { type, symbol } = req.body as { type: string; symbol: string };
  if (type === "DISCONNECT") {
    eaInfo = null;
    console.log(`[EA] 切断: ${symbol}`);
  }
  broadcast({ type, symbol, ts: Date.now() });
  res.json({ ok: true });
});

/** Tick ストリーム — 受信値をそのまま保存・配信 */
app.post("/tick", auth, (req, res) => {
  const tick = req.body as Tick;
  tickStore.set(tick.symbol, tick);
  lastTickTs = Date.now();
  broadcast({ type: "TICK", symbol: tick.symbol, data: tick, ts: Date.now() });
  res.json({ ok: true });
});

/**
 * バー リアルタイム更新 — 受信値をそのまま保存・配信
 * 同 time のバーは上書き（未確定バー更新）、新 time は追記。
 */
app.post("/bar", auth, (req, res) => {
  const bar = req.body as Bar & { symbol: string; timeframe: string };
  if (bar.timeframe === "M1") {
    const norm = normalizeTime(bar.time);
    console.log(`[BAR/M1] raw=${bar.time} norm=${norm} close=${bar.close}`);
  }
  upsertBar(bar.symbol, bar.timeframe, bar);
  broadcast({ type: "BAR", symbol: bar.symbol, timeframe: bar.timeframe, data: bar, ts: Date.now() });
  res.json({ ok: true });
});

/** 過去バー一括受信（EA 起動時） */
app.post("/bars/bulk", auth, (req, res) => {
  const { symbol, timeframe, bars } = req.body as {
    symbol: string; timeframe: string; bars: Bar[];
  };
  if (!symbol || !timeframe || !Array.isArray(bars)) {
    res.status(400).json({ error: "symbol / timeframe / bars が必要です" });
    return;
  }
  const key      = storeKey(symbol, timeframe);
  const existing = barStore.get(key);
  const normalized = bars.map(normalizeBar);

  // タイムスタンプ整合性チェック:
  // bulk最新バーがtickより1時間以上先の場合はチャートキャッシュのTZ不整合と判断してスキップ
  const tick = tickStore.get(symbol.toUpperCase());
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
    barStore.set(key, sorted.slice(-MAX_BARS));
    console.log(`[Bulk] ${key}: ${sorted.length}本`);
    persistSave(); // Bulk受信は重要データなので即座に保存
  }

  // Supabase への永続化（barStore の結果とは独立して常にupsert）
  // fire-and-forget: Gatewayレスポンスをブロックしない
  if (normalized.length > 0) {
    upsertBulkBars(symbol, timeframe, normalized as BarRecord[]).catch((err: unknown) => {
      console.warn(`[barData] bulk upsert failed ${key}:`, err);
    });
  }

  res.json({ ok: true });
});

/** ポジション ストリーム */
app.post("/positions", auth, (req, res) => {
  const { positions: pos, symbol } = req.body as { positions: Position[]; symbol: string };
  positions = pos ?? [];
  broadcast({ type: "POSITIONS", symbol, data: positions, ts: Date.now() });
  res.json({ ok: true });
});

/** 口座情報 ストリーム */
app.post("/account", auth, (req, res) => {
  account = req.body as Account;
  broadcast({ type: "ACCOUNT", data: account, ts: Date.now() });
  res.json({ ok: true });
});

/** ハートビート */
app.post("/heartbeat", auth, (req, res) => {
  broadcast({ type: "HEARTBEAT", data: req.body, ts: Date.now() });
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// Market Watch シンボル一括受信
// -----------------------------------------------------------------

app.post("/symbols/bulk", auth, (req, res) => {
  const body = req.body as { count?: number; symbols?: MarketWatchSymbol[] };
  if (!Array.isArray(body.symbols)) { res.status(400).json({ error: "symbols が必要です" }); return; }

  const now = Date.now();
  let updated = 0;
  for (const sym of body.symbols) {
    if (!sym.symbol) continue;
    symbolStore.set(sym.symbol.toUpperCase(), { ...sym, receivedAt: now });
    updated++;
  }

  lastSymbolTs = now;
  broadcast({ type: "SYMBOLS", data: Array.from(symbolStore.values()), ts: now });
  res.json({ ok: true, updated });
});

// -----------------------------------------------------------------
// 注文ストリーム（EA から全注文+ポジションを受信）
// -----------------------------------------------------------------

app.post("/orders/stream", auth, (req, res) => {
  const body = req.body as { count?: number; orders?: Order[] };
  if (!Array.isArray(body.orders)) { res.status(400).json({ error: "orders が必要です" }); return; }

  // 既存クリアして更新
  orderStore.clear();
  for (const order of body.orders) {
    if (!order.ticket) continue;
    orderStore.set(order.ticket, order);
  }

  broadcast({ type: "ORDERS", data: Array.from(orderStore.values()), ts: Date.now() });
  res.json({ ok: true, count: orderStore.size });
});

/** インジケーターストリーム（AI基盤）— 拡張インジケーター */
app.post("/indicators", auth, (req, res) => {
  const body = req.body as Omit<Indicators, "receivedAt">;
  if (!body.symbol || !body.timeframes) {
    res.status(400).json({ error: "symbol / timeframes が必要です" });
    return;
  }
  const sessions = getTradingSessions(body.brokerTime);
  const data: Indicators = { ...body, receivedAt: Date.now(), sessions };
  indicatorStore.set(body.symbol.toUpperCase(), data);
  lastIndicatorTs = Date.now();
  broadcast({ type: "INDICATORS", symbol: body.symbol, data, ts: Date.now() });
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

app.post("/orders/:id/result", auth, (req, res) => {
  const order = orderQueue.find((o) => o.id === req.params.id);
  if (!order) { res.status(404).json({ error: "not found" }); return; }
  order.status = (req.body as { success: boolean }).success ? "executed" : "failed";
  broadcast({ type: "ORDER_RESULT", data: { ...order, result: req.body }, ts: Date.now() });
  res.json({ ok: true });
});

app.post("/orders", (req, res) => {
  const order = { id: `order_${Date.now()}`, status: "pending", createdAt: Date.now(), ...req.body };
  orderQueue.push(order);
  broadcast({ type: "ORDER_QUEUED", data: order, ts: Date.now() });
  res.json({ ok: true, id: order.id });
});

// -----------------------------------------------------------------
// Browser → Server: 読み取り専用 REST API
// -----------------------------------------------------------------

/** ヘルスチェック */
app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:           "ok",
    version:          "3.0",
    ea:               eaInfo ? { symbol: eaInfo.symbol, login: eaInfo.login, version: eaInfo.version } : null,
    eaConnected:      eaInfo !== null,
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

/** 注文一覧（Pending + Position） */
app.get("/orders/all", (_req, res) => {
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

/** ポジション一覧 */
app.get("/positions", (_req, res) => {
  res.json(positions);
});

/** 口座情報 */
app.get("/account", (_req, res) => {
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

/** barStore へバーをアップサート（同時刻は上書き、新時刻は追加）
 *
 * 確定バー検出ロジック:
 *   - 同じ time のバーが来た場合 → 未確定バーの更新（in-memory のみ、Supabase保存なし）
 *   - 新しい time のバーが来た場合 → 前のバーが確定した = Supabase に永続化
 */
function upsertBar(symbol: string, timeframe: string, rawBar: Bar & { symbol?: string; timeframe?: string }): void {
  const key  = storeKey(symbol, timeframe);
  const bars = barStore.get(key) ?? [];
  const last = bars[bars.length - 1];
  const bar  = normalizeBar(rawBar);

  if (last && last.time === bar.time) {
    // 同時刻 → 未確定バー更新（in-memory のみ）
    bars[bars.length - 1] = { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  } else {
    // 新時刻 → 前バーが確定 → Supabase に永続化（fire-and-forget）
    if (last) {
      upsertSingleBar(symbol, timeframe, last as BarRecord).catch((err: unknown) => {
        console.warn(`[barData] confirmed bar upsert failed ${symbol}:${timeframe}:`, err);
      });
    }
    bars.push({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    if (bars.length > MAX_BARS) bars.shift();
  }
  barStore.set(key, bars);
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
  if (!isSupabaseEnabled()) {
    res.status(503).json({ error: "Supabase 未設定" });
    return;
  }
  // fire-and-forget
  syncBarStoreToSupabase(barStore as unknown as Map<string, BarRecord[]>).catch((err: unknown) => {
    console.warn("[barData] sync-to-supabase error:", err);
  });
  res.json({ ok: true, message: "同期をバックグラウンドで開始しました。ログを確認してください。" });
});

// -----------------------------------------------------------------
// 起動
// -----------------------------------------------------------------

// Railway provides PORT env var. Fall back to MT5_WEBSOCKET_PORT for local dev.
const PORT = parseInt(process.env.PORT ?? process.env.MT5_WEBSOCKET_PORT ?? "8080", 10);

// 起動時にディスクからバーデータを復元
persistLoad();

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
  console.log("==============================================");

  // 起動時: barStore に既存データがあれば Supabase へ非同期同期
  if (isSupabaseEnabled()) {
    const totalBars = Array.from(barStore.values()).reduce((s, b) => s + b.length, 0);
    if (totalBars > 0) {
      console.log(`[barData] 起動時同期: barStore ${totalBars}本 → Supabase ...`);
      syncBarStoreToSupabase(barStore as unknown as Map<string, BarRecord[]>).catch((err: unknown) => {
        console.warn("[barData] startup sync error:", err);
      });
    }
  }
});

// シャットダウン時に保存
process.on("SIGTERM", () => { persistSave(); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { persistSave(); server.close(() => process.exit(0)); });
