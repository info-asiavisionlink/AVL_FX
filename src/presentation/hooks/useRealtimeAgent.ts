"use client";

// =================================================================
// useRealtimeAgent v2 — JARVIS-class Voice State Machine
//
// Strict state machine: IDLE → LISTENING → SPEAKING → LISTENING
//
// Key rules:
//   • Microphone is ALWAYS muted while AI is speaking
//   • Unmute only after TTS fully completes + 450ms delay
//   • Background noise / echo CANNOT trigger new turns
//   • MediaStream acquired with echoCancellation + noiseSuppression
// =================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useAIOSStore }     from "@/application/stores/aiOSStore";
import { useIndicatorStore } from "@/application/stores/indicatorStore";
import { usePriceStore }     from "@/application/stores/priceStore";

// ── State machine (one state at a time) ──────────────────────────
export type VoiceState =
  | "idle"        // not started
  | "connecting"  // WebRTC setup
  | "listening"   // mic active, waiting for user speech
  | "processing"  // AI thinking (mic muted, brief transition)
  | "speaking"    // AI TTS playing (mic muted)
  | "error";

// Legacy alias for components that import VoiceStatus
export type RealtimeVoiceStatus = VoiceState;

export interface RealtimeVoiceReturn {
  status:       VoiceState;
  error:        string | null;
  muted:        boolean;
  speakingText: string; // Streaming transcript of current AI utterance
  start:        (symbol?: string) => Promise<void>;
  stop:         () => void;
  toggleMute:   () => void;
  interrupt:    () => void;
}

interface UseRealtimeAgentOptions {
  onTranscript?:    (text: string, role: "user" | "assistant") => void;
  onOrderProposal?: (proposal: OrderProposal) => void;
  onAgentThinking?: (thinking: boolean) => void;
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

// All gateway calls go through Vercel API proxy (avoids CORS + env var issues)
const API = "/api/mt5";

// How long to keep mic muted after agent_end before re-enabling
// Text-length estimate: Japanese TTS ≈ 60ms/char, min 2500ms, max 9000ms
const audioDelay = (charCount: number) =>
  Math.min(Math.max(2500, charCount * 60), 9000);

export function useRealtimeAgent(opts: UseRealtimeAgentOptions = {}): RealtimeVoiceReturn {
  const [status,       setStatus]       = useState<VoiceState>("idle");
  const [error,        setError]        = useState<string | null>(null);
  const [muted,        setMuted]        = useState(false);
  const [speakingText, setSpeakingText] = useState("");

  const sessionRef  = useRef<import("@openai/agents/realtime").RealtimeSession | null>(null);
  const audioElRef  = useRef<HTMLAudioElement | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const isSpeaking  = useRef(false);
  const statusRef   = useRef<VoiceState>("idle"); // always current, avoids stale closures
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { addLog, setAgentStatus }  = useAIOSStore();
  const { indicators }              = useIndicatorStore();
  const { activeSymbol, watchlist } = usePriceStore();

  // ── Helpers ────────────────────────────────────────────────────
  const clearResumeTimer = () => {
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
  };

  // Sync statusRef so setTimeout callbacks never read stale state
  const setStatusSync = useCallback((s: VoiceState) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // Find and cache the WebRTC audio sender track for direct control
  const findMicTrack = useCallback(() => {
    if (micTrackRef.current) return; // already cached
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = (sessionRef.current as any)?.transport;
    if (!transport) return;
    const pc: RTCPeerConnection | undefined =
      transport.peerConnection ?? transport._peerConnection ?? transport.pc;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'audio') {
        micTrackRef.current = sender.track;
        break;
      }
    }
  }, []);

  // Mute microphone — two-layer approach for reliability:
  //   1. SDK-level mute (tells SDK to stop sending audio)
  //   2. Direct WebRTC track disable (prevents audio frames reaching server VAD)
  const muteMic = useCallback((mute: boolean) => {
    // Layer 1: SDK mute
    if (sessionRef.current) {
      try { sessionRef.current.mute(mute); } catch { /* not exposed in all SDK versions */ }
    }
    // Layer 2: Direct track control (more reliable — actually stops audio frames)
    findMicTrack();
    if (micTrackRef.current) {
      micTrackRef.current.enabled = !mute;
    }
  }, [findMicTrack]);

  // ── Stop / cleanup ─────────────────────────────────────────────
  const stop = useCallback(() => {
    clearResumeTimer();
    isSpeaking.current = false;
    if (micTrackRef.current) {
      micTrackRef.current.enabled = true;
      micTrackRef.current = null;
    }
    sessionRef.current?.close();
    sessionRef.current = null;
    audioElRef.current?.remove();
    audioElRef.current = null;
    setStatusSync("idle");
    setError(null);
    setMuted(false);
    setSpeakingText("");
    setAgentStatus("voice", "idle", "停止");
  }, [setAgentStatus, setStatusSync]);

  // ── Start ──────────────────────────────────────────────────────
  const start = useCallback(async (symbolOverride?: string) => {
    if (typeof window === "undefined") return;
    stop();
    setStatusSync("connecting");
    setError(null);
    setAgentStatus("voice", "thinking", "接続中...");
    addLog("[VOICE] AVL AI 音声エージェント接続中...", "ai");

    try {
      const sym = (symbolOverride ?? activeSymbol).replace("/", "");

      // 1. Ephemeral token ─────────────────────────────────────────
      const tokenRes = await fetch("/api/ai/realtime-session", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbol: sym }),
      });
      if (!tokenRes.ok) {
        const e = await tokenRes.json() as { error?: string };
        throw new Error(e.error ?? `セッション作成失敗: ${tokenRes.status}`);
      }
      const { token, model } = await tokenRes.json() as { token: string; model: string };

      // 2. SDK dynamic import ──────────────────────────────────────
      const { RealtimeAgent, RealtimeSession, tool } =
        await import("@openai/agents/realtime");
      const { z } = await import("zod");

      // 3. Build live market context ───────────────────────────────
      const indData = indicators[sym.toUpperCase()];
      const ctxParts: string[] = [`## LIVE Market Data: ${sym}`];
      const wl = watchlist.find(w => w.symbol.replace("/", "") === sym);
      if (wl?.bid)  ctxParts.push(`Bid: ${wl.bid.toFixed(5)}  Ask: ${wl.ask.toFixed(5)}  Spread: ${wl.spread.toFixed(1)} pips`);
      if (indData) {
        ctxParts.push(`Spread (EA): ${indData.spread.toFixed(1)} pips`);
        for (const [tf, v] of Object.entries(indData.timeframes)) {
          const dir = v.ema21 > v.ema200 ? "上昇" : "下降";
          ctxParts.push(`${tf}: EMA21=${v.ema21.toFixed(5)} EMA200=${v.ema200.toFixed(5)} ATR=${v.atr.toFixed(5)} [${dir}]`);
        }
      } else {
        ctxParts.push("（指標データ取得中 — get_market_data ツールを呼び出してください）");
      }

      // 4. Tools ───────────────────────────────────────────────────
      const getMarketData = tool({
        name:        "get_market_data",
        description: "指定シンボルの最新価格・EMA21/200・ATR・スプレッドをGatewayから取得する。",
        parameters:  z.object({ symbol: z.string() }),
        execute: async ({ symbol: s }) => {
          const key = s.toUpperCase().replace("/", "");
          try {
            const [tickRes, indRes] = await Promise.all([
              fetch(`${API}/tick/${key}`).then(r => r.ok ? r.json() : null),
              fetch(`${API}/indicators/${key}`).then(r => r.ok ? r.json() : null),
            ]);
            if (!tickRes && !indRes) return JSON.stringify({ error: `${key} のデータがGatewayにありません。` });
            const result: Record<string, unknown> = { symbol: key };
            if (tickRes) { result.bid = (tickRes as {bid:number}).bid; result.ask = (tickRes as {ask:number}).ask; }
            if (indRes)  { result.spread_pips = (indRes as {spread:number}).spread; result.timeframes = (indRes as {timeframes:unknown}).timeframes; }
            return JSON.stringify(result);
          } catch (e) { return JSON.stringify({ error: `Gateway 接続失敗: ${String(e)}` }); }
        },
      });

      const getPositions = tool({
        name: "get_positions", description: "MT5 の現在のオープンポジション一覧を取得する",
        parameters: z.object({}),
        execute: async () => {
          try { const r = await fetch(`${API}/positions`); return r.ok ? await r.text() : JSON.stringify({ error: "取得失敗" }); }
          catch { return JSON.stringify({ error: "Gateway 接続失敗" }); }
        },
      });

      const getAccount = tool({
        name: "get_account", description: "MT5 の口座情報（残高・証拠金・損益）を取得する",
        parameters: z.object({}),
        execute: async () => {
          try { const r = await fetch(`${API}/live`).then(async res => { const d = await res.json(); return { ...d.account }; }); return JSON.stringify(r); }
          catch { return JSON.stringify({ error: "Gateway 接続失敗" }); }
        },
      });

      const proposeOrder = tool({
        name: "propose_order", description: "売買注文の提案をUIに表示してユーザーの確認を求める。",
        parameters: z.object({
          direction: z.enum(["BUY","SELL"]), symbol: z.string(),
          entry: z.number(), sl: z.number(), tp: z.number(),
          rr: z.string(), confidence: z.number().min(0).max(100), reason: z.string(),
        }),
        execute: async (params) => {
          opts.onOrderProposal?.(params as OrderProposal);
          addLog(`[VOICE SIGNAL] ${params.direction} ${params.symbol} @ ${params.entry} (${params.confidence}%)`, "signal");
          return JSON.stringify({ status: "proposed", message: "注文提案をUIに表示しました。" });
        },
      });

      const getEconomicCalendar = tool({
        name:        "get_economic_calendar",
        description: "今後24時間の経済指標・中央銀行イベント・雇用統計・CPI等の高影響イベントを取得する。トレード前に必ず確認すること。",
        parameters:  z.object({
          currencies: z.string().describe("カンマ区切りの通貨コード例: USD,EUR,JPY").optional(),
        }),
        execute: async ({ currencies }) => {
          try {
            const cur = currencies ?? "USD,EUR,JPY,GBP,AUD,NZD,CAD,CHF";
            const r = await fetch(`/api/market/economic-events?currencies=${encodeURIComponent(cur)}&hours=24`);
            if (!r.ok) return JSON.stringify({ error: "経済指標取得失敗" });
            const events = await r.json() as Array<{time:string;currency:string;title:string;impact:string;forecast?:string}>;
            if (!events.length) return "今後24時間に高影響イベントなし";
            return JSON.stringify(events.slice(0, 10));
          } catch (e) { return JSON.stringify({ error: String(e) }); }
        },
      });

      const getMarketNews = tool({
        name:        "get_market_news",
        description: "指定シンボルの最新ニュース・ファンダメンタルズ情報を取得する。",
        parameters:  z.object({
          symbol: z.string().describe("例: EURUSD"),
        }),
        execute: async ({ symbol: s }) => {
          try {
            const r = await fetch(`/api/market/news?symbol=${encodeURIComponent(s)}&limit=5`);
            if (!r.ok) return JSON.stringify({ error: "ニュース取得失敗" });
            const news = await r.json() as Array<{title:string;excerpt:string;source:string;publishedAt:string}>;
            if (!news.length) return `${s}の最新ニュースはDBにありません。search_web_newsで検索してください。`;
            return JSON.stringify(news);
          } catch (e) { return JSON.stringify({ error: String(e) }); }
        },
      });

      const searchWebNews = tool({
        name:        "search_web_news",
        description: "Webからリアルタイムのニュース・中央銀行発言・金利・インフレ・雇用データを検索する。Supabaseにデータがない場合のフォールバック。",
        parameters:  z.object({
          query: z.string().describe("検索クエリ例: 'USD FRB 金利 最新ニュース 2026'"),
        }),
        execute: async ({ query }) => {
          try {
            const r = await fetch("/api/market/web-search", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ query }),
            });
            if (!r.ok) return "Web検索失敗";
            const { result } = await r.json() as { result: string };
            return result;
          } catch (e) { return JSON.stringify({ error: String(e) }); }
        },
      });

      // 5. Trade Scanner tool ─────────────────────────────────────
      const scanForTrades = tool({
        name:        "scan_for_trades",
        description: "全通貨ペアをスキャンしてトレードチャンスを検出する。起動時と「チャンスは？」「トレードは？」の質問時に必ず呼び出す。",
        parameters:  z.object({
          pairs: z.array(z.string()).optional().describe("スキャン対象ペア。省略時は主要10ペアを自動スキャン"),
        }),
        execute: async ({ pairs }) => {
          try {
            const r = await fetch("/api/ai/trade-scanner", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ pairs }),
            });
            if (!r.ok) return "スキャン失敗";
            const data = await r.json() as {
              opportunities: Array<{
                symbol: string; direction: string; confidence: number;
                entry?: number; sl?: number; tp1?: number; tp2?: number;
                rrRatio1?: string; rrRatio2?: string;
                dowTrend: string; patterns: string[]; synthesis: string;
              }>;
              summary: string;
              scannedPairs: number;
            };
            if (!data.opportunities.length) return data.summary;
            return JSON.stringify(data.opportunities.slice(0, 3));
          } catch (e) { return `スキャンエラー: ${String(e)}`; }
        },
      });

      const getFullAnalysis = tool({
        name:        "get_full_analysis",
        description: "指定シンボルの完全な多要素分析（ダウ理論・マルチTF・テクニカル・S/R・相関）を実行し、エントリー条件を判断する。",
        parameters:  z.object({ symbol: z.string() }),
        execute: async ({ symbol: s }) => {
          try {
            const r = await fetch("/api/ai/analysis/full", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ symbol: s }),
            });
            if (!r.ok) return "分析失敗";
            const d = await r.json() as {
              overall: { confidence: number; direction: string; tradeable: boolean };
              tradeSetup: { entry: number; sl: number; tp1: number; tp2: number; rrRatio1: string; rrRatio2: string } | null;
              dowTheory: { trend: string; score: number };
              aiSynthesis: string;
            };
            return JSON.stringify({
              symbol: s,
              overall: d.overall,
              tradeSetup: d.tradeSetup,
              dowTrend: d.dowTheory.trend,
              synthesis: d.aiSynthesis,
            });
          } catch (e) { return `分析エラー: ${String(e)}`; }
        },
      });

      // 6. RealtimeAgent ───────────────────────────────────────────
      const agent = new RealtimeAgent({
        name: "AVL AI",
        handoffDescription: "AVL FX Trade Decision AI",
        instructions: `あなたは AVL AI、機関投資家レベルのFX自律トレード判断AIです。
オペレーター（ボス）の目的はただ一つ：**利益を出すトレードを実行すること**。

## 最重要ミッション
ボスが話しかけてきたら、まず scan_for_trades を呼び出してマーケット全体をスキャンし、
**今すぐエントリーできるベストなトレードチャンスを提示する。**
情報提供ではなく、**トレード判断そのもの**を出力すること。

## 起動時の動作（必須）
1. scan_for_trades を即座に呼び出してスキャン開始
2. 結果を以下のフォーマットで読み上げる：
   「[通貨ペア]、[買い/売り]、エントリー[価格]、損切り[価格]、利確1[価格]、利確2[価格]、勝率[%]、理由：[1文]」
3. チャンスがあれば propose_order で注文提案を表示する
4. チャンスがなければ「現在有効なセットアップなし、待機推奨」と伝える

## 回答フォーマット（音声で読みやすく）
良いシグナル例：
「EURUSDのバイです、ボス。エントリー1.15300、損切り1.14800、利確11.15800、勝率82%。
H4でダウ理論の上昇トレンド継続、サポートでバウンス確認。提案をUIに表示しました。」

シグナルなし例：
「現時点で有効なセットアップはありません、ボス。高影響指標前でリスクが高い状態です。次の[イベント名]通過後に再スキャンします。」

## 話し方
- 日本語、簡潔・断定的。迷わない。
- オペレーターは「ボス」と呼ぶ（各返答1回）
- 数字は読みやすく（1.15300は「いちてんいちごさん」ではなく「1点15300」と言う）
- 余計な説明不要。判断と数字だけ伝える

## ツール使用ルール
- 起動時・「チャンスは？」→ scan_for_trades（必須）
- 特定ペアの詳細 → get_full_analysis
- 経済指標リスク → get_economic_calendar（エントリー前に確認）
- 最新ニュース → get_market_news → 未取得なら search_web_news
- 現在価格確認 → get_market_data
- ポジション確認 → get_positions
- 注文提案 → propose_order（ボスの承認なしに発注は絶対禁止）

## 現在のセッション情報
${ctxParts.join("\n")}

## 絶対ルール
- 自動発注禁止。必ず propose_order → ボス承認
- 過去データや記憶でトレード判断しない。必ずライブデータを使う
- 勝率70%未満のシグナルはボスに提示しない（「待機推奨」と伝える）`,
        tools: [
          scanForTrades, getFullAnalysis,
          getMarketData, getPositions, getAccount, proposeOrder,
          getEconomicCalendar, getMarketNews, searchWebNews,
        ],
      });

      // 6. RealtimeSession ─────────────────────────────────────────
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElRef.current = audioEl;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = new RealtimeSession(agent, {
        transport: "webrtc",
        model:     model as string,
      } as any);

      // ═══════════════════════════════════════════════════════════
      // 7. STRICT VOICE STATE MACHINE
      // ═══════════════════════════════════════════════════════════

      // AI starts speaking → mute mic. Do NOT clear the resume timer here —
      // clearing it caused the timer set by a previous agent_end to be cancelled,
      // leaving status stuck in "processing" indefinitely.
      session.on("agent_start", () => {
        isSpeaking.current = true;
        setSpeakingText("");
        muteMic(true);
        setStatusSync("speaking");
        opts.onAgentThinking?.(true);
        setAgentStatus("voice", "thinking", "応答中...");
        addLog("[VOICE] AI 発話開始 — マイク無効化", "ai");
      });

      // AI finishes generating → start timer to re-enable mic after audio plays out.
      // WebRTC audio.ended does NOT fire between turns, so we estimate duration from text.
      session.on("agent_end", (_, __, output) => {
        isSpeaking.current = false;
        opts.onAgentThinking?.(false);
        setStatusSync("processing");

        if (output) {
          opts.onTranscript?.(output, "assistant");
          setSpeakingText(output);
          addLog(`[VOICE AI] ${output.slice(0, 80)}`, "ai");
        }

        // Cancel any previous timer then start a new one
        clearResumeTimer();
        const delay = audioDelay(output?.length ?? 0);
        resumeTimer.current = setTimeout(() => {
          // Use statusRef (not captured "status") to avoid stale closure
          if (statusRef.current !== "processing") return;
          muteMic(false);
          setStatusSync("listening");
          setSpeakingText("");
          setAgentStatus("voice", "active", "音声入力待機中");
          addLog("[VOICE] マイク有効化 — 入力待機", "info");
        }, delay);
      });

      session.on("agent_tool_start", (_, __, t) => {
        addLog(`[VOICE TOOL] ${t.name} 呼び出し中...`, "info");
        setAgentStatus("market", "thinking", `${t.name} 実行中`);
      });

      session.on("agent_tool_end", (_, __, t) => {
        addLog(`[VOICE TOOL] ${t.name} 完了`, "ok");
        setAgentStatus("market", "active", `${t.name} 完了`);
      });

      session.on("history_added", (item) => {
        // Only process user messages — and only if we're in listening state
        if (item.type === "message" && item.role === "user" && !isSpeaking.current) {
          const txt = (item.content as Array<{type:string;transcript?:string}>)
            .filter(c => c.type === "audio" || c.type === "text")
            .map(c => c.transcript ?? "")
            .join("");
          if (txt) {
            opts.onTranscript?.(txt, "user");
            addLog(`[VOICE USER] ${txt.slice(0, 60)}`, "info");
          }
        }
      });

      session.on("error", (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatusSync("error");
        addLog(`[VOICE ERR] ${msg}`, "warn");
        setAgentStatus("voice", "error", msg);
      });

      sessionRef.current = session;

      // 8. Connect (WebRTC) ─────────────────────────────────────
      await session.connect({ apiKey: token } as Parameters<typeof session.connect>[0]);

      // Start in listening mode with mic enabled
      muteMic(false);
      setStatusSync("listening");
      setAgentStatus("voice", "active", "音声入力待機中");
      addLog("[VOICE] AVL AI 音声エージェント起動 ✓", "ok");
      addLog(`[VOICE] ${sym} モード — 話しかけてください`, "info");

      // Cache the WebRTC audio track reference after ICE negotiation settles
      setTimeout(() => findMicTrack(), 800);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatusSync("error");
      addLog(`[VOICE ERR] ${msg}`, "warn");
      setAgentStatus("voice", "error", msg);
      stop();
    }
  }, [stop, activeSymbol, indicators, watchlist, addLog, setAgentStatus, muteMic, findMicTrack, opts]);

  // ── Toggle mute (manual) ───────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (!sessionRef.current) return;
    const next = !muted;
    muteMic(next);
    setMuted(next);
    addLog(`[VOICE] ${next ? "ミュート ON" : "ミュート OFF"}`, "info");
  }, [muted, muteMic, addLog]);

  // ── Interrupt (user-initiated only) ───────────────────────────
  const interrupt = useCallback(() => {
    if (!sessionRef.current) return;
    clearResumeTimer();
    try {
      (sessionRef.current.transport as import("@openai/agents/realtime").OpenAIRealtimeWebRTC | undefined)?.interrupt();
    } catch { /* ignore */ }
    isSpeaking.current = false;

    // Re-enable mic immediately on intentional interrupt
    muteMic(false);
    setStatusSync("listening");
    addLog("[VOICE] ユーザー割り込み — マイク有効化", "info");
  }, [muteMic, addLog]);

  // Watchdog: if stuck in processing/speaking for >10s, force transition to listening.
  // Guards against edge cases (e.g. agent_start fires again and no agent_end follows).
  useEffect(() => {
    if (status !== "processing" && status !== "speaking") return;
    const t = setTimeout(() => {
      if (statusRef.current !== "processing" && statusRef.current !== "speaking") return;
      if (!sessionRef.current) return;
      muteMic(false);
      setStatusSync("listening");
      setSpeakingText("");
      setAgentStatus("voice", "active", "音声入力待機中");
      addLog("[VOICE] ウォッチドッグ — マイク有効化", "info");
    }, 10000);
    return () => clearTimeout(t);
  }, [status, muteMic, setStatusSync, setAgentStatus, addLog]);

  useEffect(() => () => { stop(); }, [stop]);

  return { status, error, muted, speakingText, start, stop, toggleMute, interrupt };
}
