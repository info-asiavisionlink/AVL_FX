"use client";

// =================================================================
// AIEABuilder v2 — GOLD# 専用 AI EA 一括生成
//
// フロー:
//   input → generating → results（5候補を並べてバックテスト逐次実行）
//
// 設計原則:
//   - 自然言語（曖昧 OK）+ 指標目標（PF/MDD/勝率/ペイオフ）で入力
//   - AI が 5 つの多様な GOLD# 戦略を生成
//   - バックテストを逐次実行してカードを更新
//   - 各カードに独立した「EA を追加する」ボタン
// =================================================================

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  conditionToJapanese,
  type StrategySpec,
  type StrategyRecord,
} from "@/lib/strategySchema";

// ── Color constants ────────────────────────────────────────────────
const NG      = "#f97316";
const NG_rgba = "rgba(249,115,22,";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";
const GREEN   = "#4ade80";

// ── Step ──────────────────────────────────────────────────────────
type Step = "input" | "generating" | "results";

// ── Metric targets ────────────────────────────────────────────────
interface MetricTargets {
  minPF:     string;   // "" = 指定なし
  maxMDD:    string;   // "" = 指定なし
  minWR:     string;   // "" = 指定なし
  minPayoff: string;   // "" = 指定なし
}

const EMPTY_TARGETS: MetricTargets = { minPF: "", maxMDD: "", minWR: "", minPayoff: "" };

// ── Backtest result ───────────────────────────────────────────────
interface BtReport {
  totalTrades:      number;
  wins:             number;
  losses:           number;
  winRate:          number;
  totalPips:        number;
  avgPips:          number;
  profitFactor:     number | null;
  maxDrawdownPct:   number;
  verdict:          "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:    string;
  sampleSizeWarning: boolean;
  minRecommendedTrades: number;
}

// ── Per-candidate state ───────────────────────────────────────────
interface Candidate {
  idx:      number;
  spec:     StrategySpec;
  btStatus: "pending" | "testing" | "done" | "error";
  report:   BtReport | null;
  btError:  string | null;
  added:    boolean;
  saving:   boolean;
}

// ── Props ─────────────────────────────────────────────────────────
interface Props {
  open:    boolean;
  onClose: () => void;
  onSaved: (strategy: StrategyRecord) => void;
}

// ── Helpers ───────────────────────────────────────────────────────
function pipsColor(p: number)    { return p >= 0 ? NG : RED; }
function verdictColor(v: string) { return v === "PASSED" ? GREEN : v === "CONDITIONAL" ? AMBER : RED; }
function verdictLabel(v: string) { return v === "PASSED" ? "合格" : v === "CONDITIONAL" ? "条件付" : "不合格"; }

function typeLabel(t: string) {
  if (t === "SCALPING")  return "スキャル";
  if (t === "DAY_TRADE") return "デイトレ";
  if (t === "SWING")     return "スイング";
  return t;
}

function typeColor(t: string) {
  if (t === "SCALPING")  return "#2563eb";
  if (t === "DAY_TRADE") return AMBER;
  return NG;
}

function payoffRatio(pf: number | null, wr: number): number | null {
  if (pf === null || wr <= 0 || wr >= 100) return null;
  const wrDec = wr / 100;
  return pf * (1 - wrDec) / wrDec;
}

// =================================================================
// メインコンポーネント
// =================================================================
export function AIEABuilder({ open, onClose, onSaved }: Props) {
  const [step,        setStep]        = useState<Step>("input");
  const [description, setDescription] = useState("");
  const [targets,     setTargets]     = useState<MetricTargets>(EMPTY_TARGETS);
  const [candidates,  setCandidates]  = useState<Candidate[]>([]);
  const [genError,    setGenError]    = useState<string | null>(null);
  const [addedCount,  setAddedCount]  = useState(0);
  const btAbortRef   = useRef<boolean>(false);
  const rawPromptRef = useRef("");

  // ── 個別 EA 追加（hooks ルール: useCallback は条件分岐の前に置く）──
  const handleAdd = useCallback(async (idx: number) => {
    setCandidates(prev => prev.map((c, ci) => ci === idx ? { ...c, saving: true } : c));

    setCandidates(prev => {
      const cand = prev[idx];
      if (!cand) return prev;

      void (async () => {
        try {
          const res  = await fetch("/api/strategies", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              spec:       cand.spec,
              raw_prompt: rawPromptRef.current,
              ...(cand.report ? {
                previewBacktestData: { report: cand.report, trades: [], barCount: 0 },
              } : {}),
            }),
          });
          const data = await res.json() as { strategy?: StrategyRecord; error?: string };

          if (!data.strategy) {
            toast.error(data.error ?? "保存に失敗しました");
            setCandidates(p => p.map((c, ci) => ci === idx ? { ...c, saving: false } : c));
            return;
          }

          setCandidates(p => p.map((c, ci) => ci === idx ? { ...c, saving: false, added: true } : c));
          setAddedCount(p => p + 1);
          toast.success(`「${cand.spec.name}」を追加しました`);
          onSaved(data.strategy);
        } catch {
          toast.error("保存エラーが発生しました");
          setCandidates(p => p.map((c, ci) => ci === idx ? { ...c, saving: false } : c));
        }
      })();
      return prev;
    });
  }, [onSaved]);

  if (!open) return null;

  const isReady = description.trim().length >= 3;

  // ── リセット ─────────────────────────────────────────────────────
  function handleClose() {
    btAbortRef.current = true;
    setStep("input");
    setDescription("");
    setTargets(EMPTY_TARGETS);
    setCandidates([]);
    setGenError(null);
    setAddedCount(0);
    onClose();
  }

  // ── 5戦略を生成 ──────────────────────────────────────────────────
  async function handleGenerate() {
    if (!isReady) return;
    setGenError(null);
    setStep("generating");
    btAbortRef.current = false;

    const t: Record<string, number> = {};
    if (targets.minPF     && !isNaN(Number(targets.minPF)))     t.minPF     = Number(targets.minPF);
    if (targets.maxMDD    && !isNaN(Number(targets.maxMDD)))    t.maxMDD    = Number(targets.maxMDD);
    if (targets.minWR     && !isNaN(Number(targets.minWR)))     t.minWR     = Number(targets.minWR);
    if (targets.minPayoff && !isNaN(Number(targets.minPayoff))) t.minPayoff = Number(targets.minPayoff);

    rawPromptRef.current = description.trim();

    try {
      const res  = await fetch("/api/ai/strategy/build-multi", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ description: description.trim(), targets: t }),
      });
      const data = await res.json() as { success: boolean; specs?: StrategySpec[]; error?: string };

      if (!data.success || !data.specs || data.specs.length === 0) {
        setGenError(data.error ?? "生成に失敗しました。再試行してください。");
        setStep("input");
        return;
      }

      const initialCandidates: Candidate[] = data.specs.map((spec, idx) => ({
        idx, spec, btStatus: "pending", report: null, btError: null, added: false, saving: false,
      }));
      setCandidates(initialCandidates);
      setStep("results");

      // バックテストを逐次実行
      for (let i = 0; i < initialCandidates.length; i++) {
        if (btAbortRef.current) break;

        setCandidates(prev => prev.map((c, ci) => ci === i ? { ...c, btStatus: "testing" } : c));

        try {
          const btRes  = await fetch("/api/ai/strategy/preview-backtest", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ spec: initialCandidates[i].spec }),
          });
          const btData = await btRes.json() as {
            success: boolean;
            report?: BtReport;
            error?:  string;
          };

          setCandidates(prev => prev.map((c, ci) => ci === i ? {
            ...c,
            btStatus: btData.success && btData.report ? "done" : "error",
            report:   btData.report ?? null,
            btError:  btData.success ? null : (btData.error ?? "バックテスト失敗"),
          } : c));
        } catch {
          setCandidates(prev => prev.map((c, ci) => ci === i ? {
            ...c, btStatus: "error", btError: "ネットワークエラー",
          } : c));
        }
      }

    } catch (e) {
      setGenError(e instanceof Error ? e.message : "ネットワークエラー");
      setStep("input");
    }
  }


  // =================================================================
  // レンダリング
  // =================================================================
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(4,6,13,0.92)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="relative w-full font-mono flex flex-col overflow-hidden rounded-lg"
        style={{
          maxWidth:   step === "results" ? "900px" : "560px",
          maxHeight:  "92vh",
          background: "#ffffff",
          border:     `1px solid ${NG_rgba}0.20)`,
          boxShadow:  `0 0 60px ${NG_rgba}0.06), 0 0 120px rgba(0,0,0,0.8)`,
          transition: "max-width 0.3s ease",
        }}
      >
        {/* ── ヘッダー ── */}
        <div className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${NG_rgba}0.10)` }}>
          <div className="flex items-center gap-3">
            <span className="text-[10px] tracking-[0.3em] font-black" style={{ color: NG }}>
              AI EA BUILDER · GOLD#
            </span>
            {step === "generating" && (
              <span className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}>
                5 戦略を設計中...
              </span>
            )}
            {step === "results" && (
              <span className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: `rgba(74,222,128,0.08)`, border: `1px solid rgba(74,222,128,0.25)`, color: GREEN }}>
                {addedCount > 0 ? `${addedCount} 件追加済み` : "候補を選択してください"}
              </span>
            )}
          </div>
          <button onClick={handleClose} className="text-[16px] leading-none transition-opacity hover:opacity-60"
            style={{ color: "#4b5563" }}>×</button>
        </div>

        {/* ── コンテンツ ── */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* ─── INPUT ─── */}
          {(step === "input" || step === "generating") && (
            <div className="flex flex-col gap-5 max-w-xl mx-auto">

              {/* 自然言語 */}
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[10px] tracking-[0.15em] font-black" style={{ color: NG }}>
                    戦略の方向性
                  </span>
                  <span className="text-[7px] tracking-widest" style={{ color: "#9a9a9a" }}>STRATEGY CONCEPT</span>
                </div>
                <p className="text-[9px] mb-1.5" style={{ color: "#9a9a9a" }}>
                  GOLD のトレードスタイルを自由に記述（曖昧でも OK）
                </p>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  disabled={step === "generating"}
                  rows={4}
                  placeholder={"例：GOLDのデイトレで上昇トレンドに乗るものがほしい\n　　一目均衡表を使ったスイング\n　　勝率重視でリスク少なめ\n　　RSIとMACDで両建て戦略"}
                  className="w-full rounded resize-none text-[11px] leading-relaxed outline-none transition-all"
                  style={{
                    background: step === "generating" ? "rgba(249,115,22,0.02)" : "rgba(0,0,0,0.04)",
                    border:     description.length >= 3 ? `1px solid ${NG_rgba}0.30)` : "1px solid rgba(71,85,105,0.35)",
                    color:      "#cbd5e1",
                    padding:    "10px 12px",
                    caretColor: NG,
                  }}
                />
                {/* 法的免責事項 */}
                <div className="mt-2 px-3 py-2 rounded"
                  style={{ background: "rgba(255,68,102,0.04)", border: "1px solid rgba(255,68,102,0.15)" }}>
                  <p className="text-[8px] leading-relaxed" style={{ color: RED }}>
                    ⚠ 本ツールはトレード戦略の自動生成を行うものであり、利益を保証するものではありません。
                    過去のバックテスト結果は将来の収益を約束するものではなく、実際の取引には損失リスクが伴います。
                    投資判断はご自身の責任で行ってください。（金融商品取引法第37条の3に基づく注意事項）
                  </p>
                </div>
              </div>

              {/* 指標目標（4つ） */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1" style={{ background: `${NG_rgba}0.10)` }} />
                  <span className="text-[8px] tracking-[0.25em] font-black" style={{ color: "#9a9a9a" }}>
                    パフォーマンス目標（任意）
                  </span>
                  <div className="h-px flex-1" style={{ background: `${NG_rgba}0.10)` }} />
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {([
                    { key: "minPF",     label: "PF",    unit: "≥",  placeholder: "1.5", hint: "プロフィットファクター" },
                    { key: "maxMDD",    label: "MDD",   unit: "≤",  placeholder: "20",  hint: "最大ドローダウン（%）" },
                    { key: "minWR",     label: "勝率",  unit: "≥",  placeholder: "50",  hint: "勝率（%）" },
                    { key: "minPayoff", label: "ペイオフ", unit: "≥", placeholder: "1.2", hint: "ペイオフレシオ" },
                  ] as const).map(({ key, label, unit, placeholder, hint }) => (
                    <div key={key} className="flex flex-col gap-1">
                      <p className="text-[7px] tracking-widest text-center" style={{ color: "#9a9a9a" }}>{hint}</p>
                      <div className="flex flex-col items-center gap-0.5 px-2 py-2 rounded"
                        style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.07)" }}>
                        <span className="text-[8px] font-black" style={{ color: NG }}>{label}</span>
                        <span className="text-[7px]" style={{ color: "#9a9a9a" }}>{unit}</span>
                        <input
                          type="number"
                          value={targets[key]}
                          onChange={e => setTargets(p => ({ ...p, [key]: e.target.value }))}
                          disabled={step === "generating"}
                          placeholder={placeholder}
                          className="w-full text-center rounded text-[11px] font-bold outline-none mt-0.5"
                          style={{
                            background:  "transparent",
                            border:      "none",
                            color:       targets[key] ? NG : "#4a4a4a",
                            caretColor:  NG,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[8px] mt-1.5 text-center" style={{ color: "#9a9a9a" }}>
                  空欄の場合は制約なし。AI が目標を達成できる戦略を設計します。
                </p>
              </div>

              {genError && (
                <div className="text-[10px] px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}>
                  ⚠ {genError}
                </div>
              )}

              {step === "generating" && (
                <LoadingDots label="5 つの GOLD# 戦略を設計しています..." sub="バックテストデータに合わせて最適化中" />
              )}
            </div>
          )}

          {/* ─── RESULTS ─── */}
          {step === "results" && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
                {candidates.map((c, i) => (
                  <CandidateCard
                    key={i}
                    candidate={c}
                    onAdd={() => handleAdd(i)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── フッター ── */}
        {step !== "generating" && (
          <div className="shrink-0 px-5 py-3" style={{ borderTop: `1px solid ${NG_rgba}0.08)` }}>
            {step === "input" && (
              <div className="flex items-center justify-between gap-3">
                <button onClick={handleClose}
                  className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                  style={{ color: "#4b5563" }}>
                  キャンセル
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={!isReady}
                  className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                  style={{
                    background: `${NG_rgba}0.14)`,
                    border:     `1px solid ${NG_rgba}0.35)`,
                    color:      NG,
                    boxShadow:  isReady ? `0 0 12px ${NG_rgba}0.15)` : "none",
                  }}>
                  ▶ AI で 5 戦略を生成する
                </button>
              </div>
            )}

            {step === "results" && (
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => { btAbortRef.current = true; setStep("input"); setCandidates([]); setGenError(null); }}
                  className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                  style={{ color: "#4a4a4a", border: "1px solid rgba(71,85,105,0.25)" }}>
                  ← 再生成する
                </button>
                <button
                  onClick={handleClose}
                  className="text-[10px] font-black tracking-widest px-4 py-2 rounded transition-opacity hover:opacity-70"
                  style={{
                    background: `${NG_rgba}0.10)`,
                    border:     `1px solid ${NG_rgba}0.30)`,
                    color:      NG,
                  }}>
                  完了（{addedCount} 件追加）
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1.2); }
        }
      `}</style>
    </div>
  );
}

// =================================================================
// CandidateCard — 1候補ごとのカード
// =================================================================
function CandidateCard({ candidate, onAdd }: { candidate: Candidate; onAdd: () => void }) {
  const { spec, btStatus, report, btError, added, saving } = candidate;
  const col = typeColor(spec.strategy_type);

  // 勝率からペイオフ計算
  const pf      = report?.profitFactor ?? null;
  const wr      = report?.winRate ?? 0;
  const payoff  = payoffRatio(pf, wr);

  const isTesting = btStatus === "testing";
  const isDone    = btStatus === "done";
  const isError   = btStatus === "error";

  // エントリー条件を最大2件表示
  const mainConds = spec.entry_conditions.conditions
    .filter(c => !c.condition?.startsWith("UNSUPPORTED:"))
    .slice(0, 2);

  return (
    <div className="flex flex-col rounded-lg overflow-hidden"
      style={{
        background: "#fff",
        border:     `1px solid ${col}25`,
        boxShadow:  "0 2px 8px rgba(0,0,0,0.05)",
        opacity:    added ? 0.65 : 1,
      }}>

      {/* ヘッダー */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-start justify-between gap-1 mb-1">
          <h3 className="font-black text-[12px] leading-tight" style={{ color: "#1a1a1a" }}>
            {spec.name}
          </h3>
          <span className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded shrink-0"
            style={{ background: `${col}10`, border: `1px solid ${col}25`, color: col }}>
            {typeLabel(spec.strategy_type)}
          </span>
        </div>
        {/* シンボル / TF */}
        <div className="flex gap-1 flex-wrap">
          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: `${NG_rgba}0.08)`, color: NG, border: `1px solid ${NG_rgba}0.20)` }}>
            GOLD#
          </span>
          {spec.timeframes.map(tf => (
            <span key={tf} className="text-[8px] px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,0,0,0.04)", color: "#64748b", border: "1px solid rgba(0,0,0,0.06)" }}>
              {tf}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* エントリー条件サマリー */}
      <div className="px-3 py-2">
        <p className="text-[6px] tracking-widest mb-1" style={{ color: "#9a9a9a" }}>ENTRY CONDITIONS</p>
        {mainConds.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {mainConds.map((c, i) => (
              <div key={i} className="flex items-start gap-1">
                <span className="text-[7px] mt-0.5 shrink-0" style={{ color: NG }}>●</span>
                <span className="text-[9px] leading-snug" style={{ color: "#4a4a4a" }}>
                  {conditionToJapanese(c)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[9px]" style={{ color: "#9a9a9a" }}>{spec.description}</p>
        )}
      </div>

      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* バックテスト結果 */}
      <div className="px-3 py-2.5">
        {btStatus === "pending" && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#9a9a9a" }} />
            <span className="text-[8px]" style={{ color: "#9a9a9a" }}>バックテスト待機中...</span>
          </div>
        )}
        {isTesting && (
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5">
              {[0,1,2].map(i => (
                <div key={i} className="w-1 h-1 rounded-full"
                  style={{ background: NG, animation: `pulse 1s ease-in-out ${i*0.2}s infinite` }} />
              ))}
            </div>
            <span className="text-[8px]" style={{ color: NG }}>バックテスト実行中...</span>
          </div>
        )}
        {isError && (
          <p className="text-[8px]" style={{ color: AMBER }}>⚠ {btError ?? "バックテストデータ不足"}</p>
        )}
        {isDone && report && (
          <div className="flex flex-col gap-1.5">
            {/* Verdict */}
            <div className="flex items-center justify-between">
              <span className="text-[7px] tracking-widest" style={{ color: "#9a9a9a" }}>BACKTEST</span>
              <span className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
                style={{
                  color:       verdictColor(report.verdict),
                  background:  `${verdictColor(report.verdict)}15`,
                  border:      `1px solid ${verdictColor(report.verdict)}30`,
                }}>
                {verdictLabel(report.verdict)}
              </span>
            </div>
            {/* Pips */}
            <div className="text-center py-1 rounded"
              style={{ background: `${pipsColor(report.totalPips)}06`, border: `1px solid ${pipsColor(report.totalPips)}15` }}>
              <p className="text-[20px] font-black leading-none" style={{ color: pipsColor(report.totalPips) }}>
                {report.totalPips >= 0 ? "+" : ""}{report.totalPips.toFixed(1)}
              </p>
              <p className="text-[6px] tracking-widest mt-0.5" style={{ color: "#9a9a9a" }}>合計 PIPS</p>
            </div>
            {/* 4指標グリッド */}
            <div className="grid grid-cols-4 gap-1">
              {[
                {
                  label: "PF",
                  value: pf != null ? pf.toFixed(2) : "—",
                  color: (pf ?? 0) >= 1.2 ? NG : (pf ?? 0) >= 1 ? AMBER : RED,
                },
                {
                  label: "MDD",
                  value: `${report.maxDrawdownPct.toFixed(1)}%`,
                  color: report.maxDrawdownPct < 10 ? NG : report.maxDrawdownPct < 20 ? AMBER : RED,
                },
                {
                  label: "勝率",
                  value: `${wr.toFixed(0)}%`,
                  color: wr >= 55 ? NG : wr >= 50 ? AMBER : RED,
                },
                {
                  label: "ペイオフ",
                  value: payoff != null ? payoff.toFixed(2) : "—",
                  color: (payoff ?? 0) >= 1.2 ? NG : (payoff ?? 0) >= 1 ? AMBER : RED,
                },
              ].map(({ label, value, color }) => (
                <div key={label} className="px-1 py-1 rounded text-center"
                  style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
                  <p className="text-[6px] tracking-widest" style={{ color: "#9a9a9a" }}>{label}</p>
                  <p className="text-[9px] font-bold mt-0.5" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>
            {/* 取引数 */}
            <p className="text-[7px] text-center" style={{ color: "#9a9a9a" }}>
              {report.totalTrades} 取引 · {report.wins}勝 {report.losses}敗
            </p>
          </div>
        )}
      </div>

      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* CTA */}
      <div className="px-3 pb-3 pt-2">
        {added ? (
          <div className="w-full h-8 rounded flex items-center justify-center gap-2"
            style={{ background: "rgba(74,222,128,0.10)", border: "1px solid rgba(74,222,128,0.30)" }}>
            <span className="text-[10px] font-black tracking-widest" style={{ color: GREEN }}>✓ 追加済み</span>
          </div>
        ) : (
          <button
            onClick={onAdd}
            disabled={saving}
            className="w-full h-8 rounded font-black text-[10px] tracking-widest transition-all hover:opacity-80 disabled:opacity-50"
            style={{
              background: `${NG_rgba}0.12)`,
              border:     `1px solid ${NG_rgba}0.35)`,
              color:      NG,
            }}>
            {saving ? "追加中..." : "EA を追加する"}
          </button>
        )}
      </div>
    </div>
  );
}

// =================================================================
// 小コンポーネント
// =================================================================
function LoadingDots({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <div className="flex gap-1.5">
        {[0,1,2,3].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full"
            style={{ background: NG, animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`, boxShadow: `0 0 6px ${NG}` }} />
        ))}
      </div>
      <p className="text-[10px] tracking-[0.2em]" style={{ color: NG }}>{label}</p>
      {sub && <p className="text-[9px]" style={{ color: "#9a9a9a" }}>{sub}</p>}
    </div>
  );
}
