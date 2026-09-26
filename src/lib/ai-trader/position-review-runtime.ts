import { createAdminClient } from "@/infrastructure/supabase/admin";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";
import { validateFavorableStopLossMove, validateModifySL } from "@/lib/ai-trader/market-data-validator";
import { loadCustomerKnowledge, selectCustomerKnowledge, snapshotCustomerKnowledge, formatKnowledgeForPrompt, KnowledgeUnavailableError } from "@/lib/knowledge/customer-knowledge-loader";
import { createProductionPositionCommand, createProductionRuntimeService, type RuntimePosition } from "@/lib/ai-trader/runtime-service";
import { detectPositionCandidate } from "@/lib/ai-trader/position-candidate-detector";

const GATEWAY_URL = process.env.MT5_GATEWAY_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";
async function currentTick(connectionId: string, symbol: string) {
  if (!GATEWAY_URL) return { price: 0, time: 0 };
  try { const r = await fetch(`${GATEWAY_URL}/connections/${connectionId}/tick/${encodeURIComponent(symbol)}`, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(4_000) }); if (!r.ok) return { price: 0, time: 0 }; const t = await r.json() as { bid?: number; ask?: number; time?: number; timestamp?: number }; return { price: ((t.bid ?? 0) + (t.ask ?? 0)) / 2 || 0, time: t.time ?? t.timestamp ?? 0 }; } catch { return { price: 0, time: 0 }; }
}

/** Production position-review handler; the HTTP route is only an adapter. */
export async function handleManagePositions(input: {
  db: ReturnType<typeof createAdminClient>; traderId: string; userId: string; barTime: number; trigger: string;
  aiDecision?: (position: RuntimePosition, trigger: string, knowledge: string) => Promise<{ decision: unknown; newSl?: unknown; newTp?: unknown; reasoning?: string }>;
}) {
  const { db, traderId, userId } = input;
  const { data: trader } = await db.from("ai_traders").select("id,user_id,market,current_version").eq("id", traderId).eq("user_id", userId).single();
  if (!trader) return { status: 404, body: { error: "Traderが見つかりません" } };
  const { data: profile } = await db.from("ai_trader_versions").select("id,version,magic_number").eq("ai_trader_id", traderId).eq("version", trader.current_version).single();
  const { data: rows } = await db.from("ai_positions").select("*").eq("ai_trader_id", traderId).eq("status", "OPEN");
  if (!rows?.length) return { status: 200, body: { ok: true, managed: 0 } };
  const { data: conn } = await db.from("mt5_connections").select("id,last_heartbeat_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!conn) return { status: 503, body: { ok: false, error: "POSITION_CONNECTION_UNAVAILABLE", managed: 0 } };
  const symbol = trader.market === "GOLD" ? "GOLD#" : String(trader.market);
  const tick = await currentTick(conn.id as string, symbol);
  if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.time) || tick.time <= 0) return { status: 503, body: { ok: false, error: "POSITION_MARKET_DATA_UNAVAILABLE", managed: 0 } };
  // V2: knowledge binds from Customer Supabase (Stage 4 package), never the Console API.
  let knowledgePrompt: string; let knowledgeSnapshot: ReturnType<typeof snapshotCustomerKnowledge>;
  try {
    const knowledge = await loadCustomerKnowledge(db, traderId, userId);
    const selected = selectCustomerKnowledge(knowledge, { market: String(trader.market), timeframe: "M5", triggerType: input.trigger, limit: 6 });
    if (!selected.length) throw new KnowledgeUnavailableError("EMPTY_RESULT");
    knowledgePrompt = formatKnowledgeForPrompt(selected, 1200); knowledgeSnapshot = snapshotCustomerKnowledge(selected);
  } catch { return { status: 503, body: { ok: false, error: "KNOWLEDGE_UNAVAILABLE", managed: 0 } }; }
  const client = getOpenAIClient(); const managed: Array<{ posId: string; decision: string; action?: string }> = [];
  for (const row of rows) {
    const pos: RuntimePosition = { id: row.id, traderId, scenarioId: row.scenario_id ?? "", status: "OPEN", side: String(row.side).toUpperCase() === "SELL" ? "SELL" : "BUY", entryPrice: Number(row.entry_price), currentPrice: tick.price, stopLoss: Number(row.stop_loss ?? 0), takeProfit: Number(row.take_profit ?? 0), volume: Number(row.volume ?? 0), userId, connectionId: conn.id as string, symbol, magicNumber: Number(row.magic_number ?? profile?.magic_number ?? 0), positionTicket: row.position_ticket ?? null };
    const candidate: { trigger: "TP_RECHECK" | "SL_RECHECK" | "H1_BAR_CLOSED" | null } = input.trigger === "POSITION_REVIEW"
      ? detectPositionCandidate({ side: pos.side, currentPrice: pos.currentPrice ?? 0, entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit })
      : { trigger: input.trigger === "TP_RECHECK" || input.trigger === "SL_RECHECK" || input.trigger === "H1_BAR_CLOSED" ? input.trigger : null };
    if (!candidate.trigger) continue;

    const runtime = createProductionRuntimeService(db, {
      ai: { entry: async () => ({ decision: "WAIT" }), position: async () => {
        if (input.aiDecision) return input.aiDecision(pos, input.trigger, knowledgePrompt);
        const prompt = `Return JSON only {"decision":"HOLD|CLOSE|MODIFY_SL|EXTEND_TP","new_sl":number|null,"new_tp":number|null,"reasoning":string}. Position side=${pos.side} entry=${pos.entryPrice} current=${pos.currentPrice} SL=${pos.stopLoss} TP=${pos.takeProfit}\nKnowledge:\n${knowledgePrompt}`;
        const r = await client.chat.completions.create({ model: process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chatFast, messages: [{ role: "user", content: prompt }], max_completion_tokens: 200, response_format: { type: "json_object" } });
        const p = JSON.parse(r.choices[0]?.message?.content ?? "{}"); return { decision: p.decision, newSl: p.new_sl, newTp: p.new_tp, reasoning: p.reasoning };
      } },
      risk: { entry: async () => ({ approved: false, reason: "POSITION_REVIEW_ONLY" }) },
      market: { validEntry: () => false, validPosition: p => Number.isFinite(p.currentPrice) && (p.currentPrice ?? 0) > 0 && Number.isFinite(p.entryPrice) && p.entryPrice > 0, validateHardSl: () => true, validateModifySl: (p, v) => validateModifySL(typeof v === "number" ? v : null, p.currentPrice ?? 0, p.side, 0, 2).valid && validateFavorableStopLossMove(typeof v === "number" ? v : null, p.stopLoss, p.side, 2).valid, validateModifyTp: (p, v) => typeof v === "number" && Number.isFinite(v) && v > 0 && (p.side === "BUY" ? v > (p.currentPrice ?? p.entryPrice) : v < (p.currentPrice ?? p.entryPrice)) },
      createPositionCommand: command => createProductionPositionCommand(db, command as Parameters<typeof createProductionPositionCommand>[1]),
    });
    const reviewTrigger = candidate.trigger;
    const review = await runtime.positionReview({ userId, traderId, traderVersionId: String(profile?.id ?? trader.current_version ?? ""), position: pos, trigger: reviewTrigger, barTime: input.barTime, knowledgeSnapshot });
    managed.push({ posId: pos.id, decision: review.decision, ...(review.commandId ? { action: "command_issued" } : {}) });
  }
  return { status: 200, body: { ok: true, managed: managed.length, results: managed } };
}
