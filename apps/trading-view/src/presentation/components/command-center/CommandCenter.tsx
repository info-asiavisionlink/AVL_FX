"use client";

// =================================================================
// AVL AI Trading Operating System — Command Center v2.0
// JARVIS/FRIDAY スタイルの AI トレーディング OS
// =================================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { usePriceStore }      from "@/application/stores/priceStore";
import { useIndicatorStore, type IndicatorData } from "@/application/stores/indicatorStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";
import { useVoiceChat, type VoiceStatus } from "@/presentation/hooks/useVoiceChat";
import { AVLAICore, type AIState, type ActiveAgent } from "@/presentation/components/ai-core/AVLAICore";
import {
  Mic, MicOff, Send, RefreshCw, Zap, ChevronRight,
  Radio, Wifi, WifiOff, AlertCircle,
  TrendingUp, TrendingDown, Minus, CheckCircle, XCircle,
  Volume2, VolumeX,
} from "lucide-react";

// -----------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------
interface Message {
  id:      string;
  role:    "user" | "assistant" | "system";
  content: string;
  ts:      number;
}

interface OrderProposal {
  direction:  "BUY" | "SELL";
  symbol:     string;
  entry:      number;
  sl:         number;
  tp:         number;
  rr:         string;
  confidence: number;
  reason:     string;
}

interface LogEntry {
  id:   string;
  ts:   number;
  text: string;
  type: "info" | "warn" | "ok" | "ai";
}

// -----------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------
function parseOrderProposal(text: string): OrderProposal | null {
  const m = text.match(/<ORDER>\s*([\s\S]*?)\s*<\/ORDER>/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as OrderProposal; }
  catch { return null; }
}

function stripOrderTag(text: string): string {
  return text.replace(/<ORDER>[\s\S]*?<\/ORDER>/g, "").trim();
}

function formatPrice(n: number, digits = 5): string {
  return n.toFixed(digits);
}

function trendDir(ema21: number, ema200: number): "up" | "down" | "flat" {
  const diff = Math.abs(ema21 - ema200) / ema200;
  if (diff < 0.0001) return "flat";
  return ema21 > ema200 ? "up" : "down";
}

// -----------------------------------------------------------------
// HUD デコレーター
// -----------------------------------------------------------------
function Corner({ pos }: { pos: "tl"|"tr"|"bl"|"br" }) {
  const cls = cn(
    "absolute w-3 h-3 border-cyan-500/40",
    pos === "tl" && "top-0 left-0 border-t border-l",
    pos === "tr" && "top-0 right-0 border-t border-r",
    pos === "bl" && "bottom-0 left-0 border-b border-l",
    pos === "br" && "bottom-0 right-0 border-b border-r",
  );
  return <div className={cls} />;
}

function HUDCard({ title, children, className }: {
  title?: string; children: React.ReactNode; className?: string
}) {
  return (
    <div className={cn("relative border border-[#1a2535] bg-[#080c14] p-3", className)}>
      <Corner pos="tl" /><Corner pos="tr" /><Corner pos="bl" /><Corner pos="br" />
      {title && (
        <div className="flex items-center gap-1.5 mb-2">
          <div className="w-1 h-3 bg-cyan-500/70" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest uppercase">{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}

// -----------------------------------------------------------------
// AI 状態マッピング
// -----------------------------------------------------------------
function toAIState(thinking: boolean, vs: VoiceStatus): AIState {
  if (thinking)               return "thinking";
  if (vs === "listening")     return "listening";
  if (vs === "speaking")      return "speaking";
  if (vs === "connecting")    return "listening";
  return "standby";
}

function toActiveAgent(thinking: boolean, vs: VoiceStatus): ActiveAgent {
  if (vs === "listening" || vs === "speaking" || vs === "connecting") return "voice";
  if (thinking)               return "analysis";
  return null;
}

// -----------------------------------------------------------------
// インジケーターパネル（左）
// -----------------------------------------------------------------
function MarketPanel({ symbol, indicators, watchlist }: {
  symbol:     string;
  indicators: IndicatorData | undefined;
  watchlist:  { symbol: string; bid: number; ask: number; spread: number; isConnected: boolean }[];
}) {
  const TF_LIST = ["H4", "H1", "M15", "M5"] as const;

  return (
    <div className="flex flex-col gap-2 h-full overflow-y-auto p-2 w-64 shrink-0">
      {/* Market Intelligence */}
      <HUDCard title="Market Intel">
        <div className="space-y-0.5">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-cyan-400 font-mono font-semibold">{symbol}</span>
            {indicators && (
              <span className="text-[9px] text-gray-600 font-mono">
                {new Date(indicators.brokerTime * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          {indicators && (
            <div className="text-[9px] text-gray-500 font-mono mb-2">
              Spread: <span className="text-yellow-500">{indicators.spread.toFixed(1)} pips</span>
            </div>
          )}

          {TF_LIST.map((tf) => {
            const data = indicators?.timeframes?.[tf];
            const dir  = data ? trendDir(data.ema21, data.ema200) : "flat";
            return (
              <div key={tf} className="border border-[#1a2535]/60 p-1.5 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-cyan-500/80 font-mono">[{tf}]</span>
                  {dir === "up"   && <TrendingUp   size={9} className="text-green-400" />}
                  {dir === "down" && <TrendingDown  size={9} className="text-red-400" />}
                  {dir === "flat" && <Minus         size={9} className="text-gray-500" />}
                </div>
                {data ? (
                  <>
                    <div className="flex justify-between text-[8px] font-mono">
                      <span className="text-gray-600">EMA21</span>
                      <span className="text-white">{formatPrice(data.ema21, indicators?.digits ?? 5)}</span>
                    </div>
                    <div className="flex justify-between text-[8px] font-mono">
                      <span className="text-gray-600">EMA200</span>
                      <span className="text-white">{formatPrice(data.ema200, indicators?.digits ?? 5)}</span>
                    </div>
                    <div className="flex justify-between text-[8px] font-mono">
                      <span className="text-gray-600">ATR14</span>
                      <span className="text-orange-400">{formatPrice(data.atr, indicators?.digits ?? 5)}</span>
                    </div>
                  </>
                ) : (
                  <span className="text-[8px] text-gray-700 font-mono">データ待機中...</span>
                )}
              </div>
            );
          })}
        </div>
      </HUDCard>

      {/* Watchlist */}
      <HUDCard title="Watchlist">
        <div className="space-y-1">
          {watchlist.map((item) => (
            <div key={item.symbol} className="flex items-center justify-between">
              <span className={cn("text-[9px] font-mono", item.isConnected ? "text-cyan-400" : "text-gray-600")}>
                {item.symbol}
              </span>
              <div className="text-right">
                <span className="text-[9px] font-mono text-white">
                  {item.bid > 0 ? item.bid.toFixed(3) : "---"}
                </span>
                {item.isConnected && (
                  <div className="text-[8px] text-gray-600 font-mono">
                    {item.spread.toFixed(1)}p
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </HUDCard>
    </div>
  );
}

// -----------------------------------------------------------------
// マークダウン風メッセージ表示
// -----------------------------------------------------------------
function MessageContent({ content }: { content: string }) {
  const clean = stripOrderTag(content);
  const lines = clean.split("\n");
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        if (line.startsWith("## "))  return <p key={i} className="text-cyan-300 font-semibold text-[11px] mt-2">{line.slice(3)}</p>;
        if (line.startsWith("### ")) return <p key={i} className="text-blue-300 font-medium text-[10px] mt-1">{line.slice(4)}</p>;
        if (/^\*\*(.+)\*\*$/.test(line)) return <p key={i} className="text-white font-semibold text-[11px]">{line.replace(/\*\*/g, "")}</p>;
        if (line.trim() === "")     return <div key={i} className="h-1" />;
        return <p key={i} className="text-gray-300 text-[11px] leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

// -----------------------------------------------------------------
// 注文確認カード
// -----------------------------------------------------------------
function OrderConfirmCard({ proposal, onConfirm, onCancel }: {
  proposal: OrderProposal;
  onConfirm: () => void;
  onCancel:  () => void;
}) {
  const isBuy = proposal.direction === "BUY";
  return (
    <div className={cn(
      "border p-3 mx-2 my-1 relative",
      isBuy ? "border-green-700/60 bg-green-950/30" : "border-red-700/60 bg-red-950/30"
    )}>
      <Corner pos="tl" /><Corner pos="tr" /><Corner pos="bl" /><Corner pos="br" />
      <div className="flex items-center gap-2 mb-2">
        <div className={cn("text-xs font-bold font-mono px-2 py-0.5", isBuy ? "bg-green-800/60 text-green-300" : "bg-red-800/60 text-red-300")}>
          ◆ {proposal.direction}
        </div>
        <span className="text-[10px] text-cyan-400 font-mono">{proposal.symbol}</span>
        <span className="ml-auto text-[9px] text-gray-500 font-mono">CONFIRMATION REQUIRED</span>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        {[
          { label: "ENTRY", value: proposal.entry.toFixed(5), color: "text-white" },
          { label: "SL",    value: proposal.sl.toFixed(5),    color: "text-red-400" },
          { label: "TP",    value: proposal.tp.toFixed(5),    color: "text-green-400" },
        ].map(({ label, value, color }) => (
          <div key={label} className="border border-[#1a2535] p-1.5 text-center">
            <div className="text-[8px] text-gray-600 font-mono">{label}</div>
            <div className={cn("text-[10px] font-mono font-semibold", color)}>{value}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[9px] font-mono mb-2">
        <span className="text-gray-500">RR: <span className="text-cyan-400">{proposal.rr}</span></span>
        <span className="text-gray-500">Confidence: <span className="text-yellow-400">{proposal.confidence}%</span></span>
      </div>

      <p className="text-[9px] text-gray-400 font-mono mb-3 leading-relaxed">{proposal.reason}</p>

      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-mono font-semibold transition-all",
            isBuy
              ? "bg-green-800/60 hover:bg-green-700/80 text-green-300 border border-green-700/50"
              : "bg-red-800/60 hover:bg-red-700/80 text-red-300 border border-red-700/50"
          )}
        >
          <CheckCircle size={11} />
          注文する
        </button>
        <button
          onClick={onCancel}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-mono border border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-all"
        >
          <XCircle size={11} />
          キャンセル
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// 右パネル（Mission Control）
// -----------------------------------------------------------------
function MissionControlPanel({ logs, positions, account }: {
  logs:      LogEntry[];
  positions: { ticket: number; type: number; volume: number; openPrice: number; currentPrice: number; profit: number; symbol?: string }[];
  account:   { balance: number; equity: number; freeMargin: number; marginLevel: number; currency: string } | null;
}) {
  return (
    <div className="flex flex-col gap-2 h-full overflow-y-auto p-2 w-56 shrink-0">
      {/* Account */}
      {account && (
        <HUDCard title="Account">
          <div className="space-y-0.5">
            {[
              { label: "Balance",  value: `${account.currency} ${account.balance.toFixed(2)}`, color: "text-white" },
              { label: "Equity",   value: `${account.currency} ${account.equity.toFixed(2)}`,  color: account.equity >= account.balance ? "text-green-400" : "text-red-400" },
              { label: "Free Mg",  value: `${account.currency} ${account.freeMargin.toFixed(2)}`, color: "text-cyan-400" },
              { label: "Mg Level", value: account.marginLevel > 0 ? `${account.marginLevel.toFixed(0)}%` : "---", color: "text-yellow-400" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-[8px] text-gray-600 font-mono">{label}</span>
                <span className={cn("text-[9px] font-mono", color)}>{value}</span>
              </div>
            ))}
          </div>
        </HUDCard>
      )}

      {/* Positions */}
      <HUDCard title={`Positions (${positions.length})`}>
        {positions.length === 0 ? (
          <p className="text-[9px] text-gray-700 font-mono">No open positions</p>
        ) : (
          <div className="space-y-1.5">
            {positions.map((pos) => (
              <div key={pos.ticket} className="border border-[#1a2535] p-1.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className={cn("text-[9px] font-mono font-semibold", pos.type === 0 ? "text-green-400" : "text-red-400")}>
                    {pos.type === 0 ? "▲ BUY" : "▼ SELL"}
                  </span>
                  <span className="text-[8px] text-gray-500 font-mono">{pos.volume}L</span>
                </div>
                <div className="flex justify-between text-[8px] font-mono">
                  <span className="text-gray-600">Open: {pos.openPrice.toFixed(5)}</span>
                </div>
                <div className="text-right">
                  <span className={cn("text-[10px] font-mono font-semibold", pos.profit >= 0 ? "text-green-400" : "text-red-400")}>
                    {pos.profit >= 0 ? "+" : ""}{pos.profit.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </HUDCard>

      {/* System Log */}
      <HUDCard title="System Log" className="flex-1">
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {logs.slice().reverse().map((log) => (
            <div key={log.id} className="flex items-start gap-1">
              <span className={cn(
                "text-[7px] font-mono shrink-0 mt-0.5",
                log.type === "ok"   && "text-green-500",
                log.type === "warn" && "text-yellow-500",
                log.type === "ai"   && "text-purple-400",
                log.type === "info" && "text-gray-500",
              )}>●</span>
              <div>
                <span className="text-[7px] text-gray-700 font-mono">{new Date(log.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <p className="text-[8px] text-gray-400 font-mono leading-tight">{log.text}</p>
              </div>
            </div>
          ))}
          {logs.length === 0 && <p className="text-[8px] text-gray-700 font-mono">Waiting for events...</p>}
        </div>
      </HUDCard>
    </div>
  );
}

// -----------------------------------------------------------------
// クイックコマンド
// -----------------------------------------------------------------
const QUICK_CMDS = [
  { label: "EURUSD分析", cmd: "EURUSDを詳しく分析してください" },
  { label: "USDJPY分析", cmd: "USDJPYを詳しく分析してください" },
  { label: "トレンド",   cmd: "現在のトレンド方向を教えてください" },
  { label: "ATR確認",    cmd: "現在のATRとボラティリティを教えてください" },
];

// -----------------------------------------------------------------
// メインコンポーネント
// -----------------------------------------------------------------
export function CommandCenter() {
  const { status, connectedAt } = useConnectionStore();
  const { activeSymbol, watchlist } = usePriceStore();
  const { setIndicators, getForSymbol } = useIndicatorStore();

  const [messages, setMessages]       = useState<Message[]>([{
    id: "boot", role: "system",
    content: "AVL AI TRADING OS v2.0 起動完了\nシステム初期化... OK\nMT5 接続待機中",
    ts: Date.now(),
  }]);
  const [input, setInput]             = useState("");
  const [thinking, setThinking]       = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [orderProposal, setOrderProposal] = useState<OrderProposal | null>(null);
  const [positions, setPositions]     = useState<Parameters<typeof MissionControlPanel>[0]["positions"]>([]);
  const [account, setAccount]         = useState<Parameters<typeof MissionControlPanel>[0]["account"]>(null);
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [time, setTime]               = useState(new Date());
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const scrollRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const isConnected = status === "connected";
  const indicators  = getForSymbol(activeSymbol);

  // ログ追加ヘルパー
  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev.slice(-49),
      { id: `${Date.now()}_${Math.random()}`, ts: Date.now(), text, type },
    ]);
  }, []);

  // 時計
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // スクロール
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // WebSocket サブスクリプション
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    const unsubs = [
      client.onIndicators((ind) => {
        setIndicators(ind);
        addLog(`[IND] ${ind.symbol} EMA updated`, "info");
      }),
      client.onPosition((pos) => setPositions(pos)),
      client.onAccount((acc) => setAccount(acc)),
    ];
    addLog("MT5 データストリーム接続", "ok");

    return () => unsubs.forEach((u) => u());
  }, [status, setIndicators, addLog]);

  // 接続状態変化ログ
  useEffect(() => {
    if (status === "connected") addLog("MT5 Gateway 接続完了", "ok");
    if (status === "disconnected") addLog("MT5 Gateway 切断", "warn");
  }, [status, addLog]);

  // AI テキストチャット送信
  const sendMessage = useCallback(async (userText: string) => {
    if (!userText.trim() || thinking) return;
    setError(null);
    setOrderProposal(null);

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: userText.trim(), ts: Date.now() };
    const aid = `a_${Date.now()}`;
    const assistantMsg: Message = { id: aid, role: "assistant", content: "", ts: Date.now() };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setThinking(true);
    addLog(`User: "${userText.slice(0, 30)}..."`, "ai");

    const sym = userText.match(/EURUSD|USDJPY|GBPUSD|AUDUSD|XAUUSD/i)?.[0]?.toUpperCase() ?? activeSymbol;
    const history = messages.filter((m) => m.role !== "system").slice(-8)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    try {
      const res = await fetch("/api/ai/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: [...history, { role: "user", content: userText }], symbol: sym }),
      });
      if (!res.ok || !res.body) throw new Error(`AI API エラー: ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";
      let   full    = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const d = line.slice(6).trim();
          if (d === "[DONE]") break;
          try {
            const { delta } = JSON.parse(d) as { delta: string };
            full += delta;
            setMessages((prev) => prev.map((m) =>
              m.id === aid ? { ...m, content: full } : m
            ));
          } catch {}
        }
      }

      // 注文提案を解析
      const proposal = parseOrderProposal(full);
      if (proposal) {
        setOrderProposal(proposal);
        addLog(`[AI] 注文提案: ${proposal.direction} ${proposal.symbol}`, "ai");
      }
      addLog("[AI] 分析完了", "ai");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages((prev) => prev.filter((m) => m.id !== aid));
      addLog(`[ERR] ${msg}`, "warn");
    } finally {
      setThinking(false);
    }
  }, [thinking, messages, activeSymbol, addLog]);

  // 注文実行（Gateway → EA）
  const executeOrder = useCallback(async (proposal: OrderProposal) => {
    addLog(`[ORDER] ${proposal.direction} ${proposal.symbol} ${proposal.entry} 送信中...`, "ai");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL}/orders/pending`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          type:      proposal.direction,
          symbol:    proposal.symbol,
          entry:     proposal.entry,
          sl:        proposal.sl,
          tp:        proposal.tp,
          volume:    0.01,
          source:    "AVL_AI",
        }),
      });
      if (res.ok) {
        addLog(`[ORDER] ${proposal.direction} ${proposal.symbol} 注文送信完了`, "ok");
        setMessages((prev) => [...prev, {
          id:      `sys_${Date.now()}`,
          role:    "system",
          content: `✓ 注文を EA に送信しました。\n${proposal.direction} ${proposal.symbol} @ ${proposal.entry}`,
          ts:      Date.now(),
        }]);
      } else {
        addLog(`[ORDER] 送信失敗: ${res.status}`, "warn");
      }
    } catch {
      addLog("[ORDER] Gateway 送信エラー", "warn");
    }
    setOrderProposal(null);
  }, [addLog]);

  // Voice フック
  const voice = useVoiceChat({
    symbol:  activeSymbol,
    onTranscript: (text, role) => {
      setMessages((prev) => [...prev, {
        id:   `v_${Date.now()}`,
        role,
        content: text,
        ts:   Date.now(),
      }]);
      if (role === "assistant") addLog(`[VOICE AI] ${text.slice(0, 40)}...`, "ai");
    },
    onOrderProposal: (raw) => {
      const p = parseOrderProposal(raw);
      if (p) setOrderProposal(p);
    },
    onStatusChange: (s) => {
      if (s === "listening")   addLog("[VOICE] 音声入力待機中", "info");
      if (s === "speaking")    addLog("[VOICE] AI 応答中", "ai");
      if (s === "error")       addLog("[VOICE] 音声エラー発生", "warn");
    },
  });

  const toggleVoice = useCallback(async () => {
    if (voice.status !== "idle") {
      voice.stop();
      setVoiceEnabled(false);
    } else {
      setVoiceEnabled(true);
      await voice.start(activeSymbol);
    }
  }, [voice, activeSymbol]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); sendMessage(input); };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  // -----------------------------------------------------------------
  // レンダリング
  // -----------------------------------------------------------------
  return (
    <div className="flex flex-col h-screen bg-[#060910] text-gray-100 overflow-hidden">

      {/* ====== ヘッダーバー ====== */}
      <header className="flex items-center gap-4 px-4 py-2 border-b border-[#1a2535] bg-[#080c14] shrink-0">
        {/* ロゴ */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center text-[9px] font-black text-white">
            FX
          </div>
          <div>
            <div className="text-[10px] font-mono font-semibold text-cyan-400 tracking-widest">AVL AI</div>
            <div className="text-[7px] font-mono text-gray-600 tracking-widest">TRADING OPERATING SYSTEM</div>
          </div>
        </div>

        {/* スキャンライン区切り */}
        <div className="flex-1 h-px bg-gradient-to-r from-cyan-500/20 via-cyan-500/5 to-transparent" />

        {/* ステータスインジケーター */}
        <div className="flex items-center gap-4">
          {/* MT5 */}
          <div className="flex items-center gap-1.5">
            {isConnected
              ? <Wifi size={10} className="text-green-400" />
              : <WifiOff size={10} className="text-gray-600" />}
            <span className={cn("text-[8px] font-mono", isConnected ? "text-green-400" : "text-gray-600")}>
              MT5
            </span>
          </div>

          {/* AI */}
          <div className="flex items-center gap-1.5">
            <div className={cn(
              "w-1.5 h-1.5 rounded-full",
              thinking ? "bg-purple-400 animate-pulse" : isConnected ? "bg-cyan-500" : "bg-gray-700"
            )} />
            <span className={cn("text-[8px] font-mono", thinking ? "text-purple-400" : "text-cyan-400")}>
              {thinking ? "THINKING" : "AI READY"}
            </span>
          </div>

          {/* Voice */}
          <div className="flex items-center gap-1.5">
            {voiceEnabled
              ? <Volume2 size={10} className={cn(voice.status === "speaking" ? "text-green-400" : voice.status === "listening" ? "text-cyan-400" : "text-yellow-400")} />
              : <VolumeX size={10} className="text-gray-600" />}
            <span className={cn("text-[8px] font-mono", voiceEnabled ? "text-cyan-400" : "text-gray-600")}>
              VOICE {voiceEnabled ? voice.status.toUpperCase() : "OFF"}
            </span>
          </div>

          {/* 時刻 */}
          <div className="flex items-center gap-1 border-l border-[#1a2535] pl-4">
            <Radio size={9} className="text-gray-600" />
            <span className="text-[9px] font-mono text-gray-400">
              {time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>

          {/* アクティブシンボル */}
          <div className="text-[9px] font-mono text-cyan-400 border border-cyan-500/30 px-2 py-0.5">
            {activeSymbol}
          </div>
        </div>
      </header>

      {/* ====== メインコンテンツ（3カラム）====== */}
      <div className="flex flex-1 overflow-hidden">

        {/* === 左パネル: Market Intelligence === */}
        <MarketPanel
          symbol={activeSymbol}
          indicators={indicators}
          watchlist={watchlist}
        />

        {/* 縦区切り */}
        <div className="w-px bg-gradient-to-b from-transparent via-cyan-500/20 to-transparent shrink-0" />

        {/* === 中央パネル: AI Core === */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">

          {/* AVL AI Core — 3D ホログラム */}
          <div className="shrink-0 h-64 relative">
            <AVLAICore
              state={toAIState(thinking, voice.status)}
              activeAgent={toActiveAgent(thinking, voice.status)}
              className="w-full h-full"
            />
          </div>

          {/* 横区切り */}
          <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/10 to-transparent mx-4" />

          {/* メッセージエリア */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-2">

            {!isConnected && (
              <div className="flex items-start gap-2 p-2 border border-yellow-800/40 bg-yellow-950/20">
                <AlertCircle size={12} className="text-yellow-500 mt-0.5 shrink-0" />
                <p className="text-[10px] text-yellow-400 font-mono">
                  MT5 未接続 — /mt5 から接続してください
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role !== "user" && (
                  <div className="w-4 h-4 border border-cyan-500/30 bg-[#0d1a2a] flex items-center justify-center mr-2 mt-0.5 shrink-0">
                    <ChevronRight size={8} className="text-cyan-400" />
                  </div>
                )}
                <div className={cn(
                  "max-w-[88%] px-3 py-2 relative",
                  msg.role === "user"
                    ? "border border-blue-800/50 bg-blue-950/30 text-blue-100 text-[11px] font-mono"
                    : msg.role === "system"
                    ? "border border-[#1a2535] bg-[#080c14] text-cyan-900/80 text-[9px] font-mono"
                    : "border border-[#1a2535] bg-[#0a0f1a]"
                )}>
                  {msg.role === "assistant"
                    ? <MessageContent content={msg.content || "▋"} />
                    : <p className={cn("leading-relaxed whitespace-pre-wrap", msg.role === "user" ? "text-[11px]" : "text-[9px]")}>{msg.content}</p>
                  }
                  <p className="text-[8px] text-gray-700 mt-1 text-right font-mono">
                    {new Date(msg.ts).toLocaleTimeString("ja-JP")}
                  </p>
                </div>
              </div>
            ))}

            {/* Thinking */}
            {thinking && (
              <div className="flex items-center gap-2 pl-6">
                <div className="flex gap-0.5">
                  {[0,1,2].map((i) => (
                    <div key={i} className="w-1 h-1 bg-cyan-400/60 rounded-full animate-bounce"
                         style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
                <span className="text-[9px] text-cyan-500/60 font-mono">ANALYZING...</span>
              </div>
            )}

            {/* エラー */}
            {error && (
              <div className="flex items-start gap-2 p-2 border border-red-800/40 bg-red-950/20">
                <AlertCircle size={12} className="text-red-400 mt-0.5 shrink-0" />
                <p className="text-[10px] text-red-400 font-mono">{error}</p>
              </div>
            )}

            {/* Voice エラー */}
            {voice.error && (
              <div className="flex items-start gap-2 p-2 border border-orange-800/40 bg-orange-950/20">
                <AlertCircle size={12} className="text-orange-400 mt-0.5 shrink-0" />
                <p className="text-[10px] text-orange-400 font-mono">Voice: {voice.error}</p>
              </div>
            )}
          </div>

          {/* 注文確認カード */}
          {orderProposal && (
            <OrderConfirmCard
              proposal={orderProposal}
              onConfirm={() => executeOrder(orderProposal)}
              onCancel={() => { setOrderProposal(null); addLog("[ORDER] キャンセル", "info"); }}
            />
          )}

          {/* クイックコマンド */}
          <div className="flex gap-1.5 px-4 py-1.5 border-t border-[#1a2535] flex-wrap shrink-0">
            {QUICK_CMDS.map(({ label, cmd }) => (
              <button
                key={label}
                onClick={() => sendMessage(cmd)}
                disabled={thinking || !isConnected}
                className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono border border-[#1a2535] text-gray-500 hover:border-cyan-700/50 hover:text-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <Zap size={8} />
                {label}
              </button>
            ))}
            <button
              onClick={() => {
                setMessages([{ id: "reset", role: "system", content: "会話リセット完了", ts: Date.now() }]);
                setOrderProposal(null);
                setError(null);
              }}
              className="ml-auto text-gray-700 hover:text-gray-400 transition-colors"
              title="リセット"
            >
              <RefreshCw size={11} />
            </button>
          </div>

          {/* 入力エリア */}
          <div className="shrink-0 border-t border-[#1a2535] bg-[#080c14] px-4 py-2">
            <form onSubmit={handleSubmit} className="flex gap-2 items-end">
              {/* Voice ボタン */}
              <button
                type="button"
                onClick={toggleVoice}
                disabled={!isConnected}
                className={cn(
                  "flex items-center justify-center w-9 h-9 border transition-all shrink-0",
                  voice.status !== "idle"
                    ? "border-cyan-500/70 bg-cyan-900/30 text-cyan-300"
                    : "border-[#1a2535] text-gray-600 hover:border-cyan-700/50 hover:text-cyan-400",
                  "disabled:opacity-30 disabled:cursor-not-allowed"
                )}
                title="音声入力"
              >
                {voice.status !== "idle" ? <Mic size={15} /> : <MicOff size={15} />}
              </button>

              {/* テキスト入力 */}
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isConnected ? "コマンドを入力... (Enter送信)" : "MT5 未接続"}
                  disabled={thinking || !isConnected}
                  rows={1}
                  className={cn(
                    "w-full resize-none border border-[#1a2535] bg-[#0d1117] text-gray-200 text-[11px] px-3 py-2 font-mono",
                    "placeholder:text-gray-700 focus:outline-none focus:border-cyan-700/50",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    "min-h-[36px] max-h-[100px]"
                  )}
                  style={{ height: "36px" }}
                  onInput={(e) => {
                    const t = e.currentTarget;
                    t.style.height = "36px";
                    t.style.height = Math.min(t.scrollHeight, 100) + "px";
                  }}
                />
              </div>

              {/* 送信 */}
              <button
                type="submit"
                disabled={!input.trim() || thinking || !isConnected}
                className={cn(
                  "flex items-center justify-center w-9 h-9 border transition-all shrink-0",
                  "border-cyan-700/50 bg-cyan-900/20 text-cyan-400 hover:bg-cyan-800/30",
                  "disabled:opacity-30 disabled:cursor-not-allowed"
                )}
              >
                <Send size={14} />
              </button>
            </form>

            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[8px] text-gray-700 font-mono">
                gpt-4.1 · EMA21/EMA200/ATR14 × H4,H1,M15,M5 · {isConnected ? `接続中 ${connectedAt ? new Date(connectedAt).toLocaleTimeString("ja-JP") : ""}` : "未接続"}
              </span>
            </div>
          </div>
        </div>

        {/* 縦区切り */}
        <div className="w-px bg-gradient-to-b from-transparent via-cyan-500/20 to-transparent shrink-0" />

        {/* === 右パネル: Mission Control === */}
        <MissionControlPanel
          logs={logs}
          positions={positions}
          account={account}
        />
      </div>
    </div>
  );
}
