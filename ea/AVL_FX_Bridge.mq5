//+------------------------------------------------------------------+
//|                                               AVL_FX_Bridge.mq5 |
//|                             AVL FX — MT5 Bridge EA v4.0         |
//|                                                                  |
//| 役割: DATA BRIDGE + EXECUTION BRIDGE（1ファイル）               |
//|                                                                  |
//| 設計原則                                                         |
//|   MT5 を唯一のデータソース（Single Source of Truth）とする       |
//|   EA は分析しない。MT5 の情報をそのまま送信するだけ。            |
//|   Strategy Logic は絶対にここに入れない。                        |
//|                                                                  |
//| ストリーム構成                                                   |
//|   Stream 1: Tick      — OnTick() 毎（スロットリング付き）        |
//|   Stream 2: OHLC Bars — OnTick() + OnTimer() 毎                 |
//|   Stream 3: Positions — OnTimer() 毎（全シンボル）               |
//|   Stream 4: Account   — OnTimer() 毎 + Heartbeatに含める         |
//|   Stream 5: Deals     — OnTimer() 毎（取引履歴）                 |
//|   Stream 6: Indicators — OnTimer() 毎（AI基盤）                  |
//|   Stream 7: Commands  — OnTimer() ポーリング（実行コマンド）      |
//|                                                                  |
//| 認証                                                             |
//|   Authorization: Bearer {InpServerSecret}   (Gateway global)    |
//|   X-Connection-Id:    {InpConnectionId}     (per-user)          |
//|   X-Connection-Token: {InpConnectionToken}  (per-user, secret)  |
//|                                                                  |
//| WebRequest許可リスト（MT5設定必須）                              |
//|   ツール → オプション → EA → WebRequest許可 → Gateway URLを追加  |
//+------------------------------------------------------------------+
#property copyright "AVL FX"
#property version   "4.00"
#include <Trade/Trade.mqh>
CTrade g_Trade;

#define BRIDGE_VERSION "4.0"

//--- 接続設定（MT5接続ページからコピー）
sinput group "=== AVL Gateway 接続設定 ==="
input string InpServerURL       = "https://remarkable-cooperation-production-7341.up.railway.app"; // Gateway URL
input string InpConnectionId    = "";   // Connection ID（/mt5ページからコピー）
input string InpConnectionToken = "";   // Connection Token（/mt5ページで発行、一度のみ表示）

//--- Tick Stream
sinput group "=== Tick Stream ==="
input bool InpTickEnabled    = true;   // Tick送信を有効にする
input int  InpTickThrottleMs = 100;    // 最小送信間隔（ms）

//--- OHLC Stream
sinput group "=== OHLC Stream ==="
input bool InpOHLCEnabled  = true;   // OHLC送信を有効にする
input int  InpOHLCHistory  = 500;    // 起動時に送信する過去バー数

//--- Position / Account Stream
sinput group "=== Account / Position / Deal Stream ==="
input bool InpPositionEnabled = true;  // Position送信を有効にする
input bool InpAccountEnabled  = true;  // Account送信を有効にする
input bool InpDealEnabled     = true;  // Deal（取引履歴）送信を有効にする
input int  InpTimerSec        = 5;     // 更新間隔（秒）
input int  InpDealDays        = 30;    // 取得する取引履歴の日数

//--- Execution
sinput group "=== Execution Command ==="
input bool InpCommandEnabled = true;  // 実行コマンドのポーリングを有効にする

//--- Indicator Stream
sinput group "=== Indicator Stream（AI基盤）==="
input bool InpIndicatorEnabled = true;  // Indicator送信を有効にする
input int  InpIndicatorSec     = 30;    // 送信間隔（秒）

//--- 全時間足
ENUM_TIMEFRAMES g_TfList[] = {
   PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
   PERIOD_H1, PERIOD_H4, PERIOD_D1,  PERIOD_W1
};

//--- グローバル変数
string   g_Symbol;
long     g_LastTickMs        = 0;
datetime g_LastBulkSent      = 0;
datetime g_LastBarTimes[8];
datetime g_LastIndicatorSent = 0;
datetime g_LastDealSent      = 0;

#define BULK_RESEND_SEC 600

//+------------------------------------------------------------------+
//| 初期化                                                           |
//+------------------------------------------------------------------+
int OnInit()
{
   g_Symbol = Symbol();
   ArrayInitialize(g_LastBarTimes, 0);

   if(StringLen(InpServerURL) == 0 || StringLen(InpConnectionId) == 0 || StringLen(InpConnectionToken) == 0)
   {
      Alert("AVL Bridge: 以下の3つを設定してください:\n1. Gateway URL\n2. Connection ID\n3. Connection Token\n\navl-fx.vercel.app/mt5 からコピーできます");
      Print("=== セットアップ手順 ===");
      Print("1. avl-fx.vercel.app/mt5 にログイン");
      Print("2. 「接続情報を発行する」を押してConnection ID / Tokenを取得");
      Print("3. ツール → オプション → EA → WebRequest許可リストに Gateway URL を追加:");
      Print("   ", InpServerURL);
      Print("4. EA設定画面にGateway URL / Connection ID / Connection Tokenを入力");
      return INIT_PARAMETERS_INCORRECT;
   }

   // 接続通知（Heartbeat兼用）
   if(!BridgeHeartbeat_Send())
   {
      Print("AVL Bridge: Gateway接続失敗");
      Print("URL: ", InpServerURL);
      Print("WebRequestのURL許可リストを確認してください: ", InpServerURL);
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

   // 起動時に取引履歴を即時送信
   if(InpDealEnabled)
   {
      DealStream_Send();
      g_LastDealSent = TimeCurrent();
   }

   EventSetTimer(InpTimerSec);

   Print("==============================================");
   Print("  AVL Bridge v", BRIDGE_VERSION, " 起動");
   Print("  Symbol      : ", g_Symbol);
   Print("  Gateway     : ", InpServerURL);
   Print("  ConnectionId: ", StringSubstr(InpConnectionId, 0, 8), "...");
   Print("==============================================");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| 終了処理                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   BridgeDisconnect_Send();
   Print("AVL Bridge 停止 (reason=", reason, ")");
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

   if(InpTickEnabled)    TickStream_Send(tick);
   if(InpOHLCEnabled)    OHLCStream_OnTick();
}

//+------------------------------------------------------------------+
//| OnTimer                                                          |
//+------------------------------------------------------------------+
void OnTimer()
{
   BridgeHeartbeat_Send();

   if(InpPositionEnabled) PositionStream_Send();
   if(InpAccountEnabled)  AccountStream_Send();
   if(InpCommandEnabled)  CommandStream_Poll();

   // OHLC Bulk定期再送
   if(InpOHLCEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastBulkSent == 0 || (now - g_LastBulkSent) >= BULK_RESEND_SEC)
      {
         OHLCStream_SendBulk();
         g_LastBulkSent = now;
      }
   }

   // Indicator定期送信
   if(InpIndicatorEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastIndicatorSent == 0 || (now - g_LastIndicatorSent) >= InpIndicatorSec)
      {
         IndicatorStream_Send();
         g_LastIndicatorSent = now;
      }
   }

   // Deal定期送信（5分ごと）
   if(InpDealEnabled)
   {
      datetime now = TimeCurrent();
      if(g_LastDealSent == 0 || (now - g_LastDealSent) >= 300)
      {
         DealStream_Send();
         g_LastDealSent = now;
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
      "{\"symbol\":\"%s\","
      "\"bid\":%.5f,"
      "\"ask\":%.5f,"
      "\"spread\":%.2f,"
      "\"digits\":%d,"
      "\"time\":%I64d}",
      g_Symbol,
      tick.bid, tick.ask, spread, digits,
      (long)TimeCurrent()
   );
   Bridge_Post("/bridge/ticks", body);
}

//=================================================================//
//  Stream 2: OHLC Stream                                         //
//=================================================================//

void OHLCStream_OnTick()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++)
   {
      ENUM_TIMEFRAMES tf  = g_TfList[i];
      datetime curTime    = iTime(g_Symbol, tf, 0);
      if(curTime == 0) continue;

      if(g_LastBarTimes[i] != 0 && curTime > g_LastBarTimes[i])
         OHLCStream_SendBar(tf, 1); // 確定バー

      g_LastBarTimes[i] = curTime;
      OHLCStream_SendBar(tf, 0);   // 現在バー
   }
}

void OHLCStream_SendBar(ENUM_TIMEFRAMES tf, int shift)
{
   MqlRates rates[];
   if(CopyRates(g_Symbol, tf, shift, 1, rates) <= 0) return;

   string body = StringFormat(
      "{\"symbol\":\"%s\","
      "\"timeframe\":\"%s\","
      "\"time\":%I64d,"
      "\"open\":%.5f,"
      "\"high\":%.5f,"
      "\"low\":%.5f,"
      "\"close\":%.5f,"
      "\"volume\":%d}",
      g_Symbol, TF_ToString(tf),
      (long)rates[0].time,
      rates[0].open, rates[0].high,
      rates[0].low, rates[0].close,
      (long)rates[0].tick_volume
   );
   Bridge_Post("/bridge/bars", body);
}

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
         "{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bars\":[%s]}",
         g_Symbol, TF_ToString(tf), barsJson
      );
      Bridge_Post("/bridge/bars/bulk", body);
      Print("OHLC Bulk: ", g_Symbol, ":", TF_ToString(tf), " ", n, "本");
      Sleep(30);
   }
}

//=================================================================//
//  Stream 3: Position Stream（全シンボル）                        //
//=================================================================//

void PositionStream_Send()
{
   string posArr = "";
   int    count  = 0;

   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      string sym = PositionGetString(POSITION_SYMBOL);

      if(count > 0) posArr += ",";
      posArr += StringFormat(
         "{\"positionTicket\":%I64d,"
         "\"symbol\":\"%s\","
         "\"direction\":\"%s\","
         "\"volume\":%.2f,"
         "\"openPrice\":%.5f,"
         "\"currentPrice\":%.5f,"
         "\"stopLoss\":%.5f,"
         "\"takeProfit\":%.5f,"
         "\"unrealizedPnl\":%.2f,"
         "\"commission\":%.2f,"
         "\"swap\":%.2f,"
         "\"magicNumber\":%I64d,"
         "\"openedAt\":%I64d}",
         (long)ticket,
         sym,
         (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY" : "SELL",
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_PRICE_CURRENT),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         PositionGetDouble(POSITION_COMMISSION),
         PositionGetDouble(POSITION_SWAP),
         (long)PositionGetInteger(POSITION_MAGIC),
         (long)PositionGetInteger(POSITION_TIME)
      );
      count++;
   }

   string body = StringFormat("{\"positions\":[%s]}", posArr);
   Bridge_Post("/bridge/positions", body);
}

//=================================================================//
//  Stream 4: Account Stream                                       //
//=================================================================//

void AccountStream_Send()
{
   string body = StringFormat(
      "{\"login\":%I64d,"
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
   Bridge_Post("/bridge/account", body);
}

//=================================================================//
//  Stream 5: Deal Stream（取引履歴）                              //
//=================================================================//

void DealStream_Send()
{
   datetime from = TimeCurrent() - (datetime)(InpDealDays * 86400);
   if(!HistorySelect(from, TimeCurrent())) return;

   int total = HistoryDealsTotal();
   if(total <= 0) return;

   string dealsJson = "";
   int    count     = 0;

   for(int i = total - 1; i >= 0 && count < 100; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket <= 0) continue;

      long dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dealType == DEAL_TYPE_BALANCE) continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      string entryStr = "";
      if(entry == DEAL_ENTRY_IN)         entryStr = "IN";
      else if(entry == DEAL_ENTRY_OUT)   entryStr = "OUT";
      else if(entry == DEAL_ENTRY_INOUT) entryStr = "INOUT";
      else continue;

      if(count > 0) dealsJson += ",";
      dealsJson += StringFormat(
         "{\"dealTicket\":%I64d,"
         "\"symbol\":\"%s\","
         "\"dealType\":\"%s\","
         "\"entryType\":\"%s\","
         "\"volume\":%.2f,"
         "\"price\":%.5f,"
         "\"profit\":%.2f,"
         "\"commission\":%.2f,"
         "\"swap\":%.2f,"
         "\"dealTime\":%I64d,"
         "\"magicNumber\":%I64d}",
         (long)ticket,
         HistoryDealGetString(ticket, DEAL_SYMBOL),
         (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL",
         entryStr,
         HistoryDealGetDouble(ticket, DEAL_VOLUME),
         HistoryDealGetDouble(ticket, DEAL_PRICE),
         HistoryDealGetDouble(ticket, DEAL_PROFIT),
         HistoryDealGetDouble(ticket, DEAL_COMMISSION),
         HistoryDealGetDouble(ticket, DEAL_SWAP),
         (long)HistoryDealGetInteger(ticket, DEAL_TIME),
         (long)HistoryDealGetInteger(ticket, DEAL_MAGIC)
      );
      count++;
   }

   if(count == 0) return;

   string body = StringFormat("{\"deals\":[%s]}", dealsJson);
   Bridge_Post("/bridge/deals", body);
   Print("Deal Stream: ", count, "件");
}

//=================================================================//
//  Stream 7: Command Execution（実行コマンドポーリング）          //
//=================================================================//

void CommandStream_Poll()
{
   char   req[], res[];
   string headers = Bridge_Headers();
   string resHdr;

   int code = WebRequest(
      "GET",
      InpServerURL + "/execution-commands/pending",
      headers, 5000, req, res, resHdr
   );
   if(code != 200 || ArraySize(res) == 0) return;

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return;

   Print("[Command] 受信: ", response);

   // JSON配列内の各オブジェクトを処理
   int pos = 0;
   while(true)
   {
      int start = StringFind(response, "{", pos);
      if(start < 0) break;
      int depth = 0;
      int end   = start;
      for(int i = start; i < StringLen(response); i++)
      {
         string c = StringSubstr(response, i, 1);
         if(c == "{") depth++;
         else if(c == "}") { depth--; if(depth == 0) { end = i; break; } }
      }
      string obj = StringSubstr(response, start, end - start + 1);
      pos = end + 1;

      string commandId = JsonGetStr(obj, "id");
      string action    = JsonGetStr(obj, "action");
      string sym       = JsonGetStr(obj, "symbol");
      double volume    = JsonGetDbl(obj, "volume");
      double sl        = JsonGetDbl(obj, "stopLoss");
      double tp        = JsonGetDbl(obj, "takeProfit");
      long   magic     = (long)JsonGetDbl(obj, "magicNumber");
      long   posTicket = (long)JsonGetDbl(obj, "positionTicket");

      if(commandId == "" || action == "") continue;

      // Claim
      Command_Claim(commandId);

      g_Trade.SetExpertMagicNumber((ulong)magic);
      g_Trade.SetDeviationInPoints(30);

      bool   ok     = false;
      string status = "REJECTED";
      long   dealTkt = 0;
      long   posTkt  = 0;

      if(action == "BUY" && sym != "" && volume > 0)
      {
         ok = g_Trade.Buy(volume, sym, 0, sl, tp, "AVL");
         if(ok) { dealTkt = (long)g_Trade.ResultDeal(); posTkt = (long)g_Trade.ResultOrder(); status = "FILLED"; }
         else     status = "REJECTED";
      }
      else if(action == "SELL" && sym != "" && volume > 0)
      {
         ok = g_Trade.Sell(volume, sym, 0, sl, tp, "AVL");
         if(ok) { dealTkt = (long)g_Trade.ResultDeal(); posTkt = (long)g_Trade.ResultOrder(); status = "FILLED"; }
         else     status = "REJECTED";
      }
      else if(action == "CLOSE" && posTicket > 0)
      {
         ok = g_Trade.PositionClose((ulong)posTicket, 30);
         if(ok) { dealTkt = (long)g_Trade.ResultDeal(); status = "FILLED"; }
         else     status = "REJECTED";
      }
      else if(action == "MODIFY_SL" && posTicket > 0)
      {
         if(PositionSelectByTicket((ulong)posTicket))
         {
            double curSL = PositionGetDouble(POSITION_SL);
            double curTP = PositionGetDouble(POSITION_TP);
            ok = g_Trade.PositionModify((ulong)posTicket, (sl > 0 ? sl : curSL), (tp > 0 ? tp : curTP));
            status = ok ? "FILLED" : "REJECTED";
         }
      }
      else if(action == "MODIFY_TP" && posTicket > 0)
      {
         if(PositionSelectByTicket((ulong)posTicket))
         {
            double curSL = PositionGetDouble(POSITION_SL);
            double curTP = PositionGetDouble(POSITION_TP);
            ok = g_Trade.PositionModify((ulong)posTicket, (sl > 0 ? sl : curSL), (tp > 0 ? tp : curTP));
            status = ok ? "FILLED" : "REJECTED";
         }
      }

      Print("[Command] ", action, " ", sym, " vol=", volume,
            " → ", ok ? "成功" : "失敗",
            " retcode=", (int)g_Trade.ResultRetcode());

      Command_Result(commandId, ok, status,
                     (int)g_Trade.ResultRetcode(),
                     dealTkt, posTkt,
                     g_Trade.ResultPrice(), volume);
   }
}

void Command_Claim(const string commandId)
{
   char req[], res[];
   string resHdr;
   string body = "{}";
   char bodyArr[];
   StringToCharArray(body, bodyArr, 0, StringLen(body));

   WebRequest(
      "POST",
      InpServerURL + "/execution-commands/" + commandId + "/claim",
      Bridge_Headers(), 5000,
      bodyArr, res, resHdr
   );
}

void Command_Result(const string commandId,
                    bool success, const string status,
                    int retcode, long dealTicket, long posTicket,
                    double execPrice, double execVolume)
{
   string body = StringFormat(
      "{\"success\":%s,"
      "\"status\":\"%s\","
      "\"retcode\":%d,"
      "\"dealTicket\":%I64d,"
      "\"positionTicket\":%I64d,"
      "\"executionPrice\":%.5f,"
      "\"executedVolume\":%.2f,"
      "\"errorCode\":%d,"
      "\"errorMessage\":\"%s\"}",
      success ? "true" : "false",
      status,
      retcode,
      dealTicket,
      posTicket,
      execPrice,
      execVolume,
      GetLastError(),
      success ? "" : g_Trade.ResultComment()
   );

   char bodyArr[], res[];
   string resHdr;
   StringToCharArray(body, bodyArr, 0, StringLen(body));

   WebRequest(
      "POST",
      InpServerURL + "/execution-commands/" + commandId + "/result",
      Bridge_Headers(), 5000,
      bodyArr, res, resHdr
   );
}

//=================================================================//
//  Heartbeat / Disconnect                                         //
//=================================================================//

bool BridgeHeartbeat_Send()
{
   long   accountType = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string accTypeStr  = (accountType == ACCOUNT_TRADE_MODE_REAL) ? "REAL" : "DEMO";
   long   accMode     = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   string accModeStr  = (accMode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) ? "HEDGING" : "NETTING";
   bool   tradeOk     = (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);

   string body = StringFormat(
      "{\"bridgeVersion\":\"%s\","
      "\"mt5Login\":%I64d,"
      "\"broker\":\"%s\","
      "\"accountType\":\"%s\","
      "\"accountMode\":\"%s\","
      "\"tradeAllowed\":%s,"
      "\"balance\":%.2f,"
      "\"equity\":%.2f,"
      "\"margin\":%.2f,"
      "\"freeMargin\":%.2f,"
      "\"leverage\":%d}",
      BRIDGE_VERSION,
      (long)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      accTypeStr,
      accModeStr,
      tradeOk ? "true" : "false",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE)
   );

   int code = Bridge_Post("/bridge/heartbeat", body);
   return (code == 200 || code == 201);
}

void BridgeDisconnect_Send()
{
   string body = "{\"reason\":\"EA_DEINIT\"}";
   Bridge_Post("/bridge/disconnect", body);
}

//=================================================================//
//  Indicator Stream（AI基盤）                                     //
//=================================================================//

void IndicatorStream_Send()
{
   int    digits = (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(g_Symbol, SYMBOL_POINT);
   MqlTick tick;
   double spread = 0.0;
   if(SymbolInfoTick(g_Symbol, tick) && point > 0)
   {
      double rawPts = (tick.ask - tick.bid) / point;
      spread = (digits == 5 || digits == 3) ? rawPts / 10.0 : rawPts;
   }

   ENUM_TIMEFRAMES aiTfs[]    = { PERIOD_H4, PERIOD_H1, PERIOD_M15, PERIOD_M5 };
   string          aiTfNames[] = { "H4",     "H1",      "M15",      "M5"      };

   string tfJson = "";
   for(int i = 0; i < 4; i++)
   {
      double ema21 = 0.0, ema200 = 0.0, atr14 = 0.0;

      int h21 = iMA(g_Symbol, aiTfs[i], 21, 0, MODE_EMA, PRICE_CLOSE);
      if(h21 != INVALID_HANDLE)
      {
         double buf[]; ArraySetAsSeries(buf, true);
         if(CopyBuffer(h21, 0, 1, 1, buf) > 0) ema21 = buf[0];
         IndicatorRelease(h21);
      }
      int h200 = iMA(g_Symbol, aiTfs[i], 200, 0, MODE_EMA, PRICE_CLOSE);
      if(h200 != INVALID_HANDLE)
      {
         double buf[]; ArraySetAsSeries(buf, true);
         if(CopyBuffer(h200, 0, 1, 1, buf) > 0) ema200 = buf[0];
         IndicatorRelease(h200);
      }
      int hATR = iATR(g_Symbol, aiTfs[i], 14);
      if(hATR != INVALID_HANDLE)
      {
         double buf[]; ArraySetAsSeries(buf, true);
         if(CopyBuffer(hATR, 0, 1, 1, buf) > 0) atr14 = buf[0];
         IndicatorRelease(hATR);
      }

      if(i > 0) tfJson += ",";
      tfJson += StringFormat(
         "\"%s\":{\"ema21\":%.5f,\"ema200\":%.5f,\"atr\":%.5f}",
         aiTfNames[i], ema21, ema200, atr14
      );
   }

   string body = StringFormat(
      "{\"symbol\":\"%s\","
      "\"spread\":%.2f,"
      "\"digits\":%d,"
      "\"brokerTime\":%I64d,"
      "\"timeframes\":{%s}}",
      g_Symbol, spread, digits, (long)TimeCurrent(), tfJson
   );
   Bridge_Post("/indicators", body);
}

//=================================================================//
//  HTTP通信ユーティリティ                                         //
//=================================================================//

string Bridge_Headers()
{
   // Gateway SecretはUserへ公開しない — Connection Token認証のみ使用
   return
      "Content-Type: application/json\r\n"
      "X-Connection-Id: "    + InpConnectionId    + "\r\n"
      "X-Connection-Token: " + InpConnectionToken + "\r\n";
}

int Bridge_Post(const string path, const string body)
{
   char reqData[], resData[];
   string resHdr;
   StringToCharArray(body, reqData, 0, StringLen(body));

   int code = WebRequest(
      "POST",
      InpServerURL + path,
      Bridge_Headers(), 5000,
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
            Alert("WebRequest未許可！\nMT5 → ツール → オプション → EA → WebRequest許可リストに追加:\n" + InpServerURL);
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
//  JSON 簡易パーサー                                              //
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
