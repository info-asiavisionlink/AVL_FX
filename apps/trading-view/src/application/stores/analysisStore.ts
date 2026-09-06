"use client";

import { create } from "zustand";
import type { FullAnalysisResult } from "@/infrastructure/analysis/types";

interface AnalysisStore {
  results:  Record<string, FullAnalysisResult>;
  loading:  Record<string, boolean>;
  error:    Record<string, string | null>;
  runAnalysis: (symbol: string) => Promise<void>;
  getResult:   (symbol: string) => FullAnalysisResult | null;
}

export const useAnalysisStore = create<AnalysisStore>((set, get) => ({
  results: {},
  loading: {},
  error:   {},

  runAnalysis: async (symbol: string) => {
    const sym = symbol.toUpperCase();
    set(s => ({ loading: { ...s.loading, [sym]: true }, error: { ...s.error, [sym]: null } }));
    try {
      const res = await fetch("/api/ai/analysis/full", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbol: sym }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as FullAnalysisResult;

      try {
        const embRes = await fetch("/api/ai/embeddings/similar-trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: data.symbol,
            direction: data.overall.direction,
            trend: data.dowTheory.trend,
            indicators: data.technicalIndicators.summary,
          }),
        });
        if (embRes.ok) {
          const { similar } = await embRes.json() as { similar: unknown[] };
          (data as FullAnalysisResult & { similarTrades?: unknown[] }).similarTrades = similar;
        }
      } catch { /* embeddings optional */ }

      set(s => ({ results: { ...s.results, [sym]: data }, loading: { ...s.loading, [sym]: false } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set(s => ({ loading: { ...s.loading, [sym]: false }, error: { ...s.error, [sym]: msg } }));
    }
  },

  getResult: (symbol: string) => get().results[symbol.toUpperCase()] ?? null,
}));
