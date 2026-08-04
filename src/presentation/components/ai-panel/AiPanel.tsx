"use client";

// =================================================================
// AVL AI — Command Center v1.0
// AI Trading Operating System
// OpenAI gpt-4.1 による市場分析・売買提案
// =================================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { BrainCircuit, Send, Loader2, RefreshCw, Zap, TrendingUp, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { usePriceStore }      from "@/application/stores/priceStore";

// -----------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------
interface Message {
  id:      string;
  role:    "user" | "assistant" | "system";
  content: string;
  ts:      number;
}

// -----------------------------------------------------------------
// クイックコマンドボタン
// -----------------------------------------------------------------
const QUICK_COMMANDS = [
  { label: "EURUSD分析", cmd: "EURUSDを分析してください" },
  { label: "USDJPY分析", cmd: "USDJPYを分析してください" },
  { label: "トレンド確認", cmd: "現在のトレンド方向を確認してください" },
  { label: "ATR確認",    cmd: "現在のATRとボラティリティを教えてください" },
];

// -----------------------------------------------------------------
// AI ステータスインジケーター
// -----------------------------------------------------------------
function AIStatusDot({ thinking }: { thinking: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn(
        "w-2 h-2 rounded-full",
        thinking ? "bg-purple-400 animate-pulse" : "bg-purple-600"
      )} />
      <span className="text-[10px] text-purple-400 font-mono">
        {thinking ? "THINKING" : "READY"}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------
// マークダウン風表示（シンプル版）
// -----------------------------------------------------------------
function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith("## "))  return <p key={i} className="text-blue-300 font-semibold text-xs mt-2">{line.slice(3)}</p>;
        if (line.startsWith("### ")) return <p key={i} className="text-cyan-300 font-medium text-xs mt-1">{line.slice(4)}</p>;
        if (line.startsWith("**") && line.endsWith("**")) return <p key={i} className="text-white font-semibold text-xs">{line.slice(2, -2)}</p>;
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return <p key={i} className="text-gray-300 text-xs leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

// -----------------------------------------------------------------
// メインコンポーネント
// -----------------------------------------------------------------
export function AiPanel() {
  const { status }                     = useConnectionStore();
  const { activeSymbol }               = usePriceStore();
  const [messages, setMessages]        = useState<Message[]>([]);
  const [input, setInput]              = useState("");
  const [thinking, setThinking]        = useState(false);
  const [error, setError]              = useState<string | null>(null);
  const scrollRef                      = useRef<HTMLDivElement>(null);
  const inputRef                       = useRef<HTMLTextAreaElement>(null);
  const isConnected                    = status === "connected";

  // スクロールを末尾に合わせる
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 初回ウェルカムメッセージ
  useEffect(() => {
    setMessages([{
      id: "welcome",
      role: "system",
      content: "AVL AI Trading OS 起動しました。\nシンボルを指定して分析を開始してください。\n例: 「EURUSDを分析して」",
      ts: Date.now(),
    }]);
  }, []);

  // AI にメッセージ送信（ストリーミング）
  const sendMessage = useCallback(async (userText: string) => {
    if (!userText.trim() || thinking) return;
    setError(null);

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: userText.trim(), ts: Date.now() };
    const assistantId = `a_${Date.now()}`;
    const assistantMsg: Message = { id: assistantId, role: "assistant", content: "", ts: Date.now() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput("");
    setThinking(true);

    // 使用シンボルを判定（ユーザー発言またはアクティブシンボル）
    const symbol = userText.match(/EURUSD|USDJPY|GBPUSD|AUDUSD|XAUUSD/i)?.[0]?.toUpperCase() ?? activeSymbol;

    // 会話履歴（system/welcomeは除く）
    const history = messages
      .filter(m => m.role !== "system")
      .slice(-10) // 直近10件
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    try {
      const res = await fetch("/api/ai/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: [...history, { role: "user", content: userText }], symbol }),
      });

      if (!res.ok) throw new Error(`AI API エラー: ${res.status}`);
      if (!res.body) throw new Error("レスポンスボディなし");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const { delta } = JSON.parse(data) as { delta: string };
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m
            ));
          } catch {}
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages(prev => prev.filter(m => m.id !== assistantId));
    } finally {
      setThinking(false);
    }
  }, [thinking, messages, activeSymbol]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  // -----------------------------------------------------------------
  // レンダリング
  // -----------------------------------------------------------------
  return (
    <div className="flex flex-col h-full bg-[#0a0d14] text-gray-100">

      {/* ヘッダー — Command Center タイトルバー */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1a1d2e] bg-[#0f1117] shrink-0">
        <div className="relative">
          <div className="w-8 h-8 rounded-lg bg-purple-900/40 border border-purple-700/40 flex items-center justify-center">
            <BrainCircuit size={16} className="text-purple-400" />
          </div>
          <span className={cn(
            "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-[#0f1117]",
            isConnected ? "bg-green-400" : "bg-gray-600"
          )} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-100 tracking-wide">AVL AI</span>
            <span className="text-[10px] text-gray-600 font-mono">TRADING OS</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn("text-[10px] font-mono", isConnected ? "text-green-500" : "text-gray-600")}>
              {isConnected ? "MT5 CONNECTED" : "MT5 DISCONNECTED"}
            </span>
            <span className="text-gray-700 text-[10px]">·</span>
            <span className="text-[10px] font-mono text-blue-500">{activeSymbol}</span>
          </div>
        </div>
        <AIStatusDot thinking={thinking} />
      </div>

      {/* クイックコマンドパネル */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-[#1a1d2e] shrink-0 flex-wrap">
        {QUICK_COMMANDS.map(({ label, cmd }) => (
          <button
            key={label}
            onClick={() => sendMessage(cmd)}
            disabled={thinking || !isConnected}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-all",
              "border border-[#2a2d3e] text-gray-400 hover:border-purple-700 hover:text-purple-300",
              "disabled:opacity-30 disabled:cursor-not-allowed"
            )}
          >
            <Zap size={9} />
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            setMessages([{
              id: "welcome-reset",
              role: "system",
              content: "会話をリセットしました。",
              ts: Date.now(),
            }]);
            setError(null);
          }}
          className="ml-auto p-1 text-gray-600 hover:text-gray-400 transition-colors"
          title="会話リセット"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* メッセージエリア */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

        {/* 未接続時の警告 */}
        {!isConnected && (
          <div className="flex items-start gap-2 p-2.5 rounded bg-yellow-950/30 border border-yellow-900/40">
            <AlertCircle size={13} className="text-yellow-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-yellow-400 leading-relaxed">
              MT5 未接続のため市場データを取得できません。<br />
              /mt5 から接続してください。
            </p>
          </div>
        )}

        {/* メッセージ一覧 */}
        {messages.map((msg) => (
          <div key={msg.id} className={cn(
            "flex",
            msg.role === "user" ? "justify-end" : "justify-start"
          )}>
            {msg.role !== "user" && (
              <div className="w-5 h-5 rounded bg-purple-900/50 border border-purple-800/50 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                <BrainCircuit size={10} className="text-purple-400" />
              </div>
            )}
            <div className={cn(
              "max-w-[85%] rounded-lg px-3 py-2",
              msg.role === "user"
                ? "bg-blue-900/40 border border-blue-800/40 text-blue-100 text-xs"
                : msg.role === "system"
                ? "bg-[#1a1d2e] border border-[#2a2d3e] text-gray-500 text-[11px] font-mono"
                : "bg-[#141720] border border-[#2a2d3e]"
            )}>
              {msg.role === "assistant" ? (
                <MessageContent content={msg.content || "▋"} />
              ) : (
                <p className={cn(
                  "leading-relaxed whitespace-pre-wrap",
                  msg.role === "user" ? "text-xs" : "text-[11px]"
                )}>{msg.content}</p>
              )}
              <p className="text-[9px] text-gray-700 mt-1 text-right font-mono">
                {new Date(msg.ts).toLocaleTimeString("ja-JP")}
              </p>
            </div>
          </div>
        ))}

        {/* Thinking インジケーター */}
        {thinking && (
          <div className="flex justify-start">
            <div className="w-5 h-5 rounded bg-purple-900/50 border border-purple-800/50 flex items-center justify-center mr-2 shrink-0">
              <BrainCircuit size={10} className="text-purple-400 animate-pulse" />
            </div>
            <div className="bg-[#141720] border border-[#2a2d3e] rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5">
                <Loader2 size={11} className="text-purple-400 animate-spin" />
                <span className="text-[11px] text-purple-400 font-mono">分析中...</span>
              </div>
            </div>
          </div>
        )}

        {/* エラー表示 */}
        {error && (
          <div className="flex items-start gap-2 p-2.5 rounded bg-red-950/30 border border-red-900/40">
            <AlertCircle size={13} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-[11px] text-red-400">{error}</p>
          </div>
        )}
      </div>

      {/* 入力フォーム */}
      <div className="shrink-0 border-t border-[#1a1d2e] bg-[#0f1117] px-3 py-2">
        <form onSubmit={handleSubmit} className="flex gap-2 items-end">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? "分析依頼を入力... (Enter で送信)" : "MT5 未接続"}
              disabled={thinking || !isConnected}
              rows={1}
              className={cn(
                "w-full resize-none rounded bg-[#141720] border border-[#2a2d3e] text-gray-200 text-xs px-3 py-2",
                "placeholder:text-gray-600 focus:outline-none focus:border-purple-700/60",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                "font-mono leading-relaxed",
                "min-h-[36px] max-h-[120px]"
              )}
              style={{ height: "36px" }}
              onInput={e => {
                const t = e.currentTarget;
                t.style.height = "36px";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />
          </div>
          <button
            type="submit"
            disabled={!input.trim() || thinking || !isConnected}
            className={cn(
              "flex items-center justify-center w-9 h-9 rounded transition-all shrink-0",
              "bg-purple-700/80 hover:bg-purple-600 text-white",
              "disabled:opacity-30 disabled:cursor-not-allowed"
            )}
          >
            {thinking ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </form>
        <div className="flex items-center gap-1.5 mt-1.5">
          <TrendingUp size={9} className="text-gray-700" />
          <span className="text-[9px] text-gray-700 font-mono">
            gpt-4.1 · MT5 EMA21/EMA200/ATR14 × H4,H1,M15,M5
          </span>
        </div>
      </div>
    </div>
  );
}
