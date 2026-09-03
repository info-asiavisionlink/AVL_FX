//+------------------------------------------------------------------+
//|                                      AVL_ExecutionBridge.mq5    |
//|                     AVL AI Trading System — Execution Bridge     |
//|                                  v1.0 (STAGE 3-B)               |
//|                                                                  |
//| 役割                                                             |
//|   MT5での注文実行専用EA。Strategyロジックを持たない。            |
//|   AVL-FX Server側のExecution Commandを受信し、MT5で実行する。   |
//|                                                                  |
//| 責務 ✓                                                           |
//|   Gateway接続・認証 / Heartbeat / Command Polling                |
//|   Idempotency / Expiry / emergency_stop確認                      |
//|   BUY / SELL / CLOSE / MODIFY_SL / MODIFY_TP                    |
//|   Magic Number設定 / Volume・SL/TP検証                           |
//|   Execution Result返却 / Position同期 / Deal同期                 |
//|                                                                  |
//| 責務 ✗（絶対に追加しない）                                       |
//|   Strategy判断 / EMA・RSI計算 / Signal生成 / AI判断             |
//|                                                                  |
//| Safety Design:                                                   |
//|   trading_enabled=false → 全注文停止（CLOSE含む）               |
//|   emergency_stop=true → BUY/SELL停止、CLOSE許可（リスク削減）   |
//|   Demo account を厳格に確認                                      |
//|   Idempotency: in-memory cache + DB Status check                 |
//|   Expiry: expires_at確認後に注文送信                             |
//+------------------------------------------------------------------+
#property copyright "AVL AI Trading System"
#property version   "1.00"
#include <Trade/Trade.mqh>

//=================================================================//
//  入力パラメーター                                                //
//=================================================================//

sinput group "=== AVL Gateway 接続設定 ==="
input string InpGatewayURL       = "https://remarkable-cooperation-production-7341.up.railway.app";
input string InpGatewaySecret    = "";   // MT5_GATEWAY_SECRET

sinput group "=== Connection認証 ==="
input string InpConnectionId     = "";   // AVL-FX の mt5_connections.id (UUID)
input string InpConnectionToken  = "";   // AVL-FX で発行されたConnection Token (平文)

sinput group "=== Polling設定 ==="
input int    InpPollIntervalSec  = 5;    // Pending Command ポーリング間隔 (秒)
input int    InpHeartbeatSec     = 15;   // Heartbeat送信間隔 (秒)
input int    InpPositionSyncSec  = 10;   // Position同期間隔 (秒)
input int    InpDealSyncSec      = 30;   // Deal同期間隔 (秒)

sinput group "=== Safety ==="
input bool   InpDemoOnly         = true; // true: DEMO口座以外を拒否
input double InpMinVolume        = 0.01; // 最小許容ロット

sinput group "=== Order設定 ==="
input int    InpDeviationPoints  = 30;   // スリッページ許容 (points)

//=================================================================//
//  グローバル変数                                                  //
//=================================================================//

CTrade g_Trade;

// Safety flags（Heartbeat応答で更新）
bool   g_TradingEnabled = false;
bool   g_EmergencyStop  = true;   // 安全側デフォルト
string g_AccountMode    = "HEDGING";

// Timing
datetime g_LastPollTime     = 0;
datetime g_LastHeartbeat    = 0;
datetime g_LastPositionSync = 0;
datetime g_LastDealSync     = 0;

// Idempotency cache（in-memory, セッション中のみ有効）
string g_ProcessedIds[];
int    g_ProcessedCount = 0;
#define MAX_PROCESSED_CACHE 1000

// Account info（起動時に取得）
bool   g_IsDemo  = false;
long   g_Login   = 0;
string g_Broker  = "";

//=================================================================//
//  OnInit                                                          //
//=================================================================//
int OnInit()
{
   // 入力バリデーション
   if(StringLen(InpConnectionId) < 10) {
      Alert("[Bridge] InpConnectionId が未設定です。EAを停止します。");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(StringLen(InpConnectionToken) < 10) {
      Alert("[Bridge] InpConnectionToken が未設定です。EAを停止します。");
      return(INIT_PARAMETERS_INCORRECT);
   }

   // アカウント情報確認
   ENUM_ACCOUNT_TRADE_MODE tradeMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   g_IsDemo  = (tradeMode == ACCOUNT_TRADE_MODE_DEMO);
   g_Login   = AccountInfoInteger(ACCOUNT_LOGIN);
   g_Broker  = AccountInfoString(ACCOUNT_COMPANY);

   ENUM_ACCOUNT_MARGIN_MODE marginMode = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   g_AccountMode = (marginMode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) ? "HEDGING" : "NETTING";

   Print("==============================================");
   Print("  AVL Execution Bridge v1.0");
   Print("==============================================");
   Print("  Login      : ", g_Login);
   Print("  Broker     : ", g_Broker);
   Print("  IsDemo     : ", g_IsDemo ? "YES (DEMO)" : "NO (REAL)");
   Print("  AccountMode: ", g_AccountMode);
   Print("  ConnectionId: ", InpConnectionId);
   Print("  Gateway    : ", InpGatewayURL);
   Print("==============================================");

   // Demo Only チェック
   if(InpDemoOnly && !g_IsDemo) {
      Alert("[Bridge] Demo Only モードですがREAL口座です。EAを停止します。");
      return(INIT_PARAMETERS_INCORRECT);
   }

   // CTrade 設定
   g_Trade.SetExpertMagicNumber(0);
   g_Trade.SetDeviationInPoints((ulong)InpDeviationPoints);
   g_Trade.SetTypeFilling(ORDER_FILLING_IOC);
   g_Trade.SetAsyncMode(false);

   // Processed cache 初期化
   ArrayResize(g_ProcessedIds, MAX_PROCESSED_CACHE);
   g_ProcessedCount = 0;

   // タイマー設定（500ms）
   EventSetMillisecondTimer(500);

   // 初回Heartbeat（接続確立 + Safety flags取得）
   if(!Heartbeat_Send()) {
      Print("[Bridge] 初回Heartbeat失敗。Gateway接続を確認してください。");
   }

   return(INIT_SUCCEEDED);
}

//=================================================================//
//  OnDeinit                                                        //
//=================================================================//
void OnDeinit(const int reason)
{
   EventKillTimer();
   Bridge_Disconnect();
   Print("[Bridge] EA終了 reason=", reason);
}

//=================================================================//
//  OnTimer（メインループ）                                          //
//=================================================================//
void OnTimer()
{
   datetime now = TimeCurrent();

   // Heartbeat
   if((int)(now - g_LastHeartbeat) >= InpHeartbeatSec) {
      Heartbeat_Send();
      g_LastHeartbeat = now;
   }

   // Position同期
   if((int)(now - g_LastPositionSync) >= InpPositionSyncSec) {
      PositionSync_Send();
      g_LastPositionSync = now;
   }

   // Deal同期（直近分）
   if((int)(now - g_LastDealSync) >= InpDealSyncSec) {
      DealSync_Send(false);
      g_LastDealSync = now;
   }

   // Command ポーリング
   if((int)(now - g_LastPollTime) >= InpPollIntervalSec) {
      Command_Poll();
      g_LastPollTime = now;
   }
}

//=================================================================//
//  Heartbeat                                                       //
//=================================================================//
bool Heartbeat_Send()
{
   ENUM_ACCOUNT_TRADE_MODE tradeMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   bool tradeAllowed = AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) == 1;

   string body = StringFormat(
      "{\"mt5Login\":%I64d,\"broker\":\"%s\","
      "\"accountType\":\"%s\",\"accountMode\":\"%s\","
      "\"tradeAllowed\":%s,"
      "\"balance\":%.2f,\"equity\":%.2f,"
      "\"margin\":%.2f,\"freeMargin\":%.2f,"
      "\"leverage\":%d}",
      g_Login, g_Broker,
      (tradeMode == ACCOUNT_TRADE_MODE_DEMO) ? "DEMO" : "REAL",
      g_AccountMode,
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
      // Safety flags更新（JSON応答から取得）
      string tradingEnabledStr = JsonGetStr(response, "tradingEnabled");
      string emergencyStopStr  = JsonGetStr(response, "emergencyStop");

      if(StringLen(tradingEnabledStr) > 0)
         g_TradingEnabled = (tradingEnabledStr == "true");
      if(StringLen(emergencyStopStr) > 0)
         g_EmergencyStop = (emergencyStopStr == "true");

      string accountMode = JsonGetStr(response, "accountMode");
      if(StringLen(accountMode) > 0)
         g_AccountMode = accountMode;

      Print("[Bridge] Heartbeat OK | tradingEnabled=", g_TradingEnabled,
            " emergencyStop=", g_EmergencyStop);
      return true;
   }

   Print("[Bridge] Heartbeat FAIL code=", code);
   return false;
}

void Bridge_Disconnect()
{
   HTTP_Post("/bridge/disconnect", "{}", (string &)"");
   Print("[Bridge] 切断通知送信");
}

//=================================================================//
//  Command Polling                                                 //
//=================================================================//
void Command_Poll()
{
   // Supabase未設定や接続不可時はスキップ
   char req[], res[];
   string headers = BuildHeaders();
   string resHdr;
   string url = InpGatewayURL + "/execution-commands/pending";

   int code = WebRequest("GET", url, headers, 5000, req, res, resHdr);
   if(code != 200 || ArraySize(res) == 0) {
      if(code != 200)
         Print("[Bridge] Poll FAIL code=", code);
      return;
   }

   string response = CharArrayToString(res);
   if(StringLen(response) <= 2) return; // [] empty

   // JSONの配列を1要素ずつ処理
   // 形式: [{"commandId":"...","action":"BUY",...},...]
   int searchPos = 0;
   int depth = 0;
   int objStart = -1;

   for(int i = 0; i < StringLen(response); i++) {
      string ch = StringSubstr(response, i, 1);
      if(ch == "{") {
         if(depth == 0) objStart = i;
         depth++;
      } else if(ch == "}") {
         depth--;
         if(depth == 0 && objStart >= 0) {
            string cmdJson = StringSubstr(response, objStart, i - objStart + 1);
            Command_Process(cmdJson);
            objStart = -1;
         }
      }
   }
}

//=================================================================//
//  Individual Command Processing                                   //
//=================================================================//
void Command_Process(const string cmdJson)
{
   // フィールド解析
   string commandId    = JsonGetStr(cmdJson, "commandId");
   string action       = JsonGetStr(cmdJson, "action");
   string symbol       = JsonGetStr(cmdJson, "symbol");
   double volume       = JsonGetDbl(cmdJson, "volume");
   long   magicNumber  = (long)JsonGetDbl(cmdJson, "magicNumber");
   double sl           = JsonGetDbl(cmdJson, "stopLoss");
   double tp           = JsonGetDbl(cmdJson, "takeProfit");
   long   posTkt       = (long)JsonGetDbl(cmdJson, "positionTicket");
   string expiresAt    = JsonGetStr(cmdJson, "expiresAt");
   string strategyId   = JsonGetStr(cmdJson, "strategyId");

   if(StringLen(commandId) == 0 || StringLen(action) == 0) {
      Print("[Bridge] Malformed command JSON: ", cmdJson);
      return;
   }

   Print("[Bridge] Command受信 | commandId=", commandId,
         " action=", action, " symbol=", symbol,
         " magic=", magicNumber);

   // ─── 1. Idempotency: In-memory cache確認 ─────────────────────
   if(IsProcessed(commandId)) {
      Print("[Bridge] SKIP（In-memory cache: 処理済み）commandId=", commandId);
      return;
   }

   // ─── 2. Expiry確認 ───────────────────────────────────────────
   if(StringLen(expiresAt) > 0) {
      datetime expiry = ParseISO(expiresAt);
      if(expiry > 0 && TimeCurrent() > expiry) {
         Print("[Bridge] EXPIRED commandId=", commandId,
               " expiresAt=", expiresAt);
         MarkProcessed(commandId);
         Result_Send(commandId, "EXPIRED", false, 0,
                     0, 0, 0, 0, 0, 0, 0, 0,
                     -1, "Command expired before execution");
         return;
      }
   }

   // ─── 3. Safety Guards ────────────────────────────────────────
   // trading_enabled=false → 全注文停止（CLOSE含む）
   if(!g_TradingEnabled) {
      Print("[Bridge] BLOCKED: trading_enabled=false commandId=", commandId);
      MarkProcessed(commandId);
      Result_Send(commandId, "REJECTED", false, 0,
                  0, 0, 0, 0, 0, 0, 0, 0,
                  -1, "TRADING_DISABLED");
      return;
   }

   // emergency_stop=true → BUY/SELL停止、CLOSEは許可
   if(g_EmergencyStop && (action == "BUY" || action == "SELL")) {
      Print("[Bridge] BLOCKED: emergency_stop=true action=", action,
            " commandId=", commandId);
      MarkProcessed(commandId);
      Result_Send(commandId, "REJECTED", false, 0,
                  0, 0, 0, 0, 0, 0, 0, 0,
                  -1, "EMERGENCY_STOP_ACTIVE");
      return;
   }

   // ─── 4. Atomic Claim（PENDING → CLAIMED） ────────────────────
   if(!Command_Claim(commandId)) {
      Print("[Bridge] Claim失敗（別プロセスが処理中か存在しない）commandId=",
            commandId);
      MarkProcessed(commandId); // 再取得を防ぐ
      return;
   }

   // ─── 5. 入力バリデーション ────────────────────────────────────
   if(StringLen(symbol) == 0) {
      Send_Failed(commandId, "symbol が空です");
      return;
   }
   if(magicNumber < 20001 || magicNumber > 29999) {
      Send_Failed(commandId, StringFormat("magic_number=%I64d が範囲外（20001〜29999）", magicNumber));
      return;
   }

   // Symbol存在確認
   if(!SymbolSelect(symbol, true)) {
      Print("[Bridge] Symbol不明: ", symbol);
      Send_Failed(commandId, "Symbol not found in Market Watch: " + symbol);
      return;
   }

   // ─── 6. 注文実行 ─────────────────────────────────────────────
   MarkProcessed(commandId);

   // Magic Number設定
   g_Trade.SetExpertMagicNumber((ulong)magicNumber);

   bool ok = false;
   int  retcode = 0;
   long orderTkt = 0, dealTkt = 0, positionTkt = 0;
   double execPrice = 0;

   if(action == "BUY") {
      ok = Execute_BUY(commandId, symbol, volume, sl, tp,
                       retcode, orderTkt, dealTkt, positionTkt, execPrice);

   } else if(action == "SELL") {
      ok = Execute_SELL(commandId, symbol, volume, sl, tp,
                        retcode, orderTkt, dealTkt, positionTkt, execPrice);

   } else if(action == "CLOSE") {
      ok = Execute_CLOSE(commandId, symbol, (ulong)posTkt, magicNumber,
                         retcode, orderTkt, dealTkt, execPrice);
      if(ok) positionTkt = posTkt;

   } else if(action == "MODIFY_SL") {
      ok = Execute_MODIFY(commandId, (ulong)posTkt, sl, 0, true, false, retcode);

   } else if(action == "MODIFY_TP") {
      ok = Execute_MODIFY(commandId, (ulong)posTkt, 0, tp, false, true, retcode);

   } else {
      Print("[Bridge] 未知のaction: ", action, " commandId=", commandId);
      Send_Failed(commandId, "Unknown action: " + action);
      return;
   }

   // ─── 7. Result送信 ────────────────────────────────────────────
   string brokerTime = TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + " UTC";

   if(ok) {
      double execVol = (action == "CLOSE") ? 0.0 : volume;
      Result_Send(commandId, "FILLED", true, retcode,
                  orderTkt, dealTkt, positionTkt,
                  0, execPrice, volume, execVol,
                  0, "");

      // Deal同期（約定直後）
      if(dealTkt > 0)
         DealSync_Single(commandId, dealTkt);

      // Position同期（ポジション状態更新）
      PositionSync_Send();

   } else {
      string errDesc = StringFormat(
         "MT5 retcode=%d: %s", retcode,
         GetRetcodeDescription(retcode)
      );
      Result_Send(commandId, "FAILED", false, retcode,
                  0, 0, 0,
                  0, 0, volume, 0,
                  retcode, errDesc);
   }
}

//=================================================================//
//  BUY実行                                                        //
//=================================================================//
bool Execute_BUY(
   const string commandId,
   const string symbol,
   const double volume,
   const double sl,
   const double tp,
   int    &retcode,
   long   &orderTkt,
   long   &dealTkt,
   long   &positionTkt,
   double &execPrice
)
{
   // Volume検証
   if(!Validate_Volume(symbol, volume)) {
      Send_Failed(commandId, StringFormat("Invalid volume=%.2f for %s", volume, symbol));
      return false;
   }

   // SL/TP 価格丸め
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double roundedSL = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   double roundedTP = (tp > 0) ? NormalizeDouble(tp, digits) : 0;

   // SL/TP Stops Level検証
   double stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) *
                       SymbolInfoDouble(symbol, SYMBOL_POINT);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);

   if(roundedSL > 0 && ask - roundedSL < stopsLevel) {
      Print("[Bridge] SL too close to price. symbol=", symbol,
            " ask=", ask, " sl=", roundedSL, " stopsLevel=", stopsLevel);
      roundedSL = 0; // SL無しで注文（安全側）
   }
   if(roundedTP > 0 && roundedTP - ask < stopsLevel) {
      Print("[Bridge] TP too close to price. Clearing TP.");
      roundedTP = 0;
   }

   bool ok = g_Trade.Buy(volume, symbol, 0, roundedSL, roundedTP, "AVL-Bridge");
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   positionTkt = (long)g_Trade.ResultDeal(); // Market orderでは deal≈position
   execPrice   = g_Trade.ResultPrice();

   Print("[Bridge] BUY ", symbol, " vol=", volume,
         " ok=", ok, " retcode=", retcode,
         " order=", orderTkt, " deal=", dealTkt);
   return ok;
}

//=================================================================//
//  SELL実行                                                        //
//=================================================================//
bool Execute_SELL(
   const string commandId,
   const string symbol,
   const double volume,
   const double sl,
   const double tp,
   int    &retcode,
   long   &orderTkt,
   long   &dealTkt,
   long   &positionTkt,
   double &execPrice
)
{
   if(!Validate_Volume(symbol, volume)) {
      Send_Failed(commandId, StringFormat("Invalid volume=%.2f for %s", volume, symbol));
      return false;
   }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double roundedSL = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   double roundedTP = (tp > 0) ? NormalizeDouble(tp, digits) : 0;

   double stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) *
                       SymbolInfoDouble(symbol, SYMBOL_POINT);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);

   if(roundedSL > 0 && roundedSL - bid < stopsLevel) {
      Print("[Bridge] SL too close. Clearing SL for safety.");
      roundedSL = 0;
   }
   if(roundedTP > 0 && bid - roundedTP < stopsLevel) {
      Print("[Bridge] TP too close. Clearing TP.");
      roundedTP = 0;
   }

   bool ok = g_Trade.Sell(volume, symbol, 0, roundedSL, roundedTP, "AVL-Bridge");
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   positionTkt = (long)g_Trade.ResultDeal();
   execPrice   = g_Trade.ResultPrice();

   Print("[Bridge] SELL ", symbol, " vol=", volume,
         " ok=", ok, " retcode=", retcode,
         " order=", orderTkt, " deal=", dealTkt);
   return ok;
}

//=================================================================//
//  CLOSE実行                                                       //
//=================================================================//
bool Execute_CLOSE(
   const string commandId,
   const string symbol,
   const ulong  positionTicket,
   const long   expectedMagic,
   int    &retcode,
   long   &orderTkt,
   long   &dealTkt,
   double &execPrice
)
{
   if(positionTicket == 0) {
      Send_Failed(commandId, "CLOSE: positionTicket が必要です");
      return false;
   }

   // PositionSelectByTicketで存在確認
   if(!PositionSelectByTicket(positionTicket)) {
      Print("[Bridge] CLOSE: Position ticket=", positionTicket, " not found");
      Send_Failed(commandId, StringFormat("Position %I64d not found", (long)positionTicket));
      return false;
   }

   // Magic Number整合性確認（他Strategyのポジションを誤って閉じない）
   long posMagic = (long)PositionGetInteger(POSITION_MAGIC);
   if(expectedMagic > 0 && posMagic != expectedMagic) {
      Print("[Bridge] CLOSE: Magic mismatch! expected=", expectedMagic,
            " actual=", posMagic, " ticket=", positionTicket);
      Send_Failed(commandId,
         StringFormat("Magic number mismatch: expected=%I64d actual=%I64d",
                      expectedMagic, posMagic));
      return false;
   }

   // Symbol確認
   string posSymbol = PositionGetString(POSITION_SYMBOL);
   if(StringLen(symbol) > 0 && posSymbol != symbol) {
      Print("[Bridge] CLOSE: Symbol mismatch! expected=", symbol,
            " actual=", posSymbol);
      Send_Failed(commandId,
         StringFormat("Symbol mismatch: expected=%s actual=%s", symbol, posSymbol));
      return false;
   }

   bool ok = g_Trade.PositionClose(positionTicket);
   retcode  = (int)g_Trade.ResultRetcode();
   orderTkt = (long)g_Trade.ResultOrder();
   dealTkt  = (long)g_Trade.ResultDeal();
   execPrice = g_Trade.ResultPrice();

   Print("[Bridge] CLOSE ticket=", positionTicket,
         " ok=", ok, " retcode=", retcode,
         " deal=", dealTkt);
   return ok;
}

//=================================================================//
//  MODIFY_SL / MODIFY_TP                                          //
//=================================================================//
bool Execute_MODIFY(
   const string commandId,
   const ulong  positionTicket,
   const double newSL,
   const double newTP,
   const bool   modifySL,
   const bool   modifyTP,
   int &retcode
)
{
   if(positionTicket == 0) {
      Send_Failed(commandId, "MODIFY: positionTicket が必要です");
      return false;
   }

   if(!PositionSelectByTicket(positionTicket)) {
      Send_Failed(commandId, StringFormat("Position %I64u not found", positionTicket));
      return false;
   }

   double currentSL = PositionGetDouble(POSITION_SL);
   double currentTP = PositionGetDouble(POSITION_TP);
   string sym       = PositionGetString(POSITION_SYMBOL);
   int    digits    = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);

   double applyingSL = modifySL ? NormalizeDouble(newSL, digits) : currentSL;
   double applyingTP = modifyTP ? NormalizeDouble(newTP, digits) : currentTP;

   bool ok = g_Trade.PositionModify(positionTicket, applyingSL, applyingTP);
   retcode = (int)g_Trade.ResultRetcode();

   Print("[Bridge] MODIFY ticket=", positionTicket,
         " sl=", applyingSL, " tp=", applyingTP,
         " ok=", ok, " retcode=", retcode);
   return ok;
}

//=================================================================//
//  Position Sync                                                   //
//=================================================================//
void PositionSync_Send()
{
   string posArr = "";
   int count = 0;

   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string sym  = PositionGetString(POSITION_SYMBOL);
      int    type = (int)PositionGetInteger(POSITION_TYPE);
      long   magic = (long)PositionGetInteger(POSITION_MAGIC);
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
         (long)ticket, sym,
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
         TimeToString(openTime, TIME_DATE|TIME_SECONDS)
      );
      count++;
   }

   string body = StringFormat("{\"positions\":[%s]}", posArr);
   string resp = "";
   HTTP_Post("/bridge/positions", body, resp);
}

//=================================================================//
//  Deal Sync（直近N日分）                                          //
//=================================================================//
void DealSync_Send(const bool initialSync)
{
   datetime from = TimeCurrent() - (initialSync ? 30 : 1) * 86400; // 初回30日、以降1日
   HistorySelect(from, TimeCurrent());

   string dealArr = "";
   int count = 0;
   int total = HistoryDealsTotal();

   for(int i = 0; i < total; i++) {
      ulong dealTkt = HistoryDealGetTicket(i);
      if(dealTkt == 0) continue;

      ENUM_DEAL_TYPE dealType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTkt, DEAL_TYPE);
      if(dealType != DEAL_TYPE_BUY && dealType != DEAL_TYPE_SELL) continue;

      ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTkt, DEAL_ENTRY);
      string entryStr = (entry == DEAL_ENTRY_IN) ? "IN" :
                        (entry == DEAL_ENTRY_OUT) ? "OUT" : "INOUT";

      long orderTkt = HistoryDealGetInteger(dealTkt, DEAL_ORDER);
      long posTkt   = HistoryDealGetInteger(dealTkt, DEAL_POSITION_ID);
      long magic    = HistoryDealGetInteger(dealTkt, DEAL_MAGIC);
      datetime dealTime = (datetime)HistoryDealGetInteger(dealTkt, DEAL_TIME);

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
         (long)dealTkt, orderTkt, posTkt,
         HistoryDealGetString(dealTkt, DEAL_SYMBOL),
         (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL",
         entryStr,
         HistoryDealGetDouble(dealTkt, DEAL_VOLUME),
         HistoryDealGetDouble(dealTkt, DEAL_PRICE),
         HistoryDealGetDouble(dealTkt, DEAL_PROFIT),
         HistoryDealGetDouble(dealTkt, DEAL_COMMISSION),
         HistoryDealGetDouble(dealTkt, DEAL_SWAP),
         TimeToString(dealTime, TIME_DATE|TIME_SECONDS) + " UTC",
         magic
      );
      count++;
   }

   if(count == 0) return;

   string body = StringFormat("{\"deals\":[%s]}", dealArr);
   string resp = "";
   HTTP_Post("/bridge/deals", body, resp);
   Print("[Bridge] Deal同期: ", count, "件");
}

void DealSync_Single(const string commandId, const long dealTicket)
{
   HistoryDealSelect(dealTicket);

   ENUM_DEAL_TYPE dealType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTicket, DEAL_TYPE);
   ENUM_DEAL_ENTRY entry   = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
   string entryStr = (entry == DEAL_ENTRY_IN) ? "IN" :
                     (entry == DEAL_ENTRY_OUT) ? "OUT" : "INOUT";

   long orderTkt = HistoryDealGetInteger(dealTicket, DEAL_ORDER);
   long posTkt   = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   long magic    = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
   datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);

   string body = StringFormat(
      "{\"deals\":[{"
      "\"dealTicket\":%I64d"
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
      ",\"commandId\":\"%s\"}]}",
      dealTicket, orderTkt, posTkt,
      HistoryDealGetString(dealTicket, DEAL_SYMBOL),
      (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL",
      entryStr,
      HistoryDealGetDouble(dealTicket, DEAL_VOLUME),
      HistoryDealGetDouble(dealTicket, DEAL_PRICE),
      HistoryDealGetDouble(dealTicket, DEAL_PROFIT),
      HistoryDealGetDouble(dealTicket, DEAL_COMMISSION),
      HistoryDealGetDouble(dealTicket, DEAL_SWAP),
      TimeToString(dealTime, TIME_DATE|TIME_SECONDS) + " UTC",
      magic, commandId
   );

   string resp = "";
   HTTP_Post("/bridge/deals", body, resp);
}

//=================================================================//
//  Command Claim（Atomic: PENDING → CLAIMED）                     //
//=================================================================//
bool Command_Claim(const string commandId)
{
   string path = "/execution-commands/" + commandId + "/claim";
   string body = "{}";
   string resp = "";
   int code = HTTP_Post(path, body, resp);
   return (code == 200);
}

//=================================================================//
//  Result送信                                                      //
//=================================================================//
void Result_Send(
   const string commandId,
   const string status,
   const bool   success,
   const int    retcode,
   const long   orderTkt,
   const long   dealTkt,
   const long   posTkt,
   const double reqPrice,
   const double execPrice,
   const double reqVol,
   const double execVol,
   const int    errorCode,
   const string errorMessage
)
{
   string body = StringFormat(
      "{\"commandId\":\"%s\""
      ",\"success\":%s"
      ",\"status\":\"%s\""
      ",\"retcode\":%d"
      ",\"orderTicket\":%I64d"
      ",\"dealTicket\":%I64d"
      ",\"positionTicket\":%I64d"
      ",\"requestedPrice\":%.5f"
      ",\"executionPrice\":%.5f"
      ",\"requestedVolume\":%.2f"
      ",\"executedVolume\":%.2f"
      ",\"errorCode\":%d"
      ",\"errorMessage\":\"%s\""
      ",\"brokerTime\":\"%s\""
      ",\"receivedAt\":\"%s\"}",
      commandId,
      success ? "true" : "false",
      status,
      retcode,
      orderTkt, dealTkt, posTkt,
      reqPrice, execPrice,
      reqVol, execVol,
      errorCode,
      errorMessage,
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + " UTC",
      TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + " UTC"
   );

   string path = "/execution-commands/" + commandId + "/result";
   string resp = "";
   int code = HTTP_Post(path, body, resp);
   Print("[Bridge] Result送信 commandId=", commandId,
         " status=", status, " code=", code);
}

void Send_Failed(const string commandId, const string reason)
{
   MarkProcessed(commandId);
   Result_Send(commandId, "FAILED", false, 0,
               0, 0, 0, 0, 0, 0, 0,
               -1, reason);
}

//=================================================================//
//  Volume検証                                                      //
//=================================================================//
bool Validate_Volume(const string symbol, const double volume)
{
   if(volume <= 0) return false;
   if(volume < InpMinVolume) return false;

   double minVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVol  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double stepVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   if(minVol > 0 && volume < minVol) return false;
   if(maxVol > 0 && volume > maxVol) return false;
   if(stepVol > 0) {
      // Stepに合わせて丸め（許容誤差: step/2以内）
      double rounded = MathRound(volume / stepVol) * stepVol;
      if(MathAbs(rounded - volume) > stepVol * 0.5) return false;
   }
   return true;
}

//=================================================================//
//  Retcode解説                                                     //
//=================================================================//
string GetRetcodeDescription(const int retcode)
{
   switch(retcode) {
      case 0:     return "Success";
      case 10004: return "Requote";
      case 10006: return "Request rejected";
      case 10007: return "Request cancelled by trader";
      case 10008: return "Order placed";
      case 10009: return "Request completed";
      case 10010: return "Only part of the request was completed";
      case 10011: return "Request processing error";
      case 10012: return "Request cancelled by timeout";
      case 10013: return "Invalid request";
      case 10014: return "Invalid volume";
      case 10015: return "Invalid price";
      case 10016: return "Invalid stops";
      case 10017: return "Trade is disabled";
      case 10018: return "Market is closed";
      case 10019: return "Not enough money";
      case 10020: return "Prices changed";
      case 10021: return "No quotes";
      case 10022: return "Invalid order expiration date";
      case 10023: return "Order state changed";
      case 10024: return "Too frequent requests";
      case 10025: return "No changes in request";
      case 10026: return "Autotrading disabled by server";
      case 10027: return "Autotrading disabled by client";
      case 10028: return "Request locked for processing";
      case 10029: return "Order or position frozen";
      case 10030: return "Invalid order filling type";
      default:    return StringFormat("Unknown retcode %d", retcode);
   }
}

//=================================================================//
//  Idempotency Cache                                               //
//=================================================================//
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
      // 古いエントリを半分クリア（FIFO簡易実装）
      int keep = MAX_PROCESSED_CACHE / 2;
      for(int i = 0; i < keep; i++)
         g_ProcessedIds[i] = g_ProcessedIds[g_ProcessedCount - keep + i];
      g_ProcessedCount = keep;
   }
   g_ProcessedIds[g_ProcessedCount++] = commandId;
}

//=================================================================//
//  ISO 8601 → datetime変換                                        //
//  "2026-09-03T12:00:00.000Z" → datetime (UTC)                   //
//=================================================================//
datetime ParseISO(const string iso)
{
   if(StringLen(iso) < 19) return 0;
   // "YYYY-MM-DD" + "HH:MM:SS"
   string datePart = StringSubstr(iso, 0, 10);
   string timePart = StringSubstr(iso, 11, 8);
   // "YYYY.MM.DD HH:MM:SS" (MQL5 StringToTimeが受け付ける形式)
   string converted = StringSubstr(datePart, 0, 4) + "."
                    + StringSubstr(datePart, 5, 2) + "."
                    + StringSubstr(datePart, 8, 2) + " "
                    + timePart;
   return StringToTime(converted);
}

//=================================================================//
//  JSON ユーティリティ                                             //
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
   // Stringパターン("key":"value")は先にスキップ
   string strPat = "\"" + key + "\":\"";
   if(StringFind(json, strPat) >= 0) return 0.0;

   string pat = "\"" + key + "\":";
   int s = StringFind(json, pat);
   if(s < 0) return 0.0;
   s += StringLen(pat);
   if(s >= StringLen(json)) return 0.0;

   string ch = StringSubstr(json, s, 1);
   if(ch == "n" || ch == "\"") return 0.0; // null or string

   string num = "";
   for(int i = s; i < StringLen(json) && i < s + 30; i++) {
      ch = StringSubstr(json, i, 1);
      if(ch == "," || ch == "}" || ch == "]" || ch == " " || ch == "\r" || ch == "\n") break;
      num += ch;
   }
   return StringToDouble(num);
}

//=================================================================//
//  HTTP POST                                                       //
//=================================================================//
int HTTP_Post(const string path, const string body, string &response)
{
   string headers = BuildHeaders() +
                    "Content-Type: application/json\r\n";
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
            Print("!!! WebRequest未許可 → ツール>オプション>EA>WebRequest許可: ", InpGatewayURL);
            alerted = true;
         }
      }
   }
   return code;
}

string BuildHeaders()
{
   return "Authorization: Bearer " + InpGatewaySecret + "\r\n"
        + "X-Connection-Id: " + InpConnectionId + "\r\n"
        + "X-Connection-Token: " + InpConnectionToken + "\r\n";
}
