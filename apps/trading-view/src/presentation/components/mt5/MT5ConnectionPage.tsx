"use client";

import { useState, useEffect, useCallback } from "react";
import { Copy, Download, CheckCircle, Circle, RefreshCw, AlertCircle, Wifi } from "lucide-react";
import { toast } from "sonner";

const GATEWAY_URL = process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "";

interface Connection {
  id: string;
  status: string;
  last_heartbeat_at: string | null;
  broker: string | null;
  server_name: string | null;
  mt5_login: number | null;
  created_at: string;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success(`${label}をコピーしました`);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-bold transition-all hover:opacity-80"
      style={{ background: copied ? "rgba(0,255,136,0.15)" : "rgba(0,229,255,0.1)", color: copied ? "#00ff88" : "#00e5ff", border: `1px solid ${copied ? "rgba(0,255,136,0.3)" : "rgba(0,229,255,0.25)"}` }}>
      {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
      {copied ? "コピー済み" : "コピー"}
    </button>
  );
}

function ValueBox({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "#0a0e1a", border: "1px solid rgba(255,255,255,0.08)" }}>
      <p className="text-[9px] tracking-widest mb-1.5" style={{ color: "#475569" }}>{label}</p>
      <div className="flex items-center justify-between gap-3">
        <p className={`text-xs break-all ${mono ? "font-mono" : ""}`} style={{ color: "#e2e8f0" }}>{value}</p>
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function Step({ num, title, done, active, children }: {
  num: number; title: string; done?: boolean; active?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-black"
          style={{
            background: done ? "rgba(0,255,136,0.2)" : active ? "rgba(0,229,255,0.15)" : "rgba(255,255,255,0.05)",
            color: done ? "#00ff88" : active ? "#00e5ff" : "#475569",
            border: `2px solid ${done ? "rgba(0,255,136,0.4)" : active ? "rgba(0,229,255,0.3)" : "rgba(255,255,255,0.1)"}`,
          }}>
          {done ? <CheckCircle size={16} /> : num}
        </div>
        <div className="w-px flex-1 mt-2" style={{ background: "rgba(255,255,255,0.06)" }} />
      </div>
      <div className="flex-1 pb-8">
        <p className="text-sm font-bold mb-3" style={{ color: active || done ? "#e2e8f0" : "#475569" }}>{title}</p>
        <div style={{ opacity: active || done ? 1 : 0.4 }}>{children}</div>
      </div>
    </div>
  );
}

export function MT5ConnectionPage() {
  const [connection, setConnection]   = useState<Connection | null>(null);
  const [token,      setToken]        = useState<string | null>(null);
  const [loading,    setLoading]      = useState(true);
  const [issuing,    setIssuing]      = useState(false);
  const [isOnline,   setIsOnline]     = useState(false);
  const [step,       setStep]         = useState(1);

  // 接続状態を取得
  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetch("/api/user/mt5-setup");
      if (!res.ok) return;
      const data = await res.json();
      setConnection(data.connection);
      if (data.connection) setStep(3);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  // EA がオンラインか確認
  const checkOnline = useCallback(async () => {
    if (!connection?.id) return;
    try {
      const res = await fetch(`/api/live/connections`);
      if (!res.ok) return;
      const data = await res.json();
      const conn = (data.connections ?? []).find((c: Connection) => c.id === connection.id);
      if (conn?.last_heartbeat_at) {
        const age = (Date.now() - new Date(conn.last_heartbeat_at).getTime()) / 1000;
        setIsOnline(age < 60);
      }
    } catch { /* ignore */ }
  }, [connection?.id]);

  useEffect(() => { fetchConnection(); }, [fetchConnection]);
  useEffect(() => {
    if (!connection) return;
    checkOnline();
    const id = setInterval(checkOnline, 15000);
    return () => clearInterval(id);
  }, [connection, checkOnline]);

  // 接続情報を発行
  const issueToken = async () => {
    setIssuing(true);
    try {
      const res = await fetch("/api/user/mt5-setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (!res.ok) { toast.error("発行に失敗しました"); return; }
      const data = await res.json();
      setConnection(data.connection);
      setToken(data.connectionToken);
      setStep(3);
      toast.success("接続情報を発行しました");
    } catch { toast.error("エラーが発生しました"); }
    finally { setIssuing(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
      </div>
    );
  }

  const hasConnection = !!connection;
  const hasToken = !!token;

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-black tracking-widest" style={{ color: "#e2e8f0" }}>MT5接続</h1>
        <p className="text-xs mt-1" style={{ color: "#475569" }}>
          あなたのMT5をAVL-FXに接続します。EAファイルを一度設定するだけで完了します。
        </p>
      </div>

      {/* Connection status */}
      {hasConnection && (
        <div className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{ background: isOnline ? "rgba(0,255,136,0.05)" : "rgba(255,255,255,0.03)", border: `1px solid ${isOnline ? "rgba(0,255,136,0.2)" : "rgba(255,255,255,0.08)"}` }}>
          <div className={`w-2.5 h-2.5 rounded-full ${isOnline ? "bg-green-400" : "bg-gray-500"}`}
            style={{ boxShadow: isOnline ? "0 0 6px #4ade80" : "none" }} />
          <div className="flex-1">
            <p className="text-xs font-bold" style={{ color: isOnline ? "#4ade80" : "#94a3b8" }}>
              {isOnline ? "EA接続中 — 正常稼働中" : "EA未接続 — MT5でEAを起動してください"}
            </p>
            {connection.last_heartbeat_at && (
              <p className="text-[9px] mt-0.5" style={{ color: "#475569" }}>
                最終確認: {new Date(connection.last_heartbeat_at).toLocaleString("ja-JP")}
              </p>
            )}
          </div>
          {isOnline && <Wifi size={16} className="text-green-400" />}
        </div>
      )}

      {/* Steps */}
      <div className="rounded-xl p-6" style={{ background: "#0f1423", border: "1px solid rgba(255,255,255,0.08)" }}>

        {/* STEP 1: EAをダウンロード */}
        <Step num={1} title="EAファイルをダウンロード" done={step >= 2} active={step === 1}>
          <p className="text-xs mb-3" style={{ color: "#94a3b8" }}>
            MT5に入れるEAファイル（.ex5）をダウンロードします。コンパイル不要です。
          </p>
          <a href="/ea/AVL_FX_Bridge.ex5" download="AVL_FX_Bridge.ex5">
            <button
              onClick={() => setStep(s => Math.max(s, 2))}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all hover:opacity-80"
              style={{ background: "rgba(0,229,255,0.12)", color: "#00e5ff", border: "1px solid rgba(0,229,255,0.3)" }}>
              <Download size={15} />
              AVL_FX_Bridge.ex5 をダウンロード
            </button>
          </a>
          <p className="text-[10px] mt-2" style={{ color: "#475569" }}>
            ダウンロードしたら「次へ」を押してください
          </p>
          {step === 1 && (
            <button onClick={() => setStep(2)} className="mt-2 text-[11px] underline" style={{ color: "#475569" }}>
              ダウンロード済み → 次へ
            </button>
          )}
        </Step>

        {/* STEP 2: MT5に配置 */}
        <Step num={2} title="MT5のフォルダに入れる" done={step >= 3} active={step === 2}>
          <div className="space-y-2 text-xs" style={{ color: "#94a3b8" }}>
            <p>① MT5を開く</p>
            <p>② メニュー →「ファイル」→「データフォルダを開く」</p>
            <p>③ <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "#00e5ff" }}>MQL5 → Experts</span> フォルダを開く</p>
            <p>④ ダウンロードした <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "#00e5ff" }}>AVL_FX_Bridge.ex5</span> をそのフォルダに入れる</p>
            <p>⑤ MT5のナビゲーターで「エキスパートアドバイザー」を右クリック →「更新」</p>
          </div>
          {step === 2 && (
            <button onClick={() => setStep(3)} className="mt-3 text-[11px] underline" style={{ color: "#475569" }}>
              配置完了 → 次へ
            </button>
          )}
        </Step>

        {/* STEP 3: 接続情報を取得 */}
        <Step num={3} title="接続情報を取得する" done={step >= 4 && hasToken} active={step === 3}>
          <p className="text-xs mb-3" style={{ color: "#94a3b8" }}>
            あなた専用の接続情報を発行します。EAの設定画面に入力します。
          </p>
          {!hasConnection ? (
            <button onClick={issueToken} disabled={issuing}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all hover:opacity-80"
              style={{ background: "rgba(0,229,255,0.12)", color: "#00e5ff", border: "1px solid rgba(0,229,255,0.3)", opacity: issuing ? 0.6 : 1 }}>
              {issuing ? <div className="w-4 h-4 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" /> : <CheckCircle size={15} />}
              {issuing ? "発行中..." : "接続情報を発行する"}
            </button>
          ) : (
            <div className="space-y-2">
              <ValueBox label="Gateway URL (InpServerURL に入力)" value={GATEWAY_URL} />
              <ValueBox label="接続ID (ConnectionId)" value={connection?.id ?? ""} />
              {hasToken ? (
                <div className="rounded-lg p-3" style={{ background: "#0a1a0a", border: "1px solid rgba(0,255,136,0.2)" }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <AlertCircle size={12} className="text-yellow-400 flex-shrink-0" />
                    <p className="text-[9px] font-bold tracking-widest" style={{ color: "#fbbf24" }}>
                      CONNECTION TOKEN — 一度だけ表示されます。必ずコピーしてください
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-mono break-all" style={{ color: "#4ade80" }}>{token}</p>
                    <CopyButton value={token} label="Connection Token" />
                  </div>
                </div>
              ) : (
                <div className="rounded-lg px-4 py-3" style={{ background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.2)" }}>
                  <p className="text-xs" style={{ color: "#fbbf24" }}>
                    ⚠ Connection Tokenは発行時に一度だけ表示されます。紛失した場合は再発行してください。
                  </p>
                  <button onClick={issueToken} disabled={issuing}
                    className="flex items-center gap-1.5 mt-2 text-[11px] font-bold"
                    style={{ color: "#fbbf24" }}>
                    <RefreshCw size={11} /> Token を再発行する
                  </button>
                </div>
              )}
              {step === 3 && hasToken && (
                <button onClick={() => setStep(4)} className="mt-1 text-[11px] underline" style={{ color: "#475569" }}>
                  コピーした → 次へ
                </button>
              )}
            </div>
          )}
        </Step>

        {/* STEP 4: EAをチャートにアタッチ */}
        <Step num={4} title="EAをチャートにアタッチ" done={isOnline} active={step >= 4}>
          <div className="space-y-2 text-xs" style={{ color: "#94a3b8" }}>
            <p>① MT5でチャートを開く（EURUSDなど）</p>
            <p>② ナビゲーターから <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "#00e5ff" }}>AVL_FX_Bridge</span> をチャートにドラッグ</p>
            <p>③ EA設定画面が開いたら以下を入力：</p>
            <div className="ml-4 space-y-1.5 mt-2">
              <div className="flex gap-2">
                <span className="font-mono text-[10px] px-2 py-0.5 rounded flex-shrink-0" style={{ background: "rgba(0,229,255,0.08)", color: "#00e5ff" }}>InpServerURL</span>
                <span style={{ color: "#64748b" }}>↑ STEP 3 の Gateway URL</span>
              </div>
              <div className="flex gap-2">
                <span className="font-mono text-[10px] px-2 py-0.5 rounded flex-shrink-0" style={{ background: "rgba(0,229,255,0.08)", color: "#00e5ff" }}>InpServerSecret</span>
                <span style={{ color: "#64748b" }}>↑ STEP 3 の Connection Token</span>
              </div>
            </div>
            <p className="mt-2">④「自動売買を許可する」にチェックを入れて OK</p>
            <p>⑤ このページに戻ると「EA接続中」になります</p>
          </div>
          {!isOnline && step >= 4 && (
            <div className="flex items-center gap-2 mt-3">
              <div className="w-4 h-4 rounded-full border-2 border-gray-600 border-t-cyan-400 animate-spin" />
              <p className="text-[11px]" style={{ color: "#475569" }}>EA接続を待っています...</p>
            </div>
          )}
          {isOnline && (
            <div className="flex items-center gap-2 mt-3">
              <CheckCircle size={14} className="text-green-400" />
              <p className="text-xs font-bold" style={{ color: "#4ade80" }}>接続完了！MT5が AVL-FX に繋がっています</p>
            </div>
          )}
        </Step>
      </div>

      {/* 再発行セクション */}
      {hasConnection && !issuing && (
        <div className="rounded-xl px-5 py-4" style={{ background: "#0f1423", border: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-[9px] font-bold tracking-widest mb-2" style={{ color: "#475569" }}>TOKEN紛失・再接続</p>
          <p className="text-xs mb-3" style={{ color: "#64748b" }}>
            Connection Tokenを紛失した場合や、再接続が必要な場合は再発行できます。
            再発行すると以前のTokenは無効になります。
          </p>
          <button onClick={issueToken}
            className="flex items-center gap-1.5 text-xs font-bold transition-all hover:opacity-80"
            style={{ color: "#f87171" }}>
            <RefreshCw size={12} /> Token を再発行する
          </button>
        </div>
      )}
    </div>
  );
}
