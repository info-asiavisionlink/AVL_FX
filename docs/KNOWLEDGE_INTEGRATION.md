# Stage 3 Knowledge Integration

## Boundary

Console owns `trading_knowledge`. Trading View never accesses Console
Supabase directly. The only cross-system path is a server-to-server request to
Console `/api/trading-knowledge` with `x-knowledge-api-secret`.

The secret and Console service role remain server-only. Browser code calls the
Trading View `/api/knowledge` proxy and never receives either credential.

## API contract

Console returns only `ACTIVE` records for a valid server secret:

```json
{
  "ok": true,
  "items": [],
  "meta": { "count": 0, "source": "console", "schema_version": 1 }
}
```

Missing, wrong, or unavailable credentials fail closed. The Trading View
client distinguishes configuration, authentication, network, timeout,
invalid-response, server, and empty-result conditions. An API outage is never
converted into a successful `items: []` response.

## Selection and runtime

`selectKnowledgeForTrader()` applies the trader market, timeframe, selected
knowledge IDs, trigger/analysis type, category priority, and a bounded result
limit. H1 and individual analysis use the same selector. Selected Knowledge is
formatted into the AI prompt with title, category, version, AI usage, summary,
and bounded content.

For each analysis, `knowledge_snapshot` stores the id, version, title, and
category used at that moment. Later Console edits do not rewrite old analysis
metadata. The same snapshot metadata is attached to H1 scenarios.

If Knowledge is required but unavailable or there are no ACTIVE records, the
analysis returns `KNOWLEDGE_UNAVAILABLE` and cannot create a new entry command.
Broker-side protection for existing positions is independent of this policy.

## Future scope

Immutable full Knowledge body history, URL ingestion, AI-generated Knowledge,
and vector/RAG retrieval remain outside Stage 3.
