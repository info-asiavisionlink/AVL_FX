# STAGE 1 STEP 03B — PREVIEW BACKTEST ZERO TRADES BUG
**Date:** 2026-08-22  
**Status:** FIXED  
**Severity:** P0 — Preview Backtest が双方向Strategy で常に 0 trades を返す

---

## 症状

- EURUSD H1 10,067 bars に対して Preview Backtest を実行
- Strategy: LONG (Close > EMA21 AND RSI > 50) / SHORT (Close < EMA21 AND RSI < 50)
- Total Trades = 0

---

## Diagnostic Table

| 指標 | 値 |
|-----|---|
| SUPABASE H1 ROWS | 10,067 |
| FETCHED BARS | 10,067 (pagination OK) |
| ENGINE BARS | 10,067 |
| EMA21 VALID | 10,047 |
| RSI14 VALID | 10,053 |
| ATR14 VALID | 10,054 |
| CLOSE > EMA21 | 5,005 |
| CLOSE < EMA21 | 5,012 |
| RSI > 50 | 5,035 |
| RSI < 50 | 4,982 |
| **LONG RAW (EMA↑ AND RSI>50)** | **4,800** |
| **SHORT RAW (EMA↓ AND RSI<50)** | **4,777** |
| EVALUATOR LONG SIGNALS | 0 |
| EVALUATOR SHORT SIGNALS | 0 |
| TRADES CREATED | 0 |

→ データは正常。Indicator も正常。Raw candidates は 9,577 件存在。
→ Evaluator で全て SKIP されていた。

---

## Root Cause

### PRIMARY: DIRECTION_EVALUATOR_BUG

```
inferDirectionFromConditions():
  EMA PRICE_ABOVE → buy_score++  (1)
  EMA PRICE_BELOW → sell_score++ (1)
  RSI ABOVE 50   → sell_score++ (2)  ← overbought interpretation
  RSI BELOW 50   → buy_score++  (2)  ← oversold interpretation
  
  buy_score == sell_score → AMBIGUOUS

evaluateStrategy():
  if (rawDir === "AMBIGUOUS") return "SKIP";  ← 常にSKIP
```

双方向Strategy の条件配列を `inferDirectionFromConditions` に渡すと、
BUY スコアと SELL スコアが等しくなり AMBIGUOUS になる。
Evaluator は AMBIGUOUS を常に SKIP していたため、全 bar で 0 trades。

### SECONDARY: RSI CLASSIFICATION MISMATCH

`inferDirectionFromConditions` の RSI 解釈:
- RSI ABOVE 50 → SELL (overbought)

ユーザーの意図:
- RSI ABOVE 50 → BUY (momentum bullish)

RSI が SELL として分類されることで AMBIGUOUS を加速。

---

## Fix

### `src/infrastructure/backtest/evaluator.ts`

1. **`getConditionDirection()` 追加** — Momentum semantics で条件を BUY/SELL/NEUTRAL に分類

   ```
   RSI ABOVE X (X <= 50) → BUY  (momentum above neutral)
   RSI ABOVE X (X > 50)  → SELL (overbought)
   RSI BELOW X (X >= 50) → SELL (momentum below neutral)
   RSI BELOW X (X < 50)  → BUY  (oversold)
   
   EMA PRICE_ABOVE → BUY
   EMA PRICE_BELOW → SELL
   ```

2. **`evaluateStrategy()` の AMBIGUOUS 処理変更**
   
   Before: `if (rawDir === "AMBIGUOUS") return "SKIP";`
   
   After:
   ```
   if (rawDir === "AMBIGUOUS") {
     for dir in ["BUY", "SELL"]:
       dirConds = conditions.filter(c => getConditionDirection(c) === dir || NEUTRAL)
       if (dirConds all pass) return dir
     return "SKIP"
   }
   ```

### 双方向評価の動作

Strategy: AND logic + [EMA PRICE_ABOVE, RSI ABOVE 50, EMA PRICE_BELOW, RSI BELOW 50]

```
BUY グループ  = [EMA PRICE_ABOVE, RSI ABOVE 50]
  → AND: close > EMA21 AND RSI > 50 → LONG signal

SELL グループ = [EMA PRICE_BELOW, RSI BELOW 50]  
  → AND: close < EMA21 AND RSI < 50 → SHORT signal
```

---

## Verification

```
EURUSD H1 10,067 bars (2025-01-08 〜 2026-08-21)

Before fix:
  EMA+RSI bidirectional (AND):  0 trades

After fix:
  EMA+RSI bidirectional (AND):  613 trades
    BUY  = 315
    SELL = 298
    WR   = 36.0%
    PF   = 0.90
    Pips = -1207.5
    Verdict: FAILED (strategy is not profitable — this is correct and honest)

EMA-only bidirectional (OR):  614 trades
    BUY  = 317
    SELL = 297
    WR   = 35.2%
    PF   = 0.86
```

**PF=0.90/FAILED は Bug ではなく、実際の戦略パフォーマンス。**

---

## Regression Results

| Test | Before | After | Status |
|------|--------|-------|--------|
| Unidirectional BUY (CROSS_UP+EMA filter) | 1 trade | 1 trade | ✓ |
| Restrictive spec (RSI+NY+EMA+spread) | 0 trades | 0 trades | ✓ (intentionally 0) |
| Bidirectional EMA+RSI AND | 0 trades | 613 trades | FIXED |

---

## Backward Compatibility

- 単方向 Strategy (direction = BUY/SELL) → コード変更なし、正常動作
- AMBIGUOUS Strategy のみ新しいパスを実行
- 既存 runBacktestJob / BacktestService → 影響なし

---

## Remaining Issue (AI Mapping)

Preview 画面では RSI 条件が表示されなかった。これは AI (OpenAI) が
双方向Strategy の RSI を生成しなかった、または別フィールドへマッピングしたことによる。

この AI Prompt の修正は別タスクで対応する。
今回の Evaluator 修正により、AI が正しく RSI を生成すれば動作する。
