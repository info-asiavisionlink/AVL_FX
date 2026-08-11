// =================================================================
// POST /api/ai/brain/migrate — Supabase マイグレーション実行
// trade_audit_log テーブルを作成する（存在しない場合のみ）
// =================================================================

import { NextResponse } from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS trade_audit_log (
  id               TEXT PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL,
  symbol           TEXT NOT NULL,
  snapshot_id      TEXT,
  ai_model         TEXT,
  decision         TEXT NOT NULL,
  confidence       NUMERIC,
  entry            NUMERIC,
  sl               NUMERIC,
  tp               NUMERIC,
  rr               NUMERIC,
  expected_value   NUMERIC,
  lot              NUMERIC,
  risk_pct         NUMERIC,
  risk_status      TEXT,
  rejection_reason TEXT,
  order_ticket     BIGINT,
  execution_price  NUMERIC,
  slippage_pips    NUMERIC,
  result_pnl       NUMERIC,
  live_trading     BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trade_audit_log_symbol_idx ON trade_audit_log(symbol);
CREATE INDEX IF NOT EXISTS trade_audit_log_ts_idx ON trade_audit_log(ts DESC);
`;

export async function POST() {
  try {
    const db = createAdminClient();

    // テーブルが既に存在するか確認
    const { error: checkErr } = await db
      .from("trade_audit_log")
      .select("id")
      .limit(1);

    if (!checkErr) {
      return NextResponse.json({ status: "already_exists", message: "trade_audit_log テーブルは既に存在します" });
    }

    // Supabase は REST API 経由で raw SQL を直接実行できないため、
    // pg_extensions を使用する
    const { error } = await (db as unknown as {
      rpc: (name: string, args: Record<string, string>) => Promise<{ error: { message: string } | null }>
    }).rpc("exec_ddl", { ddl: CREATE_TABLE_SQL });

    if (error) {
      // rpc が存在しない場合は Supabase Dashboard での手動実行が必要
      return NextResponse.json({
        status: "manual_required",
        message: "Supabase Dashboard > SQL Editor で以下を実行してください",
        sql: CREATE_TABLE_SQL,
        error: error.message,
      }, { status: 200 });
    }

    // 作成確認
    const { error: verifyErr } = await db.from("trade_audit_log").select("id").limit(1);
    return NextResponse.json({
      status: verifyErr ? "error" : "created",
      message: verifyErr ? verifyErr.message : "trade_audit_log テーブルを作成しました",
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
