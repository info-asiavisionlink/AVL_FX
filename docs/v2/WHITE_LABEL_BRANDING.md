# AVL-FX — White Label Branding Architecture

**Document type:** V2 Stage 11 Planned Architecture — NOT implemented  
**Status:** PLANNED — implementation begins after V2 Stage 10 Final E2E PASS  
**Created:** 2026-09-26  
**Parent:** [AVL_FX_WEBSITE_ARCHITECTURE.md](./AVL_FX_WEBSITE_ARCHITECTURE.md)

---

## 1. Concept

Each Customer Trading View is delivered with a customer-specific brand identity.  
The default "AVL FX" branding is replaced with the customer's own brand.

Example:
```
Default:          →  Customer:
AVL FX logo       →  田中FX logo
"AVL FX"          →  "田中FX"
avl-fx.vercel.app →  tanaka-fx.com
```

The customer receives a system that looks like their own product, not AVL's product.

---

## 2. Design Principles

```
✓ Configuration-driven — brand settings stored in Customer Supabase
✓ No source code fork per customer (single codebase, configuration differs)
✓ Canonical internal IDs maintained (user_id, ai_trader_id, etc.)
✓ White label is a presentation layer — trading logic is unchanged
✓ Changing branding does NOT require re-deployment (only config update)
```

---

## 3. Customer Branding Schema (Proposed)

```sql
-- Proposed: Customer Trading View Supabase
-- Created at Stage 11 provisioning, not now

CREATE TABLE customer_branding (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id           TEXT NOT NULL UNIQUE,    -- Console system identifier

  -- Identity
  system_name         TEXT NOT NULL,           -- "田中FX"
  display_name        TEXT NOT NULL,           -- "田中FX System"
  legal_display_name  TEXT,                    -- For legal footer: "田中 慶樹 個人システム"

  -- Visual
  logo_url            TEXT,                    -- Custom logo URL
  logo_dark_url       TEXT,                    -- Dark mode variant
  favicon_url         TEXT,                    -- Browser favicon
  primary_color       TEXT,                    -- Brand primary color (HEX)
  theme               TEXT NOT NULL DEFAULT 'dark'
                      CHECK (theme IN ('dark', 'light', 'system')),

  -- Domain
  custom_domain       TEXT,                    -- tanaka-fx.com (if custom domain set up)
  default_vercel_url  TEXT NOT NULL,           -- tanaka-fx.vercel.app

  -- Contact
  support_email       TEXT,                    -- Support email shown to customer

  -- Status
  branding_active     BOOLEAN NOT NULL DEFAULT true,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Branding Application Points

The Trading View application reads `customer_branding` at startup/request time:

```
Where branding is applied:
  Browser tab title:       "{system_name}"
  Favicon:                 favicon_url (or default AVL FX favicon)
  Top navigation logo:     logo_url (or default AVL FX logo)
  Top navigation title:    system_name
  Login page header:       system_name + logo_url
  Email notifications:     display_name in subject/sender name
  Footer text:             legal_display_name or system_name
  OGP / SEO:               system_name in meta tags
  Support contact:         support_email
  Page URL:                custom_domain (if configured) or default_vercel_url
```

---

## 5. Implementation Strategy

### 5-1. No Source Fork

```
PROHIBITED:
  ✗ Copy entire Trading View repository for each customer
  ✗ Hardcode customer name/logo in source files
  ✗ Separate Vercel project with different env vars per customer brand

TARGET:
  ✓ Single Trading View codebase
  ✓ customer_branding table in Customer Supabase
  ✓ Trading View reads branding config at request time
  ✓ Next.js server components fetch branding from DB
  ✓ Each customer Vercel deployment uses same code, different Supabase project
```

### 5-2. Asset Hosting

```
Customer brand assets (logo, favicon):
  Stored in: Customer Supabase Storage (public bucket: branding-assets)
  Served via: Supabase Storage public URL
  Upload: Console provisioning process (not customer self-upload in Stage 11 initial)

Default AVL FX assets:
  Fallback: if customer_branding.logo_url is null → use AVL FX default logo
  Default assets: embedded in Trading View source (no external dependency)
```

### 5-3. Custom Domain

```
Custom domain setup (e.g., tanaka-fx.com):
  1. Customer purchases domain (or AVL manages on behalf)
  2. DNS points to Vercel CNAME/A record
  3. Vercel custom domain configured for Customer Vercel project
  4. SSL auto-provisioned by Vercel
  5. customer_branding.custom_domain updated in Customer Supabase

Trading View CORS/security:
  Both custom_domain and default_vercel_url must be in allowed origins
  Gateway and Supabase CORS settings updated at provisioning time
```

---

## 6. Branding Update Workflow

```
AVL Admin (Console)
    ↓
Update customer_branding via Console provisioning UI
    ↓
Console API: PUT /api/customers/{id}/branding
    ↓
Updates Customer Supabase customer_branding record
    ↓
Trading View: reads updated branding on next request
    ↓
No re-deployment required
```

---

## 7. What "White Label" Means and Doesn't Mean

```
INCLUDED in White Label (Stage 11):
  ✓ Custom name (田中FX instead of AVL FX)
  ✓ Custom logo
  ✓ Custom favicon
  ✓ Custom domain
  ✓ Custom primary color
  ✓ Custom support email in UI

NOT INCLUDED in Stage 11 initial:
  ✗ Complete custom CSS theme per customer (post-Stage 11)
  ✗ Custom page layouts per customer
  ✗ Custom feature set per customer (all customers have same features)
  ✗ Customer self-service branding update (AVL manages branding in Stage 11)

Future (post-Stage 11):
  Custom theme beyond primary color
  Customer self-service logo/name update via Trading View settings
  Custom email domain for notifications
```

---

## 8. Provisioning Process (Stage 11)

When AVL delivers a new customer system:

```
Step 1: Console creates Customer Supabase project
Step 2: Console creates Customer Gateway (Railway)
Step 3: Console runs Trading View migrations on Customer Supabase
Step 4: Console creates customer_branding record with customer's brand config
Step 5: Console uploads customer logo to Customer Supabase Storage
Step 6: Console Vercel project: configure custom domain if provided
Step 7: Console creates initial Customer Auth user (invite-only)
Step 8: Console deploys AI Trader configuration (Builder provisioning)
Step 9: Console deploys Customer Knowledge Package
Step 10: System ready for delivery
```

Steps 1-10 should eventually be automated via Console provisioning UI.  
In Stage 11 initial, some steps may be semi-manual.
