# AVL-FX — Central Market Data Architecture

> **DEPRECATED — 2026-09-26**
>
> This document described a Central Market Data Service where AVL would operate one central MT5 and distribute OHLC bar data to all Customer Trading Views.
>
> **This architecture has been SUPERSEDED.**
>
> The target architecture was changed to **Customer Self-Contained Architecture** where each Customer's own MT5 is the canonical market data source for that customer.
>
> **New canonical document:**
> → [CUSTOMER_MARKET_DATA_ARCHITECTURE.md](./CUSTOMER_MARKET_DATA_ARCHITECTURE.md)
>
> This file is preserved as historical record only. Do not implement the architecture described below.

---

## Historical Record (for reference only — DO NOT IMPLEMENT)

The original V2-03 plan proposed:

```
AVL Central MT5 (one broker, AVL-owned)
        ↓
AVL Market Collector EA
        ↓
Market Data Service (Console Gateway extended)
        ↓
All Customer Trading Views (shared OHLC feed)
```

### Reasons this was superseded

1. **Broker price mismatch**: Central market data and customer broker prices differ. Using central prices for analysis while executing at customer broker creates a systematic price translation problem.

2. **Customer Self-Containment**: Target architecture requires each Customer system to operate independently. Central market data creates an AVL infrastructure dependency.

3. **Customer Data Ownership**: Each customer should own their own market data history. Centralized collection means AVL owns all data.

4. **Broker independence**: Customer's own MT5 already provides broker-specific accurate prices, spreads, and symbol specifications in one place.

5. **Consistency**: AI analysis price and execution price from the same MT5 eliminates the need for price translation logic.

**The Customer Self-Contained Architecture is superior for all five reasons above.**
