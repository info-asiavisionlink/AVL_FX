import { timingSafeEqual } from "node:crypto";

export type KnowledgeItem = {
  id: string;
  title: string;
  category: string;
  summary: string | null;
  content: string;
  ai_usage: string | null;
  market: string[];
  timeframes: string[];
  tags: string[];
  status: string;
  version: number;
  updated_at: string;
};

export type KnowledgeSnapshot = Pick<KnowledgeItem, "id" | "title" | "category" | "version">;

export class KnowledgeUnavailableError extends Error {
  readonly code: "CONFIG_ERROR" | "AUTH_ERROR" | "NETWORK_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "SERVER_ERROR" | "EMPTY_RESULT";
  constructor(code: KnowledgeUnavailableError["code"], message = "Knowledge unavailable") {
    super(message);
    this.name = "KnowledgeUnavailableError";
    this.code = code;
  }
}

function config(): { consoleUrl: string; secret: string } {
  return { consoleUrl: process.env.CONSOLE_URL ?? "", secret: process.env.KNOWLEDGE_API_SECRET ?? "" };
}

function normalizeItem(value: unknown): KnowledgeItem | null {
  if (!value || typeof value !== "object") return null;
  const k = value as Record<string, unknown>;
  if (typeof k.id !== "string" || typeof k.title !== "string" || typeof k.category !== "string" ||
      typeof k.content !== "string" || k.status !== "ACTIVE" || typeof k.version !== "number") return null;
  return {
    id: k.id, title: k.title, category: k.category,
    summary: typeof k.summary === "string" ? k.summary : null,
    content: k.content,
    ai_usage: typeof k.ai_usage === "string" ? k.ai_usage : null,
    market: Array.isArray(k.market) ? k.market.filter((x): x is string => typeof x === "string") : [],
    timeframes: Array.isArray(k.timeframes) ? k.timeframes.filter((x): x is string => typeof x === "string") : [],
    tags: Array.isArray(k.tags) ? k.tags.filter((x): x is string => typeof x === "string") : [],
    status: "ACTIVE", version: k.version, updated_at: typeof k.updated_at === "string" ? k.updated_at : "",
  };
}

export async function fetchActiveKnowledge(signal?: AbortSignal): Promise<KnowledgeItem[]> {
  const { consoleUrl, secret } = config();
  if (!consoleUrl || !secret) throw new KnowledgeUnavailableError("CONFIG_ERROR");
  let response: Response;
  try {
    response = await fetch(`${consoleUrl.replace(/\/$/, "")}/api/trading-knowledge?status=ACTIVE`, {
      headers: { "x-knowledge-api-secret": secret, accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new KnowledgeUnavailableError("TIMEOUT");
    throw new KnowledgeUnavailableError("NETWORK_ERROR");
  }
  if (response.status === 401 || response.status === 403) throw new KnowledgeUnavailableError("AUTH_ERROR");
  if (!response.ok) throw new KnowledgeUnavailableError("SERVER_ERROR", `Console status ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new KnowledgeUnavailableError("INVALID_RESPONSE"); }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown[] }).items)) {
    throw new KnowledgeUnavailableError("INVALID_RESPONSE");
  }
  return (payload as { items: unknown[] }).items.map(normalizeItem).filter((x): x is KnowledgeItem => x !== null);
}

// Generic so callers preserving CustomerKnowledgeItem[] subtype don't lose extra fields.
export function selectKnowledgeForTrader<T extends KnowledgeItem>(
  items: T[],
  context: { market?: string; timeframe?: string; triggerType?: string; selectedIds?: string[]; limit?: number },
): T[] {
  const market = (context.market ?? "").toUpperCase();
  const timeframe = (context.timeframe ?? "").toUpperCase();
  const selected = context.selectedIds?.length ? new Set(context.selectedIds) : null;
  const priorities: Record<string, string[]> = {
    ENTRY_RECHECK: ["Price Action", "Market Structure", "Risk Management"],
    TP_RECHECK: ["Risk Management", "Market Structure", "Price Action"],
    SL_RECHECK: ["Risk Management", "Price Action", "Market Structure"],
    POSITION_REVIEW: ["Risk Management", "Market Structure"],
    MANUAL_REANALYSIS: ["Market Structure", "Price Action", "Indicators"],
    HOURLY_ANALYSIS: ["Market Structure", "Price Action", "Risk Management", "Indicators"],
  };
  const order = priorities[context.triggerType ?? "HOURLY_ANALYSIS"] ?? priorities.HOURLY_ANALYSIS;
  return items
    .filter(k => !selected || selected.has(k.id))
    .filter(k => k.market.length === 0 || !market || k.market.some(m => ["GLOBAL", "ALL", market].includes(m.toUpperCase())))
    .filter(k => k.timeframes.length === 0 || !timeframe || k.timeframes.some(tf => tf.toUpperCase() === timeframe || tf.toUpperCase() === "ALL"))
    .sort((a, b) => (order.indexOf(a.category) < 0 ? 999 : order.indexOf(a.category)) - (order.indexOf(b.category) < 0 ? 999 : order.indexOf(b.category)) || b.version - a.version)
    .slice(0, context.limit ?? 8);
}

export function snapshotKnowledge(items: KnowledgeItem[]): KnowledgeSnapshot[] {
  return items.map(({ id, title, category, version }) => ({ id, title, category, version }));
}

export function formatKnowledgeForPrompt(items: KnowledgeItem[], maxCharsPerItem = 2000): string {
  return items.map(k => {
    const parts = [`## ${k.title} (v${k.version})`, `【カテゴリ】${k.category}`];
    if (k.ai_usage) parts.push(`【AI使用目的】${k.ai_usage}`);
    if (k.summary) parts.push(`【概要】${k.summary}`);
    parts.push(k.content.slice(0, maxCharsPerItem));
    return parts.join("\n");
  }).join("\n\n---\n\n");
}

export function isKnowledgeSecretShapeSafe(secret: string): boolean {
  const expected = config().secret;
  const supplied = Buffer.from(secret);
  const expectedBuffer = Buffer.from(expected);
  return supplied.length > 0 && expectedBuffer.length > 0 && supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}
