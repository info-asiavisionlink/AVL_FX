/**
 * dev-create-test-command.ts — STAGE 3-B E2Eテスト用コマンド作成ユーティリティ
 *
 * 目的:
 *   Strategy RuntimeがまだないSTAGE 3-Bでの手動E2Eテスト用。
 *   Supabaseに直接Execution Commandを作成する。
 *
 * 安全ガード:
 *   - Demo口座のConnectionのみ対象（account_type = 'DEMO'）
 *   - service role keyが必要（開発者のみ使用可）
 *   - Production環境では実行不可（NODE_ENV=production時は拒否）
 *   - volume: 最小ロット（デフォルト0.01）
 *   - 一度に1件のみ作成
 *
 * 使用方法:
 *   npx tsx scripts/dev-create-test-command.ts \
 *     --connection-id <UUID> \
 *     --strategy-id  <UUID> \
 *     --action       BUY \
 *     --symbol       EURUSD \
 *     --magic        20001 \
 *     --volume       0.01 \
 *     [--sl          1.08000] \
 *     [--tp          1.09000] \
 *     [--expiry-sec  300]
 */

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";

// ─── Safety Guard: Production環境を拒否 ───────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error("ERROR: Production環境では実行できません。");
  process.exit(1);
}

// ─── CLI引数パース ────────────────────────────────────────────────
function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const connectionId = getArg("connection-id");
const strategyId   = getArg("strategy-id");
const action       = getArg("action") ?? "BUY";
const symbol       = getArg("symbol") ?? "EURUSD";
const magic        = parseInt(getArg("magic") ?? "20001", 10);
const volume       = parseFloat(getArg("volume") ?? "0.01");
const sl           = parseFloat(getArg("sl") ?? "0") || undefined;
const tp           = parseFloat(getArg("tp") ?? "0") || undefined;
const posTkt       = parseInt(getArg("position-ticket") ?? "0", 10) || undefined;
const expirySec    = parseInt(getArg("expiry-sec") ?? "300", 10);

if (!connectionId || !strategyId) {
  console.error("使用方法:");
  console.error("  npx tsx scripts/dev-create-test-command.ts \\");
  console.error("    --connection-id <UUID> \\");
  console.error("    --strategy-id   <UUID> \\");
  console.error("    --action        BUY|SELL|CLOSE \\");
  console.error("    --symbol        EURUSD \\");
  console.error("    --magic         20001 \\");
  console.error("    --volume        0.01");
  process.exit(1);
}

// ─── Validation ──────────────────────────────────────────────────
if (!["BUY", "SELL", "CLOSE", "MODIFY_SL", "MODIFY_TP"].includes(action)) {
  console.error("ERROR: action は BUY|SELL|CLOSE|MODIFY_SL|MODIFY_TP のいずれかです");
  process.exit(1);
}
if (magic < 20001 || magic > 29999) {
  console.error("ERROR: magic_number は 20001〜29999 の範囲です");
  process.exit(1);
}
if ((action === "BUY" || action === "SELL") && volume <= 0) {
  console.error("ERROR: BUY/SELL には volume > 0 が必要です");
  process.exit(1);
}
if ((action === "CLOSE" || action === "MODIFY_SL" || action === "MODIFY_TP") && !posTkt) {
  console.error("ERROR: CLOSE/MODIFY には --position-ticket が必要です");
  process.exit(1);
}

// ─── Supabase接続 ─────────────────────────────────────────────────
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
  console.error("ヒント: .env.local を source するか、環境変数を設定してください");
  process.exit(1);
}

const sb = createClient(supabaseUrl, serviceKey);

async function main() {
  // ─── Connection確認（DEMO口座のみ） ────────────────────────────
  const { data: conn, error: connErr } = await sb
    .from("mt5_connections")
    .select("id, user_id, account_type, broker, server_name, mt5_login, trading_enabled, emergency_stop")
    .eq("id", connectionId)
    .single();

  if (connErr || !conn) {
    console.error("ERROR: Connection が見つかりません:", connectionId);
    process.exit(1);
  }

  if (conn.account_type !== "DEMO") {
    console.error("ERROR: DEMO口座のConnectionのみ使用できます。");
    console.error(`  account_type = ${conn.account_type}`);
    console.error("本番口座でのE2Eテストは禁止です。");
    process.exit(1);
  }

  // ─── Strategy確認 ──────────────────────────────────────────────
  const { data: strat, error: stratErr } = await sb
    .from("strategy_registry")
    .select("id, name, magic_number, user_id")
    .eq("id", strategyId)
    .single();

  if (stratErr || !strat) {
    console.error("ERROR: Strategy が見つかりません:", strategyId);
    process.exit(1);
  }

  if (strat.magic_number !== magic) {
    console.warn(`警告: --magic ${magic} がStrategy登録値 ${strat.magic_number} と一致しません`);
  }

  if (strat.user_id !== conn.user_id) {
    console.error("ERROR: StrategyとConnectionのuser_idが一致しません");
    process.exit(1);
  }

  // ─── Command作成 ───────────────────────────────────────────────
  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + expirySec * 1000).toISOString();

  console.log("\n=== Execution Command作成 ===");
  console.log(`  Connection: ${conn.broker} login=${conn.mt5_login} (${conn.account_type})`);
  console.log(`  Strategy  : ${strat.name} (magic=${strat.magic_number})`);
  console.log(`  Action    : ${action}`);
  console.log(`  Symbol    : ${symbol}`);
  console.log(`  Volume    : ${volume}`);
  if (sl) console.log(`  SL        : ${sl}`);
  if (tp) console.log(`  TP        : ${tp}`);
  if (posTkt) console.log(`  Position  : ${posTkt}`);
  console.log(`  CommandId : ${commandId}`);
  console.log(`  ExpiresAt : ${expiresAt}`);
  console.log(`  trading_enabled: ${conn.trading_enabled}`);
  console.log(`  emergency_stop:  ${conn.emergency_stop}`);

  if (!conn.trading_enabled) {
    console.warn("\n警告: trading_enabled=false です。BridgeがREJECTEDとして返します。");
  }
  if (conn.emergency_stop && (action === "BUY" || action === "SELL")) {
    console.warn("\n警告: emergency_stop=true です。BUY/SELLはBridgeがREJECTEDとして返します。");
  }

  const { data, error } = await sb
    .from("execution_commands")
    .insert({
      command_id:      commandId,
      user_id:         conn.user_id,
      connection_id:   connectionId,
      strategy_id:     strategyId,
      magic_number:    magic,
      action,
      symbol,
      volume:          (action === "BUY" || action === "SELL") ? volume : null,
      stop_loss:       sl ?? null,
      take_profit:     tp ?? null,
      position_ticket: posTkt ?? null,
      status:          "PENDING",
      expires_at:      expiresAt,
      attempt_count:   0,
    })
    .select("id, command_id, status")
    .single();

  if (error) {
    console.error("\nERROR: Command作成失敗:", error.message);
    process.exit(1);
  }

  console.log("\n✓ Command作成成功");
  console.log(`  DB id      : ${data.id}`);
  console.log(`  command_id : ${data.command_id}`);
  console.log(`  status     : ${data.status}`);
  console.log("\nBridge EAが次のPollで取得します（約5秒）");
  console.log("結果確認:");
  console.log(`  SELECT * FROM execution_commands WHERE command_id = '${commandId}';`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
