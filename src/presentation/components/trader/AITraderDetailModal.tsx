"use client";

import { useState, useEffect, useCallback } from "react";
import { toast }                             from "sonner";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  type AITrader,
} from "@/lib/aiTraderSchema";

const NG = "#f97316";

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

interface Props { trader: AITrader | null; onClose: () => void; }

const inputStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 8, fontSize: 12,
  border: "1px solid #e2e8f0", background: "#fff", color: "#1a1a1a", outline: "none",
};

function StateTag({ state }: { state: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    WAITING:     { bg: "#f8fafc", color: "#64748b", label: "待機中" },
    WATCHING:    { bg: "#eff6ff", color: "#2563eb", label: "監視中" },
    CONSIDERING: { bg: "#fffbeb", color: "#d97706", label: "検討中" },
    DECIDED:     { bg: "#fff7ed", color: NG,        label: "決断済" },
    INVALID:     { bg: "#fef2f2", color: "#dc2626", label: "無効"   },
  };
  const s = map[state] ?? { bg: "#f8fafc", color: "#64748b", label: state };
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: s.bg, color: s.color }}>{s.label}</span>
  );
}

function BiasTag({ bias }: { bias: string | null }) {
  if (!bias) return null;
  const map: Record<string, { color: string; label: string }> = {
    LONG:    { color: "#16a34a", label: "↑ 上昇バイアス" },
    SHORT:   { color: "#dc2626", label: "↓ 下降バイアス" },
    NEUTRAL: { color: "#64748b", label: "→ 中立" },
  };
  const s = map[bias] ?? { color: "#64748b", label: bias };
  return <span className="text-sm font-bold" style={{ color: s.color }}>{s.label}</span>;
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
      { scenario?: Scenario }, { decisions?: Decision[] }
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
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.ok) { toast.success("分析完了"); await load(); }
      else toast.error(data.error ?? "分析に失敗しました");
    } finally { setAnalyzing(false); }
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
      } else toast.error(data.error ?? "操作に失敗しました");
    } finally { setApproving(null); }
  }, [trader, load]);

  const handleWalkForward = useCallback(async () => {
    if (!trader) return;
    setWfRunning(true); setWfResult(null);
    try {
      const res  = await fetch(`/api/traders/${trader.id}/walk-forward`, { method: "POST" });
      const data = await res.json() as Record<string, unknown>;
      setWfResult(data);
      toast.success(`Walk Forward完了: ${data.verdict}`);
    } catch { toast.error("Walk Forward に失敗しました"); }
    finally { setWfRunning(false); }
  }, [trader]);

  if (!trader) return null;

  const profile = trader.current_profile;
  const pendingDecisions = decisions.filter(d => d.status === "PENDING");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-4 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl rounded-2xl flex flex-col"
        style={{ background: "#fff", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>

        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                style={{ background: "#eff6ff", color: "#2563eb" }}>{trader.market}</span>
              {profile && (
                <>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: "#fff7ed", color: NG }}>
                    {PERSONALITY_LABELS[profile.personality] ?? profile.personality}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px]"
                    style={{ background: "#fffbeb", color: "#d97706" }}>
                    {TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style}
                  </span>
                </>
              )}
              <span className="text-[10px]" style={{ color: "#94a3b8" }}>v{trader.current_version}</span>
            </div>
            <h2 className="text-xl font-black" style={{ color: "#1a1a1a" }}>{trader.name}</h2>
            {trader.description && (
              <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>{trader.description}</p>
            )}
          </div>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100"
            style={{ color: "#94a3b8", fontSize: 18 }}>✕</button>
        </div>

        <div className="p-6 flex flex-col gap-5">
          {loading ? (
            <div className="text-center py-8">
              <div className="w-6 h-6 border-2 rounded-full animate-spin mx-auto mb-2"
                style={{ borderColor: "rgba(249,115,22,0.2)", borderTopColor: NG }} />
              <p className="text-sm" style={{ color: "#94a3b8" }}>読み込み中...</p>
            </div>
          ) : (
            <>
              {/* アクションボタン */}
              <div className="flex gap-2">
                <button onClick={handleAnalyze} disabled={analyzing}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all"
                  style={{
                    background: analyzing ? "#94a3b8" : "linear-gradient(135deg, #f97316, #ea580c)",
                    boxShadow: analyzing ? "none" : "0 2px 8px rgba(249,115,22,0.3)",
                  }}>
                  {analyzing ? "🔍 AI分析中..." : "🔍 今の相場を分析する"}
                </button>
                <button onClick={handleWalkForward} disabled={wfRunning}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all"
                  style={{
                    background: "#eff6ff", color: "#2563eb", borderColor: "#bfdbfe",
                    opacity: wfRunning ? 0.6 : 1,
                  }}>
                  {wfRunning ? "📊 検証中..." : "📊 検証する"}
                </button>
              </div>

              {/* 保留中の判断 */}
              {pendingDecisions.length > 0 && (
                <div className="rounded-xl overflow-hidden"
                  style={{ border: `2px solid ${NG}` }}>
                  <div className="px-4 py-3"
                    style={{ background: "#fff7ed" }}>
                    <p className="text-sm font-bold" style={{ color: "#c2410c" }}>
                      ⚡ AIトレーダーが判断を待っています（{pendingDecisions.length}件）
                    </p>
                  </div>
                  {pendingDecisions.map(d => (
                    <div key={d.id} className="px-4 py-4 flex flex-col gap-3"
                      style={{ borderTop: "1px solid #fed7aa" }}>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="px-3 py-1 rounded-lg text-sm font-black"
                          style={{
                            background: d.decision === "BUY" ? "#f0fdf4" : "#fef2f2",
                            color:      d.decision === "BUY" ? "#15803d" : "#dc2626",
                          }}>
                          {d.decision === "BUY" ? "↑ BUY" : "↓ SELL"}
                        </span>
                        {d.reference_price && (
                          <span className="text-sm font-mono font-bold" style={{ color: "#1a1a1a" }}>
                            {d.reference_price.toFixed(2)}
                          </span>
                        )}
                        <span className="text-xs" style={{ color: "#94a3b8" }}>
                          {new Date(d.expires_at).toLocaleTimeString("ja-JP")}まで有効
                        </span>
                      </div>

                      {(d.suggested_sl || d.suggested_tp) && (
                        <div className="flex gap-4 text-xs">
                          {d.suggested_sl && (
                            <span>損切: <span className="font-mono font-bold" style={{ color: "#dc2626" }}>{d.suggested_sl.toFixed(2)}</span></span>
                          )}
                          {d.suggested_tp && (
                            <span>利確: <span className="font-mono font-bold" style={{ color: "#16a34a" }}>{d.suggested_tp.toFixed(2)}</span></span>
                          )}
                          {d.suggested_volume && (
                            <span>ロット: <span className="font-mono font-bold" style={{ color: NG }}>{d.suggested_volume}</span></span>
                          )}
                        </div>
                      )}

                      {d.reasoning && (
                        <p className="text-xs leading-relaxed" style={{ color: "#4a4a4a" }}>
                          {d.reasoning}
                        </p>
                      )}

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDecision(d.id, "approve")}
                          disabled={approving === d.id}
                          className="flex-1 py-2 rounded-lg text-sm font-bold text-white"
                          style={{ background: approving === d.id ? "#94a3b8" : "#16a34a" }}>
                          {approving === d.id ? "処理中..." : "✓ 承認して実行"}
                        </button>
                        <button
                          onClick={() => handleDecision(d.id, "reject")}
                          disabled={approving === d.id}
                          className="flex-1 py-2 rounded-lg text-sm font-semibold border"
                          style={{ color: "#dc2626", borderColor: "#fecaca", background: "#fef2f2" }}>
                          ✕ 却下
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 現在のシナリオ */}
              <div className="rounded-xl p-4"
                style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.06)" }}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold" style={{ color: "#1a1a1a" }}>現在のシナリオ</h3>
                  {scenario && <StateTag state={scenario.state} />}
                </div>
                {scenario ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <BiasTag bias={scenario.bias} />
                      {scenario.reference_price && (
                        <span className="text-xs font-mono" style={{ color: "#64748b" }}>
                          参照価格: {scenario.reference_price.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {scenario.scenario_text && (
                      <p className="text-sm leading-relaxed" style={{ color: "#1a1a1a" }}>
                        {scenario.scenario_text}
                      </p>
                    )}
                    {(scenario.watch_zone_low !== null && scenario.watch_zone_high !== null) && (
                      <div className="flex items-center gap-2 text-xs">
                        <span style={{ color: "#64748b" }}>監視ゾーン:</span>
                        <span className="font-mono font-bold" style={{ color: "#d97706" }}>
                          {scenario.watch_zone_low?.toFixed(2)} – {scenario.watch_zone_high?.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {scenario.ai_reasoning && (
                      <div className="rounded-lg p-3"
                        style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
                        <p className="text-[11px] font-bold mb-1" style={{ color: "#2563eb" }}>💭 AIの判断理由</p>
                        <p className="text-xs leading-relaxed" style={{ color: "#475569" }}>
                          {scenario.ai_reasoning}
                        </p>
                      </div>
                    )}
                    <p className="text-[10px]" style={{ color: "#94a3b8" }}>
                      {new Date(scenario.created_at).toLocaleString("ja-JP")}
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-5">
                    <p className="text-sm" style={{ color: "#94a3b8" }}>まだ相場分析が行われていません</p>
                    <p className="text-xs mt-1" style={{ color: "#cbd5e1" }}>「今の相場を分析する」を押してください</p>
                  </div>
                )}
              </div>

              {/* Walk Forward結果 */}
              {wfResult && (
                <div className="rounded-xl p-4"
                  style={{
                    background: wfResult.verdict === "PASSED" ? "#f0fdf4"
                      : wfResult.verdict === "CONDITIONAL" ? "#fffbeb" : "#fef2f2",
                    border: `1px solid ${wfResult.verdict === "PASSED" ? "#bbf7d0"
                      : wfResult.verdict === "CONDITIONAL" ? "#fde68a" : "#fecaca"}`,
                  }}>
                  <h3 className="text-sm font-bold mb-3" style={{ color: "#1a1a1a" }}>📊 Walk Forward 検証結果</h3>
                  <div className="grid grid-cols-3 gap-3 text-center mb-3">
                    {[
                      { label: "判定",   value: String(wfResult.verdict ?? "N/A") },
                      { label: "平均PF", value: wfResult.avg_pf ? `${(wfResult.avg_pf as number).toFixed(2)}` : "N/A" },
                      { label: "平均WR", value: wfResult.avg_wr ? `${(wfResult.avg_wr as number).toFixed(1)}%` : "N/A" },
                    ].map(m => (
                      <div key={m.label} className="rounded-lg p-2"
                        style={{ background: "rgba(255,255,255,0.6)" }}>
                        <p className="text-[9px]" style={{ color: "#94a3b8" }}>{m.label}</p>
                        <p className="text-sm font-bold" style={{ color: "#1a1a1a" }}>{m.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px]" style={{ color: "#64748b" }}>{wfResult.note as string}</p>
                </div>
              )}

              {/* 判断履歴 */}
              {decisions.filter(d => d.status !== "PENDING").length > 0 && (
                <div>
                  <h3 className="text-sm font-bold mb-2" style={{ color: "#1a1a1a" }}>判断履歴</h3>
                  <div className="flex flex-col gap-1.5">
                    {decisions.filter(d => d.status !== "PENDING").slice(0, 5).map(d => (
                      <div key={d.id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                        style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.05)" }}>
                        <span className="text-xs font-bold w-14"
                          style={{ color: d.decision === "BUY" ? "#16a34a" : d.decision === "SELL" ? "#dc2626" : "#d97706" }}>
                          {d.decision}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full"
                          style={{
                            background: d.status === "APPROVED" ? "#f0fdf4" : d.status === "REJECTED" ? "#fef2f2" : "#f8fafc",
                            color:      d.status === "APPROVED" ? "#16a34a"  : d.status === "REJECTED" ? "#dc2626"  : "#64748b",
                          }}>{d.status === "APPROVED" ? "承認" : d.status === "REJECTED" ? "却下" : d.status}</span>
                        <span className="text-[10px] flex-1 truncate" style={{ color: "#64748b" }}>
                          {d.reasoning?.slice(0, 60)}
                        </span>
                        <span className="text-[10px] shrink-0" style={{ color: "#94a3b8" }}>
                          {new Date(d.created_at).toLocaleDateString("ja-JP")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 共有セクション */}
              <div className="rounded-xl p-4"
                style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.06)" }}>
                <h3 className="text-sm font-bold mb-3" style={{ color: "#1a1a1a" }}>🔗 Trader共有</h3>
                <div className="flex items-center gap-2 mb-3">
                  <code className="flex-1 px-3 py-2 rounded-lg text-xs font-mono"
                    style={{ background: "#fff", border: "1px solid #e2e8f0", color: "#1a1a1a" }}>
                    {trader.public_id}
                  </code>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(trader.public_id); toast.success("IDをコピーしました"); }}
                    className="px-3 py-2 rounded-lg text-xs font-semibold border"
                    style={{ color: NG, borderColor: "#fed7aa", background: "#fff7ed" }}>
                    コピー
                  </button>
                </div>
                <p className="text-[10px] mb-3" style={{ color: "#94a3b8" }}>
                  このIDを別のユーザーに共有すると、そのユーザーがこのトレーダーをコピーできます
                </p>
                <div className="flex gap-2">
                  <input
                    value={importId}
                    onChange={e => setImportId(e.target.value.toUpperCase())}
                    placeholder="他のユーザーのTrader IDを入力（16文字）"
                    style={{ ...inputStyle, flex: 1, fontSize: 11 }}
                  />
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
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white transition-all"
                    style={{
                      background: importId.length < 16 ? "#94a3b8" : "linear-gradient(135deg, #f97316, #ea580c)",
                      whiteSpace: "nowrap",
                    }}>
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
