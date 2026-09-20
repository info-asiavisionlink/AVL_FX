"use client";

// =================================================================
// AITraderDetailModal v1
//
// AI Trader の詳細、現在のシナリオ、保留中の判断を表示。
// 判断がある場合は承認・却下ボタンを表示。
// =================================================================

import { useState, useEffect, useCallback } from "react";
import { toast }                             from "sonner";
import { PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS, type AITrader } from "@/lib/aiTraderSchema";

const NG      = "#f97316";
const NG_rgba = "rgba(249,115,22,";
const GREEN   = "#4ade80";
const AMBER   = "#fbbf24";
const RED     = "#ef4444";
const BLUE    = "#2563eb";

interface Scenario {
  id: string; state: string; bias: string | null; scenario_text: string | null;
  watch_zone_low: number | null; watch_zone_high: number | null;
  ai_reasoning: string | null; reference_price: number | null; created_at: string;
}

interface Decision {
  id: string; decision: "BUY" | "SELL" | "WAIT" | "EXIT"; status: string;
  reasoning: string | null; reference_price: number | null;
  suggested_sl: number | null; suggested_tp: number | null;
  suggested_volume: number | null; expires_at: string; created_at: string;
}

interface Props {
  trader: AITrader | null;
  onClose: () => void;
}

function BiasTag({ bias }: { bias: string | null }) {
  if (!bias) return null;
  const map: Record<string, { c: string; label: string }> = {
    LONG:    { c: GREEN, label: "↑ LONG" },
    SHORT:   { c: RED,   label: "↓ SHORT" },
    NEUTRAL: { c: "#94a3b8", label: "→ NEUTRAL" },
  };
  const { c, label } = map[bias] ?? { c: "#94a3b8", label: bias };
  return <span className="font-bold text-sm" style={{ color: c }}>{label}</span>;
}

function StateTag({ state }: { state: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    WAITING:     { bg: "#64748b", label: "待機中" },
    WATCHING:    { bg: "#2563eb", label: "監視中" },
    CONSIDERING: { bg: AMBER,    label: "検討中" },
    DECIDED:     { bg: NG,       label: "決断済" },
    INVALID:     { bg: RED,      label: "無効"   },
  };
  const { bg, label } = map[state] ?? { bg: "#64748b", label: state };
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white" style={{ background: bg }}>
      {label}
    </span>
  );
}

export function AITraderDetailModal({ trader, onClose }: Props) {
  const [scenario,   setScenario]   = useState<Scenario | null>(null);
  const [decisions,  setDecisions]  = useState<Decision[]>([]);
  const [analyzing,  setAnalyzing]  = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [approving,  setApproving]  = useState<string | null>(null);
  const [wfRunning,  setWfRunning]  = useState(false);
  const [wfResult,   setWfResult]   = useState<Record<string, unknown> | null>(null);
  const [importId,   setImportId]   = useState("");
  const [importing,  setImporting]  = useState(false);

  const load = useCallback(async () => {
    if (!trader) return;
    setLoading(true);
    const [sRes, dRes] = await Promise.all([
      fetch(`/api/traders/${trader.id}/scenario`),
      fetch(`/api/traders/${trader.id}/decisions`),
    ]);
    const [sData, dData] = await Promise.all([sRes.json(), dRes.json()]) as [
      { scenario?: Scenario },
      { decisions?: Decision[] }
    ];
    setScenario(sData.scenario ?? null);
    setDecisions(dData.decisions ?? []);
    setLoading(false);
  }, [trader]);

  useEffect(() => { if (trader) void load(); }, [trader, load]);

  const handleAnalyze = useCallback(async () => {
    if (!trader) return;
    setAnalyzing(true);
    try {
      const res  = await fetch(`/api/traders/${trader.id}/analyze`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; scenario?: Scenario; decision?: Decision; error?: string };
      if (data.ok) {
        toast.success("分析完了");
        await load();
      } else {
        toast.error(data.error ?? "分析に失敗しました");
      }
    } finally {
      setAnalyzing(false);
    }
  }, [trader, load]);

  const handleDecision = useCallback(async (decisionId: string, action: "approve" | "reject") => {
    if (!trader) return;
    setApproving(decisionId);
    try {
      const res  = await fetch(`/api/traders/${trader.id}/decide`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, action }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.ok) {
        toast.success(action === "approve" ? "注文を承認しました" : "却下しました");
        await load();
      } else {
        toast.error(data.error ?? "操作に失敗しました");
      }
    } finally {
      setApproving(null);
    }
  }, [trader, load]);

  const handleWalkForward = useCallback(async () => {
    if (!trader) return;
    setWfRunning(true);
    setWfResult(null);
    try {
      const res  = await fetch(`/api/traders/${trader.id}/walk-forward`, { method: "POST" });
      const data = await res.json() as Record<string, unknown>;
      setWfResult(data);
      toast.success(`Walk Forward完了: ${data.verdict}`);
    } catch {
      toast.error("Walk Forward に失敗しました");
    } finally {
      setWfRunning(false);
    }
  }, [trader]);

  if (!trader) return null;

  const profile = trader.current_profile;
  const pendingDecisions = decisions.filter(d => d.status === "PENDING");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-4 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-3xl rounded-2xl flex flex-col"
        style={{ background: "#0d1117", border: `1px solid ${NG_rgba}0.25)` }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: `1px solid ${NG_rgba}0.15)` }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] px-2 py-0.5 rounded font-bold" style={{ background: "rgba(37,99,235,0.2)", color: "#60a5fa" }}>
                {trader.market}
              </span>
              {profile && (
                <>
                  <span className="text-[10px] px-2 py-0.5 rounded font-medium" style={{ background: `${NG_rgba}0.15)`, color: NG }}>
                    {PERSONALITY_LABELS[profile.personality] ?? profile.personality}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded font-medium" style={{ background: "rgba(251,191,36,0.1)", color: AMBER }}>
                    {TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style}
                  </span>
                </>
              )}
              <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>v{trader.current_version}</span>
            </div>
            <h2 className="text-xl font-black text-white">{trader.name}</h2>
            {trader.description && <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>{trader.description}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>

        <div className="p-6 flex flex-col gap-6">
          {loading ? (
            <div className="text-center py-8 text-gray-500">読み込み中...</div>
          ) : (
            <>
              {/* Analyze ボタン */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all"
                  style={{ background: analyzing ? "#374151" : NG }}>
                  {analyzing ? "🔍 AIが相場を分析中..." : "🔍 今の相場を分析する"}
                </button>
                <button
                  onClick={handleWalkForward}
                  disabled={wfRunning}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                  style={{ background: wfRunning ? "#1e293b" : "rgba(37,99,235,0.2)", color: "#60a5fa" }}>
                  {wfRunning ? "📊 検証中..." : "📊 Walk Forward検証"}
                </button>
              </div>

              {/* 保留中の判断 */}
              {pendingDecisions.length > 0 && (
                <div className="rounded-xl overflow-hidden"
                  style={{ border: `2px solid ${NG_rgba}0.4)` }}>
                  <div className="px-4 py-3" style={{ background: `${NG_rgba}0.15)` }}>
                    <p className="text-sm font-bold text-white">
                      ⚡ AIトレーダーが判断を待っています（{pendingDecisions.length}件）
                    </p>
                  </div>
                  {pendingDecisions.map(d => (
                    <div key={d.id} className="px-4 py-4 flex flex-col gap-3"
                      style={{ borderTop: `1px solid ${NG_rgba}0.1)` }}>
                      <div className="flex items-center gap-3">
                        <span className="px-3 py-1 rounded-lg text-sm font-black"
                          style={{
                            background: d.decision === "BUY" ? "rgba(22,163,74,0.2)" : "rgba(239,68,68,0.2)",
                            color:      d.decision === "BUY" ? GREEN : RED,
                          }}>
                          {d.decision}
                        </span>
                        {d.reference_price && (
                          <span className="text-sm font-mono text-white">{d.reference_price.toFixed(2)}</span>
                        )}
                        <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>
                          {new Date(d.expires_at).toLocaleTimeString("ja-JP")}まで有効
                        </span>
                      </div>

                      {(d.suggested_sl || d.suggested_tp) && (
                        <div className="flex gap-4 text-xs">
                          {d.suggested_sl && (
                            <span>SL: <span className="font-mono text-red-400">{d.suggested_sl.toFixed(2)}</span></span>
                          )}
                          {d.suggested_tp && (
                            <span>TP: <span className="font-mono text-green-400">{d.suggested_tp.toFixed(2)}</span></span>
                          )}
                          {d.suggested_volume && (
                            <span>ロット: <span className="font-mono" style={{ color: NG }}>{d.suggested_volume}</span></span>
                          )}
                        </div>
                      )}

                      {d.reasoning && (
                        <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.6)" }}>
                          {d.reasoning}
                        </p>
                      )}

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDecision(d.id, "approve")}
                          disabled={approving === d.id}
                          className="flex-1 py-2 rounded-lg text-sm font-bold text-white transition-all"
                          style={{ background: approving === d.id ? "#374151" : "#16a34a" }}>
                          {approving === d.id ? "処理中..." : "✓ 承認して実行"}
                        </button>
                        <button
                          onClick={() => handleDecision(d.id, "reject")}
                          disabled={approving === d.id}
                          className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                          style={{ background: "rgba(239,68,68,0.2)", color: "#f87171" }}>
                          ✕ 却下
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 現在のシナリオ */}
              <div className="rounded-xl p-4" style={{ background: "#1a1f2e", border: `1px solid ${NG_rgba}0.1)` }}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-white">現在のシナリオ</h3>
                  {scenario && <StateTag state={scenario.state} />}
                </div>
                {scenario ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <BiasTag bias={scenario.bias} />
                      {scenario.reference_price && (
                        <span className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.5)" }}>
                          参照価格: {scenario.reference_price.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {scenario.scenario_text && (
                      <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.8)" }}>
                        {scenario.scenario_text}
                      </p>
                    )}
                    {(scenario.watch_zone_low !== null && scenario.watch_zone_high !== null) && (
                      <div className="flex items-center gap-2 text-xs mt-1">
                        <span style={{ color: "rgba(255,255,255,0.4)" }}>監視ゾーン:</span>
                        <span className="font-mono" style={{ color: AMBER }}>
                          {scenario.watch_zone_low?.toFixed(2)} – {scenario.watch_zone_high?.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {scenario.ai_reasoning && (
                      <div className="rounded-lg p-3 mt-1" style={{ background: "rgba(37,99,235,0.08)" }}>
                        <p className="text-[11px]" style={{ color: "#93c5fd" }}>💭 AI の判断理由</p>
                        <p className="text-xs mt-1 leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
                          {scenario.ai_reasoning}
                        </p>
                      </div>
                    )}
                    <p className="text-[10px] mt-1" style={{ color: "rgba(255,255,255,0.2)" }}>
                      更新: {new Date(scenario.created_at).toLocaleString("ja-JP")}
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-sm" style={{ color: "rgba(255,255,255,0.3)" }}>
                      まだ相場分析が行われていません
                    </p>
                    <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.2)" }}>
                      「今の相場を分析する」を押してください
                    </p>
                  </div>
                )}
              </div>

              {/* Walk Forward 結果 */}
              {wfResult && (
                <div className="rounded-xl p-4"
                  style={{
                    background: wfResult.verdict === "PASSED" ? "rgba(22,163,74,0.1)" : wfResult.verdict === "CONDITIONAL" ? "rgba(251,191,36,0.08)" : "rgba(239,68,68,0.1)",
                    border: `1px solid ${wfResult.verdict === "PASSED" ? "rgba(22,163,74,0.3)" : wfResult.verdict === "CONDITIONAL" ? "rgba(251,191,36,0.2)" : "rgba(239,68,68,0.2)"}`,
                  }}>
                  <h3 className="text-sm font-bold text-white mb-3">📊 Walk Forward 検証結果</h3>
                  <div className="grid grid-cols-3 gap-3 text-center mb-3">
                    {[
                      { label: "判定",    value: wfResult.verdict as string },
                      { label: "平均PF",  value: wfResult.avg_pf ? (wfResult.avg_pf as number).toFixed(2) : "N/A" },
                      { label: "平均WR",  value: wfResult.avg_wr ? `${(wfResult.avg_wr as number).toFixed(1)}%` : "N/A" },
                    ].map(m => (
                      <div key={m.label} className="rounded-lg p-2" style={{ background: "rgba(255,255,255,0.04)" }}>
                        <p className="text-[9px] text-gray-500">{m.label}</p>
                        <p className="text-sm font-bold text-white">{m.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.4)" }}>{wfResult.note as string}</p>
                </div>
              )}

              {/* 最近の判断履歴 */}
              {decisions.filter(d => d.status !== "PENDING").length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-white mb-2">判断履歴</h3>
                  <div className="flex flex-col gap-2">
                    {decisions.filter(d => d.status !== "PENDING").slice(0, 5).map(d => (
                      <div key={d.id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                        <span className="text-xs font-bold w-12"
                          style={{ color: d.decision === "BUY" ? GREEN : d.decision === "SELL" ? RED : AMBER }}>
                          {d.decision}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            background: d.status === "APPROVED" ? "rgba(22,163,74,0.15)" : d.status === "REJECTED" ? "rgba(239,68,68,0.1)" : "rgba(100,116,139,0.15)",
                            color: d.status === "APPROVED" ? "#4ade80" : d.status === "REJECTED" ? "#f87171" : "#94a3b8",
                          }}>{d.status}</span>
                        <span className="text-[10px] flex-1 truncate" style={{ color: "rgba(255,255,255,0.4)" }}>
                          {d.reasoning?.slice(0, 60)}
                        </span>
                        <span className="text-[10px] shrink-0" style={{ color: "rgba(255,255,255,0.25)" }}>
                          {new Date(d.created_at).toLocaleDateString("ja-JP")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Trader 共有セクション */}
              <div className="rounded-xl p-4"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <h3 className="text-sm font-bold text-white mb-3">🔗 Trader 共有</h3>
                <div className="flex items-center gap-2 mb-3">
                  <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono text-white"
                    style={{ background: "#0f0f1a" }}>{trader.public_id}</code>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(trader.public_id); toast.success("IDをコピーしました"); }}
                    className="px-3 py-2 rounded-lg text-xs text-white"
                    style={{ background: `${NG_rgba}0.2)` }}>コピー</button>
                </div>
                <p className="text-[10px] mb-3" style={{ color: "rgba(255,255,255,0.3)" }}>
                  このIDを別のユーザーに共有すると、そのユーザーがこのトレーダーをコピーできます
                </p>
                <div className="flex gap-2">
                  <input
                    value={importId}
                    onChange={e => setImportId(e.target.value.toUpperCase())}
                    placeholder="他のユーザーのTrader IDを入力"
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs text-white font-mono"
                    style={{ background: "#0f0f1a", border: "1px solid rgba(249,115,22,0.2)" }} />
                  <button
                    onClick={async () => {
                      setImporting(true);
                      const res = await fetch("/api/traders/import-by-id", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ public_id: importId }),
                      });
                      const data = await res.json() as { trader?: AITrader; error?: string };
                      if (res.ok) { toast.success("インポートしました"); setImportId(""); }
                      else toast.error(data.error ?? "失敗しました");
                      setImporting(false);
                    }}
                    disabled={importId.length < 16 || importing}
                    className="px-3 py-1.5 rounded-lg text-xs text-white transition-all"
                    style={{ background: importing ? "#374151" : NG }}>
                    {importing ? "..." : "インポート"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
