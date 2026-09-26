# AVL-FX V2 — AI Trader Style & Multi-Timeframe Profile

**Document type:** V2 Planned Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Problem Statement

V1 runtime has H1 and M5 timeframes hardcoded:
- H1 cron → scenario generation
- M5 watcher → entry monitoring

Any change to trading style requires code modification. Multiple styles (scalping, swing) cannot coexist without separate runtime files.

V2 target: runtime reads Trader Profile and adapts behavior to profile-defined timeframe roles.

---

## 2. Trading Styles

### 2-1. Style Definitions

| Style | Description | Typical Use |
|-------|-------------|-------------|
| `SCALPING` | Very short-term, tight SL, frequent monitoring | M1/M5 entries |
| `DAY_TRADING` | Intraday, closed before session end (goal) | H1/M5 setup |
| `SWING` | Multi-day to multi-week positions | D1/H4 setup |

**V1 existing `trading_style` values** (`ai_trader_versions.trading_style`):  
`TREND_FOLLOWING`, `BREAKOUT`, `REVERSAL`, `PRICE_ACTION`, `MULTI_TIMEFRAME`, `HYBRID`

V2 adds a higher-level `timeframe_style` classification (SCALPING/DAY_TRADING/SWING) as a separate concern from entry strategy style. These are orthogonal dimensions:

```
timeframe_style:  SCALPING | DAY_TRADING | SWING  (determines WHEN to trade)
trading_style:    TREND_FOLLOWING | BREAKOUT | ...  (determines HOW to identify trades)
```

---

## 3. Timeframe Role Schema

Replace implicit H1+M5 hardcoding with explicit role-based timeframe profile.

### 3-1. Role Definitions

| Role | Purpose | V1 Equivalent |
|------|---------|--------------|
| `macro_context_timeframes` | Highest-level market structure, major trend direction | (none) |
| `trend_context_timeframes` | Current trend direction, market regime | H1 (scenario) |
| `setup_timeframes` | Pattern identification, zone detection, setup conditions | (none) |
| `entry_timeframes` | Entry timing confirmation, trigger candle | M5 (watcher) |
| `management_timeframes` | Position monitoring, SL/TP management decisions | M5 (current) |

### 3-2. Proposed Schema

```sql
-- New table: ai_trader_timeframe_profiles
CREATE TABLE ai_trader_timeframe_profiles (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_trader_version_id        UUID NOT NULL REFERENCES ai_trader_versions(id),

  timeframe_style             TEXT NOT NULL
                              CHECK (timeframe_style IN ('SCALPING', 'DAY_TRADING', 'SWING')),

  macro_context_timeframes    TEXT[] NOT NULL DEFAULT '{}',
  trend_context_timeframes    TEXT[] NOT NULL DEFAULT '{}',
  setup_timeframes            TEXT[] NOT NULL DEFAULT '{}',
  entry_timeframes            TEXT[] NOT NULL DEFAULT '{}',
  management_timeframes       TEXT[] NOT NULL DEFAULT '{}',

  monitor_interval_minutes    INTEGER NOT NULL DEFAULT 5,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_timeframes CHECK (
    array_length(trend_context_timeframes, 1) > 0 AND
    array_length(entry_timeframes, 1) > 0
  )
);

-- Valid timeframe values (enforced at application layer)
-- M1, M5, M15, M30, H1, H4, D1, W1, MN
```

### 3-3. Style Default Configurations

These are defaults. Customer can override per AI Trader configuration.

**SCALPING:**
```json
{
  "timeframe_style": "SCALPING",
  "macro_context_timeframes": ["M5"],
  "trend_context_timeframes": ["M5"],
  "setup_timeframes": ["M5", "M1"],
  "entry_timeframes": ["M1"],
  "management_timeframes": ["M1"],
  "monitor_interval_minutes": 1
}
```

**DAY_TRADING:**
```json
{
  "timeframe_style": "DAY_TRADING",
  "macro_context_timeframes": ["H4"],
  "trend_context_timeframes": ["H4", "H1"],
  "setup_timeframes": ["M15", "M5"],
  "entry_timeframes": ["M5"],
  "management_timeframes": ["M15"],
  "monitor_interval_minutes": 5
}
```

**SWING:**
```json
{
  "timeframe_style": "SWING",
  "macro_context_timeframes": ["MN", "W1", "D1"],
  "trend_context_timeframes": ["D1", "H4"],
  "setup_timeframes": ["H4", "H1"],
  "entry_timeframes": ["H1", "M15"],
  "management_timeframes": ["H4"],
  "monitor_interval_minutes": 60
}
```

---

## 4. Profile-Driven Runtime Architecture

### 4-1. Core Principle

```
ONE common Runtime
    +
Trader Profile (reads timeframe roles)
    +
Strategy Module (entry logic)

NOT:
  ScalpingRuntime.ts
  DayTradingRuntime.ts
  SwingRuntime.ts
```

### 4-2. Runtime Profile Resolution

At runtime startup/trader initialization, the Runtime reads:

```typescript
// Pseudocode
interface ResolvedTraderProfile {
  trader:           AiTrader
  version:          AiTraderVersion
  timeframeProfile: AiTraderTimeframeProfile
  knowledgeProfile: AiTraderKnowledge[]
  riskProfile:      AiTraderRiskProfile
  notificationPolicy: NotificationPreferences
}

async function resolveTraderProfile(traderId: string): ResolvedTraderProfile {
  // Read all profile components from DB
  // Validate completeness
  // Return resolved profile (fail closed if incomplete)
}
```

### 4-3. How Runtime Uses the Profile

Instead of:
```typescript
// V1 hardcoded
const CONTEXT_TIMEFRAME = 'H1';
const ENTRY_TIMEFRAME = 'M5';
```

V2 uses:
```typescript
// V2 profile-driven
const contextTf = profile.timeframeProfile.trend_context_timeframes[0]; // e.g., 'H1' or 'D1'
const entryTfs  = profile.timeframeProfile.entry_timeframes;            // e.g., ['M5'] or ['H1', 'M15']
const monitorInterval = profile.timeframeProfile.monitor_interval_minutes;
```

The cron/scheduler that triggers the runtime must also be profile-aware:
- SCALPING trader: watcher runs every minute
- DAY_TRADING trader: watcher runs every 5 minutes
- SWING trader: watcher runs every 60 minutes (or configurable)

### 4-4. Analysis Granularity by Role

```
Scenario generation uses: trend_context_timeframes (primary)
                          macro_context_timeframes (context read)

Entry evaluation uses:    entry_timeframes (primary trigger)
                          setup_timeframes (confirmation)

Position management uses: management_timeframes
```

AI prompt construction changes to include multi-timeframe context based on profile.

---

## 5. V2 Example Trader Profiles

These are documentation examples only — not production defaults.

### 5-1. GOLD Scalper

```
Name:           GOLD Scalper
Market:         GOLD
Timeframe Style: SCALPING
Context TF:     M5
Setup TF:       M5, M1
Entry TF:       M1
Management TF:  M1
Monitor:        1 minute
Trading Style:  PRICE_ACTION
Knowledge:      Technical Analysis (Price Action, Market Structure)
Risk %:         0.25%
Min RR:         1.5
Max Positions:  1
Execution:      MANUAL_APPROVAL
```

### 5-2. GOLD Day Trader

```
Name:           GOLD Day Trader
Market:         GOLD
Timeframe Style: DAY_TRADING
Context TF:     H4, H1
Setup TF:       M15, M5
Entry TF:       M5
Management TF:  M15
Monitor:        5 minutes
Trading Style:  TREND_FOLLOWING
Knowledge:      Technical Analysis, News & Events (USD/Fed/CPI/NFP)
Risk %:         1.0%
Min RR:         2.0
Max Positions:  1
Execution:      MANUAL_APPROVAL
```

Note: This profile is equivalent to V1's current H1+M5 runtime configuration. V2 DAY_TRADING default is backward compatible with V1 behavior when `trend_context_timeframes = ['H1']` and `entry_timeframes = ['M5']`.

### 5-3. GOLD Swing

```
Name:           GOLD Swing
Market:         GOLD
Timeframe Style: SWING
Context TF:     MN, W1, D1
Setup TF:       H4, H1
Entry TF:       H1, M15
Management TF:  H4
Monitor:        configurable (60 min default)
Trading Style:  MULTI_TIMEFRAME
Knowledge:      Technical Analysis, Macro, News & Events
Risk %:         configurable
Min RR:         configurable
Max Positions:  1
Execution:      MANUAL_APPROVAL
```

### 5-4. Composite Style (B.LIPS type)

For traders combining fundamental and technical analysis:

```
Timeframe Style: DAY_TRADING (or SWING)
Context TF:      H4, H1
Setup TF:        M15
Entry TF:        M5
Knowledge:       Macro + Fundamentals + Technical Analysis
                 → Macro/Fundamentals provide directional bias
                 → Technical provides entry timing
Risk %:          configurable
```

This demonstrates Knowledge Profile and Timeframe Profile combination.  
No specific real person's strategy is replicated; this is an architectural example.

---

## 6. Backward Compatibility with V1

V1's current runtime (H1 + M5) maps directly to a DAY_TRADING profile:

```
V1 implicit:
  H1 cron → scenario  ←→  V2: trend_context_timeframes: ['H1']
  M5 watcher → entry  ←→  V2: entry_timeframes: ['M5']
  M5 management       ←→  V2: management_timeframes: ['M5']
  5 min monitor       ←→  V2: monitor_interval_minutes: 5
```

V2 migration path: existing V1 ai_trader_versions records get a default DAY_TRADING timeframe profile that preserves existing behavior. No runtime behavior changes until customer explicitly changes their profile.

---

## 7. V1 → V2 Schema Migration (Design Only)

V2 is additive. No existing V1 columns removed.

```
ai_trader_versions (V1, unchanged):
  personality, trading_style, risk_profile, entry_patience, news_sensitivity

New in V2:
  ai_trader_timeframe_profiles (new table)
  ai_trader_risk_profiles (new table, or extend ai_trader_versions)
  ai_trader_notification_profiles (new table)

V2 migration creates default timeframe profiles for existing traders.
```

No V1 data is deleted. No existing column renamed. Additive only.
