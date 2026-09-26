# AVL-FX — Contract & Payment Architecture

**Document type:** V2 Stage 11 Planned Architecture — NOT implemented  
**Status:** PLANNED — implementation begins after V2 Stage 10 Final E2E PASS  
**Created:** 2026-09-26  
**Parent:** [AVL_FX_WEBSITE_ARCHITECTURE.md](./AVL_FX_WEBSITE_ARCHITECTURE.md)

---

## 1. Contract Workflow

### 1-1. Documents Required

```
Document set for each customer:
  1. Development Agreement (開発委託契約書)
     - Scope of development, deliverables, timeline, fee
  2. System License / Sale Agreement (システム利用許諾 / 売買契約)
     - License or sale terms for the delivered system
  3. Managed Hosting / Maintenance Agreement (管理ホスティング・保守契約)
     - Monthly managed service scope and fees
  4. Terms of Service (利用規約)
  5. Privacy Policy (プライバシーポリシー)
  6. Risk Disclosure (リスク開示)

All documents are version-controlled.
The version accepted at application time is permanently recorded.
```

### 1-2. Contract Acceptance Schema

```sql
-- Proposed: Website Supabase
CREATE TABLE contract_acceptances (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          UUID NOT NULL,

  -- Document versions accepted
  dev_agreement_version   TEXT NOT NULL,
  dev_agreement_hash      TEXT NOT NULL,      -- SHA-256 of document content
  license_version         TEXT NOT NULL,
  license_hash            TEXT NOT NULL,
  managed_service_version TEXT NOT NULL,
  managed_service_hash    TEXT NOT NULL,
  terms_version           TEXT NOT NULL,
  terms_hash              TEXT NOT NULL,
  privacy_version         TEXT NOT NULL,
  privacy_hash            TEXT NOT NULL,
  risk_disclosure_version TEXT NOT NULL,
  risk_disclosure_hash    TEXT NOT NULL,

  -- Acceptance metadata
  accepted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  signer_full_name        TEXT NOT NULL,
  signer_email            TEXT NOT NULL,
  ip_address              TEXT,               -- for non-repudiation
  user_agent              TEXT,

  -- Electronic signature reference
  signature_method        TEXT NOT NULL DEFAULT 'checkbox_confirm',
                          -- 'checkbox_confirm' | 'external_esign' | 'draw_signature'
  signature_data          TEXT,              -- provider reference or drawn signature
  esign_provider          TEXT,              -- e.g., 'docusign', 'cloudsign', null
  esign_envelope_id       TEXT,              -- external provider envelope ID

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 1-3. Electronic Signature Options

Stage 11 must decide between these options before implementation:

```
Option A: Checkbox Confirmation (最小実装)
  Customer checks required checkboxes:
    [x] I have read and agree to the Development Agreement (v2026-09-26)
    [x] I have read and agree to the Terms of Service
    [x] I understand and accept the Risk Disclosure
  
  + Simple, immediate
  + No external dependency
  - Lower legal weight than certified e-signature
  - May be insufficient for some contract types

Option B: External E-Signature Provider
  Use CloudSign (JP), DocuSign, or similar certified e-signature service
  
  + Highest legal weight
  + Built-in non-repudiation
  + Audit trail managed by certified provider
  - Additional cost per envelope
  - Integration complexity
  - External service dependency

Option C: Hybrid
  Checkbox confirmation for Terms/Privacy/Risk
  External e-signature for Development Agreement (most legally significant)

Decision:
  Final choice must be made at Stage 11A Architecture Freeze
  with review of Japanese electronic signature law requirements.
  This document does NOT make the final choice.
```

---

## 2. Stripe Architecture

### 2-1. Payment Phases

**Phase A: Initial Development Fee (one-time)**

```
Customer completes application + contract acceptance
    ↓
Website: Create Stripe Payment Intent
  amount: configured development fee (e.g., ¥300,000)
  currency: jpy
  metadata: { application_id, customer_name }
    ↓
Customer: Complete payment (Stripe Elements or Stripe Checkout)
    ↓
Stripe webhook: payment_intent.succeeded
    ↓
Website API: verify webhook signature → update application.status = PAID
    ↓
Console notification: new paid order
    ↓
Development begins
```

**Phase B: Monthly Managed Service (recurring)**

```
After DELIVERED status confirmed:
    ↓
Console: Create Stripe Subscription
  price_id: monthly managed service price (e.g., ¥30,000/month)
  customer: stripe_customer_id (linked to application)
  billing_cycle_anchor: [billing date]
    ↓
Stripe: issues monthly invoices
    ↓
Stripe webhook: invoice.payment_succeeded → customer.status = MANAGED_SERVICE_ACTIVE
    ↓
Stripe webhook: invoice.payment_failed → PAYMENT_FAILED notification
```

### 2-2. Stripe Security Requirements

```
✗ Stripe secret key NEVER in browser
✗ Stripe secret key NEVER in client-side code
✗ Stripe publishable key only in browser (safe to expose)

✓ All Stripe API calls: server-side only
✓ Webhook endpoint: verify Stripe-Signature header on every inbound webhook
✓ Webhook idempotency: deduplicate by Stripe event ID
✓ Replay protection: reject events older than 5 minutes
✓ Audit log: every Stripe event recorded
✓ Server-only ENV: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
```

### 2-3. Stripe ENV Variables

```
# Console .env.local (server-only — never in Trading View or Website browser)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Website .env.local (server-only)
STRIPE_SECRET_KEY=sk_live_...        (or same key if Console handles Stripe)
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...  (safe — browser-accessible)
```

### 2-4. Billing Policy (to be decided at Stage 11)

```
Items requiring decision at Stage 11:
  - First billing date (day of delivery? first of next month? billing_cycle_anchor)
  - Proration for mid-month starts
  - Failed payment retry policy (how many retries, intervals)
  - Grace period before service suspension
  - Refund policy for development fee (partial, none, conditions)
  - Cancellation procedure and notice period
  - Delivery delay compensation

Target candidate (proposed, not confirmed):
  Billing date: 25th of each month
  First bill:   first 25th after DELIVERED
  Failed payment: retry 3 times → PAYMENT_FAILED → suspension notice
  Refund: per individual contract terms
```

---

## 3. Stripe in the Console

Console manages Stripe subscriptions:

```
Console Customer Detail → Billing section:
  Stripe Customer ID
  Subscription status
  Current plan
  Next invoice date
  Next invoice amount
  Payment method on file
  Invoice history
  Manual actions:
    [ Pause subscription ]
    [ Cancel subscription ]
    [ Apply coupon ]
    [ Update billing date ]
```

Console does NOT expose Stripe secret key to browser.  
All Stripe management actions go through Console server API.

---

## 4. Payment Failure Handling

```
Stripe: invoice.payment_failed webhook received
    ↓
Console: mark customer PAYMENT_FAILED
    ↓
LINE notification: BILLING_NOTICE (payment failed)
    ↓
Stripe: automatic retry (configured in Stripe settings)
    ↓
If retry succeeds:
    → MANAGED_SERVICE_ACTIVE (restored)
    → LINE: BILLING_NOTICE (payment succeeded)
    
If all retries fail:
    → Console: review and manual action required
    → Human Gate: AVL staff decides (suspend, contact customer, etc.)
    
Customer Trading View access:
    Status PAYMENT_FAILED does NOT automatically lock Trading View.
    Access restriction is a separate operational decision (not automatic in Stage 11 initial).
```

---

## 5. Monthly Fee Display on Website

```
Pricing display policy:
  Show text representations only (e.g., "¥30,000〜/月")
  Not shown: exact fixed price in UI code
  Actual price controlled via Console CMS (website_content.pricing_monthly_text)

Rationale:
  Prices may change. CMS-driven text allows update without re-deployment.
  Exact pricing is confirmed in contract documents, not website display text.
```

---

## 6. Compliance Note

```
COMPLIANCE REVIEW REQUIRED:

Payment processing and subscription billing for technology services:
  - Consumption tax (消費税) treatment must be confirmed
  - Invoice requirements under the qualified invoice system (インボイス制度)
  - Stripe's legal entity and payment method availability in Japan
  - Electronic contract enforceability in Japan

Contract and legal documents:
  - Specific contract terms require legal review before use
  - Risk disclosure content requires review by financial compliance experts
  - Consumer protection law (消費者契約法) applicability
  - Statutory cooling-off rights

AVL must obtain appropriate legal/tax/compliance review before commercial operation.
This document describes technical architecture only.
```
