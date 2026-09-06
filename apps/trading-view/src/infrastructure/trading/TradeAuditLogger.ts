// =================================================================
// TradeAuditLogger — 全 AI 決定を Supabase に記録
//
// AI 決定 → Risk Engine → 実行結果 の全ステップを保存する。
// =================================================================

import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { TradeAuditRecord } from "@/domain/trading/MarketSnapshot";
import { randomUUID } from "crypto";

export function makeAuditId(): string {
  return randomUUID();
}

export async function logTradeDecision(record: Omit<TradeAuditRecord, "id" | "ts">): Promise<string> {
  const id = makeAuditId();
  const row: TradeAuditRecord = { id, ts: Date.now(), ...record };

  try {
    const db = createAdminClient();
    const { error } = await db.from("trade_audit_log").insert([{
      id:               row.id,
      ts:               new Date(row.ts).toISOString(),
      symbol:           row.symbol,
      snapshot_id:      row.snapshot_id,
      ai_model:         row.ai_model,
      decision:         row.decision,
      confidence:       row.confidence,
      entry:            row.entry,
      sl:               row.sl,
      tp:               row.tp,
      rr:               row.rr,
      expected_value:   row.expected_value,
      lot:              row.lot,
      risk_pct:         row.risk_pct,
      risk_status:      row.risk_status,
      rejection_reason: row.rejection_reason,
      order_ticket:     row.order_ticket,
      execution_price:  row.execution_price,
      slippage_pips:    row.slippage_pips,
      result_pnl:       row.result_pnl,
      live_trading:     row.live_trading,
    }]);
    if (error) console.error("[AuditLogger]", error.message);
  } catch (e) {
    console.error("[AuditLogger] insert failed:", e);
  }

  return id;
}
