"use client";

// =================================================================
// useBrainScanner — Continuous Opportunity Scanner Loop
//
// Runs a timed scan of all configured symbols.
// Emits scan events and ranked opportunities to the UI.
// ENABLE_LIVE_TRADING=false at all times.
// =================================================================

import { useCallback, useRef, useState } from "react";
import type { ActivityEvent } from "@/presentation/components/ai-brain/ActivityStream";
import type { RankedOpp }     from "@/presentation/components/ai-brain/OpportunityRanker";
import type { ScanResult }    from "@/app/api/ai/brain/scan/route";

export interface SymbolScanRow {
  symbol:     string;
  status:     "pending" | "scanning" | "done" | "skip";
  direction:  "BUY" | "SELL" | "WAIT" | null;
  confidence: number;
  dataQuality:number;
  spread:     number;
  source:     string;
}

const DEFAULT_SYMBOLS = [
  "EURUSD","USDJPY","EURJPY","GBPJPY",
  "GBPUSD","AUDUSD","USDCAD","GOLD",
];

let evCounter = 0;
function mkEvent(
  category: ActivityEvent["category"],
  message:  string,
  level:    ActivityEvent["level"] = "info"
): ActivityEvent {
  return { id: `ev_${++evCounter}_${Date.now()}`, ts: Date.now(), category, message, level };
}

export function useBrainScanner(symbols: string[] = DEFAULT_SYMBOLS) {
  const [scanning,      setScanning]      = useState(false);
  const [scanRows,      setScanRows]      = useState<SymbolScanRow[]>([]);
  const [currentSym,   setCurrentSym]    = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<RankedOpp[]>([]);
  const [events,        setEvents]        = useState<ActivityEvent[]>([]);
  const [lastScanTs,    setLastScanTs]    = useState<number | null>(null);
  const [brainVisState, setBrainVisState] = useState("idle");

  const abortRef = useRef(false);

  const addEvent = useCallback((ev: ActivityEvent) => {
    setEvents(prev => [...prev.slice(-99), ev]);
  }, []);

  const runScan = useCallback(async () => {
    if (scanning) return;
    abortRef.current = false;
    setScanning(true);
    setBrainVisState("scanning");
    addEvent(mkEvent("SYSTEM", `Opportunity scan started — ${symbols.length} symbols`, "ok"));

    // Reset rows
    setScanRows(symbols.map(s => ({
      symbol: s, status: "pending", direction: null,
      confidence: 0, dataQuality: 0, spread: 0, source: "",
    })));
    setOpportunities([]);

    try {
      // Use backend scanner for efficiency
      addEvent(mkEvent("AI", "Dispatching market scanner to Railway Gateway", "ai"));
      setBrainVisState("collecting");

      const res = await fetch("/api/ai/brain/scan", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbols, maxResults: 10 }),
      });

      if (!res.ok) throw new Error(`Scan API failed: ${res.status}`);
      const data = await res.json() as ScanResult;

      if (abortRef.current) return;

      // Animate rows one by one
      setBrainVisState("analyzing");
      addEvent(mkEvent("MARKET", `Received data for ${data.scanned} symbols`, "ok"));

      const allOpps = [...data.opportunities, ...data.skipped];
      for (const opp of allOpps) {
        if (abortRef.current) break;
        setCurrentSym(opp.symbol);

        // Small delay for visual effect
        await new Promise(r => setTimeout(r, 120));

        setScanRows(prev => prev.map(r =>
          r.symbol === opp.symbol
            ? {
                ...r,
                status:     opp.skipped ? "skip" : "done",
                direction:  opp.direction,
                confidence: opp.confidence,
                dataQuality:opp.dataQuality,
                spread:     opp.spread,
                source:     opp.data_source ?? "",
              }
            : r
        ));

        if (!opp.skipped) {
          const lvl = opp.direction !== "WAIT" ? "signal" : "info";
          addEvent(mkEvent("TECHNICAL",
            `${opp.symbol}: ${opp.direction} conf=${opp.confidence} DQ=${opp.dataQuality}/100`,
            lvl
          ));
        } else {
          addEvent(mkEvent("SYSTEM", `${opp.symbol}: insufficient data (DQ=${opp.dataQuality})`, "warn"));
        }
      }

      setCurrentSym(null);

      // Build ranked opportunities
      const ranked: RankedOpp[] = data.opportunities
        .filter(o => !o.skipped)
        .map(o => ({
          rank:        o.rank,
          symbol:      o.symbol,
          direction:   o.direction,
          confidence:  o.confidence,
          dataQuality: o.dataQuality,
          rr:          o.rr,
          entry:       o.entry,
          sl:          o.sl,
          tp:          o.tp,
          spread:      o.spread,
          dowTrend:    o.dow_trend,
          reason:      o.reason,
        }));

      setOpportunities(ranked);

      // Summary events
      const actionable = ranked.filter(r => r.direction !== "WAIT");
      if (actionable.length > 0) {
        const best = actionable[0];
        addEvent(mkEvent("AI",
          `Best opportunity: ${best.symbol} ${best.direction} (conf=${best.confidence}%)`,
          "signal"
        ));
        setBrainVisState(best.direction === "BUY" ? "complete_buy" : best.direction === "SELL" ? "complete_sell" : "complete_wait");
      } else {
        addEvent(mkEvent("AI", "No actionable setups — market conditions warrant WAIT", "info"));
        setBrainVisState("complete_wait");
      }

      addEvent(mkEvent("SYSTEM", `Scan complete — ${data.summary}`, "ok"));
      setLastScanTs(Date.now());

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addEvent(mkEvent("SYSTEM", `Scan error: ${msg}`, "warn"));
      setBrainVisState("error");
    } finally {
      setScanning(false);
      setCurrentSym(null);
      // Return to standby after 3s
      setTimeout(() => setBrainVisState(prev =>
        ["complete_buy","complete_sell","complete_wait"].includes(prev) ? "standby" : prev
      ), 4000);
    }
  }, [scanning, symbols, addEvent]);

  const stop = useCallback(() => {
    abortRef.current = true;
    setScanning(false);
    setCurrentSym(null);
    setBrainVisState("standby");
    addEvent(mkEvent("SYSTEM", "Scan stopped by user", "warn"));
  }, [addEvent]);

  return {
    scanning, scanRows, currentSym, opportunities,
    events, lastScanTs, brainVisState,
    runScan, stop, addEvent,
    symbols,
  };
}
