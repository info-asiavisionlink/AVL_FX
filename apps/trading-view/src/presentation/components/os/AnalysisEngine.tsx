"use client";

import { useAnalysisStore } from "@/application/stores/analysisStore";
import type { FullAnalysisResult, ModuleResult, Direction } from "@/infrastructure/analysis/types";
import { Brain, Zap, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 75) return "#22c55e";
  if (score >= 60) return "#eab308";
  return "#ef4444";
}

function dirIcon(dir: Direction) {
  if (dir === 'BUY')  return <TrendingUp  size={10} className="text-green-400"/>;
  if (dir === 'SELL') return <TrendingDown size={10} className="text-red-400"/>;
  return <Minus size={10} className="text-gray-500"/>;
}

function ScoreBar({ label, score, direction }: { label: string; score: number; direction: Direction }) {
  const col = scoreColor(score);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="flex items-center gap-1 w-5">{dirIcon(direction)}</div>
      <span className="text-[8px] font-mono text-gray-400 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${score}%`, backgroundColor: col, boxShadow: `0 0 4px ${col}88` }}/>
      </div>
      <span className="text-[9px] font-mono tabular-nums w-8 text-right" style={{ color: col }}>{score}%</span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-2 p-4">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="h-4 bg-gray-800 rounded" style={{ width: `${60 + (i % 3) * 15}%` }}/>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Trade Setup Card
// ─────────────────────────────────────────────

function TradeSetupCard({ setup, digits }: {
  setup: NonNullable<FullAnalysisResult['tradeSetup']>;
  digits: number;
}) {
  const isBuy = setup.direction === 'BUY';
  const col   = isBuy ? '#22c55e' : '#ef4444';

  return (
    <div className="border p-3 space-y-1.5" style={{ borderColor: `${col}40`, backgroundColor: `${col}08` }}>
      <div className="flex items-center justify-between">
        <span className="text-[8px] font-mono tracking-[0.2em] text-gray-500">TRADE SETUP</span>
        <span className="text-[10px] font-mono font-bold" style={{ color: col, textShadow: `0 0 8px ${col}88` }}>
          {setup.direction}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {[
          { label: 'ENTRY', value: setup.entry?.toFixed(digits) },
          { label: 'SL',    value: setup.sl?.toFixed(digits),   col: '#ef4444' },
          { label: 'TP1',   value: setup.tp1?.toFixed(digits),  col: '#22c55e' },
          { label: 'TP2',   value: setup.tp2?.toFixed(digits),  col: '#22c55e' },
          { label: 'RR1',   value: setup.rrRatio1 },
          { label: 'RR2',   value: setup.rrRatio2 },
        ].map(({ label, value, col: c }) => (
          <div key={label} className="flex justify-between items-baseline border-b border-gray-800 pb-0.5">
            <span className="text-[7.5px] text-gray-600 font-mono">{label}</span>
            <span className="text-[9px] font-mono tabular-nums font-semibold" style={{ color: c ?? '#e5e7eb' }}>{value ?? '—'}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <span className="text-[8px] font-mono text-gray-500">Confidence: {setup.confidence}%</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Swing Points mini visualization
// ─────────────────────────────────────────────

function SwingViz({ swings }: { swings: FullAnalysisResult['dowTheory']['swingPoints'] }) {
  const last = swings.slice(-12);
  if (last.length === 0) return null;

  const prices = last.map(s => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  return (
    <div className="relative h-10 mt-1">
      <svg className="w-full h-full" viewBox="0 0 200 40" preserveAspectRatio="none">
        <polyline
          points={last.map((s, i) => `${(i / (last.length - 1)) * 200},${40 - ((s.price - min) / range) * 36}`).join(' ')}
          fill="none" stroke="#00e5ff44" strokeWidth="1"/>
        {last.map((s, i) => {
          const x = (i / (last.length - 1)) * 200;
          const y = 40 - ((s.price - min) / range) * 36;
          const col = s.type === 'high' ? '#00e5ff' : '#ef4444';
          return <circle key={i} cx={x} cy={y} r={2} fill={col} opacity={0.8}/>;
        })}
      </svg>
      <div className="flex gap-2 mt-0.5">
        {last.slice(-5).map((s, i) => (
          <span key={i} className={cn("text-[6.5px] font-mono", s.type === 'high' ? 'text-cyan-400' : 'text-red-400')}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Module row details
// ─────────────────────────────────────────────

function ModuleCard({ title, result }: { title: string; result: ModuleResult }) {
  return (
    <div className="border border-gray-800 p-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[7.5px] font-mono tracking-[0.15em] text-gray-500">{title}</span>
        <span className="text-[8px] font-mono" style={{ color: scoreColor(result.score) }}>{result.score}%</span>
      </div>
      <p className="text-[8px] font-mono text-gray-400 leading-relaxed">{result.summary}</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

export function AnalysisEngine({ activeSymbol }: { activeSymbol: string }) {
  const sym     = activeSymbol.toUpperCase();
  const store   = useAnalysisStore();
  const result  = store.getResult(sym);
  const loading = store.loading[sym] ?? false;
  const error   = store.error[sym];

  const digits = sym.includes('JPY') ? 3 : 5;

  const modules = result ? [
    { label: 'Market Env',  score: result.marketEnvironment.score,    direction: result.marketEnvironment.direction },
    { label: 'Dow Theory',  score: result.dowTheory.score,            direction: result.dowTheory.direction },
    { label: 'Multi-TF',    score: result.multiTF.score,              direction: result.multiTF.direction },
    { label: 'Indicators',  score: result.technicalIndicators.score,  direction: result.technicalIndicators.direction },
    { label: 'S/R Levels',  score: result.supportResistance.score,    direction: result.supportResistance.direction },
    { label: 'Candles',     score: result.candlestickPatterns.score,  direction: result.candlestickPatterns.direction },
    { label: 'Chart Pat.',  score: result.chartPatterns.score,        direction: result.chartPatterns.direction },
    { label: 'Correlation', score: result.correlation.score,          direction: result.correlation.direction },
  ] : [];

  const overallCol = result ? scoreColor(result.overall.confidence) : '#6b7280';

  return (
    <div className="flex flex-col h-full bg-[#02040a] overflow-hidden text-gray-200">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-cyan-900/20 bg-[#04060c] shrink-0">
        <div className="flex items-center gap-2.5">
          <Brain size={12} style={{ color: '#00e5ff' }}/>
          <span className="text-[9.5px] font-mono tracking-[0.2em] text-cyan-400/80 font-semibold">ANALYSIS ENGINE</span>
          <span className="text-[8px] font-mono border border-cyan-800/40 px-2 py-0.5 text-cyan-300/60">{sym}</span>
        </div>
        <button
          onClick={() => store.runAnalysis(sym)}
          disabled={loading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-[7.5px] font-mono border tracking-wider transition-all",
            loading
              ? "border-cyan-700/30 text-cyan-400/40 cursor-wait"
              : "border-cyan-700/50 text-cyan-400 hover:bg-cyan-900/20 hover:border-cyan-500/60"
          )}>
          <Zap size={8} className={loading ? 'animate-pulse' : ''}/>
          {loading ? 'ANALYZING...' : 'RUN ANALYSIS'}
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT — Confidence Matrix */}
        <div className="w-52 shrink-0 border-r border-cyan-900/20 flex flex-col p-3 gap-2 overflow-y-auto">
          <p className="text-[7.5px] font-mono tracking-[0.2em] text-gray-600">CONFIDENCE MATRIX</p>

          {loading && <Skeleton/>}

          {!loading && modules.map(m => (
            <ScoreBar key={m.label} {...m}/>
          ))}

          {!loading && result && (
            <>
              <div className="my-1 h-px bg-cyan-900/20"/>
              <div className="flex items-center justify-between px-1">
                <span className="text-[8.5px] font-mono text-gray-400 font-semibold">OVERALL</span>
                <span className="text-[12px] font-black font-mono tabular-nums"
                  style={{ color: overallCol, textShadow: `0 0 8px ${overallCol}88` }}>
                  {result.overall.confidence}%
                </span>
              </div>
              <div className="flex items-center gap-2 px-1">
                {dirIcon(result.overall.direction)}
                <span className="text-[9px] font-mono font-bold"
                  style={{ color: result.overall.direction === 'BUY' ? '#22c55e' : result.overall.direction === 'SELL' ? '#ef4444' : '#6b7280' }}>
                  {result.overall.direction}
                </span>
                {result.overall.tradeable && (
                  <span className="text-[7px] font-mono border border-green-600/40 text-green-400/80 px-1.5 py-0.5 bg-green-950/15">
                    TRADEABLE
                  </span>
                )}
              </div>
            </>
          )}

          {!loading && !result && !error && (
            <p className="text-[8px] text-gray-700 font-mono pt-2">Press RUN ANALYSIS to start.</p>
          )}

          {error && (
            <div className="flex items-start gap-1.5 text-red-400">
              <AlertCircle size={10} className="mt-0.5 shrink-0"/>
              <p className="text-[7.5px] font-mono">{error}</p>
            </div>
          )}
        </div>

        {/* RIGHT — Details */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">

          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <RefreshCw size={20} className="text-cyan-400/40 animate-spin"/>
              <p className="text-[9px] font-mono tracking-[0.2em] text-gray-600">RUNNING MULTI-FACTOR ANALYSIS...</p>
            </div>
          )}

          {!loading && result && (
            <>
              {/* AI Synthesis */}
              <div className="border border-cyan-900/25 p-3 bg-cyan-950/10">
                <p className="text-[7.5px] font-mono tracking-[0.2em] text-cyan-400/60 mb-2">AI SYNTHESIS</p>
                <p className="text-[8.5px] font-mono text-gray-300 leading-relaxed">{result.aiSynthesis}</p>
              </div>

              {/* Trade Setup */}
              {result.tradeSetup && (
                <TradeSetupCard setup={result.tradeSetup} digits={digits}/>
              )}

              {/* Dow Theory */}
              <div className="border border-gray-800 p-2.5">
                <p className="text-[7.5px] font-mono tracking-[0.2em] text-gray-500 mb-1.5">DOW THEORY</p>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[9px] font-mono font-bold" style={{ color: scoreColor(result.dowTheory.score) }}>
                    {result.dowTheory.trend}
                  </span>
                  <span className="text-[7.5px] font-mono text-gray-500">{result.dowTheory.summary}</span>
                </div>
                <SwingViz swings={result.dowTheory.swingPoints}/>
              </div>

              {/* Indicator detail grid */}
              {result.technicalIndicators.byTimeframe && (
                <div className="border border-gray-800 p-2.5">
                  <p className="text-[7.5px] font-mono tracking-[0.2em] text-gray-500 mb-2">INDICATORS BY TIMEFRAME</p>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(result.technicalIndicators.byTimeframe).map(([tf, data]) => {
                      const d = data as { score: number; direction: Direction; signals: string[] };
                      return (
                        <div key={tf} className="border border-gray-800/60 p-1.5">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[7.5px] font-mono text-gray-500">{tf}</span>
                            <span className="text-[8px] font-mono" style={{ color: scoreColor(d.score) }}>{d.score}%</span>
                          </div>
                          {(d.signals ?? []).slice(0, 3).map((sig, i) => (
                            <p key={i} className="text-[7px] font-mono text-gray-600">• {sig}</p>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* S/R Levels */}
              <div className="border border-gray-800 p-2.5">
                <p className="text-[7.5px] font-mono tracking-[0.2em] text-gray-500 mb-2">KEY S/R LEVELS</p>
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {result.supportResistance.levels
                    .filter(l => l.strength >= 2)
                    .sort((a, b) => b.price - a.price)
                    .slice(0, 10)
                    .map((l, i) => {
                      const isR = l.type === 'resistance';
                      const isP = l.type === 'pivot';
                      const col = isR ? '#ef4444' : isP ? '#eab308' : '#22c55e';
                      return (
                        <div key={i} className="flex items-center justify-between py-0.5 border-b border-gray-800/40 last:border-0">
                          <span className="text-[7.5px] font-mono text-gray-600">{l.source}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[6.5px] font-mono" style={{ color: col }}>{l.type.toUpperCase()}</span>
                            <span className="text-[8.5px] font-mono tabular-nums" style={{ color: col }}>{l.price.toFixed(digits)}</span>
                            <span className="text-[6.5px] text-gray-700 font-mono">×{l.strength}</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Patterns + Correlation row */}
              <div className="grid grid-cols-2 gap-2">
                <ModuleCard title="CANDLESTICK PATTERNS" result={result.candlestickPatterns}/>
                <ModuleCard title="CHART PATTERNS"       result={result.chartPatterns}/>
                <ModuleCard title="CORRELATION"          result={result.correlation}/>
                <ModuleCard title="MARKET ENVIRONMENT"   result={result.marketEnvironment}/>
              </div>

              {/* Timestamp */}
              <p className="text-[7px] font-mono text-gray-700 text-right">
                Analysis: {new Date(result.timestamp).toLocaleTimeString()}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
