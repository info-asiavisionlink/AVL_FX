# AVL-FX — Website CMS Architecture

**Document type:** V2 Stage 11 Planned Architecture — NOT implemented  
**Status:** PLANNED — implementation begins after V2 Stage 10 Final E2E PASS  
**Created:** 2026-09-26  
**Parent:** [AVL_FX_WEBSITE_ARCHITECTURE.md](./AVL_FX_WEBSITE_ARCHITECTURE.md)

---

## 1. CMS Design Principle

```
AVL Admin
    ↓
AVL FX Console (authenticated admin)
    ↓
Console Website CMS
    ↓
CMS Content API
    ↓
AVL FX Website (reads content, does NOT write)
    ↓
Public Website
```

**AVL staff never directly access Website Supabase Dashboard to update content.**  
**Website is read-only for CMS data. Console is the authoring system.**

---

## 2. CMS Source of Truth Decision

### 2-1. Options Evaluated

**Option A: Console Supabase / Storage as CMS Canonical Source**

```
Pros:
  ✓ Single canonical source in one place (Console Supabase)
  ✓ Simplest operational model (Console manages everything)
  ✓ No sync required between two systems
  ✓ Existing Console admin auth covers CMS access
  
Cons:
  ⚠ Website availability tied to Console Supabase availability
  ⚠ Website needs to call Console API for every page render (latency)
  ⚠ Console Supabase is a private system; CDN caching needed for public performance
```

**Option B: Website Supabase as Source, Console manages via API**

```
Pros:
  ✓ Website Supabase is optimized for public read performance
  ✓ Website availability independent of Console
  ✓ CDN caching directly on Supabase
  
Cons:
  ⚠ Requires sync/push from Console to Website Supabase
  ⚠ Risk of inconsistency between Console edit and Website state
  ⚠ Two Supabase projects to manage
```

### 2-2. Recommendation

**Option A (Console Supabase as Canonical CMS Source) with CDN caching layer.**

Rationale:
- Simpler: one canonical source, no sync complexity
- At launch scale (initial customer acquisition), availability coupling is acceptable
- CDN caching (Vercel Edge Cache or similar) decouples Website performance from Console availability
- Content updates are infrequent — eventual consistency via cache TTL is acceptable

Implementation detail at Stage 11:
- Console Supabase holds `website_content` table
- Console Next.js exposes a public-safe CMS API endpoint (`/api/cms/content`)
- Website fetches content from Console CMS API (server-side, cached at edge)
- Cache TTL: configurable per content type (e.g., hero = 5min, legal = 1min)

> Note: Final decision must be made at Stage 11A Architecture Freeze with production-scale considerations.

---

## 3. Manageable Content Types

### 3-1. website_content table (Console Supabase — proposed)

```sql
-- Proposed schema (created at Stage 11, not now)
CREATE TABLE website_content (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_key     TEXT NOT NULL UNIQUE,  -- 'hero', 'features', 'pricing', etc.
  content_type    TEXT NOT NULL,         -- 'text', 'rich_text', 'image', 'json'
  content_data    JSONB NOT NULL,        -- structured content
  locale          TEXT NOT NULL DEFAULT 'ja',
  version         INTEGER NOT NULL DEFAULT 1,
  published       BOOLEAN NOT NULL DEFAULT false,
  published_at    TIMESTAMPTZ,
  updated_by      TEXT,                  -- Console admin email (for audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3-2. Manageable Content Inventory

```
Page Content:
  hero_image_url          Hero background / main visual
  hero_title              Main headline
  hero_subtitle           Supporting headline
  hero_cta_text           Call-to-action button text
  hero_cta_url            CTA link target

  feature_1_title         Feature section items (1..N)
  feature_1_description
  feature_1_icon

  pricing_dev_fee_text    Development fee display (e.g., "¥300,000〜")
  pricing_monthly_text    Monthly fee display (e.g., "¥30,000/月")
  pricing_note            Pricing footnote

  faq_items               FAQ list (JSON array of {question, answer})
  announcement            Top-of-page announcement banner (optional)

Brand Assets:
  logo_url                Main logo (served from Console Supabase Storage)
  logo_dark_url           Dark-mode logo variant
  favicon_url             Browser favicon
  og_image_url            OGP / social share image

SEO:
  site_name               "AVL FX" or custom
  seo_title               Default page title
  seo_description         Default meta description
  og_title                OGP title
  og_description          OGP description

Footer:
  footer_company_name     Company name in footer
  footer_address          Company address
  footer_links            Navigation links (JSON)

Legal Document References:
  terms_version           Current Terms of Service version
  terms_effective_date    Terms effective date
  privacy_version         Privacy Policy version
  privacy_effective_date  Privacy Policy effective date
  risk_disclosure_version Risk Disclosure version
  terms_url               Link to terms document
  privacy_url             Link to privacy document
  risk_disclosure_url     Link to risk disclosure document

Sections:
  sections                JSON array of dynamic content sections
```

---

## 4. Console CMS Admin UI (Target)

```
Console → Website CMS

┌──────────────────────────────────────────────────────┐
│ Website CMS                                          │
│                                              [Preview] │
│                                             [Publish]  │
├──────────────────────────────────────────────────────┤
│ ◉ Hero Section                                       │
│ ○ Features                                           │
│ ○ Pricing                                            │
│ ○ FAQ                                                │
│ ○ Legal Documents                                    │
│ ○ SEO / OGP                                          │
│ ○ Brand Assets                                       │
│ ○ Footer                                             │
│ ○ Announcement                                       │
└──────────────────────────────────────────────────────┘
```

Content editing workflow:
1. Admin edits content in Console CMS editor
2. Content saved with `published = false` (draft)
3. Admin previews on staging Website
4. Admin publishes (`published = true`, `published_at = now()`)
5. Website CDN cache invalidated
6. Live Website shows new content

---

## 5. Image and Media Management

```
Image storage location:
  Console Supabase Storage bucket: website-assets (public bucket)
  Images served via: https://console-supabase-url/storage/v1/object/public/website-assets/...

Upload restrictions:
  Allowed types: PNG, JPG, WEBP, SVG (for logos)
  Maximum size: 5MB per image
  Automatic: resize/optimize on upload (or next.js Image component handles)

Security:
  Upload: Console admin authenticated only
  Read: public (Supabase Storage public bucket for website assets)
  No client-side upload from Website
```

---

## 6. Legal Document Management

Legal documents (Terms, Privacy Policy, Risk Disclosure) require careful version management:

```
Storage:
  Documents stored as versioned records in Console Supabase
  Each version has: version_number, content, effective_date, document_hash
  Published version referenced in website_content.terms_version

At application/contract time:
  Website shows the current published version
  Customer accepts specific version (version number + hash stored in contract record)
  Future version updates do NOT retroactively change accepted contract records

Required fields at acceptance:
  {
    terms_version: "2026-09-26-v1",
    terms_hash: "sha256:...",
    privacy_version: "2026-09-26-v1",
    privacy_hash: "sha256:...",
    risk_disclosure_version: "2026-09-26-v1",
    risk_disclosure_hash: "sha256:...",
    accepted_at: "2026-09-26T12:00:00Z"
  }
```

---

## 7. CMS Security

```
Write access (content update):
  Console admin only (isAdmin check)
  Server-side only (no client-side CMS write from Website)
  Audit log: every content change logged with admin identity and timestamp

Read access (Website serving):
  Public endpoint: GET /api/cms/content (no auth required)
  Returns only published content (published = true)
  Draft content NEVER served to public Website

Input validation:
  URL fields: validated as safe URLs
  Rich text: sanitized against XSS (no raw HTML injection)
  Image upload: type and size validation before storage
  Content length limits per field

Rate limiting:
  CMS read API: generous limit (static-like content)
  CMS write API: strict limit (admin operations)
```

---

## 8. Cache Strategy

```
Content type        Cache TTL    Invalidation trigger
────────────────────────────────────────────────────
Hero/Features       5 minutes    Admin publishes new content
FAQ                 5 minutes    Admin publishes new content
Pricing text        1 minute     Admin publishes new content
Legal references    1 minute     Admin publishes new version
Brand assets        1 hour       Admin uploads new asset
SEO metadata        5 minutes    Admin publishes changes

Implementation note:
  Vercel Edge Cache (ISR or fetch cache) for Console CMS API responses
  Cache invalidation: next.js revalidatePath / on-demand revalidation
  Fallback: serve stale content on Console API unavailability (graceful degradation)
  Critical: legal document versions must reflect current published version quickly
```
