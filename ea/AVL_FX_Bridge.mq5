//+------------------------------------------------------------------+
//|                                               AVL_FX_Bridge.mq5 |
//|                             AVL FX — MT5 Data Bridge EA v3.11   |
//|                                                                  |
//| 設計原則                                                         |
//|   MT5 を唯一のデータソース（Single Source of Truth）とする       |
//|   EA は分析しない。MT5 の情報をそのまま送信するだけ。            |
//|                                                                  |
//| ストリーム構成                                                   |
//|   Stream 1: Tick  Stream  — OnTick() 毎に送信（スロットリング）  |
//|   Stream 2: OHLC  Stream  — OnTick() 毎に現在バー送信           |
//|   Stream 3: Position Stream — OnTimer() 毎に送信                |
//|   Stream 4: Account  Stream — OnTimer() 毎に送信                |
//|   Stream 5: Order  Stream   — OnTimer() ポーリング（Phase4）    |
//|   Stream 6: Indicator Stream — OnTimer() 毎に送信（AI基盤）     |
//|             EMA21 / EMA200 / ATR14 × H4,H1,M15,M5              |
//+------------------------------------------------------------------+
#property copyright "AVL FX"
#property version   "3.11"
#include <Trade/Trade.mqh>
CTrade g_Trade;

//--- 入力パラメーター
sinput group "=== AVL Market Server 接続設定 ==="
input string InpServerURL    = "http://127.0.0.1:8080"; // Market Server URL
input string InpServerSecret = "";                       // 認証シークレット

sinput group "=== Tick Stream 設定 ==="
input bool InpTickEnabled    = true;   // Tick ストリームを有効にする
input int  InpTickThrottleMs = 100;    // 最小送信間隔（ms）

sinput group "=== OHLC Stream 設定 ==="
input bool InpOHLCEnabled    = true;   // OHLC ストリームを有効にする
input int  InpOHLCHistory    = 500;    // 起動時に送信する過去バー数

sinput group "=== Position / Account Stream 設定 ==="
input bool InpPositionEnabled = true;  // Position ストリームを有効にする
input bool InpAccountEnabled  = true;  // Account ストリームを有効にする
input int  InpTimerSec        = 5;     // 更新間隔（秒）

sinput group "=== Order Stream 設定（Phase4）==="
input bool InpOrderEnabled    = true;  // Order ストリームを有効にする

sinput group "=== Indicator Stream 設定（AI基盤）==="
input bool InpIndicatorEnabled = true;  // Indicator ストリームを有効にする
input int  InpIndicatorSec     = 30;    // 送信間隔（秒）

sinput group "=== History Stream 設定（取引履歴）==="
input bool InpHistoryEnabled   = true;  // History ストリームを有効にする
input int  InpHistoryDays      = 30;    // 取得する過去日数
input int  InpHistorySec       = 300;   // 送信間隔（秒）

//--- 全対象時間足
ENUM_TIMEFRAMES g_TfList[] = {
   PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
   PERIOD_H1, PERIOD_H4, PERIOD_D1,  PERIOD_W1
};

//--- グローバル変数
string   g_Symbol;
long     g_LastTickMs        = 0;
datetime g_LastBulkSent      = 0;
datetime g_LastBarTimes[8];
datetime g_LastIndicatorSent = 0; // インジケーター最終送信時刻
datetime g_LastHistorySent   = 0; // 履歴最終送信時刻

#define BULK_RESEND_SEC 600

//+------------------------------------------------------------------+
//| 初期化                                                           |
//+------------------------------------------------------------------+
int OnInit()
{
   g_Symbol = Symbol();
   ArrayInitialize(g_LastBarTimes, 0);

   if(StringLen(InpServerURL) == 0)
   {
      Alert("AVL Bridge: InpServerURL を設定してください");
      return INIT_PARAMETERS_INCORRECT;
   }

   // 接続通知
   if(!Connect_Send())
   {
      Print("=========================================");
      Print("  AVL Bridge: Market Server への接続失敗");
      Print("  URL: ", InpServerURL);
      Print("  → cd gateway && npm run dev を実行してください");
      Print("  → WebRequest 許可リストに追加: ", InpServerURL);
      Print("=========================================");
      return INIT_FAILED;
   }

   // 起動時に過去バーを一括送信
   if(InpOHLCEnabled)
   {
      OHLCStream_SendBulk();
      g_LastBulkSent = TimeCurrent();
   }

   // 起動時にインジケーターを即時送信
   if(InpIndicatorEnabled)
   {
      IndicatorStream_Send();
      g_LastIndicatorSent = TimeCurrent();
   }

   // 起動時に履歴を即時送信
   if(InpHistoryEnabled)
   {
      HistoryStream_Send();
      g_LastHistorySent = TimeCurrent();
   }

   EventSetTimer(InpTimerSec);

   Print("AVL Bridge v3.10 起動 | Symbol=", g_Symbol, " | Server=", InpServerURL);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| 終了処理                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   string body = "{\"type\":\"DISCONNECT\",\"symbol\":\"" + g_Symbol + "\"}";
   HTTP_Post("/event", body);
   Print("AVL Bridge 停止 (reason=", reason, ")");
}

//+------------------------------------------------------------------+
//| OnTick — Tick Stream + OHLC Stream                              |
//+------------------------------------------------------------------+
void OnTick()
{
   MqlTick tick;
   if(!SymbolInfoTick(g_Symbol, tick)) return;

   // スロットリング
   if((tick.time_msc - g_LastTickMs) < InpTickThrottleMs) return;
   g_LastTickMs = tick.time_msc;

   // Stream 1: Tick
   if(InpTickEnabled)
      TickStream_Send(tick);

   // Stream 2: OHLC
   if(InpOHLCEnabled)
      OHLCStream_OnTick();
}

//+------------------------------------------------------------------+
//| OnTimer — Position Stream + Account Stream + Order Stream       |
//+------------------------------------------------------------------+
void OnTimer()
{
   Heartbeat_Send();

   if(InpPositionEnabled) PositionStream_Send();
   if(InpAccountEnabled)  AccountStream_Send();
   if(InpOrderEnabled)    OrderStream_Poll();

   // 過去バーを定期的に再送
   if(InpOHLCEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastBulkSent == 0 || (now - g_LastBulkSent) >= BULK_RESEND_SEC)
      {
         OHLCStream_SendBulk();
         g_LastBulkSent = now;
         Print("OHLC Bulk 自動再送完了 (次回: ", BULK_RESEND_SEC / 60, "分後)");
      }
   }

   // インジケーターを定期送信（AI基盤）
   if(InpIndicatorEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastIndicatorSent == 0 || (now - g_LastIndicatorSent) >= InpIndicatorSec)
      {
         IndicatorStream_Send();
         g_LastIndicatorSent = now;
      }
   }

   // 取引履歴を定期送信
   if(InpHistoryEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastHistorySent == 0 || (now - g_LastHistorySent) >= InpHistorySec)
      {
         HistoryStream_Send();
         g_LastHistorySent = now;
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

   // 時刻: TimeCurrent()（秒）をそのまま使用。UTC変換禁止。
   string body = StringFormat(
      "{\"type\":\"TICK\","
      "\"symbol\":\"%s\","
      "\"bid\":%.5f,"
      "\"ask\":%.5f,"
      "\"spread\":%.2f,"
      "\"digits\":%d,"
      "\"time\":%I64d}",
      g_Symbol,
      tick.bid,
      tick.ask,
      spread,
      digits,
      (long)TimeCurrent()
   );
   HTTP_Post("/tick", body);
}

//=================================================================//
//  Stream 2: OHLC Stream                                         //
//=================================================================//

// 全時間足の現在バー（shift=0）を送信。新バー確定時は前バー（shift=1）も送信。
void OHLCStream_OnTick()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++)
   {
      ENUM_TIMEFRAMES tf = g_TfList[i];
      datetime curTime   = iTime(g_Symbol, tf, 0);
      if(curTime == 0) continue;

      // 新バー確定検出 → 前バー（shift=1）の確定OHLCを送信
      if(g_LastBarTimes[i] != 0 && curTime > g_LastBarTimes[i])
         OHLCStream_SendBar(tf, 1);

      g_LastBarTimes[i] = curTime;

      // 現在バー（shift=0）を送信
      OHLCStream_SendBar(tf, 0);
   }
}

// 1本のバーを送信
// 時刻: rates[0].time（秒）をそのまま使用。UTC変換禁止。
void OHLCStream_SendBar(ENUM_TIMEFRAMES tf, int shift)
{
   MqlRates rates[];
   if(CopyRates(g_Symbol, tf, shift, 1, rates) <= 0) return;

   string body = StringFormat(
      "{\"type\":\"BAR\","
      "\"symbol\":\"%s\","
      "\"timeframe\":\"%s\","
      "\"time\":%I64d,"
      "\"open\":%.5f,"
      "\"high\":%.5f,"
      "\"low\":%.5f,"
      "\"close\":%.5f,"
      "\"volume\":%d}",
      g_Symbol,
      TF_ToString(tf),
      (long)rates[0].time,
      rates[0].open,
      rates[0].high,
      rates[0].low,
      rates[0].close,
      (long)rates[0].tick_volume
   );
   HTTP_Post("/bar", body);
}

// 起動時の過去バー一括送信（チャート初期データ）
void OHLCStream_SendBulk()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++)
   {
      ENUM_TIMEFRAMES tf = g_TfList[i];
      MqlRates rates[];
      int n = CopyRates(g_Symbol, tf, 0, InpOHLCHistory, rates);
      if(n <= 0) continue;

      string barsJson = "";
      for(int j = 0; j < n; j++)
      {
         if(j > 0) barsJson += ",";
         // 時刻: rates[j].time（秒）をそのまま使用。加工禁止。
         barsJson += StringFormat(
            "{\"time\":%I64d,\"open\":%.5f,\"high\":%.5f,"
            "\"low\":%.5f,\"close\":%.5f,\"volume\":%d}",
            (long)rates[j].time,
            rates[j].open, rates[j].high,
            rates[j].low,  rates[j].close,
            (long)rates[j].tick_volume
         );
      }

      string body = StringFormat(
         "{\"type\":\"BARS\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bars\":[%s]}",
         g_Symbol, TF_ToString(tf), barsJson
      );
      HTTP_Post("/bars/bulk", body);
      Print("OHLC Bulk: ", g_Symbol, ":", TF_ToString(tf), " ", n, "本送信");
      Sleep(30);
   }
}

//=================================================================//
//  Stream 3: Position Stream                                      //
//=================================================================//

void PositionStream_Send()
{
   string posArr = "";
   int    count  = 0;

   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_Symbol) continue;

      if(count > 0) posArr += ",";
      posArr += StringFormat(
         "{\"ticket\":%d,"
         "\"type\":%d,"
         "\"volume\":%.2f,"
         "\"openPrice\":%.5f,"
         "\"currentPrice\":%.5f,"
         "\"sl\":%.5f,"
         "\"tp\":%.5f,"
         "\"profit\":%.2f,"
         "\"swap\":%.2f,"
         "\"openTime\":%d,"
         "\"magic\":%d}",
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
//  Stream 4: Account Stream                                       //
//=================================================================//

void AccountStream_Send()
{
   string body = StringFormat(
      "{\"type\":\"ACCOUNT\","
      "\"login\":%d,"
      "\"broker\":\"%s\","
      "\"currency\":\"%s\","
      "\"balance\":%.2f,"
      "\"equity\":%.2f,"
      "\"margin\":%.2f,"
      "\"freeMargin\":%.2f,"
      "\"marginLevel\":%.2f,"
      "\"leverage\":%d}",
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE)
   );
   HTTP_Post("/account", body);
}

//=================================================================//
//  Stream 5: Order Stream（Phase4）                              //
//=================================================================//

void OrderStream_Poll()
{
   char   req[], res[];
   string headers = "Authorization: Bearer " + InpServerSecret + "\r\n";
   string resHdr;

   int code = WebRequest(
      "GET",
      InpServerURL + "/orders/pending",
      headers, 5000, req, res, resHdr
   );
   if(code != 200 || ArraySize(res) == 0) return;

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return; // "[]" 空配列

   Print("[OrderStream] 指示受信: ", response);

   // 各 { ... } ブロックを順に処理
   int pos = 0;
   while(true)
   {
      int start = StringFind(response, "{", pos);
      if(start < 0) break;
      int end = StringFind(response, "}", start);
      if(end < 0) break;
      string obj = StringSubstr(response, start, end - start + 1);
      pos = end + 1;

      string orderId    = JsonGetStr(obj, "id");
      string direction  = JsonGetStr(obj, "direction");   // "BUY" or "SELL"
      string sym        = JsonGetStr(obj, "symbol");
      double volume     = JsonGetDbl(obj, "volume");
      double sl         = JsonGetDbl(obj, "sl");
      double tp         = JsonGetDbl(obj, "tp");
      long   magic      = (long)JsonGetDbl(obj, "magic");

      if(orderId == "" || direction == "" || sym == "" || volume <= 0) continue;

      // 自シンボル以外は対象外
      if(sym != g_Symbol && sym != "") { Print("[OrderStream] シンボル不一致: ", sym); continue; }

      g_Trade.SetExpertMagicNumber((ulong)magic);
      g_Trade.SetDeviationInPoints(30);

      bool ok = false;
      if(direction == "BUY")
         ok = g_Trade.Buy(volume, sym, 0, sl, tp, "AVL AI");
      else if(direction == "SELL")
         ok = g_Trade.Sell(volume, sym, 0, sl, tp, "AVL AI");

      Print("[OrderStream] ", direction, " ", sym, " vol=", volume,
            " sl=", sl, " tp=", tp, " → ", ok ? "成功" : "失敗");

      // 結果をGatewayに報告
      string resultBody = StringFormat(
         "{\"success\":%s,\"retcode\":%d,\"deal\":%I64d,\"comment\":\"%s\"}",
         ok ? "true" : "false",
         (int)g_Trade.ResultRetcode(),
         (long)g_Trade.ResultDeal(),
         ok ? "executed" : g_Trade.ResultComment()
      );
      HTTP_Post("/orders/" + orderId + "/result", resultBody);
   }
}

//=================================================================//
//  接続通知 / ハートビート                                        //
//=================================================================//

bool Connect_Send()
{
   string body = StringFormat(
      "{\"type\":\"CONNECT\","
      "\"symbol\":\"%s\","
      "\"digits\":%d,"
      "\"point\":%.7f,"
      "\"login\":%d,"
      "\"broker\":\"%s\","
      "\"version\":\"3.10\","
      "\"serverTime\":%I64d}",
      g_Symbol,
      (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS),
      SymbolInfoDouble(g_Symbol, SYMBOL_POINT),
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      (long)TimeCurrent()
   );

   int code = HTTP_Post("/connect", body);
   return (code == 200 || code == 201);
}

void Heartbeat_Send()
{
   string body = StringFormat(
      "{\"type\":\"HEARTBEAT\","
      "\"symbol\":\"%s\","
      "\"serverTime\":%I64d}",
      g_Symbol, (long)TimeCurrent()
   );
   HTTP_Post("/heartbeat", body);
}

//=================================================================//
//  Stream 6: Indicator Stream（AI基盤）                          //
//  EMA21 / EMA200 / ATR14 を H4,H1,M15,M5 で取得して送信        //
//=================================================================//

void IndicatorStream_Send()
{
   int    digits = (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(g_Symbol, SYMBOL_POINT);

   // Spread（点数→従来pips換算: 5桁通貨ペアは /10, 3桁は /1）
   MqlTick tick;
   double  spread = 0.0;
   if(SymbolInfoTick(g_Symbol, tick) && point > 0)
   {
      double rawPoints = (tick.ask - tick.bid) / point;
      // 5桁通貨ペア(digits==5 or 3) → 10点=1pips
      spread = (digits == 5 || digits == 3) ? rawPoints / 10.0 : rawPoints;
   }

   // 対象時間足（AI分析用: H4,H1,M15,M5）
   ENUM_TIMEFRAMES aiTfs[]    = { PERIOD_H4, PERIOD_H1, PERIOD_M15, PERIOD_M5 };
   string          aiTfNames[] = { "H4",     "H1",      "M15",      "M5"      };
   int tfCount = 4;

   // 各時間足のインジケーター値を取得して JSON 文字列に組み立て
   // MT5では iMA()/iATR() はハンドルを返す。実値は CopyBuffer() で取得。
   string tfJson = "";
   for(int i = 0; i < tfCount; i++)
   {
      ENUM_TIMEFRAMES tf    = aiTfs[i];
      string          tfStr = aiTfNames[i];

      double ema21  = 0.0;
      double ema200 = 0.0;
      double atr14  = 0.0;

      // EMA21 — 確定バー(shift=1)の値を取得
      int h21 = iMA(g_Symbol, tf, 21, 0, MODE_EMA, PRICE_CLOSE);
      if(h21 != INVALID_HANDLE)
      {
         double buf[];
         ArraySetAsSeries(buf, true);
         if(CopyBuffer(h21, 0, 1, 1, buf) > 0) ema21 = buf[0];
         IndicatorRelease(h21);
      }

      // EMA200
      int h200 = iMA(g_Symbol, tf, 200, 0, MODE_EMA, PRICE_CLOSE);
      if(h200 != INVALID_HANDLE)
      {
         double buf[];
         ArraySetAsSeries(buf, true);
         if(CopyBuffer(h200, 0, 1, 1, buf) > 0) ema200 = buf[0];
         IndicatorRelease(h200);
      }

      // ATR14
      int hATR = iATR(g_Symbol, tf, 14);
      if(hATR != INVALID_HANDLE)
      {
         double buf[];
         ArraySetAsSeries(buf, true);
         if(CopyBuffer(hATR, 0, 1, 1, buf) > 0) atr14 = buf[0];
         IndicatorRelease(hATR);
      }

      if(i > 0) tfJson += ",";
      tfJson += StringFormat(
         "\"%s\":{\"ema21\":%.5f,\"ema200\":%.5f,\"atr\":%.5f}",
         tfStr, ema21, ema200, atr14
      );
   }

   string body = StringFormat(
      "{\"type\":\"INDICATORS\","
      "\"symbol\":\"%s\","
      "\"spread\":%.2f,"
      "\"digits\":%d,"
      "\"brokerTime\":%I64d,"
      "\"timeframes\":{%s}}",
      g_Symbol,
      spread,
      digits,
      (long)TimeCurrent(),
      tfJson
   );

   HTTP_Post("/indicators", body);
}

//=================================================================//
//  Stream 7: History Stream（取引履歴）                          //
//  HistorySelect → 決済（OUT）Deal を送信                        //
//  注意: DEAL_ENTRY_OUT のみ対象（決済ごとに1件）                //
//=================================================================//

void HistoryStream_Send()
{
   datetime from = TimeCurrent() - (datetime)(InpHistoryDays * 86400);
   if(!HistorySelect(from, TimeCurrent())) return;

   int total = HistoryDealsTotal();
   if(total <= 0) return;

   string dealsJson = "";
   int    count     = 0;

   // 新しい順に最大100件取得
   for(int i = total - 1; i >= 0 && count < 100; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket <= 0) continue;

      // このシンボルのみ
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != g_Symbol) continue;

      // バランス（入金/出金）は除外
      long dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dealType == DEAL_TYPE_BALANCE) continue;

      // 決済(OUT)または両建て(INOUT)のみ送信
      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT) continue;

      double profit     = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double swap       = HistoryDealGetDouble(ticket, DEAL_SWAP);
      double commission = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      double price      = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double volume     = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      long   closeTime  = (long)HistoryDealGetInteger(ticket, DEAL_TIME);
      long   magic      = (long)HistoryDealGetInteger(ticket, DEAL_MAGIC);

      if(count > 0) dealsJson += ",";
      dealsJson += StringFormat(
         "{\"ticket\":%I64d,"
         "\"type\":%d,"
         "\"volume\":%.2f,"
         "\"closeTime\":%I64d,"
         "\"closePrice\":%.5f,"
         "\"profit\":%.2f,"
         "\"swap\":%.2f,"
         "\"commission\":%.2f,"
         "\"magic\":%I64d}",
         ticket,
         (int)dealType,
         volume,
         closeTime,
         price,
         profit,
         swap,
         commission,
         magic
      );
      count++;
   }

   if(count == 0) return;

   string body = StringFormat(
      "{\"type\":\"HISTORY\","
      "\"symbol\":\"%s\","
      "\"days\":%d,"
      "\"total\":%d,"
      "\"deals\":[%s]}",
      g_Symbol, InpHistoryDays, count, dealsJson
   );

   HTTP_Post("/history/bulk", body);
   Print("History Stream: ", count, "件送信 (過去", InpHistoryDays, "日)");
}

//=================================================================//
//  HTTP POST ユーティリティ                                       //
//=================================================================//

int HTTP_Post(const string path, const string body)
{
   string headers =
      "Content-Type: application/json\r\n"
      "Authorization: Bearer " + InpServerSecret + "\r\n";

   char reqData[], resData[];
   string resHdr;
   StringToCharArray(body, reqData, 0, StringLen(body));

   int code = WebRequest(
      "POST",
      InpServerURL + path,
      headers, 5000,
      reqData, resData, resHdr
   );

   if(code < 0)
   {
      int err = GetLastError();
      if(err == 4014)
      {
         static bool alerted = false;
         if(!alerted)
         {
            Print("!!! WebRequest 未許可 !!!");
            Print("MT5 → ツール → オプション → EA → WebRequest許可リストに追加:");
            Print("  ", InpServerURL);
            alerted = true;
         }
      }
   }
   return code;
}

//=================================================================//
//  時間足 → 文字列                                               //
//=================================================================//

string TF_ToString(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
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

//=================================================================//
//  JSON 簡易パーサー（文字列・数値フィールド取得）                //
//=================================================================//

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
   // skip spaces
   while(s < StringLen(json) && StringSubstr(json,s,1)==" ") s++;
   string num = "";
   for(int i=s; i<StringLen(json); i++)
   {
      string c = StringSubstr(json,i,1);
      if(c==","||c=="}"||c=="]"||c==" ") break;
      num += c;
   }
   return StringToDouble(num);
}
//+------------------------------------------------------------------+
