"use client";

// =================================================================
// StrategyResearchAssistant — Conversational Strategy Research Assistant
//
// バックテスト結果を見ながらAIと会話して戦略を改善するモーダル。
//
// 主な機能:
//   - マウント時にAI初回診断を自動実行
//   - チャット形式でAIと会話
//   - AI提案を承認して再バックテスト
//   - リビジョン履歴の管理（R0, R1, R2...）
//   - Before/After 比較表示
//   - 過学習ガード（同ChangeType 3回以上 / 5回以上PF<1.0）
// =================================================================

import { useState, useEffect, useRef, useCallback } from "react";

// ── カラー定数 ────────────────────────────────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";

// ── 型定義 ───────────────────────────────────────────────────────

interface SessionStat {
  tradeCount:   number;
  wins:         number;
  losses:       number;
  winRate:      number;
  totalPips:    number;
  profitFactor: number | null;
}

interface PreviewReport {
  periodLabel:          string;
  dataFrom:             number;
  dataTo:               number;
  dataCoverageDays:     number;
  totalTrades:          number;
  wins:                 number;
  losses:               number;
  winRate:              number;
  totalPips:            number;
  avgPips:              number;
  profitFactor:         number | null;
  maxDrawdown:          number;
  maxDrawdownPct:       number;
  sampleSizeWarning:    boolean;
  minRecommendedTrades: number;
  verdict:              "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:        string;
  sessionStats:         Record<string, SessionStat>;
  bestSession:          string | null;
  worstSession:         string | null;
}

interface TradeForPromotion {
  symbol:       string;
  timeframe:    string;
  direction:    string;
  entryTime:    number;
  entryPrice:   number;
  exitTime:     number;
  exitPrice:    number;
  sl:           number;
  tp:           number;
  lot:          number;
  pips:         number;
  result:       string;
  exitReason:   string;
  durationMin:  number;
  spreadPips:   number;
  slippagePips: number;
  entryBarIdx:  number;
  exitBarIdx:   number;
}

interface DirStat {
  trades:  number;
  wins:    number;
  pips:    number;
  winRate: number;
}

interface BacktestResultState {
  report:             PreviewReport;
  trades:             TradeForPromotion[];
  barCount:           number;
  directionBreakdown: { buy: DirStat; sell: DirStat };
  warnings:           string[];
}

interface ProposedChange {
  description: string;
  changeType:  string;
  reasoning:   string;
  newSpec:     unknown;
}

interface ChatMessage {
  id:            string;
  role:          "user" | "assistant" | "system";
  content:       string;
  proposedChange?: ProposedChange;
  approvalState?: "pending" | "approved" | "rejected";
  isLoading?:    boolean;
}

interface Revision {
  id:                string;
  spec:              unknown;
  backtestResult:    BacktestResultState;
  changeDescription: string;
  changeType?:       string;
  timestamp:         number;
}

interface Props {
  spec:                 unknown;
  initialBacktestResult: BacktestResultState;
  onAddEA:             (spec: unknown, result: BacktestResultState) => void;
  onDiscard:           () => void;
}

// ── ヘルパー ─────────────────────────────────────────────────────

function pipsColor(pips: number) { return pips >= 0 ? NG : RED; }

function verdictColor(v: string) {
  if (v === "PASSED")      return NG;
  if (v === "CONDITIONAL") return AMBER;
  return RED;
}

function verdictLabel(v: string) {
  if (v === "PASSED")      return "合格";
  if (v === "CONDITIONAL") return "条件付";
  return "不合格";
}

function changeTypeLabel(t: string) {
  const labels: Record<string, string> = {
    ENTRY_CHANGE:      "エントリー変更",
    EXIT_CHANGE:       "エグジット変更",
    FILTER_CHANGE:     "フィルター変更",
    DIRECTION_CHANGE:  "方向変更",
    SESSION_CHANGE:    "セッション変更",
    HYPOTHESIS_CHANGE: "仮説変更",
  };
  return labels[t] ?? t;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Delta表示ヘルパー ─────────────────────────────────────────────

function Delta({ before, after, fmt }: {
  before: number | null;
  after:  number | null;
  fmt:    (v: number) => string;
}) {
  if (before == null || after == null) return null;
  const diff = after - before;
  const up   = diff > 0;
  const same = diff === 0;
  return (
    <span
      className="text-[9px] ml-1"
      style={{ color: same ? "#64748b" : up ? NG : RED }}
    >
      {same ? "→" : up ? "↑" : "↓"}{" "}
      {fmt(Math.abs(diff))}
    </span>
  );
}

// =================================================================
// メインコンポーネント
// =================================================================

export function StrategyResearchAssistant({
  spec,
  initialBacktestResult,
  onAddEA,
  onDiscard,
}: Props) {
  // ── State ─────────────────────────────────────────────────────
  const [revisions, setRevisions]               = useState<Revision[]>([
    {
      id:                "R0",
      spec,
      backtestResult:    initialBacktestResult,
      changeDescription: "初期戦略",
      timestamp:         Date.now(),
    },
  ]);
  const [currentRevIdx, setCurrentRevIdx]       = useState(0);
  const [messages, setMessages]                 = useState<ChatMessage[]>([]);
  const [input, setInput]                       = useState("");
  const [isAILoading, setIsAILoading]           = useState(false);
  const [isReBacktesting, setIsReBacktesting]   = useState(false);
  const [diagnoseRan, setDiagnoseRan]           = useState(false);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);

  const currentRevision = revisions[currentRevIdx];

  // ── チャット末尾へスクロール ──────────────────────────────────
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── マウント時: AI初回診断 ────────────────────────────────────
  useEffect(() => {
    if (diagnoseRan) return;
    setDiagnoseRan(true);
    void runDiagnose(spec, initialBacktestResult, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── AI呼び出し（汎用） ────────────────────────────────────────
  const callChatAPI = useCallback(async (
    currentSpec:      unknown,
    btResult:         BacktestResultState,
    history:          Revision[],
    chatMessages:     ChatMessage[],
    mode:             "diagnose" | "chat",
  ): Promise<{
    message:            string;
    proposedChange:     ProposedChange | null;
    overfittingWarning: string | null;
    stopRecommendation: string | null;
  }> => {
    const revSummary = history.map(r => ({
      id:                r.id,
      changeDescription: r.changeDescription,
      pf:                r.backtestResult.report.profitFactor,
      totalPips:         r.backtestResult.report.totalPips,
      totalTrades:       r.backtestResult.report.totalTrades,
      verdict:           r.backtestResult.report.verdict,
    }));

    const res = await fetch("/api/ai/strategy/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        spec:          currentSpec,
        backtestResult: {
          report:             btResult.report,
          directionBreakdown: btResult.directionBreakdown,
          barCount:           btResult.barCount,
        },
        revisionHistory: revSummary,
        messages:        chatMessages
          .filter(m => m.role !== "system" && !m.isLoading)
          .map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        mode,
      }),
    });

    return await res.json() as {
      message:            string;
      proposedChange:     ProposedChange | null;
      overfittingWarning: string | null;
      stopRecommendation: string | null;
    };
  }, []);

  // ── 初回診断 ──────────────────────────────────────────────────
  async function runDiagnose(
    currentSpec: unknown,
    btResult:    BacktestResultState,
    history:     Revision[],
  ) {
    const loadingId = genId();
    setMessages(prev => [...prev, {
      id:        loadingId,
      role:      "assistant",
      content:   "",
      isLoading: true,
    }]);
    setIsAILoading(true);

    try {
      const result = await callChatAPI(currentSpec, btResult, history, [], "diagnose");

      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? {
              id:            loadingId,
              role:          "assistant" as const,
              content:       result.message,
              proposedChange: result.proposedChange ?? undefined,
              approvalState: result.proposedChange ? "pending" as const : undefined,
              isLoading:     false,
            }
          : m
      ));

      // 警告メッセージをシステムメッセージとして追加
      if (result.overfittingWarning) {
        setMessages(prev => [...prev, {
          id:      genId(),
          role:    "system",
          content: result.overfittingWarning!,
        }]);
      }
      if (result.stopRecommendation) {
        setMessages(prev => [...prev, {
          id:      genId(),
          role:    "system",
          content: result.stopRecommendation!,
        }]);
      }
    } catch {
      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? { id: loadingId, role: "assistant" as const, content: "診断の取得に失敗しました。", isLoading: false }
          : m
      ));
    } finally {
      setIsAILoading(false);
    }
  }

  // ── ユーザーメッセージ送信 ────────────────────────────────────
  async function handleSendMessage() {
    const text = input.trim();
    if (!text || isAILoading) return;

    const userMsg: ChatMessage = {
      id:      genId(),
      role:    "user",
      content: text,
    };

    const loadingId = genId();
    const loadingMsg: ChatMessage = {
      id:        loadingId,
      role:      "assistant",
      content:   "",
      isLoading: true,
    };

    const newMessages = [...messages, userMsg, loadingMsg];
    setMessages(newMessages);
    setInput("");
    setIsAILoading(true);

    try {
      const result = await callChatAPI(
        currentRevision.spec,
        currentRevision.backtestResult,
        revisions,
        newMessages.filter(m => !m.isLoading),
        "chat",
      );

      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? {
              id:            loadingId,
              role:          "assistant" as const,
              content:       result.message,
              proposedChange: result.proposedChange ?? undefined,
              approvalState: result.proposedChange ? "pending" as const : undefined,
              isLoading:     false,
            }
          : m
      ));

      if (result.overfittingWarning) {
        setMessages(prev => [...prev, {
          id:      genId(),
          role:    "system",
          content: result.overfittingWarning!,
        }]);
      }
      if (result.stopRecommendation) {
        setMessages(prev => [...prev, {
          id:      genId(),
          role:    "system",
          content: result.stopRecommendation!,
        }]);
      }
    } catch {
      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? { id: loadingId, role: "assistant" as const, content: "エラーが発生しました。もう一度お試しください。", isLoading: false }
          : m
      ));
    } finally {
      setIsAILoading(false);
    }
  }

  // ── 提案を承認して再バックテスト ──────────────────────────────
  async function handleApprove(msgId: string, proposedChange: ProposedChange) {
    // approvalState を approved に
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, approvalState: "approved" as const } : m
    ));

    setIsReBacktesting(true);

    try {
      const res  = await fetch("/api/ai/strategy/preview-backtest", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spec: proposedChange.newSpec }),
      });
      const data = await res.json() as {
        success:             boolean;
        report?:             PreviewReport;
        trades?:             TradeForPromotion[];
        barCount?:           number;
        directionBreakdown?: { buy: DirStat; sell: DirStat };
        warnings?:           string[];
        error?:              string;
      };

      if (!data.success || !data.report) {
        // 失敗: system メッセージで通知
        setMessages(prev => [...prev, {
          id:      genId(),
          role:    "system",
          content: `再バックテスト失敗: ${data.error ?? "不明なエラー"}`,
        }]);
        // approvalState を pending に戻す
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, approvalState: "pending" as const } : m
        ));
        return;
      }

      const newResult: BacktestResultState = {
        report:             data.report,
        trades:             data.trades ?? [],
        barCount:           data.barCount ?? 0,
        directionBreakdown: data.directionBreakdown ?? {
          buy:  { trades: 0, wins: 0, pips: 0, winRate: 0 },
          sell: { trades: 0, wins: 0, pips: 0, winRate: 0 },
        },
        warnings: data.warnings ?? [],
      };

      const newRevId = `R${revisions.length}`;
      const newRevision: Revision = {
        id:                newRevId,
        spec:              proposedChange.newSpec,
        backtestResult:    newResult,
        changeDescription: proposedChange.description,
        changeType:        proposedChange.changeType,
        timestamp:         Date.now(),
      };

      const updatedRevisions = [...revisions, newRevision];
      setRevisions(updatedRevisions);
      setCurrentRevIdx(updatedRevisions.length - 1);

      // 再診断を自動実行
      await runDiagnose(proposedChange.newSpec, newResult, updatedRevisions);

    } catch {
      setMessages(prev => [...prev, {
        id:      genId(),
        role:    "system",
        content: "再バックテスト中にエラーが発生しました。",
      }]);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, approvalState: "pending" as const } : m
      ));
    } finally {
      setIsReBacktesting(false);
    }
  }

  // ── 提案を却下 ────────────────────────────────────────────────
  function handleReject(msgId: string) {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, approvalState: "rejected" as const } : m
    ));
  }

  // ── EAを追加する ─────────────────────────────────────────────
  function handleAddEA() {
    onAddEA(currentRevision.spec, currentRevision.backtestResult);
  }

  // ── Enter で送信 ─────────────────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }

  const prevRevision = currentRevIdx > 0 ? revisions[currentRevIdx - 1] : null;

  // =================================================================
  // レンダリング
  // =================================================================
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col"
      style={{ background: "rgba(4,6,13,0.96)", backdropFilter: "blur(8px)" }}
    >
      {/* ── ヘッダー ── */}
      <div
        className="shrink-0 flex items-center justify-between px-5 py-3"
        style={{ borderBottom: `1px solid ${NG_rgba}0.12)`, background: "#080e1a" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[10px] tracking-[0.3em] font-black" style={{ color: NG }}>
            AI STRATEGY RESEARCH
          </span>
          {isReBacktesting && (
            <span
              className="text-[8px] tracking-widest px-2 py-0.5 rounded"
              style={{ background: `${AMBER}12`, border: `1px solid ${AMBER}30`, color: AMBER }}
            >
              再検証中...
            </span>
          )}
        </div>
        <button
          onClick={onDiscard}
          className="text-[16px] leading-none transition-opacity hover:opacity-60"
          style={{ color: "#4b5563" }}
        >
          ×
        </button>
      </div>

      {/* ── リビジョン履歴バー ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-5 py-2.5 overflow-x-auto"
        style={{ borderBottom: `1px solid rgba(255,255,255,0.04)`, background: "#06090f" }}
      >
        <span className="text-[7px] tracking-widest shrink-0" style={{ color: "#334155" }}>
          REVISIONS
        </span>
        {revisions.map((rev, idx) => (
          <button
            key={rev.id}
            onClick={() => setCurrentRevIdx(idx)}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded text-[9px] transition-all"
            style={{
              background: idx === currentRevIdx
                ? `${NG_rgba}0.12)`
                : "rgba(255,255,255,0.03)",
              border: idx === currentRevIdx
                ? `1px solid ${NG_rgba}0.30)`
                : "1px solid rgba(255,255,255,0.06)",
              color: idx === currentRevIdx ? NG : "#475569",
            }}
          >
            <span className="font-black">{rev.id}</span>
            {rev.changeType && (
              <span className="text-[7px]" style={{ color: idx === currentRevIdx ? NG : "#334155" }}>
                {changeTypeLabel(rev.changeType)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── メインコンテンツ ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ── 左側: バックテスト結果 ── */}
        <div
          className="w-72 shrink-0 flex flex-col overflow-y-auto"
          style={{ borderRight: `1px solid rgba(255,255,255,0.04)`, background: "#06090f" }}
        >
          <div className="px-4 py-4 flex flex-col gap-4">
            {/* 現在のリビジョン */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[8px] tracking-widest font-black" style={{ color: "#475569" }}>
                  {currentRevision.id}
                </span>
                <span
                  className="text-[8px] font-black tracking-widest px-2 py-0.5 rounded"
                  style={{
                    color:      verdictColor(currentRevision.backtestResult.report.verdict),
                    background: `${verdictColor(currentRevision.backtestResult.report.verdict)}12`,
                    border:     `1px solid ${verdictColor(currentRevision.backtestResult.report.verdict)}30`,
                  }}
                >
                  {verdictLabel(currentRevision.backtestResult.report.verdict)}
                </span>
              </div>
              <p className="text-[8px] mb-3" style={{ color: "#334155" }}>
                {currentRevision.changeDescription}
              </p>
            </div>

            {/* Before/After 比較 */}
            {prevRevision && (
              <div
                className="px-3 py-2.5 rounded"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                <p className="text-[7px] tracking-widest mb-2" style={{ color: "#334155" }}>
                  {prevRevision.id} → {currentRevision.id} 比較
                </p>
                {[
                  {
                    label:  "PF",
                    before: prevRevision.backtestResult.report.profitFactor,
                    after:  currentRevision.backtestResult.report.profitFactor,
                    fmt:    (v: number) => v.toFixed(2),
                  },
                  {
                    label:  "PIPS",
                    before: prevRevision.backtestResult.report.totalPips,
                    after:  currentRevision.backtestResult.report.totalPips,
                    fmt:    (v: number) => v.toFixed(1),
                  },
                  {
                    label:  "WR",
                    before: prevRevision.backtestResult.report.winRate,
                    after:  currentRevision.backtestResult.report.winRate,
                    fmt:    (v: number) => `${v.toFixed(1)}%`,
                  },
                ].map(({ label, before, after, fmt }) => (
                  <div key={label} className="flex items-center justify-between mb-1">
                    <span className="text-[7px] tracking-widest" style={{ color: "#475569" }}>{label}</span>
                    <div className="flex items-center">
                      <span className="text-[9px]" style={{ color: "#64748b" }}>
                        {before != null ? fmt(before) : "N/A"}
                      </span>
                      <Delta before={before} after={after} fmt={fmt} />
                      <span className="text-[9px] ml-1.5" style={{ color: "#94a3b8" }}>
                        {after != null ? fmt(after) : "N/A"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 現在の結果 */}
            <ResultPanel result={currentRevision.backtestResult} />
          </div>
        </div>

        {/* ── 右側: チャット ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* チャット履歴 */}
          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onApprove={handleApprove}
                onReject={handleReject}
                isReBacktesting={isReBacktesting}
              />
            ))}
            {messages.length === 0 && (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-[10px] tracking-widest" style={{ color: "#334155" }}>
                  AI診断を準備中...
                </p>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* 入力欄 */}
          <div
            className="shrink-0 px-5 py-3"
            style={{ borderTop: `1px solid rgba(255,255,255,0.04)`, background: "#06090f" }}
          >
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isAILoading || isReBacktesting}
                rows={2}
                placeholder="AIに質問や指示を入力… (Enter で送信、Shift+Enter で改行)"
                className="flex-1 rounded resize-none text-[11px] leading-relaxed tracking-wide outline-none transition-all"
                style={{
                  background: "rgba(0,255,136,0.03)",
                  border:     `1px solid ${NG_rgba}0.12)`,
                  color:      "#cbd5e1",
                  padding:    "8px 10px",
                  caretColor: NG,
                  opacity:    isAILoading || isReBacktesting ? 0.5 : 1,
                }}
              />
              <button
                onClick={() => void handleSendMessage()}
                disabled={!input.trim() || isAILoading || isReBacktesting}
                className="shrink-0 text-[10px] font-black tracking-widest px-4 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                style={{
                  background: `${NG_rgba}0.12)`,
                  border:     `1px solid ${NG_rgba}0.30)`,
                  color:      NG,
                }}
              >
                送信
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── フッター ── */}
      <div
        className="shrink-0 flex items-center justify-between px-5 py-3"
        style={{ borderTop: `1px solid ${NG_rgba}0.08)`, background: "#080e1a" }}
      >
        <button
          onClick={onDiscard}
          className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
          style={{ color: "#64748b", border: "1px solid #1e293b" }}
        >
          この案を破棄する
        </button>
        <button
          onClick={handleAddEA}
          disabled={isReBacktesting}
          className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
          style={{
            background: `${NG_rgba}0.14)`,
            border:     `1px solid ${NG_rgba}0.35)`,
            color:      NG,
            boxShadow:  `0 0 12px ${NG_rgba}0.15)`,
          }}
        >
          EA を追加する ({currentRevision.id})
        </button>
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
// ResultPanel — 現在のバックテスト結果パネル
// =================================================================

function ResultPanel({ result }: { result: BacktestResultState }) {
  const r = result.report;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[7px] tracking-widest" style={{ color: "#334155" }}>現在の結果</p>

      {/* Total Pips */}
      <div
        className="px-3 py-2 rounded text-center"
        style={{
          background: `${pipsColor(r.totalPips)}06`,
          border:     `1px solid ${pipsColor(r.totalPips)}20`,
        }}
      >
        <p className="text-[7px] tracking-widest mb-0.5" style={{ color: "#334155" }}>合計 PIPS</p>
        <p
          className="text-[22px] font-black leading-none"
          style={{ color: pipsColor(r.totalPips), textShadow: `0 0 12px ${pipsColor(r.totalPips)}50` }}
        >
          {r.totalPips >= 0 ? "+" : ""}{r.totalPips.toFixed(1)}
        </p>
      </div>

      {/* Stats グリッド */}
      <div className="grid grid-cols-2 gap-1">
        {[
          { label: "取引数",  value: String(r.totalTrades),                                                          color: "#94a3b8" },
          { label: "勝率",    value: `${r.winRate.toFixed(1)}%`,                                                     color: r.winRate >= 55 ? NG : r.winRate >= 50 ? AMBER : RED },
          { label: "PF",     value: r.profitFactor != null ? r.profitFactor.toFixed(2) : "∞",                       color: (r.profitFactor ?? 0) >= 1.2 ? NG : (r.profitFactor ?? 0) >= 1 ? AMBER : RED },
          { label: "最大DD",  value: `${r.maxDrawdownPct.toFixed(1)}%`,                                              color: r.maxDrawdownPct < 10 ? NG : r.maxDrawdownPct < 20 ? AMBER : RED },
          { label: "平均",    value: `${r.avgPips >= 0 ? "+" : ""}${r.avgPips.toFixed(1)}p`,                        color: pipsColor(r.avgPips) },
          { label: "期間",    value: `${Math.round(r.dataCoverageDays)}日`,                                          color: "#64748b" },
        ].map(({ label, value, color }) => (
          <div key={label} className="px-2 py-1 rounded"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
            <p className="text-[6px] tracking-widest" style={{ color: "#334155" }}>{label}</p>
            <p className="text-[9px] font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* BUY/SELL */}
      {(result.directionBreakdown.buy.trades > 0 || result.directionBreakdown.sell.trades > 0) && (
        <div className="grid grid-cols-2 gap-1">
          {(["buy", "sell"] as const).map(dir => {
            const d = result.directionBreakdown[dir];
            return (
              <div key={dir} className="px-2 py-1.5 rounded"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                <p className="text-[7px] tracking-widest font-black mb-1"
                  style={{ color: dir === "buy" ? NG : RED }}>
                  {dir === "buy" ? "BUY" : "SELL"}
                </p>
                <p className="text-[8px]" style={{ color: "#64748b" }}>
                  {d.trades}t · {d.winRate.toFixed(0)}%
                </p>
                <p className="text-[9px] font-bold" style={{ color: pipsColor(d.pips) }}>
                  {d.pips >= 0 ? "+" : ""}{d.pips.toFixed(1)}p
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Verdict reason */}
      {r.verdictReason && (
        <p className="text-[8px] leading-relaxed px-2 py-1.5 rounded"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", color: "#475569" }}>
          {r.verdictReason}
        </p>
      )}
    </div>
  );
}

// =================================================================
// MessageBubble — チャットメッセージ
// =================================================================

interface MessageBubbleProps {
  msg:             ChatMessage;
  onApprove:       (msgId: string, change: ProposedChange) => void;
  onReject:        (msgId: string) => void;
  isReBacktesting: boolean;
}

function MessageBubble({ msg, onApprove, onReject, isReBacktesting }: MessageBubbleProps) {
  // システムメッセージ
  if (msg.role === "system") {
    return (
      <div
        className="px-3 py-2 rounded text-[9px] leading-relaxed text-center"
        style={{ background: `${AMBER}08`, border: `1px solid ${AMBER}20`, color: AMBER }}
      >
        ⚠ {msg.content}
      </div>
    );
  }

  // ローディング
  if (msg.isLoading) {
    return (
      <div className="flex gap-1.5 items-center py-2 pl-2">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: NG,
              animation:  `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              boxShadow:  `0 0 6px ${NG}`,
            }}
          />
        ))}
        <span className="text-[9px] ml-1" style={{ color: "#334155" }}>AI 分析中...</span>
      </div>
    );
  }

  // ユーザーメッセージ
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[80%] px-3 py-2 rounded text-[11px] leading-relaxed"
          style={{
            background: "rgba(0,229,255,0.08)",
            border:     "1px solid rgba(0,229,255,0.15)",
            color:      "#cbd5e1",
          }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  // AIメッセージ
  return (
    <div className="flex flex-col gap-2">
      {/* メッセージ本文 */}
      <div
        className="px-3 py-2.5 rounded text-[11px] leading-relaxed"
        style={{
          background: `${NG_rgba}0.04)`,
          border:     `1px solid ${NG_rgba}0.12)`,
          color:      "#94a3b8",
        }}
      >
        <span className="text-[7px] tracking-widest block mb-1.5 font-black" style={{ color: NG }}>
          AI RESEARCH
        </span>
        {msg.content}
      </div>

      {/* 提案カード */}
      {msg.proposedChange && (
        <ProposedChangeCard
          msgId={msg.id}
          change={msg.proposedChange}
          approvalState={msg.approvalState}
          onApprove={onApprove}
          onReject={onReject}
          isReBacktesting={isReBacktesting}
        />
      )}
    </div>
  );
}

// =================================================================
// ProposedChangeCard — AI提案カード
// =================================================================

interface ProposedChangeCardProps {
  msgId:           string;
  change:          ProposedChange;
  approvalState?:  "pending" | "approved" | "rejected";
  onApprove:       (msgId: string, change: ProposedChange) => void;
  onReject:        (msgId: string) => void;
  isReBacktesting: boolean;
}

function ProposedChangeCard({
  msgId,
  change,
  approvalState,
  onApprove,
  onReject,
  isReBacktesting,
}: ProposedChangeCardProps) {
  const approved  = approvalState === "approved";
  const rejected  = approvalState === "rejected";
  const pending   = approvalState === "pending";

  return (
    <div
      className="rounded px-3 py-3 flex flex-col gap-2"
      style={{
        background: approved ? `${NG_rgba}0.06)` : rejected ? "rgba(255,255,255,0.02)" : "rgba(251,191,36,0.06)",
        border:     approved ? `1px solid ${NG_rgba}0.25)` : rejected ? "1px solid rgba(255,255,255,0.06)" : "1px solid rgba(251,191,36,0.25)",
        opacity:    rejected ? 0.5 : 1,
      }}
    >
      {/* ヘッダー */}
      <div className="flex items-center gap-2">
        <span
          className="text-[7px] tracking-widest font-black px-2 py-0.5 rounded"
          style={{
            background: `${AMBER}12`,
            border:     `1px solid ${AMBER}25`,
            color:      AMBER,
          }}
        >
          {changeTypeLabel(change.changeType)}
        </span>
        {approved && (
          <span className="text-[7px] tracking-widest font-black" style={{ color: NG }}>
            ✓ 承認・再検証済み
          </span>
        )}
        {rejected && (
          <span className="text-[7px] tracking-widest" style={{ color: "#475569" }}>
            却下済み
          </span>
        )}
      </div>

      {/* 変更内容 */}
      <p className="text-[10px] leading-relaxed" style={{ color: "#94a3b8" }}>
        {change.description}
      </p>

      {/* 理由 */}
      {change.reasoning && (
        <p className="text-[9px] leading-relaxed" style={{ color: "#475569" }}>
          理由: {change.reasoning}
        </p>
      )}

      {/* ボタン */}
      {pending && (
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => onApprove(msgId, change)}
            disabled={isReBacktesting}
            className="text-[9px] font-black tracking-widest px-3 py-1.5 rounded transition-all hover:opacity-80 disabled:opacity-30"
            style={{
              background: `${NG_rgba}0.12)`,
              border:     `1px solid ${NG_rgba}0.30)`,
              color:      NG,
            }}
          >
            {isReBacktesting ? "再検証中..." : "この変更で再検証"}
          </button>
          <button
            onClick={() => onReject(msgId)}
            disabled={isReBacktesting}
            className="text-[9px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60 disabled:opacity-30"
            style={{
              color:  "#64748b",
              border: "1px solid #1e293b",
            }}
          >
            却下
          </button>
        </div>
      )}
    </div>
  );
}
