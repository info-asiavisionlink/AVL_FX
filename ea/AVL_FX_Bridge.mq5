//+------------------------------------------------------------------+
//|                                         AVL_FX_Bridge.mq5 (V2) |
//|                          AVL FX — Unified MT5 Bridge EA v5.0   |
//|                                                                  |
//| V2 Architecture: Single EA replaces separate market/execution   |
//| EAs. Module independence maintained:                            |
//|   Market Data failure ≠ Execution failure                       |
//|   Execution failure ≠ Market Data failure                       |
//|                                                                  |
//| Modules:                                                        |
//|   [A] Connection     — auth, heartbeat, reconnect              |
//|   [B] Market Data    — OnTick, OnBarClose → /market-data/*     |
//|   [C] Historical Data — reconnect backfill → Stage 2 V2 API   |
//|   [D] Symbol Spec    — broker specs → /bridge/symbol-spec      |
//|   [E] Account        — balance/equity → /bridge/heartbeat      |
//|   [F] Position       — snapshot → /bridge/positions            |
//|   [G] Deal           — recent deals → /bridge/deals            |
//|   [H] Execution      — command poll, OrderSend, safety checks  |
//|                                                                  |
//| Authentication (all endpoints):                                 |
//|   X-Connection-Id:    {InpConnectionId}                        |
//|   X-Connection-Token: {InpConnectionToken}                     |
//|                                                                  |
//| V2 Endpoints used:                                              |
//|   POST /market-data/tick          [Module B]                   |
//|   POST /market-data/bars          [Module B]                   |
//|   POST /market-data/backfill      [Module C]                   |
//|   GET  /market-data/last-bar      [Module C]                   |
//|   POST /market-data/backfill/complete [Module C]               |
//|   POST /bridge/symbol-spec        [Module D]                   |
//|   POST /bridge/heartbeat          [Modules A/E]                |
//|   POST /bridge/positions          [Module F]                   |
//|   POST /bridge/deals              [Module G]                   |
//|   GET  /execution-commands/pending [Module H]                  |
//|   POST /execution-commands/:id/claim  [Module H]              |
//|   POST /execution-commands/:id/result [Module H]              |
//|   POST /bridge/disconnect         [Module A]                   |
//+------------------------------------------------------------------+
#property copyright "AVL FX"
#property version   "5.00"
#include <Trade/Trade.mqh>
CTrade g_Trade;

#define BRIDGE_VERSION "5.0"

//=================================================================//
//  INPUT PARAMETERS                                               //
//=================================================================//

sinput group "=== [A] Gateway Connection ==="
input string InpGatewayURL      = "https://remarkable-cooperation-production-7341.up.railway.app";
input string InpConnectionId    = "";   // Connection ID (from AVL-FX /mt5 page)
input string InpConnectionToken = "";   // Connection Token (one-time reveal)

sinput group "=== [B] Market Data ==="
input bool InpTickEnabled    = true;   // Enable tick stream
input int  InpTickThrottleMs = 100;    // Min tick send interval (ms)
input bool InpOHLCEnabled    = true;   // Enable OHLC bar stream

sinput group "=== [C] Historical Data / Backfill ==="
input int  InpBackfillBars   = 500;    // Max bars to backfill per timeframe on reconnect
input int  InpBackfillSec    = 3600;   // Re-check backfill interval (seconds)

sinput group "=== [F] Position / [G] Deal ==="
input bool InpPositionEnabled = true;  // Enable position sync
input bool InpDealEnabled     = true;  // Enable deal sync
input int  InpTimerSec        = 5;     // Timer interval (seconds)
input int  InpDealDays        = 30;    // Deal history days

sinput group "=== [H] Execution Safety ==="
input bool   InpDemoOnly        = true;  // true: reject REAL accounts
input double InpMinVolume       = 0.01;  // Minimum allowed volume
input int    InpDeviationPoints = 30;    // Order slippage tolerance (points)
input int    InpPollIntervalSec = 5;     // Command poll interval (seconds)
input int    InpHeartbeatSec    = 15;    // Heartbeat interval (seconds)

//=================================================================//
//  GLOBAL STATE                                                   //
//=================================================================//

// [A] Connection
bool g_Connected   = false;

// [B] Market Data
string   g_Symbol;
long     g_LastTickMs   = 0;
datetime g_LastBarTimes[9];  // per-timeframe last confirmed bar time
ENUM_TIMEFRAMES g_TfList[] = {
   PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30,
   PERIOD_H1, PERIOD_H4, PERIOD_D1,  PERIOD_W1, PERIOD_MN1
};

// [C] Historical Data
datetime g_LastBackfillCheck = 0;

// [E/F/G] Sync timing
datetime g_LastPositionSync = 0;
datetime g_LastDealSync     = 0;

// [H] Execution safety flags (updated from heartbeat response)
bool   g_TradingEnabled = false;  // safe default: disabled until heartbeat confirms
bool   g_EmergencyStop  = true;   // safe default: emergency until heartbeat
string g_AccountMode    = "HEDGING";
bool   g_IsDemo         = false;
long   g_Login          = 0;
string g_Broker         = "";
datetime g_LastPollTime = 0;
datetime g_LastHeartbeat = 0;

// [H] Idempotency cache
string g_ProcessedIds[];
int    g_ProcessedCount = 0;
#define MAX_PROCESSED_CACHE 1000

//=================================================================//
//  [A] OnInit — Connection + Module initialization               //
//=================================================================//
int OnInit()
{
   if(StringLen(InpConnectionId) < 10 || StringLen(InpConnectionToken) < 10) {
      Alert("[AVL Bridge V2] ConnectionId / ConnectionToken が未設定です。\n"
            "AVL-FX /mt5 ページから取得してください。");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_Symbol = Symbol();
   ArrayInitialize(g_LastBarTimes, 0);

   // Account info
   ENUM_ACCOUNT_TRADE_MODE tradeMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   g_IsDemo  = (tradeMode == ACCOUNT_TRADE_MODE_DEMO);
   g_Login   = AccountInfoInteger(ACCOUNT_LOGIN);
   g_Broker  = AccountInfoString(ACCOUNT_COMPANY);
   ENUM_ACCOUNT_MARGIN_MODE marginMode = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   g_AccountMode = (marginMode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) ? "HEDGING" : "NETTING";

   // [H] Demo-only guard (checked before any connection)
   if(InpDemoOnly && !g_IsDemo) {
      Alert("[AVL Bridge] DemoOnly=true ですがREAL口座です。EAを停止します。");
      return INIT_PARAMETERS_INCORRECT;
   }

   // [H] CTrade configuration
   g_Trade.SetExpertMagicNumber(0);
   g_Trade.SetDeviationInPoints((ulong)InpDeviationPoints);
   g_Trade.SetTypeFilling(ORDER_FILLING_IOC);
   g_Trade.SetAsyncMode(false);

   // [H] Idempotency cache init
   ArrayResize(g_ProcessedIds, MAX_PROCESSED_CACHE);
   g_ProcessedCount = 0;

   Print("==============================================");
   Print("  AVL Bridge V2 (Unified) v", BRIDGE_VERSION);
   Print("  Symbol      : ", g_Symbol);
   Print("  Gateway     : ", InpGatewayURL);
   Print("  IsDemo      : ", g_IsDemo ? "YES (DEMO)" : "NO (REAL)");
   Print("  AccountMode : ", g_AccountMode);
   Print("  Connection  : ", StringSubstr(InpConnectionId, 0, 8), "...");
   Print("==============================================");

   // [A] Initial heartbeat — establishes connection, fetches safety flags
   if(!Module_A_Heartbeat()) {
      Print("[Bridge] 初回Heartbeat失敗。Gateway URLとWebRequest許可を確認: ", InpGatewayURL);
      return INIT_FAILED;
   }

   // [D] Symbol spec — on connect for Risk Engine lot calculation
   Module_D_SymbolSpec(g_Symbol);

   // [C] Historical Data backfill on startup
   if(InpOHLCEnabled) {
      Module_C_BackfillAll();
      g_LastBackfillCheck = TimeCurrent();
   }

   EventSetTimer(InpTimerSec);
   return INIT_SUCCEEDED;
}

//=================================================================//
//  [A] OnDeinit                                                   //
//=================================================================//
void OnDeinit(const int reason)
{
   EventKillTimer();
   Module_A_Disconnect();
   Print("[Bridge] EA終了 reason=", reason);
}

//=================================================================//
//  [B] OnTick — Market Data realtime                             //
//=================================================================//
void OnTick()
{
   MqlTick tick;
   if(!SymbolInfoTick(g_Symbol, tick)) return;

   if((tick.time_msc - g_LastTickMs) < InpTickThrottleMs) return;
   g_LastTickMs = tick.time_msc;

   if(InpTickEnabled) Module_B_SendTick(tick);
   if(InpOHLCEnabled) Module_B_OnBarClose();
}

//=================================================================//
//  OnTimer — All periodic modules                                //
//=================================================================//
void OnTimer()
{
   datetime now = TimeCurrent();

   // [A/E] Heartbeat + safety flags
   if((int)(now - g_LastHeartbeat) >= InpHeartbeatSec) {
      Module_A_Heartbeat();
      g_LastHeartbeat = now;
   }

   // [F] Position sync
   if(InpPositionEnabled && (int)(now - g_LastPositionSync) >= InpTimerSec) {
      Module_F_PositionSync();
      g_LastPositionSync = now;
   }

   // [G] Deal sync
   if(InpDealEnabled) {
      if(g_LastDealSync == 0 || (int)(now - g_LastDealSync) >= 300) {
         Module_G_DealSync(false);
         g_LastDealSync = now;
      }
   }

   // [H] Execution command poll (module-independent of Market Data)
   if((int)(now - g_LastPollTime) >= InpPollIntervalSec) {
      Module_H_CommandPoll();
      g_LastPollTime = now;
   }

   // [C] Periodic backfill re-check
   if(InpOHLCEnabled && (int)(now - g_LastBackfillCheck) >= InpBackfillSec) {
      Module_C_BackfillAll();
      g_LastBackfillCheck = now;
   }
}

//=================================================================//
//  MODULE A: Connection / Heartbeat / Disconnect                 //
//=================================================================//

bool Module_A_Heartbeat()
{
   ENUM_ACCOUNT_TRADE_MODE tm = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   bool tradeAllowed = (AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) == 1);
   ENUM_ACCOUNT_MARGIN_MODE mm = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);

   string body = StringFormat(
      "{\"bridgeVersion\":\"%s\","
      "\"mt5Login\":%I64d,\"broker\":\"%s\","
      "\"accountType\":\"%s\",\"accountMode\":\"%s\","
      "\"tradeAllowed\":%s,"
      "\"balance\":%.2f,\"equity\":%.2f,"
      "\"margin\":%.2f,\"freeMargin\":%.2f,"
      "\"leverage\":%d}",
      BRIDGE_VERSION,
      g_Login, g_Broker,
      (tm == ACCOUNT_TRADE_MODE_DEMO) ? "DEMO" : "REAL",
      (mm == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) ? "HEDGING" : "NETTING",
      tradeAllowed ? "true" : "false",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE)
   );

   string response = "";
   int code = HTTP_Post("/bridge/heartbeat", body, response);

   if(code == 200 && StringLen(response) > 0) {
      g_TradingEnabled = JsonGetBool(response, "tradingEnabled", false);
      g_EmergencyStop  = JsonGetBool(response, "emergencyStop",  true);
      string am = JsonGetStr(response, "accountMode");
      if(StringLen(am) > 0) g_AccountMode = am;
      Print("[Bridge] Heartbeat OK | tradingEnabled=", g_TradingEnabled,
            " emergencyStop=", g_EmergencyStop);
      g_Connected = true;
      return true;
   }

   g_Connected = false;
   Print("[Bridge] Heartbeat FAIL code=", code);
   return false;
}

void Module_A_Disconnect()
{
   string resp = "";
   HTTP_Post("/bridge/disconnect", "{}", resp);
}

//=================================================================//
//  MODULE B: Market Data — Tick + Bar (V2 endpoints)            //
//=================================================================//

void Module_B_SendTick(const MqlTick &tick)
{
   int    digits = (int)SymbolInfoInteger(g_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(g_Symbol, SYMBOL_POINT);
   double spread = (point > 0) ? (tick.ask - tick.bid) / point : 0.0;

   string body = StringFormat(
      "{\"symbol\":\"%s\","
      "\"bid\":%.5f,\"ask\":%.5f,"
      "\"spread\":%.2f,\"digits\":%d,"
      "\"time\":%I64d}",
      g_Symbol, tick.bid, tick.ask, spread, digits,
      (long)TimeCurrent()
   );
   HTTP_Post("/market-data/tick", body);
}

void Module_B_OnBarClose()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++) {
      ENUM_TIMEFRAMES tf = g_TfList[i];
      datetime curTime   = iTime(g_Symbol, tf, 0);
      if(curTime == 0) continue;

      if(g_LastBarTimes[i] != 0 && curTime > g_LastBarTimes[i]) {
         // Confirmed bar (shift=1)
         Module_B_SendBar(tf, 1, true);
      }
      g_LastBarTimes[i] = curTime;
      // Forming bar (shift=0)
      Module_B_SendBar(tf, 0, false);
   }
}

void Module_B_SendBar(ENUM_TIMEFRAMES tf, int shift, bool confirmed)
{
   MqlRates rates[];
   if(CopyRates(g_Symbol, tf, shift, 1, rates) <= 0) return;

   // Broker server UTC offset for normalization
   int utcOffset = (int)(TimeCurrent() - TimeGMT());

   string body = StringFormat(
      "{\"bars\":[{"
      "\"symbol\":\"%s\","
      "\"timeframe\":\"%s\","
      "\"time\":%I64d,"
      "\"open\":%.5f,\"high\":%.5f,"
      "\"low\":%.5f,\"close\":%.5f,"
      "\"tick_volume\":%d}],"
      "\"utc_offset_hours\":%d}",
      g_Symbol, TF_ToString(tf),
      (long)rates[0].time,
      rates[0].open, rates[0].high,
      rates[0].low,  rates[0].close,
      (long)rates[0].tick_volume,
      utcOffset
   );
   HTTP_Post("/market-data/bars", body);
}

//=================================================================//
//  MODULE C: Historical Data — Backfill / Recovery (V2 Stage 2) //
//=================================================================//

void Module_C_BackfillAll()
{
   int tfCount = ArraySize(g_TfList);
   for(int i = 0; i < tfCount; i++) {
      Module_C_BackfillTF(g_TfList[i]);
      Sleep(50); // avoid flooding gateway
   }
}

void Module_C_BackfillTF(ENUM_TIMEFRAMES tf)
{
   string tfStr = TF_ToString(tf);

   // Step 1: Query last persisted bar time
   char   req[], res[];
   string headers = BuildHeaders();
   string resHdr;
   string url = StringFormat(
      "%s/market-data/last-bar?symbol=%s&timeframe=%s",
      InpGatewayURL, g_Symbol, tfStr
   );

   int code = WebRequest("GET", url, headers, 8000, req, res, resHdr);
   if(code != 200 || ArraySize(res) == 0) {
      Print("[Bridge][C] last-bar query failed tf=", tfStr, " code=", code);
      return;
   }

   string resp        = CharArrayToString(res);
   string lastBarUtc  = JsonGetStr(resp, "last_bar_utc");
   bool   hasLastBar  = (StringLen(lastBarUtc) > 5);

   // Step 2: Gap detection
   datetime lastBarSec = hasLastBar ? ParseISO(lastBarUtc) : 0;
   int      tfPeriodSec = TF_ToSeconds(tf);
   datetime now         = TimeCurrent();

   bool gapExists = (!hasLastBar || (now > lastBarSec + tfPeriodSec));
   if(!gapExists) {
      Print("[Bridge][C] No gap detected: ", g_Symbol, ":", tfStr);
      return;
   }

   // Step 3: Calculate how many bars to fetch
   int barsMissing = (hasLastBar && tfPeriodSec > 0)
      ? (int)((now - lastBarSec) / tfPeriodSec) + 1
      : InpBackfillBars;
   int barsToFetch = MathMin(barsMissing, InpBackfillBars);

   Print("[Bridge][C] Backfill needed: ", g_Symbol, ":", tfStr,
         " lastBar=", TimeToString(lastBarSec),
         " missing≈", barsMissing, " fetching=", barsToFetch);

   // Step 4: CopyRates and send in batches of ≤500
   MqlRates rates[];
   int n = CopyRates(g_Symbol, tf, 0, barsToFetch, rates);
   if(n <= 0) {
      Print("[Bridge][C] CopyRates failed: ", g_Symbol, ":", tfStr);
      return;
   }

   int utcOffset    = (int)(TimeCurrent() - TimeGMT());
   int barsSent     = 0;
   int barsAccepted = 0;
   string fromUtc   = "";
   string toUtc     = "";

   // rates is oldest→newest; send in batches
   int batchSize = 500;
   for(int start = 0; start < n; start += batchSize) {
      int end        = MathMin(start + batchSize, n);
      string barsJson = "";

      for(int j = start; j < end; j++) {
         if(j > start) barsJson += ",";
         barsJson += StringFormat(
            "{\"symbol\":\"%s\",\"timeframe\":\"%s\","
            "\"time\":%I64d,"
            "\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,"
            "\"tick_volume\":%d}",
            g_Symbol, tfStr,
            (long)rates[j].time,
            rates[j].open, rates[j].high, rates[j].low, rates[j].close,
            (long)rates[j].tick_volume
         );
         if(j == start)
            fromUtc = TimeToString(rates[j].time + utcOffset * 3600, TIME_DATE|TIME_MINUTES) + ":00Z";
         if(j == end - 1)
            toUtc = TimeToString(rates[j].time + utcOffset * 3600, TIME_DATE|TIME_MINUTES) + ":00Z";
      }

      string batchBody = StringFormat(
         "{\"bars\":[%s],\"utc_offset_hours\":%d}",
         barsJson, utcOffset
      );

      char   breq[], bres[];
      string bResHdr;
      string bHeaders = BuildHeaders() + "Content-Type: application/json\r\n";
      StringToCharArray(batchBody, breq, 0, StringLen(batchBody));

      int bCode = WebRequest("POST",
         InpGatewayURL + "/market-data/backfill",
         bHeaders, 15000, breq, bres, bResHdr);

      int batchCount = end - start;
      barsSent += batchCount;
      if(bCode == 200)
         barsAccepted += batchCount;
      else
         Print("[Bridge][C] backfill batch FAIL code=", bCode, " tf=", tfStr);

      Sleep(30);
   }

   // Step 5: Notify completion
   string completeBody = StringFormat(
      "{\"symbol\":\"%s\",\"timeframe\":\"%s\","
      "\"from_utc\":\"%s\",\"to_utc\":\"%s\","
      "\"bars_sent\":%d,\"bars_accepted\":%d}",
      g_Symbol, tfStr, fromUtc, toUtc, barsSent, barsAccepted
   );
   HTTP_Post("/market-data/backfill/complete", completeBody);

   Print("[Bridge][C] Backfill complete: ", g_Symbol, ":", tfStr,
         " sent=", barsSent, " accepted=", barsAccepted);
}

//=================================================================//
//  MODULE D: Symbol Specification                                 //
//=================================================================//

void Module_D_SymbolSpec(const string sym)
{
   if(!SymbolSelect(sym, true)) return;

   string body = "{\"brokerSymbol\":\"" + sym + "\""
      + ",\"contractSize\":"     + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2)
      + ",\"volumeMin\":"        + DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4)
      + ",\"volumeMax\":"        + DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 2)
      + ",\"volumeStep\":"       + DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4)
      + ",\"tickSize\":"         + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 6)
      + ",\"tickValue\":"        + DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6)
      + ",\"pointSize\":"        + DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), 6)
      + ",\"digits\":"           + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_DIGITS))
      + ",\"stopsLevelPoints\":" + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL))
      + ",\"stopsLevelPrice\":"  + DoubleToString((int)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(sym, SYMBOL_POINT), 6)
      + ",\"marginInitial\":0.0"
      + ",\"spreadCurrent\":"    + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_SPREAD))
      + "}";

   HTTP_Post("/bridge/symbol-spec", body);
   Print("[Bridge][D] SymbolSpec sent: ", sym);
}

//=================================================================//
//  MODULE F: Position Sync (complete snapshot)                   //
//=================================================================//

void Module_F_PositionSync()
{
   string posArr = "";
   int    count  = 0;

   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      long   magic    = PositionGetInteger(POSITION_MAGIC);
      long   type     = PositionGetInteger(POSITION_TYPE);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);

      if(count > 0) posArr += ",";
      posArr += StringFormat(
         "{\"positionTicket\":%I64d"
         ",\"symbol\":\"%s\""
         ",\"direction\":\"%s\""
         ",\"volume\":%.2f"
         ",\"openPrice\":%.5f"
         ",\"currentPrice\":%.5f"
         ",\"stopLoss\":%.5f"
         ",\"takeProfit\":%.5f"
         ",\"unrealizedPnl\":%.2f"
         ",\"commission\":%.2f"
         ",\"swap\":%.2f"
         ",\"magicNumber\":%I64d"
         ",\"openedAt\":\"%s\"}",
         (long)ticket,
         PositionGetString(POSITION_SYMBOL),
         (type == POSITION_TYPE_BUY) ? "BUY" : "SELL",
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_PRICE_CURRENT),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         PositionGetDouble(POSITION_COMMISSION),
         PositionGetDouble(POSITION_SWAP),
         magic,
         TimeToString(openTime, TIME_DATE|TIME_SECONDS) + " UTC"
      );
      count++;
   }

   string body = StringFormat("{\"snapshot_complete\":true,\"positions\":[%s]}", posArr);
   string resp = "";
   HTTP_Post("/bridge/positions", body, resp);
}

//=================================================================//
//  MODULE G: Deal Sync                                            //
//=================================================================//

void Module_G_DealSync(const bool initialSync)
{
   datetime from = TimeCurrent() - (initialSync ? 30 : 1) * 86400;
   HistorySelect(from, TimeCurrent());

   string dealArr = "";
   int    count   = 0;
   int    total   = HistoryDealsTotal();

   for(int i = 0; i < total; i++) {
      ulong dealTkt = HistoryDealGetTicket(i);
      if(dealTkt == 0) continue;

      ENUM_DEAL_TYPE  dt  = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTkt, DEAL_TYPE);
      ENUM_DEAL_ENTRY ent = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTkt, DEAL_ENTRY);
      if(dt != DEAL_TYPE_BUY && dt != DEAL_TYPE_SELL) continue;
      string entStr = (ent == DEAL_ENTRY_IN) ? "IN" : (ent == DEAL_ENTRY_OUT) ? "OUT" : "INOUT";

      if(count > 0) dealArr += ",";
      dealArr += StringFormat(
         "{\"dealTicket\":%I64d"
         ",\"orderTicket\":%I64d"
         ",\"positionTicket\":%I64d"
         ",\"symbol\":\"%s\""
         ",\"dealType\":\"%s\""
         ",\"entryType\":\"%s\""
         ",\"volume\":%.2f"
         ",\"price\":%.5f"
         ",\"profit\":%.2f"
         ",\"commission\":%.2f"
         ",\"swap\":%.2f"
         ",\"dealTime\":\"%s\""
         ",\"magicNumber\":%I64d"
         ",\"commandId\":null}",
         (long)dealTkt,
         HistoryDealGetInteger(dealTkt, DEAL_ORDER),
         HistoryDealGetInteger(dealTkt, DEAL_POSITION_ID),
         HistoryDealGetString(dealTkt, DEAL_SYMBOL),
         (dt == DEAL_TYPE_BUY) ? "BUY" : "SELL",
         entStr,
         HistoryDealGetDouble(dealTkt, DEAL_VOLUME),
         HistoryDealGetDouble(dealTkt, DEAL_PRICE),
         HistoryDealGetDouble(dealTkt, DEAL_PROFIT),
         HistoryDealGetDouble(dealTkt, DEAL_COMMISSION),
         HistoryDealGetDouble(dealTkt, DEAL_SWAP),
         TimeToString((datetime)HistoryDealGetInteger(dealTkt, DEAL_TIME), TIME_DATE|TIME_SECONDS) + " UTC",
         HistoryDealGetInteger(dealTkt, DEAL_MAGIC)
      );
      count++;
   }

   if(count == 0) return;
   string body = StringFormat("{\"deals\":[%s]}", dealArr);
   string resp = "";
   HTTP_Post("/bridge/deals", body, resp);
   Print("[Bridge][G] Deal sync: ", count, " deals");
}

void Module_G_DealSingle(const string commandId, const long dealTkt)
{
   HistoryDealSelect(dealTkt);
   ENUM_DEAL_TYPE  dt  = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTkt, DEAL_TYPE);
   ENUM_DEAL_ENTRY ent = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTkt, DEAL_ENTRY);
   string entStr = (ent == DEAL_ENTRY_IN) ? "IN" : (ent == DEAL_ENTRY_OUT) ? "OUT" : "INOUT";

   string body = StringFormat(
      "{\"deals\":[{\"dealTicket\":%I64d"
      ",\"orderTicket\":%I64d,\"positionTicket\":%I64d"
      ",\"symbol\":\"%s\",\"dealType\":\"%s\",\"entryType\":\"%s\""
      ",\"volume\":%.2f,\"price\":%.5f"
      ",\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f"
      ",\"dealTime\":\"%s\",\"magicNumber\":%I64d"
      ",\"commandId\":\"%s\"}]}",
      dealTkt,
      HistoryDealGetInteger(dealTkt, DEAL_ORDER),
      HistoryDealGetInteger(dealTkt, DEAL_POSITION_ID),
      HistoryDealGetString(dealTkt, DEAL_SYMBOL),
      (dt == DEAL_TYPE_BUY) ? "BUY" : "SELL",
      entStr,
      HistoryDealGetDouble(dealTkt, DEAL_VOLUME),
      HistoryDealGetDouble(dealTkt, DEAL_PRICE),
      HistoryDealGetDouble(dealTkt, DEAL_PROFIT),
      HistoryDealGetDouble(dealTkt, DEAL_COMMISSION),
      HistoryDealGetDouble(dealTkt, DEAL_SWAP),
      TimeToString((datetime)HistoryDealGetInteger(dealTkt, DEAL_TIME), TIME_DATE|TIME_SECONDS) + " UTC",
      HistoryDealGetInteger(dealTkt, DEAL_MAGIC),
      commandId
   );
   string resp = "";
   HTTP_Post("/bridge/deals", body, resp);
}

//=================================================================//
//  MODULE H: Execution — Command Poll + Safety Checks            //
//  All V1 safety properties preserved (see UNIFIED_MT5_BRIDGE.md) //
//=================================================================//

void Module_H_CommandPoll()
{
   char   req[], res[];
   string headers = BuildHeaders();
   string resHdr;
   string url = InpGatewayURL + "/execution-commands/pending";

   int code = WebRequest("GET", url, headers, 5000, req, res, resHdr);
   if(code != 200 || ArraySize(res) == 0) return;

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return;

   // Parse JSON array of command objects
   int depth = 0, objStart = -1;
   for(int i = 0; i < StringLen(response); i++) {
      string ch = StringSubstr(response, i, 1);
      if(ch == "{") {
         if(depth == 0) objStart = i;
         depth++;
      } else if(ch == "}") {
         depth--;
         if(depth == 0 && objStart >= 0) {
            Module_H_ProcessCommand(StringSubstr(response, objStart, i - objStart + 1));
            objStart = -1;
         }
      }
   }
}

void Module_H_ProcessCommand(const string cmdJson)
{
   string commandId   = JsonGetStr(cmdJson, "commandId");
   string action      = JsonGetStr(cmdJson, "action");
   string symbol      = JsonGetStr(cmdJson, "symbol");
   double volume      = JsonGetDbl(cmdJson, "volume");
   long   magicNumber = (long)JsonGetDbl(cmdJson, "magicNumber");
   double sl          = JsonGetDbl(cmdJson, "stopLoss");
   double tp          = JsonGetDbl(cmdJson, "takeProfit");
   long   posTkt      = (long)JsonGetDbl(cmdJson, "positionTicket");
   string expiresAt   = JsonGetStr(cmdJson, "expiresAt");

   if(StringLen(commandId) == 0 || StringLen(action) == 0) {
      Print("[Bridge][H] Malformed command: ", cmdJson);
      return;
   }

   Print("[Bridge][H] Command: id=", commandId, " action=", action,
         " symbol=", symbol, " vol=", volume, " magic=", magicNumber);

   // ── CHECK 1: Idempotency ──────────────────────────────────────
   if(IsProcessed(commandId)) {
      Print("[Bridge][H] SKIP (processed): ", commandId);
      return;
   }

   // ── CHECK 2: Expiry ──────────────────────────────────────────
   if(StringLen(expiresAt) == 0) {
      Module_H_SendFailed(commandId, "MISSING_EXPIRY");
      return;
   }
   datetime expiry = ParseISO(expiresAt);
   if(expiry <= 0) {
      Module_H_SendFailed(commandId, "INVALID_EXPIRY");
      return;
   }
   if(TimeCurrent() >= expiry) {
      MarkProcessed(commandId);
      Module_H_SendResult(commandId, "EXPIRED", false, 0,
                          0, 0, 0, 0, 0, 0, 0, -1, "Command expired");
      return;
   }

   // ── CHECK 3: trading_enabled ─────────────────────────────────
   if(!g_TradingEnabled) {
      MarkProcessed(commandId);
      Module_H_SendResult(commandId, "REJECTED", false, 0,
                          0, 0, 0, 0, 0, 0, 0, -1, "TRADING_DISABLED");
      return;
   }

   // ── CHECK 4: emergency_stop ──────────────────────────────────
   if(g_EmergencyStop && (action == "BUY" || action == "SELL")) {
      MarkProcessed(commandId);
      Module_H_SendResult(commandId, "REJECTED", false, 0,
                          0, 0, 0, 0, 0, 0, 0, -1, "EMERGENCY_STOP_ACTIVE");
      return;
   }

   // ── CHECK 5: Atomic claim ─────────────────────────────────────
   if(!Module_H_ClaimCommand(commandId)) {
      MarkProcessed(commandId);
      return;
   }

   // ── CHECK 6: Symbol presence ─────────────────────────────────
   if(StringLen(symbol) == 0) {
      Module_H_SendFailed(commandId, "EMPTY_SYMBOL");
      return;
   }
   if(!SymbolSelect(symbol, true)) {
      Module_H_SendFailed(commandId, "SYMBOL_NOT_FOUND: " + symbol);
      return;
   }

   // ── CHECK 7: Magic number range ──────────────────────────────
   bool magicValid = (magicNumber >= 20001 && magicNumber <= 29999)
                  || (magicNumber >= 900001 && magicNumber <= 999999);
   if(!magicValid) {
      Module_H_SendFailed(commandId, StringFormat("MAGIC_OUT_OF_RANGE: %I64d", magicNumber));
      return;
   }

   MarkProcessed(commandId);
   g_Trade.SetExpertMagicNumber((ulong)magicNumber);

   // ── Execute action ───────────────────────────────────────────
   bool   ok        = false;
   int    retcode   = 0;
   long   orderTkt  = 0, dealTkt = 0, positionTkt = 0;
   double execPrice = 0;

   if(action == "BUY") {
      ok = Module_H_ExecuteBUY(commandId, symbol, volume, sl, tp,
                               retcode, orderTkt, dealTkt, positionTkt, execPrice);
   } else if(action == "SELL") {
      ok = Module_H_ExecuteSELL(commandId, symbol, volume, sl, tp,
                                retcode, orderTkt, dealTkt, positionTkt, execPrice);
   } else if(action == "CLOSE") {
      ok = Module_H_ExecuteCLOSE(commandId, symbol, (ulong)posTkt, magicNumber,
                                  retcode, orderTkt, dealTkt, execPrice);
      if(ok) positionTkt = posTkt;
   } else if(action == "MODIFY_SL") {
      ok = Module_H_ExecuteMODIFY(commandId, (ulong)posTkt, sl, 0, true, false, retcode);
   } else if(action == "MODIFY_TP") {
      ok = Module_H_ExecuteMODIFY(commandId, (ulong)posTkt, 0, tp, false, true, retcode);
   } else {
      Module_H_SendFailed(commandId, "UNKNOWN_ACTION: " + action);
      return;
   }

   if(ok) {
      Module_H_SendResult(commandId, "FILLED", true, retcode,
                          orderTkt, dealTkt, positionTkt,
                          0, execPrice, volume, volume, 0, "");
      if(dealTkt > 0) Module_G_DealSingle(commandId, dealTkt);
      Module_F_PositionSync();
   } else {
      string errDesc = StringFormat("MT5 retcode=%d", retcode);
      Module_H_SendResult(commandId, "FAILED", false, retcode,
                          0, 0, 0, 0, 0, volume, 0, retcode, errDesc);
   }
}

bool Module_H_ExecuteBUY(const string commandId, const string symbol,
                         const double volume, const double sl, const double tp,
                         int &retcode, long &orderTkt, long &dealTkt,
                         long &positionTkt, double &execPrice)
{
   if(!Validate_Volume(symbol, volume)) {
      Module_H_SendFailed(commandId, StringFormat("INVALID_VOLUME: %.2f", volume));
      return false;
   }
   int    digits    = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double roundedSL = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   double roundedTP = (tp > 0) ? NormalizeDouble(tp, digits) : 0;

   // CHECK: SL required
   if(roundedSL <= 0) {
      Module_H_SendFailed(commandId, "SL_REQUIRED");
      return false;
   }
   double ask        = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double point      = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;

   // CHECK: SL direction (BUY: SL must be below entry)
   if(roundedSL >= ask) {
      Module_H_SendFailed(commandId, "SL_ABOVE_ENTRY_BUY");
      return false;
   }
   // CHECK: SL too close
   if(ask - roundedSL < stopsLevel) {
      Module_H_SendFailed(commandId, StringFormat("SL_TOO_CLOSE sl=%.5f ask=%.5f stops=%.5f", roundedSL, ask, stopsLevel));
      return false;
   }
   if(roundedTP > 0 && roundedTP - ask < stopsLevel) roundedTP = 0;

   bool ok  = g_Trade.Buy(volume, symbol, 0, roundedSL, roundedTP, "AVL-Bridge");
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   execPrice = g_Trade.ResultPrice();
   positionTkt = ok ? orderTkt : 0;
   Print("[Bridge][H] BUY ", symbol, " vol=", volume, " ok=", ok, " retcode=", retcode);
   return ok;
}

bool Module_H_ExecuteSELL(const string commandId, const string symbol,
                          const double volume, const double sl, const double tp,
                          int &retcode, long &orderTkt, long &dealTkt,
                          long &positionTkt, double &execPrice)
{
   if(!Validate_Volume(symbol, volume)) {
      Module_H_SendFailed(commandId, StringFormat("INVALID_VOLUME: %.2f", volume));
      return false;
   }
   int    digits    = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double roundedSL = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   double roundedTP = (tp > 0) ? NormalizeDouble(tp, digits) : 0;

   if(roundedSL <= 0) {
      Module_H_SendFailed(commandId, "SL_REQUIRED");
      return false;
   }
   double bid        = SymbolInfoDouble(symbol, SYMBOL_BID);
   double point      = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;

   // CHECK: SL direction (SELL: SL must be above entry)
   if(roundedSL <= bid) {
      Module_H_SendFailed(commandId, "SL_BELOW_ENTRY_SELL");
      return false;
   }
   if(roundedSL - bid < stopsLevel) {
      Module_H_SendFailed(commandId, StringFormat("SL_TOO_CLOSE sl=%.5f bid=%.5f stops=%.5f", roundedSL, bid, stopsLevel));
      return false;
   }
   if(roundedTP > 0 && bid - roundedTP < stopsLevel) roundedTP = 0;

   bool ok  = g_Trade.Sell(volume, symbol, 0, roundedSL, roundedTP, "AVL-Bridge");
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   execPrice = g_Trade.ResultPrice();
   positionTkt = ok ? orderTkt : 0;
   Print("[Bridge][H] SELL ", symbol, " vol=", volume, " ok=", ok, " retcode=", retcode);
   return ok;
}

bool Module_H_ExecuteCLOSE(const string commandId, const string symbol,
                            const ulong positionTicket, const long expectedMagic,
                            int &retcode, long &orderTkt, long &dealTkt, double &execPrice)
{
   if(positionTicket == 0) {
      Module_H_SendFailed(commandId, "CLOSE_MISSING_TICKET");
      return false;
   }
   if(!PositionSelectByTicket(positionTicket)) {
      Module_H_SendFailed(commandId, StringFormat("POSITION_NOT_FOUND: %I64d", (long)positionTicket));
      return false;
   }
   long posMagic = (long)PositionGetInteger(POSITION_MAGIC);
   if(expectedMagic > 0 && posMagic != expectedMagic) {
      Module_H_SendFailed(commandId, StringFormat("MAGIC_MISMATCH: expected=%I64d actual=%I64d", expectedMagic, posMagic));
      return false;
   }
   string posSymbol = PositionGetString(POSITION_SYMBOL);
   if(StringLen(symbol) > 0 && posSymbol != symbol) {
      Module_H_SendFailed(commandId, StringFormat("SYMBOL_MISMATCH: expected=%s actual=%s", symbol, posSymbol));
      return false;
   }

   bool ok = g_Trade.PositionClose(positionTicket);
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   execPrice = g_Trade.ResultPrice();
   Print("[Bridge][H] CLOSE ticket=", positionTicket, " ok=", ok, " retcode=", retcode);
   return ok;
}

bool Module_H_ExecuteMODIFY(const string commandId, const ulong positionTicket,
                             const double newSL, const double newTP,
                             const bool modifySL, const bool modifyTP, int &retcode)
{
   if(positionTicket == 0) {
      Module_H_SendFailed(commandId, "MODIFY_MISSING_TICKET");
      return false;
   }
   if(!PositionSelectByTicket(positionTicket)) {
      Module_H_SendFailed(commandId, StringFormat("POSITION_NOT_FOUND: %I64u", positionTicket));
      return false;
   }

   string sym     = PositionGetString(POSITION_SYMBOL);
   int    digits  = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double currSL  = PositionGetDouble(POSITION_SL);
   double currTP  = PositionGetDouble(POSITION_TP);
   long   posType = PositionGetInteger(POSITION_TYPE);

   double applySL = modifySL ? NormalizeDouble(newSL, digits) : currSL;
   double applyTP = modifyTP ? NormalizeDouble(newTP, digits) : currTP;

   if(modifySL) {
      if(!MathIsValidNumber(newSL) || newSL <= 0 || applySL <= 0) {
         Module_H_SendFailed(commandId, "MODIFY_SL_INVALID");
         return false;
      }
      double point      = SymbolInfoDouble(sym, SYMBOL_POINT);
      double stopsLevel = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
      double bid        = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask        = SymbolInfoDouble(sym, SYMBOL_ASK);

      if(posType == POSITION_TYPE_BUY) {
         // BUY: SL must move up (tighter), below bid
         if(applySL >= bid || bid - applySL < stopsLevel || applySL < currSL) {
            Module_H_SendFailed(commandId, "MODIFY_SL_BUY_DIRECTION_INVALID");
            return false;
         }
      } else {
         // SELL: SL must move down (tighter), above ask
         if(applySL <= ask || applySL - ask < stopsLevel || applySL > currSL) {
            Module_H_SendFailed(commandId, "MODIFY_SL_SELL_DIRECTION_INVALID");
            return false;
         }
      }
   }

   bool ok = g_Trade.PositionModify(positionTicket, applySL, applyTP);
   retcode = (int)g_Trade.ResultRetcode();
   Print("[Bridge][H] MODIFY ticket=", positionTicket, " SL=", applySL, " ok=", ok);
   return ok;
}

bool Module_H_ClaimCommand(const string commandId)
{
   string path = "/execution-commands/" + commandId + "/claim";
   string resp = "";
   return (HTTP_Post(path, "{}", resp) == 200);
}

void Module_H_SendResult(const string commandId, const string status,
                         const bool success, const int retcode,
                         const long orderTkt, const long dealTkt, const long posTkt,
                         const double reqPrice, const double execPrice,
                         const double reqVol, const double execVol,
                         const int errorCode, const string errorMessage)
{
   string body = StringFormat(
      "{\"commandId\":\"%s\""
      ",\"success\":%s,\"status\":\"%s\",\"retcode\":%d"
      ",\"orderTicket\":%I64d,\"dealTicket\":%I64d,\"positionTicket\":%I64d"
      ",\"requestedPrice\":%.5f,\"executionPrice\":%.5f"
      ",\"requestedVolume\":%.2f,\"executedVolume\":%.2f"
      ",\"errorCode\":%d,\"errorMessage\":\"%s\""
      ",\"brokerTime\":\"%s\",\"receivedAt\":\"%s\"}",
      commandId,
      success ? "true" : "false", status, retcode,
      orderTkt, dealTkt, posTkt,
      reqPrice, execPrice, reqVol, execVol,
      errorCode, errorMessage,
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + " UTC",
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + " UTC"
   );
   string resp = "";
   int code = HTTP_Post("/execution-commands/" + commandId + "/result", body, resp);
   Print("[Bridge][H] Result: id=", commandId, " status=", status, " code=", code);
}

void Module_H_SendFailed(const string commandId, const string reason)
{
   MarkProcessed(commandId);
   Module_H_SendResult(commandId, "FAILED", false, 0,
                       0, 0, 0, 0, 0, 0, 0, -1, reason);
}

//=================================================================//
//  UTILITIES                                                      //
//=================================================================//

bool Validate_Volume(const string symbol, const double volume)
{
   if(volume <= 0 || volume < InpMinVolume) return false;
   double minVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double stepVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(minVol > 0 && volume < minVol) return false;
   if(maxVol > 0 && volume > maxVol) return false;
   if(stepVol > 0) {
      double rounded = MathRound(volume / stepVol) * stepVol;
      if(MathAbs(rounded - volume) > stepVol * 0.5) return false;
   }
   return true;
}

bool IsProcessed(const string commandId)
{
   for(int i = 0; i < g_ProcessedCount; i++)
      if(g_ProcessedIds[i] == commandId) return true;
   return false;
}

void MarkProcessed(const string commandId)
{
   if(IsProcessed(commandId)) return;
   if(g_ProcessedCount >= MAX_PROCESSED_CACHE) {
      int keep = MAX_PROCESSED_CACHE / 2;
      for(int i = 0; i < keep; i++)
         g_ProcessedIds[i] = g_ProcessedIds[g_ProcessedCount - keep + i];
      g_ProcessedCount = keep;
   }
   g_ProcessedIds[g_ProcessedCount++] = commandId;
}

datetime ParseISO(const string iso)
{
   if(StringLen(iso) < 19) return 0;
   string datePart  = StringSubstr(iso, 0, 10);
   string timePart  = StringSubstr(iso, 11, 8);
   string converted = StringSubstr(datePart, 0, 4) + "."
                    + StringSubstr(datePart, 5, 2) + "."
                    + StringSubstr(datePart, 8, 2) + " "
                    + timePart;
   int gmtOffset = (int)(TimeCurrent() - TimeGMT());
   return StringToTime(converted) + gmtOffset;
}

bool JsonGetBool(const string json, const string key, const bool defaultVal = false)
{
   string pat = "\"" + key + "\":";
   int s = StringFind(json, pat);
   if(s < 0) return defaultVal;
   s += StringLen(pat);
   while(s < StringLen(json) && StringSubstr(json, s, 1) == " ") s++;
   if(StringSubstr(json, s, 4) == "true")  return true;
   if(StringSubstr(json, s, 5) == "false") return false;
   return defaultVal;
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
   string strPat = "\"" + key + "\":\"";
   if(StringFind(json, strPat) >= 0) return 0.0;
   string pat = "\"" + key + "\":";
   int s = StringFind(json, pat);
   if(s < 0) return 0.0;
   s += StringLen(pat);
   if(s >= StringLen(json)) return 0.0;
   string ch = StringSubstr(json, s, 1);
   if(ch == "n" || ch == "\"") return 0.0;
   string num = "";
   for(int i = s; i < StringLen(json) && i < s + 30; i++) {
      ch = StringSubstr(json, i, 1);
      if(ch == "," || ch == "}" || ch == "]" || ch == " " || ch == "\r" || ch == "\n") break;
      num += ch;
   }
   return StringToDouble(num);
}

int HTTP_Post(const string path, const string body)
{
   string dummy = "";
   return HTTP_Post(path, body, dummy);
}

int HTTP_Post(const string path, const string body, string &response)
{
   string headers = BuildHeaders() + "Content-Type: application/json\r\n";
   char reqData[], resData[];
   string resHdr;
   StringToCharArray(body, reqData, 0, StringLen(body));

   int code = WebRequest("POST", InpGatewayURL + path, headers, 8000, reqData, resData, resHdr);
   if(code > 0 && ArraySize(resData) > 0)
      response = CharArrayToString(resData);
   if(code < 0) {
      int err = GetLastError();
      if(err == 4014) {
         static bool alerted = false;
         if(!alerted) {
            Print("!!! WebRequest not allowed. Add to allowed list: ", InpGatewayURL);
            alerted = true;
         }
      }
   }
   return code;
}

string BuildHeaders()
{
   return "X-Connection-Id: "    + InpConnectionId    + "\r\n"
        + "X-Connection-Token: " + InpConnectionToken + "\r\n";
}

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
      case PERIOD_MN1: return "MN1";
      default:         return "UNKNOWN";
   }
}

int TF_ToSeconds(ENUM_TIMEFRAMES tf)
{
   switch(tf) {
      case PERIOD_M1:  return 60;
      case PERIOD_M5:  return 300;
      case PERIOD_M15: return 900;
      case PERIOD_M30: return 1800;
      case PERIOD_H1:  return 3600;
      case PERIOD_H4:  return 14400;
      case PERIOD_D1:  return 86400;
      case PERIOD_W1:  return 604800;
      case PERIOD_MN1: return 2592000;
      default:         return 3600;
   }
}
