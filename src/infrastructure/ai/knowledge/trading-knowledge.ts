export const TRADING_KNOWLEDGE = `# AVL FX Trading System — Knowledge Base

## Core Trading Philosophy
- Never trade based on a single indicator
- Always confirm with multiple timeframes (H4 → H1 → M15)
- Dow Theory is the primary decision engine
- Trade WITH the trend, not against it
- Protect capital above all else

## Dow Theory Rules
- UPTREND = Higher Highs (HH) + Higher Lows (HL)
- DOWNTREND = Lower Highs (LH) + Lower Lows (LL)
- RANGE = Mixed HH/LH with HL/LL pattern
- Always identify the trend BEFORE looking for entry

## Entry Criteria (ALL must be met)
1. Dow Theory trend confirmed on H4
2. Price pulling back to key support/resistance
3. At least 2 timeframes aligned (H4 + H1 minimum)
4. RSI not in extreme zone against trade direction
5. MACD histogram confirming direction
6. ATR showing adequate volatility (not too low = dead market)

## Stop Loss Rules
- Always use ATR-based stop loss
- Minimum 1.0 × ATR distance from entry
- Place beyond nearest S/R level
- Never move SL against the trade
- Maximum risk per trade: 1% of account

## Take Profit Rules
- TP1: 1:1 RR minimum to nearest S/R
- TP2: 1:2 RR to next S/R level
- Close 50% at TP1, let remaining run to TP2
- Trail stop after TP1 hit

## Market Environment Rules
- HIGH impact news within 2 hours = NO NEW TRADES
- High volatility (VIX > 25 equivalent) = reduce position size by 50%
- London-New York overlap (14:00-17:00 JST) = highest volume, best liquidity
- Tokyo session = JPY pairs most active
- Spread > 3 pips = avoid scalping

## Risk Management
- Maximum 3 concurrent open trades
- Daily loss limit: 2% of account
- Weekly loss limit: 5% of account
- If daily limit hit: STOP trading for the day

## Indicator Interpretation
### EMA (21 vs 200)
- EMA21 above EMA200 = BULLISH trend
- EMA21 below EMA200 = BEARISH trend
- Gap widening = trend strengthening
- Gap narrowing = potential reversal approaching

### RSI (14-period)
- Above 70 = overbought, watch for reversal
- Below 30 = oversold, watch for reversal
- 40-60 = neutral zone
- Divergence with price = strongest signal

### MACD
- Histogram crossing zero = momentum shift
- Histogram increasing = trend strengthening
- Divergence with price = reversal warning

### ADX
- ADX > 25 = trending market (use trend-following strategies)
- ADX < 20 = ranging market (use oscillator strategies)
- ADX rising + DI+ > DI- = strong uptrend
- ADX rising + DI- > DI+ = strong downtrend

## Correlated Markets
### USD pairs
- DXY rising = USD strength = sell EUR/GBP/AUD/NZD
- DXY falling = USD weakness = buy EUR/GBP/AUD/NZD

### GOLD (XAUUSD)
- DXY and GOLD move inversely
- US10Y yields rising = GOLD falls
- Risk-off sentiment = GOLD rises

### JPY pairs
- JP225 rising = risk-on = USDJPY likely rises
- USDJPY and EURJPY often move together

## Candlestick Pattern Reliability
### High reliability (use as entry trigger)
- Bullish/Bearish Engulfing at S/R levels
- Pin Bar with long rejection wick at S/R
- Morning Star / Evening Star at S/R

### Medium reliability (use as confirmation)
- Doji at S/R levels
- Hammer / Shooting Star

### Low reliability (use as warning only)
- Harami patterns
- Single doji in trending market

## Confidence Score Thresholds
- 90%+ = High confidence, full position size
- 75-89% = Good confidence, standard position size
- 60-74% = Moderate, reduce position by 50%
- Below 60% = Do not trade
`;

export const RISK_MANAGEMENT_KNOWLEDGE = `# Risk Management Rules — AVL FX

## Position Sizing
- Base risk per trade: 1% of account balance
- Formula: Position Size = (Account × Risk%) / (Entry - Stop Loss in pips × Pip Value)

## Maximum Drawdown Rules
- Stop trading for the day if -2% daily drawdown reached
- Stop trading for the week if -5% weekly drawdown reached
- Reduce position size by 50% if -1% drawdown in a single day

## Trade Journal Requirements
- Record every trade with: symbol, direction, entry, SL, TP, reason, result
- Review weekly to identify patterns in wins/losses
- Track win rate by: symbol, session, strategy type

## Psychological Rules
- Never revenge trade after a loss
- Take a break after 3 consecutive losses
- Do not increase risk trying to recover losses
- A missed opportunity is better than a bad trade
`;
