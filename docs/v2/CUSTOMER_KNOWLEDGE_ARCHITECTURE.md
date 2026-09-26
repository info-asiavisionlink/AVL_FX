# AVL-FX — Customer Knowledge Architecture

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Architecture Change

### 1-1. CURRENT V1 (Runtime Knowledge Fetch)

```
CURRENT:
  Console Supabase (trading_knowledge)
      ↓ (runtime API call during every AI analysis)
  Console /api/trading-knowledge
      ↓ (server-to-server, KNOWLEDGE_API_SECRET)
  Customer Trading View /api/knowledge proxy
      ↓
  AI Trader analysis (uses fetched knowledge in prompt)
```

**Problem:** AI Trader has a runtime dependency on Console. If Console is unavailable, AI analysis fails. Customer system is NOT self-contained.

### 1-2. TARGET (Customer Knowledge Package)

```
TARGET:
  AVL builds Knowledge Package for each AI Trader
      ↓ (at provisioning/deployment time — NOT at runtime)
  Knowledge Package stored in Customer Supabase (customer_knowledge table)
      ↓ (runtime — local read, no Console call)
  Customer AI Trader reads from Customer Supabase
```

**Result:** Customer AI Trader has zero runtime dependency on Console for knowledge. Customer system is self-contained.

---

## 2. Knowledge Package Model

A Knowledge Package is a versioned snapshot of knowledge items delivered to the customer's system at AI Trader creation/update time.

```
Knowledge Package = {
  trader_id:          UUID (ai_traders.id)
  version:            integer
  package_version:    string (e.g., "2026-09-26-v1")
  created_by:         string (AVL admin who created this package)
  installed_at:       TIMESTAMPTZ

  knowledge_items: [
    {
      knowledge_id:     UUID (from Console trading_knowledge.id — reference only)
      title:            string
      category:         string
      version:          integer (Console version at time of packaging)
      content_hash:     string (SHA-256 of content — integrity verification)
      content:          string (full knowledge content, copied to Customer Supabase)
      ai_usage:         string
      summary:          string
      market:           string[]
      timeframes:       string[]
      source_type:      string
      packaged_at:      TIMESTAMPTZ
    }
  ]
}
```

---

## 3. Customer Knowledge Schema

### 3-1. customer_knowledge table (Customer Supabase)

```sql
CREATE TABLE customer_knowledge (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id),
  ai_trader_id      UUID        NOT NULL REFERENCES ai_traders(id) ON DELETE CASCADE,

  -- Package metadata
  package_version   TEXT        NOT NULL,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Provenance (reference back to Console source — not a live FK)
  source_knowledge_id   UUID,            -- Console trading_knowledge.id at time of packaging
  source_version        INTEGER,         -- Console knowledge version packaged
  content_hash          TEXT,            -- SHA-256 of content (integrity)

  -- Knowledge content (copied from Console at package time)
  title             TEXT        NOT NULL,
  category          TEXT        NOT NULL,
  content           TEXT        NOT NULL,
  ai_usage          TEXT,
  summary           TEXT,
  market            TEXT[]      NOT NULL DEFAULT '{}',
  timeframes        TEXT[]      NOT NULL DEFAULT '{}',
  tags              TEXT[]      NOT NULL DEFAULT '{}',
  source_type       TEXT        NOT NULL DEFAULT 'PACKAGED',

  -- Status
  status            TEXT        NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REMOVED')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ck_trader_category
  ON customer_knowledge (ai_trader_id, category, status);

CREATE INDEX idx_ck_trader_status
  ON customer_knowledge (ai_trader_id, status);
```

### 3-2. knowledge_snapshot (in ai_analysis_logs — unchanged from V1)

```
ai_analysis_logs.knowledge_snapshot (V1 existing):
  Records which knowledge items were used for each analysis decision.
  In TARGET: references customer_knowledge.id (not Console knowledge.id directly)
  
  Format stays the same:
  { "id": "...", "version": 3, "title": "...", "category": "..." }
  
  Now "id" refers to customer_knowledge.id (customer-local UUID)
  "source_knowledge_id" on customer_knowledge provides traceability back to Console source
```

---

## 4. Knowledge Package Delivery Process

### 4-1. Package Creation (at AI Trader provisioning)

```
Step 1: AVL admin selects knowledge items in Console AI Trader Builder (admin provisioning tool)
Step 2: Builder compiles Knowledge Package:
  - Copy full knowledge content (not just IDs)
  - Hash content (SHA-256)
  - Record source_knowledge_id and source_version
  - Create package_version string
Step 3: Package is deployed to Customer Supabase
  - Via Console admin operation (not runtime API)
  - Insert/upsert customer_knowledge records
  - Old versions marked as SUPERSEDED (not deleted)
Step 4: AI Trader version updated with new package_version reference
Step 5: Next AI Trader analysis uses new knowledge package
```

### 4-2. Package Update

```
When AVL updates knowledge content:
  1. Update trading_knowledge in Console (existing V1 flow)
  2. Re-package affected AI Traders (AVL admin action)
  3. Deploy updated Knowledge Package to Customer Supabase
  4. Customer AI Trader uses new package from next analysis cycle
  
  Old package version: marked SUPERSEDED (not deleted)
  Historical analysis_logs: still reference old version via snapshot
```

---

## 5. AI Trader Knowledge Selection (Updated)

### 5-1. At Runtime (TARGET)

```typescript
// Pseudocode — not implementation

// V1 (current): fetches from Console at runtime
const knowledge = await fetchFromConsole(trader.selected_knowledge_ids);

// TARGET: reads from Customer Supabase (local, no Console call)
const knowledge = await supabase
  .from('customer_knowledge')
  .select('*')
  .eq('ai_trader_id', trader.id)
  .eq('status', 'ACTIVE')
  // Apply category priority, market/timeframe filter from V1 selectKnowledgeForTrader()
  .limit(KNOWLEDGE_SELECT_LIMIT);
```

### 5-2. selectKnowledgeForTrader() (Updated)

The existing `selectKnowledgeForTrader()` function in V1 reads from Console via network call. In TARGET, it reads from Customer Supabase directly. The selection logic (market filter, timeframe filter, category priority, limit) remains the same. Only the data source changes.

---

## 6. Knowledge Snapshot Auditability

The existing V1 knowledge_snapshot in `ai_analysis_logs` is preserved and enhanced:

```
V1 knowledge_snapshot:
  { id, version, title, category }
  → id was Console trading_knowledge.id

TARGET knowledge_snapshot:
  { id, version, title, category, source_knowledge_id, package_version }
  → id is customer_knowledge.id (customer-local)
  → source_knowledge_id is Console trading_knowledge.id (traceability)
  → package_version identifies which package version was active

This allows auditing:
  "Which knowledge did this AI Trader use for this decision?"
  → customer_knowledge by id
  → Source content: customer_knowledge.content (copied at package time)
  → Console source: customer_knowledge.source_knowledge_id
  
Chain-of-thought is NOT stored (V1 policy maintained).
```

---

## 7. Failure Semantics

```
Customer Supabase unavailable:
  → AI analysis fail closed (KNOWLEDGE_UNAVAILABLE equivalent)
  → Same behavior as V1 Console unavailable

Customer knowledge table empty or no ACTIVE records:
  → AI analysis fail closed (no available knowledge)
  → Log: KNOWLEDGE_UNAVAILABLE

Knowledge content hash mismatch (integrity failure):
  → Log warning
  → Use knowledge item but flag for package review
  → Do NOT fail closed on hash mismatch (content is still readable)

Console unavailable:
  → NO EFFECT on Customer AI Trader runtime (target: zero runtime dependency)
  → New package deployment may be delayed (admin operation only)
```

---

## 8. V1 Migration Path

```
CURRENT V1:
  AI Trader runtime → Console /api/trading-knowledge → uses in prompt

TARGET migration:
  Phase 1: Add customer_knowledge table (additive migration)
  Phase 2: Knowledge Package deployment tool in Console
  Phase 3: selectKnowledgeForTrader() reads from customer_knowledge if present,
            falls back to Console fetch if customer_knowledge is empty
  Phase 4: All AI Traders have knowledge packages deployed
  Phase 5: Remove Console fetch fallback
  Phase 6: KNOWLEDGE_API_SECRET and Console Knowledge API retired (for runtime use)
  
  Console trading_knowledge table: retained as authoring/editorial tool
  Console Knowledge API: retained for package building, removed from customer runtime path
```

---

## 9. Relationship to AI Trader Builder

The Console AI Trader Builder (admin provisioning tool) creates the Knowledge Package:

1. Admin selects knowledge items from `trading_knowledge` in Builder UI
2. Builder compiles and deploys Knowledge Package to Customer Supabase
3. Customer AI Trader uses the deployed package

See: [AI_TRADER_BUILDER.md](./AI_TRADER_BUILDER.md) — Knowledge Selection section.

---

## 10. Customer Data Ownership

```
customer_knowledge table: owned by Customer Supabase
  → Not accessible by other customers
  → RLS: user_id = auth.uid()
  → No cross-customer knowledge sharing

If Customer system is transferred to Customer ownership:
  → customer_knowledge table transfers with Customer Supabase
  → Customer retains all knowledge content
  → Provenance (source_knowledge_id) preserved for historical reference
  → Ongoing AVL editorial updates stop (customer manages their own knowledge)
```
