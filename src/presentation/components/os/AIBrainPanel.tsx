"use client";

// =================================================================
// AIBrainPanel — AI Trading Brain パイプライン表示
//
// MarketSnapshot → AI Decision → Risk Engine → DRY RUN
// の各ステップをリアルタイムで可視化する。
// =================================================================

import { cn } from "@/lib/utils";
import { Brain, Shield, Activity, TrendingUp, TrendingDown,
         Minus, AlertCircle, CheckCircle, XCircle, Play, RotateCcw } from "lucide-react";
import type { BrainState, BrainStep } from "@/presentation/hooks/useAIBrain";
import type { TradeProposal, RiskDecision, MarketSnapshot } from "@/domain/trading/MarketSnapshot";

// -----------------------------------------------------------------
// ステップバー
// -----------------------------------------------------------------
const STEPS: { id: BrainStep; label: string }[] = [
  { id: "snapshot", label: "SNAPSHOT" },
  { id: "decision", label: "AI DECISION" },
  { id: "risk",     label: "RISK ENGINE" },
  { id: "dryrun",   label: "DRY RUN" },
  { id: "complete", label: "COMPLETE" },
];
const STEP_ORDER: BrainStep[] = ["idle","snapshot","decision","risk","dryrun","executing","complete","error"];
function stepIndex(s: BrainStep) { return STEP_ORDER.indexOf(s); }

function StepBar({ step }: { step: BrainStep }) {
  const cur = stepIndex(step);
  return (
    <div className="flex items-center gap-1 mb-3">
      {STEPS.map((s, i) => {
        const idx  = stepIndex(s.id);
        const done = cur > idx;
        const active = cur === idx;
        return (
          <div key={s.id} className="flex items-center gap-1 flex-1">
            <div className={cn("flex-1 text-center px-1 py-0.5 text-[7px] font-mono tracking-wider border transition-all",
              active ? "border-cyan-500/60 bg-cyan-900/20 text-cyan-300" :
              done   ? "border-green-700/40 bg-green-950/10 text-green-400" :
              "border-[#0d1520] text-gray-700"
            )}>
              {s.label}
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("w-3 h-px", done ? "bg-green-500/40" : "bg-[#0d1520]")}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------
// Snapshot サマリー
// -----------------------------------------------------------------
function SnapshotSummary({ snap }: { snap: MarketSnapshot }) {
  const h4 = snap.indicators.H4;
  return (
    <div className="border border-[#0d1520] p-2 space-y-1 text-[7.5px] font-mono">
      <p className="text-[7px] text-cyan-400/50 tracking-wider mb-1.5">MARKET SNAPSHOT</p>
      <div className="grid grid-cols-3 gap-1">
        <div>
          <p className="text-gray-700">SOURCE</p>
          <p className={cn("font-semibold", snap.overallSource === "MT5_LIVE" ? "text-green-400" : "text-yellow-400")}>
            {snap.overallSource}
          </p>
        </div>
        <div>
          <p className="text-gray-700">SPREAD</p>
          <p className={cn("font-semibold", snap.spread > 3 ? "text-red-400" : "text-cyan-300")}>
            {snap.spread.toFixed(1)}p
          </p>
        </div>
        <div>
          <p className="text-gray-700">NEWS RISK</p>
          <p className={cn("font-semibold",
            snap.newsRisk === "HIGH" ? "text-red-400" :
            snap.newsRisk === "MEDIUM" ? "text-yellow-400" : "text-green-400"
          )}>{snap.newsRisk}</p>
        </div>
        <div>
          <p className="text-gray-700">DOW THEORY</p>
          <p className={cn("font-semibold",
            snap.dowTheory.trend === "UPTREND" ? "text-green-400" :
            snap.dowTheory.trend === "DOWNTREND" ? "text-red-400" : "text-gray-400"
          )}>{snap.dowTheory.trend}</p>
        </div>
        <div>
          <p className="text-gray-700">MULTI-TF</p>
          <p className={cn("font-semibold",
            snap.multiTF.direction === "BUY" ? "text-green-400" :
            snap.multiTF.direction === "SELL" ? "text-red-400" : "text-gray-400"
          )}>{snap.multiTF.direction} ({snap.multiTF.alignedCount}/{snap.multiTF.totalCount})</p>
        </div>
        <div>
          <p className="text-gray-700">SESSION</p>
          <p className="text-cyan-300">{snap.session.join("+") || "OFF"}</p>
        </div>
      </div>
      {h4 && (
        <div className="pt-1 border-t border-[#0d1520] grid grid-cols-4 gap-1 text-[7px]">
          <div><p className="text-gray-700">H4 EMA</p><p className={h4.ema21>h4.ema200?"text-green-400":"text-red-400"}>{h4.trend}</p></div>
          <div><p className="text-gray-700">RSI</p><p className={h4.rsi>70?"text-red-400":h4.rsi<30?"text-green-400":"text-gray-300"}>{h4.rsi.toFixed(0)}</p></div>
          <div><p className="text-gray-700">ADX</p><p className={h4.adx>25?"text-cyan-300":"text-gray-500"}>{h4.adx.toFixed(0)}</p></div>
          <div><p className="text-gray-700">ATR</p><p className="text-orange-400">{h4.atr.toFixed(5)}</p></div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Trade Proposal 表示
// -----------------------------------------------------------------
function ProposalCard({ p }: { p: TradeProposal }) {
  const isBuy  = p.decision === "BUY";
  const isWait = p.decision === "WAIT";
  return (
    <div className={cn("border p-2 space-y-1.5 text-[7.5px] font-mono",
      isWait ? "border-gray-700/30 bg-[#04060d]" :
      isBuy  ? "border-green-700/40 bg-green-950/10" : "border-red-700/40 bg-red-950/10"
    )}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[7px] text-purple-400/50 tracking-wider">AI DECISION</p>
        <div className="flex items-center gap-2">
          <span className={cn("text-[9px] font-bold px-2 py-0.5 border",
            isWait ? "border-gray-700/40 text-gray-500" :
            isBuy  ? "border-green-600/50 text-green-300 bg-green-900/20" : "border-red-600/50 text-red-300 bg-red-900/20"
          )}>{p.decision}</span>
          <span className={cn("text-[8px]",
            p.confidence >= 75 ? "text-green-400" :
            p.confidence >= 60 ? "text-yellow-400" : "text-red-400"
          )}>{p.confidence}%</span>
        </div>
      </div>

      {!isWait && (
        <>
          <div className="grid grid-cols-3 gap-1">
            {[
              ["ENTRY", p.entry.toFixed(5), "text-white"],
              ["SL",    p.stop_loss.toFixed(5), "text-red-400"],
              ["TP",    p.take_profit.toFixed(5), "text-green-400"],
            ].map(([l, v, c]) => (
              <div key={l} className="border border-[#0d1520] p-1 text-center">
                <p className="text-[6.5px] text-gray-700">{l}</p>
                <p className={cn("text-[8px] font-semibold", c)}>{v}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-3 text-[7px]">
            <span className="text-gray-600">RR: <span className="text-cyan-400">{p.risk_reward.toFixed(2)}</span></span>
            <span className="text-gray-600">EV: <span className={p.expected_value >= 0 ? "text-green-400" : "text-red-400"}>{p.expected_value.toFixed(2)}</span></span>
            <span className="text-gray-600">WinP: <span className="text-yellow-400">{p.win_probability.toFixed(0)}%</span></span>
          </div>
          <div className="text-[6.5px] text-gray-600 leading-relaxed">
            <span className="text-gray-500">Setup: </span>{p.setup_type} | {p.time_horizon}
          </div>
        </>
      )}

      {/* Reasoning */}
      <div className="pt-1 border-t border-[#0d1520] space-y-0.5">
        {Object.entries(p.reasoning).filter(([, v]) => v).slice(0, 4).map(([k, v]) => (
          <p key={k} className="text-[6.5px] leading-snug">
            <span className="text-gray-700 uppercase">{k.replace("_", " ")}: </span>
            <span className="text-gray-500">{v}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// Risk Decision 表示
// -----------------------------------------------------------------
function RiskCard({ r }: { r: RiskDecision }) {
  const isOk   = r.status === "APPROVED";
  const isMod  = r.status === "MODIFIED";
  const isRej  = r.status === "REJECTED";
  const checks = r.checks;
  const passedChecks = Object.values(checks).filter(Boolean).length;
  const totalChecks  = Object.values(checks).length;
  return (
    <div className={cn("border p-2 space-y-1.5 text-[7.5px] font-mono",
      isOk  ? "border-green-700/40 bg-green-950/10" :
      isMod ? "border-yellow-700/40 bg-yellow-950/10" : "border-red-700/40 bg-red-950/10"
    )}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[7px] text-orange-400/50 tracking-wider">RISK ENGINE</p>
        <div className="flex items-center gap-2">
          {isOk  && <CheckCircle size={10} className="text-green-400"/>}
          {isMod && <AlertCircle size={10} className="text-yellow-400"/>}
          {isRej && <XCircle     size={10} className="text-red-400"/>}
          <span className={cn("text-[9px] font-bold",
            isOk ? "text-green-300" : isMod ? "text-yellow-300" : "text-red-300"
          )}>{r.status}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1 text-[7px]">
        {[
          ["LOT",   r.lot.toFixed(2), "text-cyan-300"],
          ["RISK",  `${r.riskPct.toFixed(2)}%`, r.riskPct < 1 ? "text-green-400" : "text-yellow-400"],
          ["CHECKS",`${passedChecks}/${totalChecks}`, passedChecks===totalChecks?"text-green-400":"text-yellow-400"],
          ["LIVE",  r.proposal.decision !== "WAIT" && !isRej ? "DRY RUN" : "—", "text-gray-500"],
        ].map(([l, v, c]) => (
          <div key={l} className="border border-[#0d1520] p-1 text-center">
            <p className="text-[6px] text-gray-700">{l}</p>
            <p className={cn("font-semibold", c)}>{v}</p>
          </div>
        ))}
      </div>

      {r.rejectionReason && (
        <p className="text-[6.5px] text-red-400/80 leading-relaxed pt-0.5 border-t border-[#0d1520]">
          {r.rejectionReason}
        </p>
      )}
      {r.modifications.length > 0 && (
        <p className="text-[6.5px] text-yellow-400/80 leading-relaxed">
          {r.modifications.join(" | ")}
        </p>
      )}

      {/* Check grid */}
      <div className="pt-1 border-t border-[#0d1520] grid grid-cols-4 gap-0.5 text-[6px]">
        {Object.entries(checks).map(([k, v]) => (
          <div key={k} className="flex items-center gap-0.5">
            <div className={cn("w-1 h-1 rounded-full", v ? "bg-green-500" : "bg-red-500")}/>
            <span className={v ? "text-gray-600" : "text-red-400/70"}>{k.replace(/Ok$/, "").slice(0, 9)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// メインパネル
// -----------------------------------------------------------------
interface AIBrainPanelProps {
  state:    BrainState;
  onRun:    (symbol?: string) => void;
  onReset:  () => void;
  symbol:   string;
}

export function AIBrainPanel({ state, onRun, onReset, symbol }: AIBrainPanelProps) {
  const { step, snapshot, proposal, riskResult, error, lastRunTs } = state;
  const isRunning = !["idle","complete","error"].includes(step);

  const dirIcon = proposal?.decision === "BUY"  ? <TrendingUp  size={10} className="text-green-400"/> :
                  proposal?.decision === "SELL" ? <TrendingDown size={10} className="text-red-400"/>   :
                  <Minus size={10} className="text-gray-500"/>;

  return (
    <div className="flex flex-col gap-2 h-full overflow-y-auto avl-scroll p-3 pt-12 md:pt-3 space-y-2">

      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={11} className="text-purple-400"/>
          <span className="text-[9px] font-mono tracking-wider text-purple-400/80">AVL AI BRAIN</span>
          <span className="text-[7px] font-mono border border-yellow-700/40 text-yellow-400 px-1.5 py-0.5">DRY RUN</span>
        </div>
        <div className="flex gap-1.5">
          <button onClick={onReset} disabled={isRunning}
            className="flex items-center gap-1 px-2 py-1 text-[7px] font-mono border border-[#0d1520] text-gray-600 hover:text-gray-400 disabled:opacity-30">
            <RotateCcw size={8}/> RESET
          </button>
          <button onClick={() => onRun(symbol)} disabled={isRunning}
            className={cn("flex items-center gap-1 px-3 py-1 text-[8px] font-mono border transition-all",
              isRunning
                ? "border-purple-700/50 text-purple-300 bg-purple-950/20 cursor-wait"
                : "border-cyan-700/40 text-cyan-400 hover:bg-cyan-900/20"
            )}>
            {isRunning
              ? <><Brain size={9} className="animate-pulse"/> {step.toUpperCase()}...</>
              : <><Play size={9}/> ANALYZE {symbol}</>}
          </button>
        </div>
      </div>

      {/* ステップバー */}
      <StepBar step={step}/>

      {/* エラー */}
      {error && (
        <div className="border border-red-700/40 bg-red-950/10 p-2">
          <p className="text-[7.5px] font-mono text-red-400"><AlertCircle size={8} className="inline mr-1"/>{error}</p>
        </div>
      )}

      {/* 結果サマリー（完了時） */}
      {step === "complete" && proposal && (
        <div className={cn("border p-2 flex items-center justify-between",
          proposal.decision === "WAIT" ? "border-gray-700/30" :
          proposal.decision === "BUY"  ? "border-green-700/40 bg-green-950/10" : "border-red-700/40 bg-red-950/10"
        )}>
          <div className="flex items-center gap-2">
            {dirIcon}
            <span className={cn("text-[10px] font-mono font-bold",
              proposal.decision === "BUY" ? "text-green-300" :
              proposal.decision === "SELL" ? "text-red-300" : "text-gray-500"
            )}>{proposal.decision}</span>
            <span className="text-[8px] font-mono text-gray-500">{symbol}</span>
          </div>
          <div className="flex items-center gap-3 text-[7.5px] font-mono">
            <span className="text-gray-600">conf: <span className="text-white">{proposal.confidence}%</span></span>
            {riskResult && <span className={cn(
              riskResult.status === "APPROVED" ? "text-green-400" :
              riskResult.status === "MODIFIED" ? "text-yellow-400" : "text-red-400"
            )}>{riskResult.status}</span>}
            {lastRunTs && (
              <span className="text-gray-700">{new Date(lastRunTs).toLocaleTimeString("ja-JP")}</span>
            )}
          </div>
        </div>
      )}

      {/* MarketSnapshot */}
      {snapshot && <SnapshotSummary snap={snapshot}/>}

      {/* Trade Proposal */}
      {proposal && <ProposalCard p={proposal}/>}

      {/* Risk Decision */}
      {riskResult && <RiskCard r={riskResult}/>}

      {/* 空状態 */}
      {step === "idle" && (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <Shield size={24} className="text-gray-800"/>
          <p className="text-[8px] text-gray-700 font-mono text-center">
            ANALYZE ボタンで AI Brain を起動<br/>
            MarketSnapshot → Decision → Risk Engine
          </p>
        </div>
      )}

      {/* DRY RUN 注意書き */}
      <div className="border border-yellow-900/20 bg-yellow-950/10 p-2">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Activity size={8} className="text-yellow-500/60"/>
          <p className="text-[7px] font-mono text-yellow-500/60 tracking-wider">SAFETY NOTICE</p>
        </div>
        <p className="text-[6.5px] font-mono text-gray-700 leading-relaxed">
          DRY RUN モード有効。実際の注文は送信されません。<br/>
          ライブ取引を有効化するには ENABLE_LIVE_TRADING=true（サーバー設定）が必要です。
        </p>
      </div>
    </div>
  );
}
