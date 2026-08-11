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
input int  InpOHLCHistory    = 500;

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

#define BULK_RESEND_SEC 600

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

   if(InpOHLCEnabled)       { OHLCStream_SendBulk(); g_LastBulkSent = TimeCurrent(); }
   if(InpIndicatorEnabled)  { IndicatorStream_Send(); g_LastIndicatorSent = TimeCurrent(); }
   if(InpHistoryEnabled)    { HistoryStream_Send();   g_LastHistorySent = TimeCurrent(); }
   if(InpMWEnabled)         { MarketWatch_Send();     g_LastMWSent = TimeCurrent(); }

   EventSetMillisecondTimer(InpTimerMs);
   Print("AVL DataManager v4.0 起動 | Symbol=", g_Symbol);
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
      Print("OHLC Bulk: ", g_Symbol, ":", TF_ToString(tf), " ", n, "本");
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
//+------------------------------------------------------------------+
