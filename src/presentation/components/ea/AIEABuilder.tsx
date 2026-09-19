"use client";

// =================================================================
// AIEABuilder v3 — GOLD# 専用 AI EA 一括生成
//
// フロー: input → generating → results（5候補をバックテスト逐次実行）
//
// 入力:
//   - 自然言語テキスト（AI自動生成 / AI修正 ボタン付き）
//   - マルチタイムフレーム選択（複数選択 / 全選択 / 自動設定）
//   - 指標目標 PF/MDD/勝率/ペイオフ（自動設定 ボタン付き）
//   - データ期間サマリー表示
// =================================================================

import { useState, useRef, useCallback, useEffect } from "react";
import { toast }   from "sonner";
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

// ── Timeframes ────────────────────────────────────────────────────
const ALL_TF = ["M1","M5","M15","M30","H1","H4","D1","W1"] as const;
type TF = typeof ALL_TF[number];

// ── Step ──────────────────────────────────────────────────────────
type Step = "input" | "generating" | "results";

// ── Metric targets ────────────────────────────────────────────────
interface MetricTargets {
  minPF: string; maxMDD: string; minWR: string; minPayoff: string;
}
const EMPTY_TARGETS: MetricTargets = { minPF: "", maxMDD: "", minWR: "", minPayoff: "" };

// ── Bar summary ───────────────────────────────────────────────────
interface TfSummary {
  count: number; years: number; label: string; firstDate: string | null;
}

// ── Backtest result ───────────────────────────────────────────────
interface BtReport {
  totalTrades: number; wins: number; losses: number; winRate: number;
  totalPips: number; avgPips: number; profitFactor: number | null;
  maxDrawdownPct: number; verdict: "PASSED"|"CONDITIONAL"|"FAILED";
  verdictReason: string; sampleSizeWarning: boolean; minRecommendedTrades: number;
}

// ── Per-candidate state ───────────────────────────────────────────
interface Candidate {
  idx: number; spec: StrategySpec;
  btStatus: "pending"|"testing"|"done"|"error";
  report: BtReport | null; btError: string | null;
  added: boolean; saving: boolean;
}

// ── Props ─────────────────────────────────────────────────────────
interface Props { open: boolean; onClose: () => void; onSaved: (s: StrategyRecord) => void; }

// ── Helpers ───────────────────────────────────────────────────────
function pipsColor(p: number)    { return p >= 0 ? NG : RED; }
function verdictColor(v: string) { return v === "PASSED" ? GREEN : v === "CONDITIONAL" ? AMBER : RED; }
function verdictLabel(v: string) { return v === "PASSED" ? "合格" : v === "CONDITIONAL" ? "条件付" : "不合格"; }
function typeLabel(t: string)    { return t === "SCALPING" ? "スキャル" : t === "DAY_TRADE" ? "デイトレ" : "スイング"; }
function typeColor(t: string)    { return t === "SCALPING" ? "#2563eb" : t === "DAY_TRADE" ? AMBER : NG; }
function payoffRatio(pf: number|null, wr: number) {
  if (!pf || wr <= 0 || wr >= 100) return null;
  return pf * (1 - wr/100) / (wr/100);
}


// =================================================================
// メインコンポーネント
// =================================================================
export function AIEABuilder({ open, onClose, onSaved }: Props) {
  const [step,        setStep]        = useState<Step>("input");
  const [description, setDescription] = useState("");
  const [targets,     setTargets]     = useState<MetricTargets>(EMPTY_TARGETS);
  const [selectedTf,  setSelectedTf]  = useState<TF[]>([]);
  const [tfDesc,      setTfDesc]      = useState<Partial<Record<TF, string>>>({});
  const [candidates,  setCandidates]  = useState<Candidate[]>([]);
  const [genError,    setGenError]    = useState<string|null>(null);
  const [addedCount,  setAddedCount]  = useState(0);
  const [barSummary,  setBarSummary]  = useState<Partial<Record<TF, TfSummary>>>({});

  // AI アシストのローディング状態
  const [aiGen,      setAiGen]      = useState(false);
  const [aiRefine,   setAiRefine]   = useState(false);
  const [aiMetrics,  setAiMetrics]  = useState(false);
  const [aiTf,       setAiTf]       = useState(false);

  const btAbortRef   = useRef(false);
  const rawPromptRef = useRef("");

  // ── データ期間サマリー取得 ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    fetch(`/api/research/bars-summary`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { timeframes?: Record<string, TfSummary> } | null) => {
        if (d?.timeframes) setBarSummary(d.timeframes as Partial<Record<TF, TfSummary>>);
      })
      .catch(() => {});
  }, [open]);

  // ── useCallback は条件分岐の前に ─────────────────────────────────
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
            body: JSON.stringify({
              spec:       cand.spec,
              raw_prompt: rawPromptRef.current,
              ...(cand.report ? { previewBacktestData: { report: cand.report, trades: [], barCount: 0 } } : {}),
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
          toast.error("保存エラー");
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
    setStep("input"); setDescription(""); setTargets(EMPTY_TARGETS);
    setSelectedTf([]); setTfDesc({}); setCandidates([]);
    setGenError(null); setAddedCount(0);
    onClose();
  }

  // ── AI 自動テキスト生成 ──────────────────────────────────────────
  async function handleAiGenerate() {
    setAiGen(true);
    try {
      const res  = await fetch("/api/ai/strategy/assist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate" }),
      });
      const data = await res.json() as { result?: string };
      if (data.result) setDescription(data.result);
    } catch { toast.error("AI 生成に失敗しました"); }
    setAiGen(false);
  }

  // ── AI テキスト修正 ──────────────────────────────────────────────
  async function handleAiRefine() {
    if (!description.trim()) { toast.error("テキストを入力してください"); return; }
    setAiRefine(true);
    try {
      const res  = await fetch("/api/ai/strategy/assist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refine", text: description }),
      });
      const data = await res.json() as { result?: string };
      if (data.result) setDescription(data.result);
    } catch { toast.error("AI 修正に失敗しました"); }
    setAiRefine(false);
  }

  // ── 指標の自動設定 ───────────────────────────────────────────────
  async function handleAutoMetrics() {
    setAiMetrics(true);
    try {
      const res  = await fetch("/api/ai/strategy/assist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggest-metrics", text: description }),
      });
      const data = await res.json() as MetricTargets;
      setTargets({ minPF: data.minPF, maxMDD: data.maxMDD, minWR: data.minWR, minPayoff: data.minPayoff });
    } catch { toast.error("自動設定に失敗しました"); }
    setAiMetrics(false);
  }

  // ── マルチTF の自動設定 ──────────────────────────────────────────
  async function handleAutoTf() {
    setAiTf(true);
    try {
      const res  = await fetch("/api/ai/strategy/assist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggest-timeframes", text: description }),
      });
      const data = await res.json() as { timeframes?: string[]; descriptions?: Record<string,string> };
      if (data.timeframes) setSelectedTf(data.timeframes.filter(t => ALL_TF.includes(t as TF)) as TF[]);
      if (data.descriptions) setTfDesc(data.descriptions as Partial<Record<TF,string>>);
    } catch { toast.error("自動設定に失敗しました"); }
    setAiTf(false);
  }

  // ── TF 選択トグル ────────────────────────────────────────────────
  function toggleTf(tf: TF) {
    setSelectedTf(prev => prev.includes(tf) ? prev.filter(t => t !== tf) : [...prev, tf]);
  }
  function selectAllTf() { setSelectedTf([...ALL_TF]); }
  function clearAllTf()  { setSelectedTf([]); }

  // ── 5戦略生成 ────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!isReady) return;
    setGenError(null);
    setStep("generating");
    btAbortRef.current = false;

    const t: Record<string, number> = {};
    if (targets.minPF     && !isNaN(+targets.minPF))     t.minPF     = +targets.minPF;
    if (targets.maxMDD    && !isNaN(+targets.maxMDD))    t.maxMDD    = +targets.maxMDD;
    if (targets.minWR     && !isNaN(+targets.minWR))     t.minWR     = +targets.minWR;
    if (targets.minPayoff && !isNaN(+targets.minPayoff)) t.minPayoff = +targets.minPayoff;

    // マルチTF 情報を自然言語に追加
    let fullDesc = description.trim();
    if (selectedTf.length > 0) {
      const tfLines = selectedTf.map(tf => {
        const d = tfDesc[tf];
        return d ? `${tf}: ${d}` : tf;
      });
      fullDesc += `\n[マルチタイムフレーム分析] ${tfLines.join(" / ")}`;
    }
    rawPromptRef.current = fullDesc;

    try {
      const res  = await fetch("/api/ai/strategy/build-multi", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: fullDesc, targets: t }),
      });
      const data = await res.json() as { success: boolean; specs?: StrategySpec[]; error?: string };

      if (!data.success || !data.specs || data.specs.length === 0) {
        setGenError(data.error ?? "生成に失敗しました");
        setStep("input"); return;
      }

      const initial: Candidate[] = data.specs.map((spec, idx) => ({
        idx, spec, btStatus: "pending", report: null, btError: null, added: false, saving: false,
      }));
      setCandidates(initial);
      setStep("results");

      for (let i = 0; i < initial.length; i++) {
        if (btAbortRef.current) break;
        setCandidates(prev => prev.map((c, ci) => ci === i ? { ...c, btStatus: "testing" } : c));
        try {
          const btRes  = await fetch("/api/ai/strategy/preview-backtest", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ spec: initial[i].spec }),
          });
          const btData = await btRes.json() as { success: boolean; report?: BtReport; error?: string };
          setCandidates(prev => prev.map((c, ci) => ci === i ? {
            ...c,
            btStatus: btData.success && btData.report ? "done" : "error",
            report:   btData.report ?? null,
            btError:  btData.success ? null : (btData.error ?? "バックテスト失敗"),
          } : c));
        } catch {
          setCandidates(prev => prev.map((c, ci) => ci === i ? { ...c, btStatus: "error", btError: "ネットワークエラー" } : c));
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
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(4,6,13,0.92)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="relative w-full font-mono flex flex-col overflow-hidden rounded-lg"
        style={{
          maxWidth: step === "results" ? "900px" : "600px",
          maxHeight: "92vh",
          background: "#ffffff",
          border: `1px solid ${NG_rgba}0.20)`,
          boxShadow: `0 0 60px ${NG_rgba}0.06), 0 0 120px rgba(0,0,0,0.8)`,
          transition: "max-width 0.3s ease",
        }}>

        {/* ── ヘッダー ── */}
        <div className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${NG_rgba}0.10)` }}>
          <div className="flex items-center gap-3">
            <span className="text-[10px] tracking-[0.3em] font-black" style={{ color: NG }}>AI EA BUILDER · GOLD#</span>
            {step === "generating" && (
              <span className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}>
                5 戦略を設計中...
              </span>
            )}
            {step === "results" && addedCount > 0 && (
              <span className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", color: GREEN }}>
                {addedCount} 件追加済み
              </span>
            )}
          </div>
          <button onClick={handleClose} className="text-[16px] leading-none transition-opacity hover:opacity-60" style={{ color: "#4b5563" }}>×</button>
        </div>

        {/* ── コンテンツ ── */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* INPUT */}
          {(step === "input" || step === "generating") && (
            <div className="flex flex-col gap-5 max-w-xl mx-auto">

              {/* データ期間サマリー */}
              <div className="rounded-xl p-3" style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.07)" }}>
                <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#9a9a9a" }}>
                  利用可能データ期間（バックテスト用 GOLD# データ）
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {ALL_TF.map(tf => {
                    const s = barSummary[tf];
                    const hasData = s && s.count > 0;
                    return (
                      <div key={tf} className="text-center px-1.5 py-1.5 rounded"
                        style={{ background: hasData ? `${NG_rgba}0.06)` : "rgba(0,0,0,0.02)", border: `1px solid ${hasData ? `${NG_rgba}0.15)` : "rgba(0,0,0,0.05)"}` }}>
                        <p className="text-[9px] font-black" style={{ color: hasData ? NG : "#d0d0d0" }}>{tf}</p>
                        {hasData ? (
                          <>
                            <p className="text-[7px] font-bold mt-0.5" style={{ color: "#1a1a1a" }}>{s.label}</p>
                            <p className="text-[6px]" style={{ color: "#9a9a9a" }}>{s.count.toLocaleString()}本</p>
                          </>
                        ) : (
                          <p className="text-[7px]" style={{ color: "#d0d0d0" }}>データなし</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 自然言語入力 */}
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[10px] tracking-[0.15em] font-black" style={{ color: NG }}>戦略の方向性</span>
                  <span className="text-[7px] tracking-widest" style={{ color: "#9a9a9a" }}>STRATEGY CONCEPT</span>
                </div>
                <p className="text-[9px] mb-1.5" style={{ color: "#9a9a9a" }}>GOLD のトレードスタイルを自由に記述（曖昧でも OK）</p>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  disabled={step === "generating"}
                  rows={4}
                  placeholder={"例：GOLDのデイトレで上昇トレンドに乗るものがほしい\n　　一目均衡表を使ったスイング\n　　勝率重視でリスク少なめ"}
                  className="w-full rounded resize-none text-[11px] leading-relaxed outline-none transition-all"
                  style={{
                    background: "rgba(0,0,0,0.04)",
                    border: description.length >= 3 ? `1px solid ${NG_rgba}0.30)` : "1px solid rgba(71,85,105,0.35)",
                    color: "#cbd5e1", padding: "10px 12px", caretColor: NG,
                  }}
                />

                {/* AI ボタン群 */}
                <div className="flex gap-2 mt-1.5">
                  <button onClick={handleAiGenerate} disabled={aiGen || step === "generating"}
                    className="text-[9px] font-bold px-3 py-1.5 rounded transition-all hover:opacity-80 disabled:opacity-40"
                    style={{ background: `${NG_rgba}0.10)`, border: `1px solid ${NG_rgba}0.25)`, color: NG }}>
                    {aiGen ? "生成中..." : "✨ AI 自動生成"}
                  </button>
                  <button onClick={handleAiRefine} disabled={aiRefine || !description.trim() || step === "generating"}
                    className="text-[9px] font-bold px-3 py-1.5 rounded transition-all hover:opacity-80 disabled:opacity-40"
                    style={{ background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.20)", color: "#2563eb" }}>
                    {aiRefine ? "修正中..." : "✏️ AI テキスト修正"}
                  </button>
                </div>

                {/* 法的免責事項 */}
                <div className="mt-2 px-3 py-2 rounded"
                  style={{ background: "rgba(255,68,102,0.04)", border: "1px solid rgba(255,68,102,0.15)" }}>
                  <p className="text-[8px] leading-relaxed" style={{ color: RED }}>
                    ⚠ 本ツールは投資収益を保証しません。バックテスト結果は将来の収益を約束するものではなく、
                    実際の取引には損失リスクが伴います。投資判断はご自身の責任で行ってください。
                    （金融商品取引法第37条の3）
                  </p>
                </div>
              </div>

              {/* マルチタイムフレーム */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[10px] tracking-[0.15em] font-black" style={{ color: "#4a4a4a" }}>マルチタイムフレーム分析</span>
                    <span className="text-[7px] tracking-widest" style={{ color: "#9a9a9a" }}>任意</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={handleAutoTf} disabled={aiTf || step === "generating"}
                      className="text-[8px] font-bold px-2 py-1 rounded transition-all hover:opacity-80 disabled:opacity-40"
                      style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}>
                      {aiTf ? "設定中..." : "⚡ 自動設定"}
                    </button>
                    <button onClick={selectAllTf}
                      className="text-[8px] px-2 py-1 rounded transition-all hover:opacity-80"
                      style={{ background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.10)", color: "#4a4a4a" }}>
                      全選択
                    </button>
                    {selectedTf.length > 0 && (
                      <button onClick={clearAllTf}
                        className="text-[8px] px-2 py-1 rounded transition-all hover:opacity-80"
                        style={{ background: `rgba(255,68,102,0.08)`, border: "1px solid rgba(255,68,102,0.20)", color: RED }}>
                        クリア
                      </button>
                    )}
                  </div>
                </div>

                {/* TF チップ選択 */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {ALL_TF.map(tf => {
                    const active  = selectedTf.includes(tf);
                    const summary = barSummary[tf];
                    return (
                      <button key={tf} onClick={() => toggleTf(tf)}
                        className="flex flex-col items-center px-2 py-1.5 rounded transition-all hover:opacity-80"
                        style={{
                          background: active ? `${NG_rgba}0.12)` : "rgba(0,0,0,0.03)",
                          border:     `1px solid ${active ? `${NG_rgba}0.35)` : "rgba(0,0,0,0.08)"}`,
                          color:      active ? NG : "#9a9a9a",
                          minWidth:   "46px",
                        }}>
                        <span className="text-[10px] font-black">{tf}</span>
                        {summary?.label && (
                          <span className="text-[6px] mt-0.5" style={{ color: active ? `${NG_rgba}0.7)` : "#d0d0d0" }}>
                            {summary.label}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* 選択された TF の説明入力 */}
                {selectedTf.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {selectedTf.map(tf => (
                      <div key={tf} className="flex items-start gap-2">
                        <span className="text-[9px] font-black w-8 shrink-0 pt-2" style={{ color: NG }}>{tf}</span>
                        <input
                          value={tfDesc[tf] ?? ""}
                          onChange={e => setTfDesc(prev => ({ ...prev, [tf]: e.target.value }))}
                          placeholder={`${tf} でのトレンド判断・条件（省略可）`}
                          className="flex-1 rounded text-[10px] outline-none"
                          style={{
                            background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.09)",
                            color: "#1a1a1a", padding: "6px 10px",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 指標目標 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-px w-6" style={{ background: `${NG_rgba}0.15)` }} />
                    <span className="text-[8px] tracking-[0.25em] font-black" style={{ color: "#9a9a9a" }}>パフォーマンス目標（任意）</span>
                    <div className="h-px flex-1" style={{ background: `${NG_rgba}0.15)` }} />
                  </div>
                  <button onClick={handleAutoMetrics} disabled={aiMetrics || step === "generating"}
                    className="text-[8px] font-bold px-2.5 py-1 rounded transition-all hover:opacity-80 disabled:opacity-40 shrink-0 ml-2"
                    style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}>
                    {aiMetrics ? "設定中..." : "⚡ 自動設定"}
                  </button>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {([
                    { key: "minPF" as const,     label: "PF",    unit: "≥",  placeholder: "1.5", hint: "プロフィットファクター" },
                    { key: "maxMDD" as const,    label: "MDD",   unit: "≤",  placeholder: "20",  hint: "最大ドローダウン（%）" },
                    { key: "minWR" as const,     label: "勝率",  unit: "≥",  placeholder: "50",  hint: "勝率（%）" },
                    { key: "minPayoff" as const, label: "ペイオフ", unit: "≥", placeholder: "1.2", hint: "ペイオフレシオ" },
                  ]).map(({ key, label, unit, placeholder, hint }) => (
                    <div key={key} className="flex flex-col gap-1">
                      <p className="text-[7px] tracking-widest text-center" style={{ color: "#9a9a9a" }}>{hint}</p>
                      <div className="flex flex-col items-center gap-0.5 px-2 py-2 rounded"
                        style={{ background: "rgba(0,0,0,0.03)", border: `1px solid ${targets[key] ? `${NG_rgba}0.25)` : "rgba(0,0,0,0.07)"}` }}>
                        <span className="text-[8px] font-black" style={{ color: NG }}>{label}</span>
                        <span className="text-[7px]" style={{ color: "#9a9a9a" }}>{unit}</span>
                        <input type="number" value={targets[key]}
                          onChange={e => setTargets(p => ({ ...p, [key]: e.target.value }))}
                          disabled={step === "generating"}
                          placeholder={placeholder}
                          className="w-full text-center rounded text-[11px] font-bold outline-none mt-0.5"
                          style={{ background: "transparent", border: "none", color: targets[key] ? NG : "#4a4a4a", caretColor: NG }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[8px] mt-1.5 text-center" style={{ color: "#9a9a9a" }}>
                  空欄の場合は制約なし。「⚡ 自動設定」で AI が推奨値を入力します。
                </p>
              </div>

              {genError && (
                <div className="text-[10px] px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}>
                  ⚠ {genError}
                </div>
              )}

              {step === "generating" && <LoadingDots label="5 つの GOLD# 戦略を設計しています..." sub="バックテストデータに合わせて最適化中" />}
            </div>
          )}

          {/* RESULTS */}
          {step === "results" && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
              {candidates.map((c, i) => (
                <CandidateCard key={i} candidate={c} onAdd={() => handleAdd(i)} />
              ))}
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
                <button onClick={handleGenerate} disabled={!isReady}
                  className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                  style={{
                    background: `${NG_rgba}0.14)`, border: `1px solid ${NG_rgba}0.35)`, color: NG,
                    boxShadow: isReady ? `0 0 12px ${NG_rgba}0.15)` : "none",
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
                <button onClick={handleClose}
                  className="text-[10px] font-black tracking-widest px-4 py-2 rounded transition-opacity hover:opacity-70"
                  style={{ background: `${NG_rgba}0.10)`, border: `1px solid ${NG_rgba}0.30)`, color: NG }}>
                  完了（{addedCount} 件追加）
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:0.3;transform:scale(0.8)} 50%{opacity:1;transform:scale(1.2)} }`}</style>
    </div>
  );
}

// =================================================================
// CandidateCard
// =================================================================
function CandidateCard({ candidate, onAdd }: { candidate: Candidate; onAdd: () => void }) {
  const { spec, btStatus, report, btError, added, saving } = candidate;
  const col     = typeColor(spec.strategy_type);
  const pf      = report?.profitFactor ?? null;
  const wr      = report?.winRate ?? 0;
  const payoff  = payoffRatio(pf, wr);
  const mainConds = spec.entry_conditions.conditions
    .filter(c => !c.condition?.startsWith("UNSUPPORTED:")).slice(0, 2);

  return (
    <div className="flex flex-col rounded-lg overflow-hidden"
      style={{ background: "#fff", border: `1px solid ${col}25`, boxShadow: "0 2px 8px rgba(0,0,0,0.05)", opacity: added ? 0.65 : 1 }}>
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-start justify-between gap-1 mb-1">
          <h3 className="font-black text-[12px] leading-tight" style={{ color: "#1a1a1a" }}>{spec.name}</h3>
          <span className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded shrink-0"
            style={{ background: `${col}10`, border: `1px solid ${col}25`, color: col }}>
            {typeLabel(spec.strategy_type)}
          </span>
        </div>
        <div className="flex gap-1 flex-wrap">
          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: `${NG_rgba}0.08)`, color: NG, border: `1px solid ${NG_rgba}0.20)` }}>GOLD#</span>
          {spec.timeframes.map(tf => (
            <span key={tf} className="text-[8px] px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,0,0,0.04)", color: "#64748b", border: "1px solid rgba(0,0,0,0.06)" }}>{tf}</span>
          ))}
        </div>
      </div>
      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />
      <div className="px-3 py-2">
        <p className="text-[6px] tracking-widest mb-1" style={{ color: "#9a9a9a" }}>ENTRY CONDITIONS</p>
        {mainConds.map((c, i) => (
          <div key={i} className="flex items-start gap-1">
            <span className="text-[7px] mt-0.5 shrink-0" style={{ color: NG }}>●</span>
            <span className="text-[9px] leading-snug" style={{ color: "#4a4a4a" }}>{conditionToJapanese(c)}</span>
          </div>
        ))}
      </div>
      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />
      <div className="px-3 py-2.5">
        {btStatus === "pending" && <div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full" style={{ background: "#9a9a9a" }} /><span className="text-[8px]" style={{ color: "#9a9a9a" }}>バックテスト待機中...</span></div>}
        {btStatus === "testing" && <div className="flex items-center gap-1.5"><div className="flex gap-0.5">{[0,1,2].map(i=><div key={i} className="w-1 h-1 rounded-full" style={{ background: NG, animation: `pulse 1s ease-in-out ${i*0.2}s infinite` }}/>)}</div><span className="text-[8px]" style={{ color: NG }}>バックテスト実行中...</span></div>}
        {btStatus === "error" && <p className="text-[8px]" style={{ color: AMBER }}>⚠ {btError ?? "データ不足"}</p>}
        {btStatus === "done" && report && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[7px] tracking-widest" style={{ color: "#9a9a9a" }}>BACKTEST</span>
              <span className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
                style={{ color: verdictColor(report.verdict), background: `${verdictColor(report.verdict)}15`, border: `1px solid ${verdictColor(report.verdict)}30` }}>
                {verdictLabel(report.verdict)}
              </span>
            </div>
            <div className="text-center py-1 rounded"
              style={{ background: `${pipsColor(report.totalPips)}06`, border: `1px solid ${pipsColor(report.totalPips)}15` }}>
              <p className="text-[20px] font-black leading-none" style={{ color: pipsColor(report.totalPips) }}>
                {report.totalPips >= 0 ? "+" : ""}{report.totalPips.toFixed(1)}
              </p>
              <p className="text-[6px] tracking-widest mt-0.5" style={{ color: "#9a9a9a" }}>合計 PIPS</p>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: "PF",      value: pf != null ? pf.toFixed(2) : "—",      color: (pf??0)>=1.2 ? NG : (pf??0)>=1 ? AMBER : RED },
                { label: "MDD",     value: `${report.maxDrawdownPct.toFixed(1)}%`, color: report.maxDrawdownPct<10 ? NG : report.maxDrawdownPct<20 ? AMBER : RED },
                { label: "勝率",    value: `${wr.toFixed(0)}%`,                   color: wr>=55 ? NG : wr>=50 ? AMBER : RED },
                { label: "ペイオフ", value: payoff != null ? payoff.toFixed(2) : "—", color: (payoff??0)>=1.2 ? NG : (payoff??0)>=1 ? AMBER : RED },
              ].map(({ label, value, color }) => (
                <div key={label} className="px-1 py-1 rounded text-center"
                  style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.05)" }}>
                  <p className="text-[6px] tracking-widest" style={{ color: "#9a9a9a" }}>{label}</p>
                  <p className="text-[9px] font-bold mt-0.5" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>
            <p className="text-[7px] text-center" style={{ color: "#9a9a9a" }}>{report.totalTrades} 取引 · {report.wins}勝 {report.losses}敗</p>
          </div>
        )}
      </div>
      <div className="mx-3 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />
      <div className="px-3 pb-3 pt-2">
        {added ? (
          <div className="w-full h-8 rounded flex items-center justify-center gap-2"
            style={{ background: "rgba(74,222,128,0.10)", border: "1px solid rgba(74,222,128,0.30)" }}>
            <span className="text-[10px] font-black tracking-widest" style={{ color: GREEN }}>✓ 追加済み</span>
          </div>
        ) : (
          <button onClick={onAdd} disabled={saving}
            className="w-full h-8 rounded font-black text-[10px] tracking-widest transition-all hover:opacity-80 disabled:opacity-50"
            style={{ background: `${NG_rgba}0.12)`, border: `1px solid ${NG_rgba}0.35)`, color: NG }}>
            {saving ? "追加中..." : "EA を追加する"}
          </button>
        )}
      </div>
    </div>
  );
}

function LoadingDots({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <div className="flex gap-1.5">
        {[0,1,2,3].map(i => <div key={i} className="w-1.5 h-1.5 rounded-full"
          style={{ background: NG, animation: `pulse 1.2s ease-in-out ${i*0.2}s infinite`, boxShadow: `0 0 6px ${NG}` }} />)}
      </div>
      <p className="text-[10px] tracking-[0.2em]" style={{ color: NG }}>{label}</p>
      {sub && <p className="text-[9px]" style={{ color: "#9a9a9a" }}>{sub}</p>}
    </div>
  );
}
