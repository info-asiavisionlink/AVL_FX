//+------------------------------------------------------------------+
//|                                          AVL_DataManager_v2.mq5 |
//|                     AVL AI Trading System — Data Manager EA v4  |
//|                                                                  |
//| 設計原則                                                         |
//|   MT5 を唯一のデータソース（Single Source of Truth）とする       |
//|   EA は分析しない。MT5 の情報をそのまま送信するだけ。            |
//|                                                                  |
//| ストリーム構成                                                   |
//|   Stream 1: Tick Stream     — OnTick() 毎（スロットリング100ms） |
//|   Stream 2: ＃どこOHLC Stream     — OnTick() 毎（全8時間足）          |
//|   Stream 3: MAVL_DataManager_v2.mq5arketWatch     — OnTimer() 3秒毎（全シンボル）      |
//|   Stream 4: Indicators      — OnTimer() 30秒毎（拡張インジケーター）|
//|   Stream 5: Orders          — OnTimer() 5秒毎（全注文+ポジション）|
//|   Stream 6: Account         — OnTimer() 5秒毎                   |
//|   Stream 7: History         — OnTimer() 300秒毎                 |
//|   Stream 8: Heartbeat       — OnTimer() 毎                      |
//+------------------------------------------------------------------+
#property copyright "AVL AI Trading System"
#property version   "4.00"
#include <Trade/Trade.mqh>
CTrade g_Trade;

//--- 入力パラメーター
sinput group "=== AVL Market Server 接続設定 ==="
input string InpServerURL    = "http://127.0.0.1:8080";
input string InpServerSecret = "";

sinput group "=== Tick Stream ==="
input bool InpTickEnabled    = true;
input int  InpTickThrottleMs = 100;

sinput group "=== OHLC Stream ==="
input bool InpOHLCEnabled    = true;
input int  InpOHLCHistory    = 5000; // Historical Data基盤: バックテスト用に増量（500→5000）

sinput group "=== Market Watch Stream ==="
input bool InpMWEnabled      = true;
input int  InpMWSec          = 3;

sinput group "=== Indicator Stream ==="
input bool InpIndicatorEnabled = true;
input int  InpIndicatorSec     = 30;

sinput group "=== Order/Position Stream ==="
input bool InpOrderEnabled    = true;
input int  InpOrderSec        = 5;

sinput group "=== Account Stream ==="
input bool InpAccountEnabled  = true;

sinput group "=== History Stream ==="
input bool InpHistoryEnabled   = true;
input int  InpHistoryDays      = 30;
input int  InpHistorySec       = 300;

sinput group "=== タイマー間隔 ==="
input int  InpTimerMs          = 500;

sinput group "=== History Sync (過去OHLC一括取得) ==="
input bool   InpHistorySyncEnabled   = false;   // true: 起動時に過去データを一括取得
input int    InpHistorySyncMonths    = 12;       // 取得する月数 (1〜60)
input int    InpHistorySyncChunkDays = 28;       // 1チャンクの日数
input int    InpHistorySyncBatchSize = 2000;     // 1 HTTP requestあたりの最大bar数 (100〜5000)
input string InpHistorySyncTFs       = "M5";    // 対象TF (カンマ区切り: M5,H1,H4 等)

sinput group "=== Data Sync Command (Incremental Sync) ==="
input bool InpDataSyncEnabled   = true;   // true: Incremental Sync Job をポーリング
input int  InpDataSyncPollSec   = 30;     // /data-commands/pending をポーリングする間隔(秒)

//--- 全対象時間足
ENUM_TIMEFRAMES g_TfList[]    = { PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
                                   PERIOD_H1, PERIOD_H4, PERIOD_D1,  PERIOD_W1  };
string          g_TfNames[]   = { "M1","M5","M15","M30","H1","H4","D1","W1" };

//--- グローバル変数
string   g_Symbol;
long     g_LastTickMs         = 0;
datetime g_LastBarTimes[8];
datetime g_LastBulkSent       = 0;
datetime g_LastMWSent         = 0;
datetime g_LastIndicatorSent  = 0;
datetime g_LastOrderSent      = 0;
datetime g_LastHistorySent    = 0;
int      g_TimerCount         = 0;
bool     g_HistorySyncPending   = false;
bool     g_HistorySyncRunning   = false;
bool     g_HistorySyncCompleted = false;
datetime g_LastDataSyncPoll     = 0;  // Data Phase B: 最後のポーリング時刻
bool     g_DataSyncRunning      = false; // Data Phase B: Incremental Sync 実行中フラグ

#define BULK_RESEND_SEC              600
#define HISTORY_SYNC_BATCH_SLEEP_MS  100   // バッチ間のSleep (ms)
#define HISTORY_SYNC_RETRY_MAX       3     // Batch送信 最大リトライ回数

//+------------------------------------------------------------------+
//| 初期化                                                           |
//+------------------------------------------------------------------+
int OnInit()
{
   g_Symbol = Symbol();
   ArrayInitialize(g_LastBarTimes, 0);

   if(StringLen(InpServerURL) == 0) { Alert("InpServerURL を設定してください"); return INIT_PARAMETERS_INCORRECT; }

   if(!Connect_Send()) {
      Print("=========================================");
      Print("  AVL DataManager: Market Server 接続失敗");
      Print("  URL: ", InpServerURL);
      Print("  → cd gateway && npm run dev を実行");
      Print("  → WebRequest 許可リストに追加: ", InpServerURL);
      Print("=========================================");
      return INIT_FAILED;
   }

   // =================================================================
   // Timezone 診断ログ（起動時に出力）
   // MqlRates.time（bar.time）が UTC かブローカー時刻かを確認するため
   // =================================================================
   {
      datetime brokerNow = TimeCurrent(); // ブローカーサーバー時刻
      datetime utcNow    = TimeGMT();     // UTC時刻
      int      offset    = (int)(brokerNow - utcNow); // 秒単位のオフセット（UTCとの差）

      MqlRates rates[];
      int copied = CopyRates(g_Symbol, PERIOD_H4, 0, 3, rates);

      Print("=== [TZ診断] Timezone Verification ===");
      Print("  TimeCurrent() = ", brokerNow, " (ブローカー時刻 Unix秒)");
      Print("  TimeGMT()     = ", utcNow,    " (UTC時刻 Unix秒)");
      Print("  Offset        = ", offset, " 秒 (= ", offset/3600, " 時間)");
      Print("  ブローカー時刻: ", TimeToString(brokerNow, TIME_DATE|TIME_SECONDS));
      Print("  UTC時刻:       ", TimeToString(utcNow, TIME_DATE|TIME_SECONDS));

      if(copied > 0)
      {
         for(int i = 0; i < copied; i++)
         {
            bool alignedUTC    = (rates[i].time % 14400) == 0;
            bool alignedUTC3   = ((rates[i].time - 10800) % 14400) == 0;
            Print("  H4 bar[", i, "] time=", rates[i].time,
                  " UTC=", TimeToString((datetime)rates[i].time, TIME_DATE|TIME_SECONDS),
                  " UTC aligned=", alignedUTC,
                  " UTC+3 aligned=", alignedUTC3);
         }
         Print("  → H4バーが UTC境界に整列していれば bar.time = UTC");
         Print("  → UTC+3境界に整列していれば bar.time = Broker Time (UTC+3)");
      }
      Print("=== [TZ診断] 完了 ===");
   }

   // History Sync有効時は初期Bulk送信をスキップ (HistorySync_Run()完了後に実行)
   if(InpOHLCEnabled && !InpHistorySyncEnabled) { OHLCStream_SendBulk(); g_LastBulkSent = TimeCurrent(); }
   else if(InpOHLCEnabled)                      { g_LastBulkSent = TimeCurrent(); }  // Sync後に実行
   if(InpIndicatorEnabled)  { IndicatorStream_Send(); g_LastIndicatorSent = TimeCurrent(); }
   if(InpHistoryEnabled)    { HistoryStream_Send();   g_LastHistorySent = TimeCurrent(); }
   if(InpMWEnabled)         { MarketWatch_Send();     g_LastMWSent = TimeCurrent(); }

   EventSetMillisecondTimer(InpTimerMs);
   Print("AVL DataManager v4.0 起動 | Symbol=", g_Symbol, " | OHLCHistory=", InpOHLCHistory, "本");

   if(InpHistorySyncEnabled)
   {
      g_HistorySyncPending = true;
      Print("[HistorySync] History Sync スケジュール済み → 次のOnTimerで実行します");
      Print("[HistorySync] TFs=", InpHistorySyncTFs, " Months=", InpHistorySyncMonths,
            " ChunkDays=", InpHistorySyncChunkDays, " BatchSize=", InpHistorySyncBatchSize);
   }
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   string body = "{\"type\":\"DISCONNECT\",\"symbol\":\"" + g_Symbol + "\"}";
   HTTP_Post("/event", body);
}

//+------------------------------------------------------------------+
//| OnTick                                                           |
//+------------------------------------------------------------------+
void OnTick()
{
   MqlTick tick;
   if(!SymbolInfoTick(g_Symbol, tick)) return;
   if((tick.time_msc - g_LastTickMs) < InpTickThrottleMs) return;
   g_LastTickMs = tick.time_msc;

   if(InpTickEnabled)  TickStream_Send(tick);
   if(InpOHLCEnabled)  OHLCStream_OnTick();
}

//+------------------------------------------------------------------+
//| OnTimer                                                          |
//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();
   g_TimerCount++;

   Heartbeat_Send();

   // Market Watch（全シンボル）
   if(InpMWEnabled && (g_LastMWSent == 0 || (now - g_LastMWSent) >= InpMWSec)) {
      MarketWatch_Send();
      g_LastMWSent = now;
   }

   // 注文 + ポジション
   if(InpOrderEnabled && (g_LastOrderSent == 0 || (now - g_LastOrderSent) >= InpOrderSec)) {
      OrderStream_Send();
      PositionStream_Send();
      if(InpAccountEnabled) AccountStream_Send();
      g_LastOrderSent = now;
   }

   // インジケーター（拡張）
   if(InpIndicatorEnabled && (g_LastIndicatorSent == 0 || (now - g_LastIndicatorSent) >= InpIndicatorSec)) {
      IndicatorStream_Send();
      g_LastIndicatorSent = now;
   }

   // OHLC 定期再送
   if(InpOHLCEnabled && (g_LastBulkSent == 0 || (now - g_LastBulkSent) >= BULK_RESEND_SEC)) {
      OHLCStream_SendBulk();
      g_LastBulkSent = now;
   }

   // 取引履歴
   if(InpHistoryEnabled && (g_LastHistorySent == 0 || (now - g_LastHistorySent) >= InpHistorySec)) {
      HistoryStream_Send();
      g_LastHistorySent = now;
   }

   // History Sync（起動時1回限り）
   // 注意: HistorySync_Run()はブロッキング実行のため、実行中はOnTimerが再入しません。
   //       Heartbeat / MarketWatch / Order 等のリアルタイム配信は History Sync完了後に自動復帰します。
   if(g_HistorySyncPending && !g_HistorySyncRunning && !g_HistorySyncCompleted)
   {
      g_HistorySyncPending = false;
      g_HistorySyncRunning = true;
      HistorySync_Run();
      g_HistorySyncRunning   = false;
      g_HistorySyncCompleted = true;
      // Sync完了後にOHLC Bulk送信を実行（通常運転の起点）
      if(InpOHLCEnabled) { OHLCStream_SendBulk(); g_LastBulkSent = TimeCurrent(); }
   }

   // Data Phase B — Incremental Sync Job ポーリング
   // HistorySync / DataSync が実行中でなければ、InpDataSyncPollSec 間隔で polling する。
   // DataSync_Poll() はブロッキング実行（job 発見時は HistorySync_Timeframe を同期実行）。
   if(InpDataSyncEnabled && !g_HistorySyncRunning && !g_DataSyncRunning)
   {
      if(g_LastDataSyncPoll == 0 || (now - g_LastDataSyncPoll) >= InpDataSyncPollSec)
      {
         g_LastDataSyncPoll = now;
         g_DataSyncRunning  = true;
         DataSync_Poll();
         g_DataSyncRunning  = false;
      }
   }
}

//=================================================================//
//  Stream 1: Tick Stream                                          //
//=================================================================//
void TickStream_Send(const MqlTick &tick)
{
   int    digits = (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(g_Symbol, SYMBOL_POINT);
   double spread = (point > 0) ? (tick.ask - tick.bid) / point : 0.0;

   string body = StringFormat(
      "{\"type\":\"TICK\",\"symbol\":\"%s\","
      "\"bid\":%.5f,\"ask\":%.5f,\"spread\":%.2f,"
      "\"digits\":%d,\"time\":%I64d}",
      g_Symbol, tick.bid, tick.ask, spread, digits, (long)TimeCurrent()
   );
   HTTP_Post("/tick", body);
}

//=================================================================//
//  Stream 2: OHLC Stream                                         //
//=================================================================//
void OHLCStream_OnTick()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++) {
      ENUM_TIMEFRAMES tf = g_TfList[i];
      datetime curTime   = iTime(g_Symbol, tf, 0);
      if(curTime == 0) continue;
      if(g_LastBarTimes[i] != 0 && curTime > g_LastBarTimes[i]) OHLCStream_SendBar(tf, 1);
      g_LastBarTimes[i] = curTime;
      OHLCStream_SendBar(tf, 0);
   }
}

void OHLCStream_SendBar(ENUM_TIMEFRAMES tf, int shift)
{
   MqlRates rates[];
   if(CopyRates(g_Symbol, tf, shift, 1, rates) <= 0) return;
   string body = StringFormat(
      "{\"type\":\"BAR\",\"symbol\":\"%s\",\"timeframe\":\"%s\","
      "\"time\":%I64d,\"open\":%.5f,\"high\":%.5f,"
      "\"low\":%.5f,\"close\":%.5f,\"volume\":%d}",
      g_Symbol, TF_ToString(tf), (long)rates[0].time,
      rates[0].open, rates[0].high, rates[0].low, rates[0].close,
      (long)rates[0].tick_volume
   );
   HTTP_Post("/bar", body);
}

void OHLCStream_SendBulk()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++) {
      ENUM_TIMEFRAMES tf = g_TfList[i];
      MqlRates rates[];
      int n = CopyRates(g_Symbol, tf, 0, InpOHLCHistory, rates);
      if(n <= 0) continue;

      string barsJson = "";
      for(int j = 0; j < n; j++) {
         if(j > 0) barsJson += ",";
         barsJson += StringFormat(
            "{\"time\":%I64d,\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,\"volume\":%d}",
            (long)rates[j].time, rates[j].open, rates[j].high,
            rates[j].low, rates[j].close, (long)rates[j].tick_volume
         );
      }
      string body = StringFormat(
         "{\"type\":\"BARS\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bars\":[%s]}",
         g_Symbol, TF_ToString(tf), barsJson
      );
      HTTP_Post("/bars/bulk", body);
      // 要求本数 vs 実際取得本数をログに出力（TERMINAL_MAXBARSやブローカー制限の確認用）
      Print("OHLC Bulk: ", g_Symbol, ":", TF_ToString(tf),
            " 要求=", InpOHLCHistory, "本 実取得=", n, "本",
            (n < InpOHLCHistory ? " ← ブローカー/端末制限で不足" : " OK"));
      Sleep(30);
   }
}

//=================================================================//
//  Stream 3: Market Watch — 全シンボル送信                        //
//=================================================================//
void MarketWatch_Send()
{
   int count = SymbolsTotal(true); // Market Watch 内のシンボル数
   if(count <= 0) return;

   string symsJson = "";
   int    sent     = 0;

   for(int i = 0; i < count; i++) {
      string sym = SymbolName(i, true);
      if(StringLen(sym) == 0) continue;

      double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
      double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
      int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      long   tickMs = SymbolInfoInteger(sym, SYMBOL_TIME);

      // スプレッド（pips換算）
      double spreadPips = (point > 0) ? (ask - bid) / point : 0;
      if(digits == 5 || digits == 3) spreadPips /= 10.0;

      // 日次変化率
      double dayOpen   = SymbolInfoDouble(sym, SYMBOL_SESSION_OPEN);
      double changePct = (dayOpen > 0 && bid > 0) ? ((bid - dayOpen) / dayOpen) * 100.0 : 0.0;

      // コントラクト情報
      double contractSize = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
      double tickValue    = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
      double tickSize     = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);

      // 52週高値・安値（Session High/Low を代用）
      double high52 = SymbolInfoDouble(sym, SYMBOL_SESSION_PRICE_LIMIT_MAX);
      double low52  = SymbolInfoDouble(sym, SYMBOL_SESSION_PRICE_LIMIT_MIN);

      // 前日終値
      double prevClose = SymbolInfoDouble(sym, SYMBOL_LAST);

      if(sent > 0) symsJson += ",";
      symsJson += StringFormat(
         "{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,"
         "\"spread\":%.2f,\"changePct\":%.3f,"
         "\"digits\":%d,\"point\":%.7f,"
         "\"contractSize\":%.0f,\"tickValue\":%.5f,\"tickSize\":%.5f,"
         "\"high52\":%.5f,\"low52\":%.5f,\"prevClose\":%.5f,"
         "\"time\":%I64d}",
         sym, bid, ask,
         spreadPips, changePct,
         digits, point,
         contractSize, tickValue, tickSize,
         high52, low52, prevClose,
         tickMs
      );
      sent++;
   }

   if(sent == 0) return;

   string body = StringFormat(
      "{\"type\":\"SYMBOLS\",\"count\":%d,\"symbols\":[%s]}",
      sent, symsJson
   );
   HTTP_Post("/symbols/bulk", body);
}

//=================================================================//
//  Stream 4: Indicator Stream（拡張 — 全インジケーター）          //
//=================================================================//
void IndicatorStream_Send()
{
   int    digits = (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(g_Symbol, SYMBOL_POINT);

   MqlTick tick;
   double spread = 0.0;
   if(SymbolInfoTick(g_Symbol, tick) && point > 0) {
      double raw = (tick.ask - tick.bid) / point;
      spread = (digits == 5 || digits == 3) ? raw / 10.0 : raw;
   }

   ENUM_TIMEFRAMES aiTfs[]    = { PERIOD_H4, PERIOD_H1, PERIOD_M15, PERIOD_M5 };
   string          aiTfNames[] = { "H4",     "H1",      "M15",      "M5"      };
   int tfCount = 4;

   string tfJson = "";
   for(int i = 0; i < tfCount; i++) {
      ENUM_TIMEFRAMES tf    = aiTfs[i];
      string          tfStr = aiTfNames[i];

      // EMA21
      double ema21 = GetIndicatorValue(iMA(g_Symbol, tf, 21,  0, MODE_EMA, PRICE_CLOSE), 0, 1);
      // EMA200
      double ema200 = GetIndicatorValue(iMA(g_Symbol, tf, 200, 0, MODE_EMA, PRICE_CLOSE), 0, 1);
      // SMA50
      double sma50  = GetIndicatorValue(iMA(g_Symbol, tf, 50,  0, MODE_SMA, PRICE_CLOSE), 0, 1);
      // ATR14
      double atr14  = GetIndicatorValue(iATR(g_Symbol, tf, 14), 0, 1);
      // RSI14
      double rsi14  = GetIndicatorValue(iRSI(g_Symbol, tf, 14, PRICE_CLOSE), 0, 1);

      // MACD(12,26,9) — マルチバッファ: ReadBuffer()を使用（ハンドルを保持）
      int hMACD = iMACD(g_Symbol, tf, 12, 26, 9, PRICE_CLOSE);
      double macdMain = ReadBuffer(hMACD, 0, 1);
      double macdSig  = ReadBuffer(hMACD, 1, 1);
      double macdHist = macdMain - macdSig;
      if(hMACD != INVALID_HANDLE) IndicatorRelease(hMACD);

      // ADX14 — マルチバッファ
      int hADX = iADX(g_Symbol, tf, 14);
      double adx    = ReadBuffer(hADX, 0, 1);
      double diPlus = ReadBuffer(hADX, 1, 1);
      double diMinus= ReadBuffer(hADX, 2, 1);
      if(hADX != INVALID_HANDLE) IndicatorRelease(hADX);

      // Bollinger Bands(20, 2) — マルチバッファ
      // Buffer 0=BASE_LINE(mid), 1=UPPER_BAND, 2=LOWER_BAND
      int hBB = iBands(g_Symbol, tf, 20, 0, 2.0, PRICE_CLOSE);
      double bbMid   = ReadBuffer(hBB, 0, 1);
      double bbUpper = ReadBuffer(hBB, 1, 1);
      double bbLower = ReadBuffer(hBB, 2, 1);
      double bbWidth = (bbMid > 0) ? (bbUpper - bbLower) / bbMid * 100.0 : 0;
      if(hBB != INVALID_HANDLE) IndicatorRelease(hBB);

      // トレンド方向
      string trendDir = (ema21 > ema200) ? "UP" : (ema21 < ema200) ? "DOWN" : "FLAT";

      if(i > 0) tfJson += ",";
      tfJson += StringFormat(
         "\"%s\":{"
         "\"ema21\":%.5f,\"ema200\":%.5f,\"sma50\":%.5f,"
         "\"atr\":%.5f,\"rsi\":%.2f,"
         "\"macd\":%.5f,\"macdSignal\":%.5f,\"macdHist\":%.5f,"
         "\"adx\":%.2f,\"diPlus\":%.2f,\"diMinus\":%.2f,"
         "\"bbUpper\":%.5f,\"bbMid\":%.5f,\"bbLower\":%.5f,\"bbWidth\":%.3f,"
         "\"trend\":\"%s\""
         "}",
         tfStr,
         ema21, ema200, sma50,
         atr14, rsi14,
         macdMain, macdSig, macdHist,
         adx, diPlus, diMinus,
         bbUpper, bbMid, bbLower, bbWidth,
         trendDir
      );
   }

   string body = StringFormat(
      "{\"type\":\"INDICATORS\","
      "\"symbol\":\"%s\","
      "\"spread\":%.2f,\"digits\":%d,"
      "\"brokerTime\":%I64d,"
      "\"timeframes\":{%s}}",
      g_Symbol, spread, digits, (long)TimeCurrent(), tfJson
   );
   HTTP_Post("/indicators", body);
}

// ── 単一バッファ読み取り + ハンドル解放（単一バッファインジケーター用）──
// EMA, ATR, RSI など1バッファのインジケーターに使用する
double GetIndicatorValue(int handle, int buffer, int shift)
{
   if(handle == INVALID_HANDLE) return 0.0;
   double buf[];
   ArraySetAsSeries(buf, true);
   double val = 0.0;
   if(CopyBuffer(handle, buffer, shift, 1, buf) > 0) val = buf[0];
   IndicatorRelease(handle);   // 1バッファのみなのでここで解放
   return val;
}

// ── マルチバッファ読み取り（ハンドルを解放しない）──
// MACD, ADX, Bollinger など複数バッファを同一ハンドルから読む際に使用する
// 呼び出し側で IndicatorRelease() を明示的に呼ぶこと
double ReadBuffer(int handle, int buffer, int shift)
{
   if(handle == INVALID_HANDLE) return 0.0;
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handle, buffer, shift, 1, buf) > 0) return buf[0];
   return 0.0;
}

//=================================================================//
//  Stream 5: Order Stream — 全注文（Pending + Position）          //
//=================================================================//
void OrderStream_Send()
{
   string ordersJson = "";
   int    count      = 0;

   // Pending Orders
   for(int i = 0; i < OrdersTotal(); i++) {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;

      if(count > 0) ordersJson += ",";
      ordersJson += StringFormat(
         "{\"ticket\":%I64d,"
         "\"symbol\":\"%s\","
         "\"type\":%d,"
         "\"orderType\":\"pending\","
         "\"volume\":%.2f,"
         "\"openPrice\":%.5f,"
         "\"sl\":%.5f,"
         "\"tp\":%.5f,"
         "\"profit\":0.0,"
         "\"swap\":0.0,"
         "\"commission\":0.0,"
         "\"openTime\":%I64d,"
         "\"magic\":%I64d,"
         "\"comment\":\"%s\"}",
         ticket,
         OrderGetString(ORDER_SYMBOL),
         (int)OrderGetInteger(ORDER_TYPE),
         OrderGetDouble(ORDER_VOLUME_INITIAL),
         OrderGetDouble(ORDER_PRICE_OPEN),
         OrderGetDouble(ORDER_SL),
         OrderGetDouble(ORDER_TP),
         (long)OrderGetInteger(ORDER_TIME_SETUP),
         (long)OrderGetInteger(ORDER_MAGIC),
         OrderGetString(ORDER_COMMENT)
      );
      count++;
   }

   // Open Positions
   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      if(count > 0) ordersJson += ",";
      ordersJson += StringFormat(
         "{\"ticket\":%I64d,"
         "\"symbol\":\"%s\","
         "\"type\":%d,"
         "\"orderType\":\"position\","
         "\"volume\":%.2f,"
         "\"openPrice\":%.5f,"
         "\"currentPrice\":%.5f,"
         "\"sl\":%.5f,"
         "\"tp\":%.5f,"
         "\"profit\":%.2f,"
         "\"swap\":%.2f,"
         "\"commission\":%.2f,"
         "\"openTime\":%I64d,"
         "\"magic\":%I64d,"
         "\"comment\":\"%s\"}",
         ticket,
         PositionGetString(POSITION_SYMBOL),
         (int)PositionGetInteger(POSITION_TYPE),
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_PRICE_CURRENT),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         PositionGetDouble(POSITION_SWAP),
         PositionGetDouble(POSITION_COMMISSION),
         (long)PositionGetInteger(POSITION_TIME),
         (long)PositionGetInteger(POSITION_MAGIC),
         PositionGetString(POSITION_COMMENT)
      );
      count++;
   }

   string body = StringFormat(
      "{\"type\":\"ORDERS\",\"count\":%d,\"orders\":[%s]}",
      count, ordersJson
   );
   HTTP_Post("/orders/stream", body);

   // Order ポーリング（AI注文実行）
   OrderStream_Poll();
}

//=================================================================//
//  Stream 5b: Order Poll（AI → EA 注文受信）                     //
//=================================================================//
void OrderStream_Poll()
{
   char req[], res[];
   string headers = "Authorization: Bearer " + InpServerSecret + "\r\n";
   string resHdr;
   int code = WebRequest("GET", InpServerURL + "/orders/pending", headers, 3000, req, res, resHdr);
   if(code != 200 || ArraySize(res) == 0) return;

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return;

   int pos = 0;
   while(true) {
      int start = StringFind(response, "{", pos);
      if(start < 0) break;
      int end = StringFind(response, "}", start);
      if(end < 0) break;
      string obj = StringSubstr(response, start, end - start + 1);
      pos = end + 1;

      string orderId   = JsonGetStr(obj, "id");
      string direction = JsonGetStr(obj, "direction");
      string sym       = JsonGetStr(obj, "symbol");
      double volume    = JsonGetDbl(obj, "volume");
      double sl        = JsonGetDbl(obj, "sl");
      double tp        = JsonGetDbl(obj, "tp");
      long   magic     = (long)JsonGetDbl(obj, "magic");

      if(orderId == "" || direction == "" || volume <= 0) continue;
      if(sym == "") sym = g_Symbol;

      g_Trade.SetExpertMagicNumber((ulong)magic);
      g_Trade.SetDeviationInPoints(30);

      bool ok = false;
      if(direction == "BUY")  ok = g_Trade.Buy(volume, sym, 0, sl, tp, "AVL AI");
      else if(direction == "SELL") ok = g_Trade.Sell(volume, sym, 0, sl, tp, "AVL AI");

      Print("[Order] ", direction, " ", sym, " vol=", volume, " → ", ok ? "OK" : "FAIL");

      string resultBody = StringFormat(
         "{\"success\":%s,\"retcode\":%d,\"deal\":%I64d}",
         ok ? "true" : "false",
         (int)g_Trade.ResultRetcode(),
         (long)g_Trade.ResultDeal()
      );
      HTTP_Post("/orders/" + orderId + "/result", resultBody);
   }
}

//=================================================================//
//  Stream 6: Position Stream                                      //
//=================================================================//
void PositionStream_Send()
{
   string posArr = "";
   int    count  = 0;

   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      if(count > 0) posArr += ",";
      posArr += StringFormat(
         "{\"ticket\":%d,\"type\":%d,\"volume\":%.2f,"
         "\"openPrice\":%.5f,\"currentPrice\":%.5f,"
         "\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f,"
         "\"swap\":%.2f,\"openTime\":%d,\"magic\":%d}",
         (long)ticket,
         (int)PositionGetInteger(POSITION_TYPE),
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_PRICE_CURRENT),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         PositionGetDouble(POSITION_SWAP),
         (long)PositionGetInteger(POSITION_TIME),
         (long)PositionGetInteger(POSITION_MAGIC)
      );
      count++;
   }

   string body = StringFormat(
      "{\"type\":\"POSITIONS\",\"symbol\":\"%s\",\"positions\":[%s]}",
      g_Symbol, posArr
   );
   HTTP_Post("/positions", body);
}

//=================================================================//
//  Stream 6b: Account Stream                                      //
//=================================================================//
void AccountStream_Send()
{
   double balance     = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity      = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin      = AccountInfoDouble(ACCOUNT_MARGIN);
   double freeMargin  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double marginLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);

   // Drawdown
   double drawdown    = (balance > 0 && equity < balance) ? ((balance - equity) / balance) * 100.0 : 0.0;
   // Risk（証拠金比率）
   double risk        = (equity > 0 && margin > 0) ? (margin / equity) * 100.0 : 0.0;

   string body = StringFormat(
      "{\"type\":\"ACCOUNT\","
      "\"login\":%d,\"broker\":\"%s\",\"currency\":\"%s\","
      "\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,"
      "\"freeMargin\":%.2f,\"marginLevel\":%.2f,\"leverage\":%d,"
      "\"drawdown\":%.2f,\"risk\":%.2f}",
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      AccountInfoString(ACCOUNT_CURRENCY),
      balance, equity, margin, freeMargin, marginLevel,
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE),
      drawdown, risk
   );
   HTTP_Post("/account", body);
}

//=================================================================//
//  Stream 7: History Stream                                       //
//=================================================================//
void HistoryStream_Send()
{
   datetime from = TimeCurrent() - (datetime)(InpHistoryDays * 86400);
   if(!HistorySelect(from, TimeCurrent())) return;

   int total = HistoryDealsTotal();
   if(total <= 0) return;

   string dealsJson = "";
   int    count     = 0;

   for(int i = total - 1; i >= 0 && count < 200; i--) {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket <= 0) continue;
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != g_Symbol) continue;

      long dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dealType == DEAL_TYPE_BALANCE) continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT) continue;

      if(count > 0) dealsJson += ",";
      dealsJson += StringFormat(
         "{\"ticket\":%I64d,\"type\":%d,\"volume\":%.2f,"
         "\"closeTime\":%I64d,\"closePrice\":%.5f,"
         "\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"magic\":%I64d}",
         ticket,
         (int)dealType,
         HistoryDealGetDouble(ticket, DEAL_VOLUME),
         (long)HistoryDealGetInteger(ticket, DEAL_TIME),
         HistoryDealGetDouble(ticket, DEAL_PRICE),
         HistoryDealGetDouble(ticket, DEAL_PROFIT),
         HistoryDealGetDouble(ticket, DEAL_SWAP),
         HistoryDealGetDouble(ticket, DEAL_COMMISSION),
         (long)HistoryDealGetInteger(ticket, DEAL_MAGIC)
      );
      count++;
   }

   if(count == 0) return;

   string body = StringFormat(
      "{\"type\":\"HISTORY\",\"symbol\":\"%s\",\"days\":%d,\"deals\":[%s]}",
      g_Symbol, InpHistoryDays, dealsJson
   );
   HTTP_Post("/history/bulk", body);
   Print("History: ", count, "件送信");
}

//=================================================================//
//  接続通知 / ハートビート                                        //
//=================================================================//
bool Connect_Send()
{
   int mwCount = SymbolsTotal(true);
   string body = StringFormat(
      "{\"type\":\"CONNECT\","
      "\"symbol\":\"%s\",\"digits\":%d,\"point\":%.7f,"
      "\"login\":%d,\"broker\":\"%s\","
      "\"version\":\"4.00\","
      "\"marketWatchCount\":%d,"
      "\"serverTime\":%I64d}",
      g_Symbol,
      (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS),
      SymbolInfoDouble(g_Symbol, SYMBOL_POINT),
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      mwCount,
      (long)TimeCurrent()
   );
   int code = HTTP_Post("/connect", body);
   return (code == 200 || code == 201);
}

void Heartbeat_Send()
{
   string body = StringFormat(
      "{\"type\":\"HEARTBEAT\",\"symbol\":\"%s\",\"serverTime\":%I64d}",
      g_Symbol, (long)TimeCurrent()
   );
   HTTP_Post("/heartbeat", body);
}

//=================================================================//
//  HTTP POST                                                      //
//=================================================================//
int HTTP_Post(const string path, const string body)
{
   string headers = "Content-Type: application/json\r\n"
                    "Authorization: Bearer " + InpServerSecret + "\r\n";
   char reqData[], resData[];
   string resHdr;
   StringToCharArray(body, reqData, 0, StringLen(body));

   int code = WebRequest("POST", InpServerURL + path, headers, 5000, reqData, resData, resHdr);
   if(code < 0) {
      int err = GetLastError();
      if(err == 4014) {
         static bool alerted = false;
         if(!alerted) {
            Print("!!! WebRequest 未許可 → MT5: ツール > オプション > EA > WebRequest許可: ", InpServerURL);
            alerted = true;
         }
      }
   }
   return code;
}

//=================================================================//
//  Stream 9: History Sync — 過去OHLC一括取得                      //
//                                                                 //
//  InpHistorySyncEnabled=true 時に起動時1回だけ OnTimer から呼ばれる。//
//  既存の OHLCStream_SendBulk / Realtime Stream と完全独立。      //
//  /bars/bulk エンドポイントを再利用。JSON形式は既存と完全互換。  //
//  Supabase ignoreDuplicates=true による冪等性で何度実行しても安全。//
//=================================================================//

// TF文字列 → ENUM_TIMEFRAMES (未知の場合は PERIOD_CURRENT=0 を返す)
ENUM_TIMEFRAMES TF_FromString(const string name)
{
   if(name == "M1")  return PERIOD_M1;
   if(name == "M5")  return PERIOD_M5;
   if(name == "M15") return PERIOD_M15;
   if(name == "M30") return PERIOD_M30;
   if(name == "H1")  return PERIOD_H1;
   if(name == "H4")  return PERIOD_H4;
   if(name == "D1")  return PERIOD_D1;
   if(name == "W1")  return PERIOD_W1;
   return PERIOD_CURRENT;  // sentinel: 未知TF
}

// ENUM_TIMEFRAMES → 1bar の秒数
int TF_ToSeconds(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return 60;
      case PERIOD_M5:  return 300;
      case PERIOD_M15: return 900;
      case PERIOD_M30: return 1800;
      case PERIOD_H1:  return 3600;
      case PERIOD_H4:  return 14400;
      case PERIOD_D1:  return 86400;
      case PERIOD_W1:  return 604800;
      default:         return 60;
   }
}

// "M5,H1,H4" → ENUM_TIMEFRAMES配列・TF名配列へ解析
// 戻り値: 有効TF数 (0 = 有効TFなし)
int HistorySync_ParseTFs(
    const string     tfStr,
    ENUM_TIMEFRAMES &tfOut[],
    string          &namesOut[]
)
{
   string parts[];
   int n = StringSplit(tfStr, StringGetCharacter(",", 0), parts);
   ArrayResize(tfOut,    0);
   ArrayResize(namesOut, 0);
   int valid = 0;

   for(int i = 0; i < n; i++)
   {
      string name = parts[i];
      StringTrimLeft(name);
      StringTrimRight(name);
      StringToUpper(name);
      if(StringLen(name) == 0) continue;

      ENUM_TIMEFRAMES tf = TF_FromString(name);
      if(tf == PERIOD_CURRENT)  // 未知TF
      {
         Print("[HistorySync] Unknown timeframe: ", name, " — skipped");
         continue;
      }

      ArrayResize(tfOut,    valid + 1);
      ArrayResize(namesOut, valid + 1);
      tfOut[valid]    = tf;
      namesOut[valid] = name;
      valid++;
   }
   return valid;
}

// 1 batch (最大batchSize bars) を /bars/bulk へ送信
// リトライ最大 HISTORY_SYNC_RETRY_MAX 回
// 戻り値: true=成功, false=全リトライ失敗
bool HistorySync_SendBatch(
    const string    symbol,
    const string    tfName,
    MqlRates       &rates[],
    const int       startIdx,
    const int       count,
    const int       batchNum,
    const int       totalBatches
)
{
   // JSON組み立て — 既存 OHLCStream_SendBulk() と完全同一形式
   string barsJson = "";
   for(int j = 0; j < count; j++)
   {
      int idx = startIdx + j;
      if(j > 0) barsJson += ",";
      barsJson += StringFormat(
         "{\"time\":%I64d,\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,\"volume\":%d}",
         (long)rates[idx].time,
         rates[idx].open,  rates[idx].high,
         rates[idx].low,   rates[idx].close,
         (long)rates[idx].tick_volume
      );
   }
   string body = StringFormat(
      "{\"type\":\"BARS\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bars\":[%s]}",
      symbol, tfName, barsJson
   );

   // リトライループ (指数バックオフ: 500ms, 1000ms, 1500ms)
   for(int attempt = 1; attempt <= HISTORY_SYNC_RETRY_MAX; attempt++)
   {
      int code = HTTP_Post("/bars/bulk", body);
      if(code == 200 || code == 201)
      {
         Print("[HistorySync] ", symbol, ":", tfName,
               " batch ", batchNum, "/", totalBatches,
               " | ", count, " bars | OK");
         return true;
      }
      // 失敗時のログ
      if(attempt < HISTORY_SYNC_RETRY_MAX)
      {
         Print("[HistorySync] ", symbol, ":", tfName,
               " batch ", batchNum, "/", totalBatches,
               " | attempt ", attempt, "/", HISTORY_SYNC_RETRY_MAX,
               " | FAILED (HTTP ", code, ") → retry");
         Sleep(500 * attempt);
      }
      else
      {
         Print("[HistorySync] ", symbol, ":", tfName,
               " batch ", batchNum, "/", totalBatches,
               " | attempt ", attempt, "/", HISTORY_SYNC_RETRY_MAX,
               " | FAILED (HTTP ", code, ") → giving up");
      }
   }
   return false;
}

// 1 TF について targetFrom〜targetTo を chunkDays 単位で分割取得・送信
// 参照パラメータで合計bar数・送信数・失敗batch数を返す
bool HistorySync_Timeframe(
    const string    symbol,
    ENUM_TIMEFRAMES tf,
    const string    tfName,
    const datetime  targetFrom,
    const datetime  targetTo,
    const int       batchSize,
    const int       chunkDays,
    long           &outCopied,
    long           &outSent,
    int            &outFailed
)
{
   outCopied = 0;
   outSent   = 0;
   outFailed = 0;

   // confirmed barのみ送信。
   // bar.time + tfSec <= TimeCurrent() を満たすbarが「確定済み」。
   // したがって stop_time の上限は targetTo - tfSec (= confirmedTo)。
   // これにより現在形成中の未確定barが /bars/bulk に混入するのを防ぐ。
   // Supabase ignoreDuplicates=true は一度保存した行を上書きしないため、
   // 未確定barを保存すると後から確定値で修正されない可能性がある。
   int  tfSec      = TF_ToSeconds(tf);
   long chunkSec   = (long)chunkDays * 86400L;
   long confirmedToL = (long)targetTo - (long)tfSec;
   if(confirmedToL <= (long)targetFrom)
   {
      Print("[HistorySync] ", symbol, ":", tfName,
            " SKIP: confirmedTo <= targetFrom (TF=", tfSec, "s, not enough range)");
      return true;
   }
   datetime confirmedTo = (datetime)confirmedToL;

   Print("[HistorySync] ", symbol, ":", tfName, " START");
   Print("[HistorySync] ", symbol, ":", tfName,
         " confirmedTo=", TimeToString(confirmedTo, TIME_DATE|TIME_SECONDS),
         " (forming bar excluded, -", tfSec, "s)");

   datetime chunkFrom   = targetFrom;
   datetime actualOldest = 0;
   datetime actualNewest = 0;

   while(chunkFrom < confirmedTo)
   {
      // チャンク終端を計算 (confirmedToを超えない)
      long chunkToL = (long)chunkFrom + chunkSec;
      if(chunkToL > (long)confirmedTo) chunkToL = (long)confirmedTo;
      datetime chunkTo = (datetime)chunkToL;

      // datetime範囲指定 CopyRates (MQL5第3オーバーロード)
      // start_time <= bar.open_time <= stop_time (両端含む)
      MqlRates rates[];
      int n = CopyRates(symbol, tf, chunkFrom, chunkTo, rates);

      if(n <= 0)
      {
         Print("[HistorySync] ", symbol, ":", tfName,
               " chunk ", TimeToString(chunkFrom, TIME_DATE), " -> ",
               TimeToString(chunkTo, TIME_DATE),
               " | n=", n, " (no data — Broker history may not cover this range)");
         // データなし → 次chunkへ (ギャップかBroker制限)
         chunkFrom = (datetime)((long)chunkTo + 1L);
         continue;
      }

      Print("[HistorySync] ", symbol, ":", tfName,
            " chunk ", TimeToString(chunkFrom, TIME_DATE), " -> ",
            TimeToString(chunkTo, TIME_DATE), " | ", n, " bars");

      // actual range tracking (Broker history可用性確認用)
      if(actualOldest == 0 || rates[0].time < actualOldest) actualOldest = rates[0].time;
      if(rates[n - 1].time > actualNewest) actualNewest = rates[n - 1].time;
      outCopied += n;

      // バッチ分割送信 (最大batchSize本ずつ)
      int totalBatches = (n + batchSize - 1) / batchSize;  // 切り上げ除算
      for(int b = 0; b < totalBatches; b++)
      {
         int start = b * batchSize;
         int count = (n - start < batchSize) ? (n - start) : batchSize;

         bool ok = HistorySync_SendBatch(
            symbol, tfName, rates, start, count, b + 1, totalBatches
         );
         if(ok)
            outSent += count;
         else
            outFailed++;

         // バッチ間のSleep (Gateway / Supabase 負荷軽減)
         if(b + 1 < totalBatches)
            Sleep(HISTORY_SYNC_BATCH_SLEEP_MS);
      }

      // 次chunkは chunkTo + 1秒から (境界barの重複を防ぐ。欠損なし保証)
      chunkFrom = (datetime)((long)chunkTo + 1L);
   }

   // TF完了サマリー
   Print("[HistorySync] ", symbol, ":", tfName, " COMPLETE");
   Print("[HistorySync] copied=", outCopied,
         " sent=", outSent, " failed_batches=", outFailed);

   // Broker History 可用性チェック
   Print("[HistorySync] ", symbol, ":", tfName,
         " requested_from=", TimeToString(targetFrom, TIME_DATE|TIME_SECONDS));
   if(actualOldest > 0)
   {
      Print("[HistorySync] ", symbol, ":", tfName,
            " actual_oldest=",  TimeToString(actualOldest, TIME_DATE|TIME_SECONDS));
      Print("[HistorySync] ", symbol, ":", tfName,
            " actual_newest=",  TimeToString(actualNewest, TIME_DATE|TIME_SECONDS));
      // 実際の最古barが要求startより1日以上後なら警告
      if((long)actualOldest > (long)targetFrom + 86400L)
      {
         Print("[HistorySync] WARNING: Broker history does not cover full requested period.");
         Print("[HistorySync]   Requested from: ", TimeToString(targetFrom,  TIME_DATE));
         Print("[HistorySync]   Actual oldest:  ", TimeToString(actualOldest, TIME_DATE));
         Print("[HistorySync]   This is a Broker/Terminal history limitation, not a code bug.");
      }
   }
   else
   {
      Print("[HistorySync] WARNING: No bars received for ", symbol, ":", tfName,
            " in the requested period.");
      Print("[HistorySync]   Check: MT5 Tools > Options > Charts > Max bars in history");
      Print("[HistorySync]   Check: Broker history availability for this symbol/TF");
   }

   return true;
}

// History Sync メイン関数 — OnTimer から起動時1回だけ呼ばれる
void HistorySync_Run()
{
   datetime syncStart = TimeCurrent();

   // パラメータ検証・クランプ
   int months    = MathMax(1,   MathMin(60,   InpHistorySyncMonths));
   int chunkDays = MathMax(1,   MathMin(365,  InpHistorySyncChunkDays));
   int batchSize = MathMax(100, MathMin(5000, InpHistorySyncBatchSize));

   // TF解析
   ENUM_TIMEFRAMES tfList[];
   string          tfNames[];
   int tfCount = HistorySync_ParseTFs(InpHistorySyncTFs, tfList, tfNames);
   if(tfCount == 0)
   {
      Print("[HistorySync] ERROR: No valid timeframes in InpHistorySyncTFs=\"",
            InpHistorySyncTFs, "\". Aborting.");
      return;
   }

   // 時刻範囲
   // targetFrom: 現在時刻 - months × 30日
   // targetTo:   現在時刻 (Supabase ignoreDuplicatesで未確定barも安全)
   datetime now        = TimeCurrent();
   datetime targetFrom = (datetime)((long)now - (long)months * 30L * 86400L);
   datetime targetTo   = now;

   // ヘッダーログ
   Print("[HistorySync] ========================================");
   Print("[HistorySync] START");
   Print("[HistorySync] Symbol:     ", g_Symbol);
   Print("[HistorySync] TFs:        ", InpHistorySyncTFs);
   Print("[HistorySync] Months:     ", months);
   Print("[HistorySync] From:       ", TimeToString(targetFrom, TIME_DATE|TIME_SECONDS));
   Print("[HistorySync] To:         ", TimeToString(targetTo,   TIME_DATE|TIME_SECONDS));
   Print("[HistorySync] Chunk days: ", chunkDays, " | Batch size: ", batchSize);
   Print("[HistorySync] ========================================");

   // 全TFを順次処理
   long totalCopied        = 0;
   long totalSent          = 0;
   int  totalFailedBatches = 0;

   for(int t = 0; t < tfCount; t++)
   {
      long copied = 0, sent = 0;
      int  failedBatches = 0;
      HistorySync_Timeframe(
         g_Symbol, tfList[t], tfNames[t],
         targetFrom, targetTo,
         batchSize, chunkDays,
         copied, sent, failedBatches
      );
      totalCopied        += copied;
      totalSent          += sent;
      totalFailedBatches += failedBatches;
   }

   datetime syncEnd   = TimeCurrent();
   int      elapsedSec = (int)(syncEnd - syncStart);

   // フッターログ
   Print("[HistorySync] ========================================");
   Print("[HistorySync] COMPLETE");
   Print("[HistorySync] Total bars copied: ", totalCopied);
   Print("[HistorySync] Total bars sent:   ", totalSent);
   Print("[HistorySync] Failed batches:    ", totalFailedBatches);
   Print("[HistorySync] Execution sec:     ", elapsedSec);
   Print("[HistorySync] ========================================");
}

//=================================================================//
//  ユーティリティ                                                  //
//=================================================================//
string TF_ToString(ENUM_TIMEFRAMES tf)
{
   switch(tf) {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1:  return "H1";
      case PERIOD_H4:  return "H4";
      case PERIOD_D1:  return "D1";
      case PERIOD_W1:  return "W1";
      case PERIOD_MN1: return "MN";
      default:         return "UNKNOWN";
   }
}

string JsonGetStr(const string json, const string key)
{
   string pat = "\"" + key + "\":\"";
   int s = StringFind(json, pat);
   if(s < 0) return "";
   s += StringLen(pat);
   int e = StringFind(json, "\"", s);
   if(e < 0) return "";
   return StringSubstr(json, s, e - s);
}

double JsonGetDbl(const string json, const string key)
{
   string pat = "\"" + key + "\":";
   int s = StringFind(json, pat);
   if(s < 0) return 0.0;
   s += StringLen(pat);
   string num = "";
   for(int i = s; i < StringLen(json); i++) {
      string c = StringSubstr(json, i, 1);
      if(c=="," || c=="}" || c=="]" || c==" " || c=="\r" || c=="\n") break;
      num += c;
   }
   return StringToDouble(num);
}

//=================================================================//
//  Data Phase B — Incremental Sync Command                        //
//                                                                 //
//  Gateway /data-commands/pending を polling し、                  //
//  PENDING な FORWARD / BACKFILL Sync Job を取得・実行する。       //
//  既存の HistorySync_Timeframe() を再利用することで、             //
//  chunk / batch / retry ロジックの重複実装を避ける。              //
//=================================================================//

// DataSync_SendProgress — job 進捗を Gateway に POST
// 失敗してもジョブ実行は継続する（fire-and-don't-crash）
void DataSync_SendProgress(
    const string jobId,
    const string status,
    const int    progressPct,
    const long   receivedBars,
    const long   sentBars,
    const int    failedBatches,
    const datetime currentFrom,
    const datetime currentTo,
    const string errorMsg = ""
)
{
   string body = StringFormat(
      "{\"status\":\"%s\","
      "\"progress_pct\":%d,"
      "\"received_bars\":%I64d,"
      "\"sent_bars\":%I64d,"
      "\"failed_batches\":%d,"
      "\"current_from\":%I64d,"
      "\"current_to\":%I64d",
      status, progressPct,
      receivedBars, sentBars,
      failedBatches,
      (long)currentFrom, (long)currentTo
   );
   if(StringLen(errorMsg) > 0)
      body += ",\"error_message\":\"" + errorMsg + "\"";
   body += "}";

   HTTP_Post("/data-commands/" + jobId + "/progress", body);
}

// DataSync_Execute — Sync Job を実行する
// 既存 HistorySync_Timeframe() を mode に応じた range で呼び出す。
void DataSync_Execute(
    const string jobId,
    const string symbol,
    ENUM_TIMEFRAMES tf,
    const string tfName,
    const string mode,
    datetime targetFrom,
    datetime targetTo   // FORWARD では 0 = TimeCurrent() を使用
)
{
   // FORWARD の場合 targetTo = TimeCurrent() (最新確定barまで)
   if(mode == "FORWARD" || targetTo == 0)
      targetTo = TimeCurrent();

   int tfSec = TF_ToSeconds(tf);

   // 最低限の期間チェック (confirmedTo <= targetFrom になる場合はスキップ)
   long confirmedToL = (long)targetTo - (long)tfSec;
   if(confirmedToL <= (long)targetFrom)
   {
      Print("[DataSync] job=", jobId, " SKIP: range too narrow for TF=", tfName,
            " (", TimeToString(targetFrom, TIME_DATE), " → ", TimeToString(targetTo, TIME_DATE), ")");
      DataSync_SendProgress(jobId, "COMPLETED", 100, 0, 0, 0, targetFrom, targetTo);
      return;
   }

   Print("[DataSync] EXECUTE job=", jobId);
   Print("[DataSync] Mode=", mode, " Symbol=", symbol, " TF=", tfName);
   Print("[DataSync] From=", TimeToString(targetFrom, TIME_DATE|TIME_SECONDS));
   Print("[DataSync] To=  ", TimeToString(targetTo,   TIME_DATE|TIME_SECONDS));

   // 進捗送信: RUNNING
   DataSync_SendProgress(jobId, "RUNNING", 0, 0, 0, 0, targetFrom, targetTo);

   // 既存 HistorySync_Timeframe() を再利用
   long copied = 0, sent = 0;
   int  failedBatches = 0;
   bool ok = HistorySync_Timeframe(
      symbol, tf, tfName,
      targetFrom, targetTo,
      InpHistorySyncBatchSize,
      InpHistorySyncChunkDays,
      copied, sent, failedBatches
   );

   if(ok)
   {
      Print("[DataSync] COMPLETE job=", jobId,
            " recv=", copied, " sent=", sent, " failed_batches=", failedBatches);
      DataSync_SendProgress(jobId, "COMPLETED", 100,
         copied, sent, failedBatches, targetFrom, targetTo);
   }
   else
   {
      string errMsg = "HistorySync_Timeframe returned false";
      Print("[DataSync] FAILED job=", jobId, ": ", errMsg);
      DataSync_SendProgress(jobId, "FAILED", 0,
         copied, sent, failedBatches, targetFrom, targetTo, errMsg);
   }
}

// DataSync_Poll — /data-commands/pending を 1 回 GET して job があれば実行
void DataSync_Poll()
{
   char req[], res[];
   string headers = "Authorization: Bearer " + InpServerSecret + "\r\n";
   string resHdr;

   // symbol フィルタ付きで pending job を取得 (自分の symbol のみ)
   string url = InpServerURL + "/data-commands/pending?symbol=" + g_Symbol;
   int code = WebRequest("GET", url, headers, 5000, req, res, resHdr);

   if(code != 200 || ArraySize(res) == 0) return;

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return;

   // jobs 配列を探す: {"jobs":[{...}]}
   int jobsStart = StringFind(response, "[");
   if(jobsStart < 0) return;
   int jobStart = StringFind(response, "{", jobsStart);
   if(jobStart < 0) return; // 空配列 []

   int jobEnd = StringFind(response, "}", jobStart);
   if(jobEnd < 0) return;

   string jobJson = StringSubstr(response, jobStart, jobEnd - jobStart + 1);

   // フィールド解析
   string jobId       = JsonGetStr(jobJson, "id");
   string symbol      = JsonGetStr(jobJson, "symbol");
   string tfStr       = JsonGetStr(jobJson, "timeframe");
   string mode        = JsonGetStr(jobJson, "mode");
   long   targetFromL = (long)JsonGetDbl(jobJson, "target_from");
   long   targetToL   = (long)JsonGetDbl(jobJson, "target_to");

   // 基本バリデーション
   if(StringLen(jobId) == 0 || StringLen(symbol) == 0 || StringLen(tfStr) == 0)
   {
      Print("[DataSync] malformed job JSON: ", jobJson);
      return;
   }
   if(symbol != g_Symbol)
   {
      Print("[DataSync] job symbol mismatch: got=", symbol, " own=", g_Symbol, " skipping");
      return;
   }
   if(mode != "FORWARD" && mode != "BACKFILL")
   {
      Print("[DataSync] unknown mode=", mode, " job=", jobId);
      return;
   }

   // TF 文字列 → ENUM
   ENUM_TIMEFRAMES tf = TF_FromString(tfStr);
   if(tf == PERIOD_CURRENT)
   {
      Print("[DataSync] unsupported timeframe=", tfStr, " job=", jobId);
      DataSync_SendProgress(jobId, "FAILED", 0, 0, 0, 0, 0, 0,
         "Unsupported timeframe: " + tfStr);
      return;
   }

   datetime targetFrom = (datetime)targetFromL;
   datetime targetTo   = (datetime)targetToL; // FORWARD では 0 が渡される

   // 実行
   DataSync_Execute(jobId, symbol, tf, tfStr, mode, targetFrom, targetTo);
}

//+------------------------------------------------------------------+
