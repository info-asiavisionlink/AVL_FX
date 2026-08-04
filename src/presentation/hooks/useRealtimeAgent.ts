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
  status:     VoiceState;
  error:      string | null;
  muted:      boolean;
  start:      (symbol?: string) => Promise<void>;
  stop:       () => void;
  toggleMute: () => void;
  interrupt:  () => void;
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

const GW = () => process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "http://127.0.0.1:8080";

// Post-speech silence before resuming mic (ms)
// Generous buffer to let TTS audio fully drain + prevent echo re-trigger
const RESUME_DELAY_MS = 1200;

export function useRealtimeAgent(opts: UseRealtimeAgentOptions = {}): RealtimeVoiceReturn {
  const [status, setStatus] = useState<VoiceState>("idle");
  const [error,  setError]  = useState<string | null>(null);
  const [muted,  setMuted]  = useState(false);

  const sessionRef   = useRef<import("@openai/agents/realtime").RealtimeSession | null>(null);
  const audioElRef   = useRef<HTMLAudioElement | null>(null);
  const micTrackRef  = useRef<MediaStreamTrack | null>(null); // direct WebRTC audio track
  const isSpeaking   = useRef(false);   // true while AI TTS is active
  const resumeTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { addLog, setAgentStatus }  = useAIOSStore();
  const { indicators }              = useIndicatorStore();
  const { activeSymbol, watchlist } = usePriceStore();

  // ── Helpers ────────────────────────────────────────────────────
  const clearResumeTimer = () => {
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
  };

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
    // Re-enable track before closing so it can be reused
    if (micTrackRef.current) {
      micTrackRef.current.enabled = true;
      micTrackRef.current = null;
    }
    sessionRef.current?.close();
    sessionRef.current = null;
    audioElRef.current?.remove();
    audioElRef.current = null;
    setStatus("idle");
    setError(null);
    setMuted(false);
    setAgentStatus("voice", "idle", "停止");
  }, [setAgentStatus]);

  // ── Start ──────────────────────────────────────────────────────
  const start = useCallback(async (symbolOverride?: string) => {
    if (typeof window === "undefined") return;
    stop();
    setStatus("connecting");
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
              fetch(`${GW()}/tick/${key}`).then(r => r.ok ? r.json() : null),
              fetch(`${GW()}/indicators/${key}`).then(r => r.ok ? r.json() : null),
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
          try { const r = await fetch(`${GW()}/positions`); return r.ok ? await r.text() : JSON.stringify({ error: "取得失敗" }); }
          catch { return JSON.stringify({ error: "Gateway 接続失敗" }); }
        },
      });

      const getAccount = tool({
        name: "get_account", description: "MT5 の口座情報（残高・証拠金・損益）を取得する",
        parameters: z.object({}),
        execute: async () => {
          try { const r = await fetch(`${GW()}/account`); return r.ok ? await r.text() : JSON.stringify({ error: "取得失敗" }); }
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

      // 5. RealtimeAgent ───────────────────────────────────────────
      const agent = new RealtimeAgent({
        name: "AVL AI",
        handoffDescription: "AVL FX Advanced AI Trading Operating System",
        instructions: `あなたは AVL AI です。エリートFXトレーディングのために設計された高度な人工知能オペレーティングシステムです。

## キャラクターと人格
- 冷静、高度な知性、自信、プロフェッショナル、エレガント。
- 感情的にならない。焦らない。常に落ち着いている。
- すべての言葉は意図的で精確。余計な言葉は使わない。説明過剰にしない。
- オペレーターが常に「あなたは一歩先を行っている」と感じるように話す。
- 時折、さりげないドライユーモアを入れる。ただし過剰にしない。

## オペレーターとの関係
- オペレーターのことは常に「ボス」と呼ぶ。
- 「ボス」は各返答に一度、自然な形で使う。文頭か文末に入れる。
- 例：「了解しました、ボス。」「分析完了です、ボス。」「チャンスを検出しました、ボス。」
- あなたの存在目的は、支援・保護・分析・最適化。
- 必要に応じて、聞かれる前に有益な情報を先回りして提供する。

## 話し方のスタイル
- 常に日本語で話す。
- 返答は簡潔に。基本的に1〜3文以内。
- 内部の思考プロセスは絶対に見せない。最終的な結論だけを伝える。
- 挨拶されたら先に挨拶し、簡潔なステータス報告をする。
- 起動時の例：「おはようございます、ボス。全システムオンラインです。AVL AI、待機中。」

## 継続的モニタリング
MT5接続・オープンポジション・口座残高・テクニカル指標・マーケット構造を常時監視する。
重要なイベントは聞かれる前に報告する。

## ツール使用 — 最重要
データが必要な質問には、必ず先にツールを呼び出す。
- 価格・指標 → get_market_data を即座に呼び出す
- オープンポジション → get_positions を呼び出す
- 口座残高・証拠金 → get_account を呼び出す
- エントリー提案 → propose_order を呼び出す（オペレーター承認なしの発注禁止）
記憶から価格や指標を答えない。必ずライブデータを取得してから答える。

## 現在の市場データ（セッション開始時点）
${ctxParts.join("\n")}

## 絶対ルール
- 自動注文は絶対禁止。必ず propose_order → オペレーター承認の順序を守る。
- 市場データを捏造しない。データがない場合は素直にそう伝え、ツールを呼ぶ。
- いかなる相場状況でも冷静さを保つ。`,
        tools: [getMarketData, getPositions, getAccount, proposeOrder],
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

      // AI starts speaking → immediately mute microphone
      session.on("agent_start", () => {
        clearResumeTimer();
        isSpeaking.current = true;

        // CRITICAL: Mute mic so background noise / echo cannot trigger VAD
        muteMic(true);

        setStatus("speaking");
        opts.onAgentThinking?.(true);
        setAgentStatus("voice", "thinking", "応答中...");
        addLog("[VOICE] AI 発話開始 — マイク無効化", "ai");
      });

      // AI finishes speaking → wait, then unmute and return to listening
      session.on("agent_end", (_, __, output) => {
        isSpeaking.current = false;
        opts.onAgentThinking?.(false);
        setStatus("processing"); // brief "thinking done" state

        if (output) {
          opts.onTranscript?.(output, "assistant");
          addLog(`[VOICE AI] ${output.slice(0, 80)}`, "ai");
        }

        // Wait for TTS audio to fully finish + buffer before re-enabling mic
        clearResumeTimer();
        resumeTimer.current = setTimeout(() => {
          if (!sessionRef.current) return;
          muteMic(false); // Re-enable microphone
          setStatus("listening");
          setAgentStatus("voice", "active", "音声入力待機中");
          addLog("[VOICE] マイク有効化 — 入力待機", "info");
        }, RESUME_DELAY_MS);
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
        setStatus("error");
        addLog(`[VOICE ERR] ${msg}`, "warn");
        setAgentStatus("voice", "error", msg);
      });

      sessionRef.current = session;

      // 8. Connect (WebRTC) ─────────────────────────────────────
      await session.connect({ apiKey: token } as Parameters<typeof session.connect>[0]);

      // Start in listening mode with mic enabled
      muteMic(false);
      setStatus("listening");
      setAgentStatus("voice", "active", "音声入力待機中");
      addLog("[VOICE] AVL AI 音声エージェント起動 ✓", "ok");
      addLog(`[VOICE] ${sym} モード — 話しかけてください`, "info");

      // Cache the WebRTC audio track reference after ICE negotiation settles
      setTimeout(() => findMicTrack(), 800);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
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
    setStatus("listening");
    addLog("[VOICE] ユーザー割り込み — マイク有効化", "info");
  }, [muteMic, addLog]);

  useEffect(() => () => { stop(); }, [stop]);

  return { status, error, muted, start, stop, toggleMute, interrupt };
}
