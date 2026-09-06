// =================================================================
// POST /api/ai/brain/decision
// AVL AI Decision Engine — MarketSnapshot → TradeProposal
//
// 出力は必ず構造化 JSON。フリーテキストで実行しない。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }   from "@/infrastructure/ai/openai-client";
import { calcDynamicSLTP }           from "@/infrastructure/trading/DynamicSLTP";
import type { MarketSnapshot, TradeProposal } from "@/domain/trading/MarketSnapshot";

export const runtime = "nodejs";

function buildSystemPrompt(): string {
  return `You are AVL AI, an elite FX trading decision engine.

Your role is to analyze a complete MarketSnapshot and produce a structured trading decision.

## OUTPUT FORMAT (strict JSON — no other text)

{
  "decision": "BUY" | "SELL" | "WAIT",
  "symbol": string,
  "confidence": number (0-100),
  "entry": number,
  "stop_loss": number,
  "take_profit": number,
  "risk_reward": number,
  "sl_pips": number,
  "tp_pips": number,
  "win_probability": number (0-100),
  "expected_value": number,
  "setup_type": string,
  "time_horizon": string,
  "reasoning": {
    "market_structure": string,
    "technical": string,
    "oscillator": string,
    "fundamental": string,
    "news": string,
    "correlation": string,
    "invalidation": string
  }
}

## DECISION RULES

1. WAIT is always valid and preferred over low-quality setups
2. confidence < 65 → always WAIT
3. Spread > 3 pips → WAIT
4. HIGH impact news within 2 hours → WAIT
5. Multi-TF alignment < 3/5 → WAIT
6. Dow Theory RANGE with no clear structure → WAIT
7. Never force trades to fill a quota
8. Never fabricate data

## ANALYSIS HIERARCHY
1. Dow Theory / market structure (most important)
2. Multi-TF alignment (H4 → H1 → M15 → M5)
3. Key S/R proximity
4. Momentum (RSI, MACD, ADX)
5. Oscillator state (not as standalone signal)
6. Fundamental risk (news, events)
7. Correlation confirmation

## SL/TP
- Do not use fixed RR = 1:2
- SL must come from market structure (swing) or ATR
- TP must target next S/R or swing structure
- RR is the result, not the input

## EXPECTED VALUE
expected_value = (win_probability/100 * tp_pips) - ((1 - win_probability/100) * sl_pips)
Must be positive for BUY/SELL. Negative → WAIT.

Respond with ONLY the JSON object. No explanation outside the JSON.`;
}

function buildUserPrompt(snap: MarketSnapshot): string {
  const ind = snap.indicators;
  const tfs = ["H4", "H1", "M15", "M5", "M1"] as const;

  const indLines = tfs.map(tf => {
    const v = ind[tf];
    if (!v) return `${tf}: NO DATA`;
    return `${tf}: EMA21=${v.ema21.toFixed(5)} EMA200=${v.ema200.toFixed(5)} trend=${v.trend} ` +
           `RSI=${v.rsi.toFixed(1)} MACD_hist=${v.macdHist.toFixed(5)} ADX=${v.adx.toFixed(1)} ` +
           `DI+=${v.diPlus.toFixed(1)} DI-=${v.diMinus.toFixed(1)} ` +
           `BB_pos=${((snap.bid - v.bbLower)/(v.bbUpper - v.bbLower || 1)*100).toFixed(0)}% ` +
           `Stoch=${v.stochastic.toFixed(1)} ATR=${v.atr.toFixed(5)} ` +
           `[freshness: ${v.freshness.ageMs < 60000 ? "FRESH" : "STALE"} ${Math.round(v.freshness.ageMs/1000)}s]`;
  }).join("\n");

  const swings = snap.dowTheory;
  const posInfo = snap.positions.length > 0
    ? snap.positions.map(p => `${p.type} ${p.volume}L @${p.openPrice} PnL=${p.profit.toFixed(2)}`).join(", ")
    : "No open positions";

  const events = snap.economicEvents.length > 0
    ? snap.economicEvents.slice(0, 3).map(e => `[${e.impact}] ${e.currency} ${e.title} in ${e.hoursUntil.toFixed(1)}h`).join("\n")
    : "No upcoming high-impact events";

  const corrLines = snap.correlatedMarkets
    .filter(c => c.bid > 0)
    .map(c => `${c.symbol}: ${c.bid.toFixed(5)} (${c.relationship})`)
    .join(", ");

  return `## MarketSnapshot: ${snap.symbol}
Timestamp: ${new Date(snap.timestamp).toISOString()}
Source: ${snap.overallSource}
Indicator age: ${snap.indicatorFreshnessSec}s

## Price
Bid: ${snap.bid.toFixed(snap.digits)}
Ask: ${snap.ask.toFixed(snap.digits)}
Spread: ${snap.spread.toFixed(1)} pips
Session: ${snap.session.join(", ") || "Off-hours"}

## Technical Indicators
${indLines}

## Dow Theory (H4/D1)
Trend: ${swings.trend} (score: ${swings.score})
HH: ${swings.lastHH?.toFixed(snap.digits) ?? "N/A"}
HL: ${swings.lastHL?.toFixed(snap.digits) ?? "N/A"}
LH: ${swings.lastLH?.toFixed(snap.digits) ?? "N/A"}
LL: ${swings.lastLL?.toFixed(snap.digits) ?? "N/A"}
Summary: ${swings.summary}

## Multi-TF Alignment
Direction: ${snap.multiTF.direction} (${snap.multiTF.alignedCount}/${snap.multiTF.totalCount} aligned, score: ${snap.multiTF.score})

## S/R Levels (nearest)
Nearest Support:    ${snap.nearestSupport.toFixed(snap.digits)}
Nearest Resistance: ${snap.nearestResistance.toFixed(snap.digits)}
Key levels: ${snap.srLevels.filter(l => l.strength >= 2).slice(0, 5).map(l => `${l.type} ${l.price.toFixed(snap.digits)} (str:${l.strength})`).join(", ")}

## Candle Patterns
${snap.candlePatterns.length > 0 ? snap.candlePatterns.map(p => `${p.name} [${p.direction}] ${p.tf}`).join(", ") : "None detected"}

## Correlated Markets
${corrLines || "No correlation data"}

## Economic Events (next 24h)
${events}
News Risk: ${snap.newsRisk}

## Account State
${snap.account
  ? `Balance: ${snap.account.balance} ${snap.account.currency}\nEquity: ${snap.account.equity}\nFree Margin: ${snap.account.freeMargin}\nDrawdown: ${snap.account.drawdownPct.toFixed(2)}%`
  : "Account data unavailable"}

## Positions
${posInfo}
Open: ${snap.openPositionsCount} total, ${snap.symbolPositionsCount} on ${snap.symbol}

## Task
Analyze the above MarketSnapshot and return a structured JSON trading decision for ${snap.symbol}.
Use dynamic SL/TP based on market structure. Do not use fixed RR.
Return ONLY the JSON object.`;
}

export async function POST(req: NextRequest) {
  try {
    const { snapshot } = await req.json() as { snapshot: MarketSnapshot };
    if (!snapshot) return NextResponse.json({ error: "snapshot required" }, { status: 400 });

    const client = getOpenAIClient();

    const response = await client.chat.completions.create({
      model:               MODELS.chat,
      max_completion_tokens: 1200,
      response_format:     { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user",   content: buildUserPrompt(snapshot) },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as Partial<TradeProposal>;

    // 構造を補完（AIが省略した場合のデフォルト）
    const proposal: TradeProposal = {
      decision:        parsed.decision        ?? "WAIT",
      symbol:          parsed.symbol          ?? snapshot.symbol,
      confidence:      parsed.confidence      ?? 0,
      entry:           parsed.entry           ?? snapshot.bid,
      stop_loss:       parsed.stop_loss       ?? 0,
      take_profit:     parsed.take_profit     ?? 0,
      risk_reward:     parsed.risk_reward     ?? 0,
      sl_pips:         parsed.sl_pips         ?? 0,
      tp_pips:         parsed.tp_pips         ?? 0,
      win_probability: parsed.win_probability ?? 0,
      expected_value:  parsed.expected_value  ?? 0,
      setup_type:      parsed.setup_type      ?? "Unknown",
      time_horizon:    parsed.time_horizon    ?? "M5",
      reasoning: {
        market_structure: parsed.reasoning?.market_structure ?? "",
        technical:        parsed.reasoning?.technical        ?? "",
        oscillator:       parsed.reasoning?.oscillator       ?? "",
        fundamental:      parsed.reasoning?.fundamental      ?? "",
        news:             parsed.reasoning?.news             ?? "",
        correlation:      parsed.reasoning?.correlation      ?? "",
        invalidation:     parsed.reasoning?.invalidation     ?? "",
      },
      snapshot_id: snapshot.snapshotId,
      timestamp:   new Date().toISOString(),
      model:       MODELS.chat,
    };

    // SL/TP が AI から提供されていれば動的計算で検証・補完
    if (proposal.decision !== "WAIT" && (proposal.stop_loss === 0 || proposal.take_profit === 0)) {
      const h1 = snapshot.indicators.H1;
      const h4 = snapshot.indicators.H4;
      if (h1 && h4) {
        const calc = calcDynamicSLTP({
          direction:   proposal.decision,
          entry:       proposal.entry,
          atr:         h1.atr,
          atrH4:       h4.atr,
          srLevels:    snapshot.srLevels,
          lastSwingHH: snapshot.dowTheory.lastHH,
          lastSwingHL: snapshot.dowTheory.lastHL,
          lastSwingLH: snapshot.dowTheory.lastLH,
          lastSwingLL: snapshot.dowTheory.lastLL,
          spread:      snapshot.spread,
          digits:      snapshot.digits,
        });
        if (proposal.stop_loss === 0)   { proposal.stop_loss  = calc.sl; proposal.sl_pips = calc.slPips; }
        if (proposal.take_profit === 0) { proposal.take_profit = calc.tp; proposal.tp_pips = calc.tpPips; }
        if (proposal.risk_reward === 0) { proposal.risk_reward = calc.rr; }
      }
    }

    return NextResponse.json(proposal, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[brain/decision]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
