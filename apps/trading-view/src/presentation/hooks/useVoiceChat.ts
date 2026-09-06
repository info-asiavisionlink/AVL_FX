"use client";

// =================================================================
// useVoiceChat — OpenAI Realtime API（WebRTC）音声会話フック
// =================================================================
// 1. /api/ai/realtime-session でエフェメラルトークンを取得
// 2. ブラウザ WebRTC でマイク→OpenAI Realtime → AI音声出力
// 3. データチャンネルでトランスクリプト/イベントを受信
// =================================================================

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "error";

interface VoiceOptions {
  symbol?: string;
  onTranscript?: (text: string, role: "user" | "assistant") => void;
  onOrderProposal?: (raw: string) => void;
  onStatusChange?: (status: VoiceStatus) => void;
}

interface UseVoiceChatReturn {
  status: VoiceStatus;
  start:  (symbol?: string) => Promise<void>;
  stop:   () => void;
  error:  string | null;
}

export function useVoiceChat(opts: VoiceOptions = {}): UseVoiceChatReturn {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error,  setError]  = useState<string | null>(null);

  const pcRef    = useRef<RTCPeerConnection | null>(null);
  const dcRef    = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const msRef    = useRef<MediaStream | null>(null);

  const updateStatus = useCallback((s: VoiceStatus) => {
    setStatus(s);
    opts.onStatusChange?.(s);
  }, [opts]);

  const stop = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    msRef.current?.getTracks().forEach((t) => t.stop());
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
    }
    pcRef.current    = null;
    dcRef.current    = null;
    audioRef.current = null;
    msRef.current    = null;
    updateStatus("idle");
    setError(null);
  }, [updateStatus]);

  const start = useCallback(async (symbolOverride?: string) => {
    stop();
    updateStatus("connecting");
    setError(null);

    try {
      const sym = symbolOverride ?? opts.symbol ?? "EURUSD";

      // 1. エフェメラルトークン取得
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

      // 2. RTCPeerConnection 作成
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // AI 音声受信
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audioRef.current = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        updateStatus("speaking");
      };

      // マイク取得
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      msRef.current = ms;
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      // データチャンネル（イベント受信）
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        updateStatus("listening");
      };

      dc.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data as string) as Record<string, unknown>;
          handleRealtimeEvent(event);
        } catch {}
      };

      // 3. SDP オファー作成 → OpenAI へ
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime?model=${model}`,
        {
          method:  "POST",
          body:    offer.sdp,
          headers: {
            Authorization:  `Bearer ${token}`,
            "Content-Type": "application/sdp",
          },
        }
      );
      if (!sdpResp.ok) throw new Error(`WebRTC SDP 失敗: ${sdpResp.status}`);

      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
          updateStatus("error");
          setError("音声接続が切断されました");
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      updateStatus("error");
      stop();
    }
  }, [opts, stop, updateStatus]);

  // RealtimeAPI イベント処理
  function handleRealtimeEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    switch (type) {
      case "input_audio_buffer.speech_started":
        updateStatus("listening");
        break;

      case "response.audio.started":
        updateStatus("speaking");
        break;

      case "response.audio.done":
        updateStatus("listening");
        break;

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = (event.transcript as string) ?? "";
        if (transcript) opts.onTranscript?.(transcript, "user");
        break;
      }

      case "response.text.done": {
        const text = (event.text as string) ?? "";
        if (text) {
          opts.onTranscript?.(text, "assistant");
          // 注文提案パターンを検出
          if (/<ORDER>/.test(text)) opts.onOrderProposal?.(text);
        }
        break;
      }

      case "response.audio_transcript.done": {
        const transcript = (event.transcript as string) ?? "";
        if (transcript) opts.onTranscript?.(transcript, "assistant");
        break;
      }

      case "error": {
        const errMsg = (event.error as { message?: string })?.message ?? "Realtime エラー";
        setError(errMsg);
        updateStatus("error");
        break;
      }
    }
  }

  // クリーンアップ
  useEffect(() => () => { stop(); }, [stop]);

  return { status, start, stop, error };
}
