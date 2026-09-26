// Customer Knowledge Loader — V2 Stage 4
//
// Reads knowledge from Customer Supabase (customer_knowledge table).
// ZERO runtime dependency on Console Knowledge API.
//
// Security model:
//   - Server-side only (admin client or service-role).
//   - Ownership validated: user_id must own the ai_trader_id.
//   - Never called from browser.
//   - Fail closed: throws KnowledgeUnavailableError on missing / unavailable knowledge.

import type { SupabaseClient } from "@supabase/supabase-js";
import { KnowledgeUnavailableError, type KnowledgeItem, selectKnowledgeForTrader as _selectBase, formatKnowledgeForPrompt } from "./knowledge-client";

// Extends KnowledgeItem with customer-local provenance fields.
export type CustomerKnowledgeItem = KnowledgeItem & {
  source_knowledge_id: string | null;   // Console trading_knowledge.id at packaging time
  source_version:      number | null;   // Console knowledge version at packaging time
  package_version:     string;          // deployment batch identifier
  content_hash:        string | null;   // SHA-256 integrity check
};

// Extended snapshot includes provenance for AI log auditability.
export type CustomerKnowledgeSnapshot = {
  id:                  string;
  title:               string;
  category:            string;
  version:             number;
  source_knowledge_id: string | null;
  package_version:     string;
};

/**
 * Load all ACTIVE customer knowledge items for a specific AI Trader.
 *
 * Validates customer ownership: if user_id does not own ai_trader_id the
 * query returns zero rows (RLS + explicit eq filter) and we fail closed.
 *
 * Throws KnowledgeUnavailableError on DB error or empty result.
 */
export async function loadCustomerKnowledge(
  db:       SupabaseClient,
  traderId: string,
  userId:   string,
): Promise<CustomerKnowledgeItem[]> {
  if (!traderId || !userId) {
    throw new KnowledgeUnavailableError("CONFIG_ERROR", "traderId and userId are required for knowledge loading");
  }

  const { data, error } = await db
    .from("customer_knowledge")
    .select(
      "id, title, category, content, ai_usage, summary, market, timeframes, tags, " +
      "source_knowledge_id, source_version, package_version, content_hash, " +
      "status, source_type, updated_at",
    )
    .eq("ai_trader_id", traderId)
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: true });

  if (error) {
    throw new KnowledgeUnavailableError("SERVER_ERROR", `customer_knowledge query failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new KnowledgeUnavailableError(
      "EMPTY_RESULT",
      `No ACTIVE customer knowledge found for trader ${traderId}. Deploy a knowledge package first.`,
    );
  }

  return (data as unknown as Record<string, unknown>[]).map(normalizeCustomerKnowledgeItem);
}

function normalizeCustomerKnowledgeItem(row: Record<string, unknown>): CustomerKnowledgeItem {
  return {
    // KnowledgeItem fields
    id:         String(row.id ?? ""),
    title:      String(row.title ?? ""),
    category:   String(row.category ?? ""),
    content:    String(row.content ?? ""),
    ai_usage:   typeof row.ai_usage === "string" ? row.ai_usage : null,
    summary:    typeof row.summary === "string" ? row.summary : null,
    market:     Array.isArray(row.market) ? (row.market as string[]).filter(x => typeof x === "string") : [],
    timeframes: Array.isArray(row.timeframes) ? (row.timeframes as string[]).filter(x => typeof x === "string") : [],
    tags:       Array.isArray(row.tags) ? (row.tags as string[]).filter(x => typeof x === "string") : [],
    status:     "ACTIVE",
    version:    typeof row.source_version === "number" ? row.source_version : 1,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    // CustomerKnowledgeItem fields
    source_knowledge_id: typeof row.source_knowledge_id === "string" ? row.source_knowledge_id : null,
    source_version:      typeof row.source_version === "number" ? row.source_version : null,
    package_version:     String(row.package_version ?? ""),
    content_hash:        typeof row.content_hash === "string" ? row.content_hash : null,
  };
}

/**
 * Select relevant customer knowledge items using the same filtering logic as V1.
 * Generic so the return type preserves CustomerKnowledgeItem[].
 */
export function selectCustomerKnowledge(
  items: CustomerKnowledgeItem[],
  context: { market?: string; timeframe?: string; triggerType?: string; limit?: number },
): CustomerKnowledgeItem[] {
  return _selectBase<CustomerKnowledgeItem>(items, context);
}

/**
 * Create knowledge snapshots for ai_analysis_logs, including V2 provenance fields.
 */
export function snapshotCustomerKnowledge(items: CustomerKnowledgeItem[]): CustomerKnowledgeSnapshot[] {
  return items.map(k => ({
    id:                  k.id,
    title:               k.title,
    category:            k.category,
    version:             k.version,
    source_knowledge_id: k.source_knowledge_id,
    package_version:     k.package_version,
  }));
}

/**
 * Format customer knowledge items for prompt injection.
 * Reuses V1 formatter — content structure is identical.
 */
export { formatKnowledgeForPrompt };

export { KnowledgeUnavailableError };
