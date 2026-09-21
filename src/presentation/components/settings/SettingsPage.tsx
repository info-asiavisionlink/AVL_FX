"use client";

import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Copy, CheckCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";

// -----------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------
type MT5Account = {
  balance: number; equity: number; currency: string;
  freeMargin: number; marginLevel: number; leverage: number;
  broker: string;
};

type ConnectionStatus = {
  connected: boolean; online: boolean;
  connectionId: string | null;
  broker: string | null; serverName: string | null;
  mt5Login: number | null; accountType: string | null;
  tradingEnabled: boolean; emergencyStop: boolean;
  lastHeartbeatAt: string | null; ageSeconds: number | null;
};

// -----------------------------------------------------------------
// コピーボタン
// -----------------------------------------------------------------
function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={handle} style={{
      padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700,
      background: copied ? "rgba(22,163,74,0.1)" : "rgba(249,115,22,0.08)",
      color: copied ? "#16a34a" : "#f97316",
      border: `1px solid ${copied ? "rgba(22,163,74,0.25)" : "rgba(249,115,22,0.2)"}`,
      cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4,
    }}>
      {copied ? <CheckCircle size={10} /> : <Copy size={10} />}
      {copied ? "コピー済み" : "コピー"}
    </button>
  );
}

// -----------------------------------------------------------------
// 情報行
// -----------------------------------------------------------------
function InfoRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const display = secret && !show ? "●".repeat(Math.min(value.length, 20)) : value;
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0"
      style={{ borderColor: "rgba(0,0,0,0.06)" }}>
      <span className="text-[10px] font-bold w-32 shrink-0" style={{ color: "#9a9a9a" }}>{label}</span>
      <span className="text-xs font-mono flex-1 break-all mx-2" style={{ color: "#1a1a1a" }}>{display}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {secret && (
          <button onClick={() => setShow(s => !s)} style={{
            padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700,
            background: "rgba(0,0,0,0.04)", color: "#9a9a9a",
            border: "1px solid rgba(0,0,0,0.08)", cursor: "pointer",
          }}>
            {show ? <EyeOff size={10} /> : <Eye size={10} />}
          </button>
        )}
        <CopyBtn value={value} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// MT5 口座パネル（数値グリッド）
// -----------------------------------------------------------------
function AccountPanel({ account }: { account: MT5Account }) {
  const pnl = account.equity - account.balance;
  const pnlPct = account.balance > 0 ? (pnl / account.balance) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "BALANCE",      value: `${account.balance.toLocaleString()} ${account.currency}`, color: "#1a1a1a" },
          { label: "EQUITY",       value: `${account.equity.toLocaleString()} ${account.currency}`,  color: pnl >= 0 ? "#16a34a" : "#dc2626" },
          { label: "UNREALIZED P&L", value: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ${account.currency}`, color: pnl >= 0 ? "#16a34a" : "#dc2626" },
          { label: "FREE MARGIN",  value: `${account.freeMargin.toFixed(0)} ${account.currency}`,   color: "#4a4a4a" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl px-3 py-2.5"
            style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.06)" }}>
            <p className="text-[9px] font-bold mb-1" style={{ color: "#9a9a9a" }}>{label}</p>
            <p className="text-[11px] font-bold font-mono tabular-nums" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "MARGIN LEVEL", value: account.marginLevel > 0 ? `${account.marginLevel.toFixed(1)}%` : "—" },
          { label: "LEVERAGE",     value: `1:${account.leverage}` },
          { label: "CURRENCY",     value: account.currency },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl px-2 py-2 text-center"
            style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.06)" }}>
            <p className="text-[8px] font-bold mb-0.5" style={{ color: "#9a9a9a" }}>{label}</p>
            <p className="text-[10px] font-bold font-mono" style={{ color: "#1a1a1a" }}>{value}</p>
          </div>
        ))}
      </div>
      {/* Equity bar */}
      <div>
        <div className="flex justify-between text-[9px] font-bold mb-1">
          <span style={{ color: "#9a9a9a" }}>Equity vs Balance</span>
          <span style={{ color: pnl >= 0 ? "#16a34a" : "#dc2626" }}>
            {pnl >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.06)" }}>
          <div className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, Math.max(0, (account.equity / Math.max(1, account.balance)) * 100))}%`,
              background: pnl >= 0 ? "linear-gradient(90deg,rgba(249,115,22,0.4),#f97316)" : "linear-gradient(90deg,rgba(220,38,38,0.4),#dc2626)",
            }} />
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// メインコンポーネント
// -----------------------------------------------------------------
export function SettingsPage() {
  const [conn,    setConn]    = useState<ConnectionStatus | null>(null);
  const [account, setAccount] = useState<MT5Account | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [acctLoading, setAcctLoading] = useState(false);

  // 接続ステータスとユーザー情報を取得
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/live/connection/status");
      if (res.ok) {
        const data = await res.json() as ConnectionStatus;
        setConn(data);
      }
    } catch {}
    setLoading(false);
  }, []);

  // MT5 口座情報を取得
  const fetchAccount = useCallback(async () => {
    setAcctLoading(true);
    try {
      const res = await fetch("/api/live/connection/account");
      if (res.ok) {
        const data = await res.json() as { account?: MT5Account };
        if (data.account) setAccount(data.account);
      }
    } catch {}
    setAcctLoading(false);
  }, []);

  // ユーザーメールを Supabase から取得
  useEffect(() => {
    fetch("/api/user/profile").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.email) setUserEmail(d.email);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 15_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // オンライン時に口座情報を取得
  const isOnlineForEffect = conn?.online ?? false;
  useEffect(() => {
    if (isOnlineForEffect) fetchAccount();
    else setAccount(null);
  }, [isOnlineForEffect, fetchAccount]);

  const isOnline = conn?.online ?? false;

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: "#f8f7f4" }}>
      {/* ヘッダー */}
      <div className="flex items-center justify-between pl-14 pr-4 md:px-6 py-3 shrink-0"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.06)", background: "#fff" }}>
        <h1 className="text-sm font-black" style={{ color: "#1a1a1a" }}>設定</h1>
        <button onClick={() => { fetchStatus(); fetchAccount(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all hover:opacity-80"
          style={{ background: "rgba(249,115,22,0.08)", color: "#f97316", border: "1px solid rgba(249,115,22,0.2)" }}>
          <RefreshCw size={11} />
          更新
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-xl mx-auto space-y-5">

          {/* === MT5 リアルタイム口座情報 === */}
          <div className="rounded-2xl p-5 space-y-4"
            style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.06)", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>

            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#9a9a9a" }}>
                MT5 リアルタイム口座情報
              </p>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full"
                  style={{
                    background: isOnline ? "#22c55e" : "#9a9a9a",
                    boxShadow: isOnline ? "0 0 6px #22c55e" : "none",
                  }} />
                <span className="text-[10px] font-bold"
                  style={{ color: isOnline ? "#22c55e" : "#9a9a9a" }}>
                  {loading ? "確認中..." : isOnline ? "MT5 Live" : "オフライン"}
                </span>
                {isOnline && conn?.ageSeconds != null && (
                  <span className="text-[9px]" style={{ color: "#9a9a9a" }}>
                    ({conn.ageSeconds}秒前)
                  </span>
                )}
              </div>
            </div>

            {isOnline && account ? (
              <AccountPanel account={account} />
            ) : isOnline && acctLoading ? (
              <div className="flex items-center gap-2 py-6 justify-center">
                <RefreshCw size={14} className="animate-spin" style={{ color: "#9a9a9a" }} />
                <p className="text-xs" style={{ color: "#9a9a9a" }}>口座データ取得中...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-8">
                <WifiOff size={24} style={{ color: "#d0d0d0" }} />
                <p className="text-xs" style={{ color: "#9a9a9a" }}>
                  MT5 が接続されていません
                </p>
                <p className="text-[10px] text-center" style={{ color: "#d0d0d0" }}>
                  MT5 で AVL_FX_Bridge と AVL_ExecutionBridge を起動してください
                </p>
              </div>
            )}

            {isOnline && conn?.broker && (
              <div className="rounded-xl px-3 py-2"
                style={{ background: "rgba(249,115,22,0.04)", border: "1px solid rgba(249,115,22,0.12)" }}>
                <div className="flex justify-between text-[10px]">
                  <span style={{ color: "#9a9a9a" }}>Broker</span>
                  <span className="font-bold" style={{ color: "#1a1a1a" }}>{conn.broker}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1">
                  <span style={{ color: "#9a9a9a" }}>Login</span>
                  <span className="font-mono font-bold" style={{ color: "#1a1a1a" }}>{conn.mt5Login}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1">
                  <span style={{ color: "#9a9a9a" }}>取引許可</span>
                  <span className="font-bold" style={{ color: conn.tradingEnabled ? "#16a34a" : "#dc2626" }}>
                    {conn.tradingEnabled ? "有効" : "無効"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* === アカウント情報 === */}
          <div className="rounded-2xl p-5 space-y-1"
            style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.06)", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
            <p className="text-[10px] font-bold tracking-widest uppercase mb-3" style={{ color: "#9a9a9a" }}>
              アカウント情報
            </p>

            {userEmail && (
              <InfoRow label="ログインID（メール）" value={userEmail} />
            )}

            {conn?.connectionId && (
              <InfoRow label="Connection ID" value={conn.connectionId} />
            )}

            <div className="flex items-center justify-between py-2.5 border-b last:border-0"
              style={{ borderColor: "rgba(0,0,0,0.06)" }}>
              <span className="text-[10px] font-bold w-32 shrink-0" style={{ color: "#9a9a9a" }}>
                Connection Token
              </span>
              <span className="text-xs flex-1 mx-2" style={{ color: "#9a9a9a" }}>
                セキュリティのため非表示（コンソールで再発行可能）
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5"
              style={{ borderColor: "rgba(0,0,0,0.06)" }}>
              <span className="text-[10px] font-bold w-32 shrink-0" style={{ color: "#9a9a9a" }}>
                Gateway URL
              </span>
              <span className="text-[9px] font-mono flex-1 break-all mr-2" style={{ color: "#4a4a4a" }}>
                {process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "—"}
              </span>
            </div>
          </div>

          {/* === MT5 接続ステータス詳細 === */}
          {conn?.connected && (
            <div className="rounded-2xl p-5"
              style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.06)", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
              <p className="text-[10px] font-bold tracking-widest uppercase mb-3" style={{ color: "#9a9a9a" }}>
                接続ステータス
              </p>
              <div className="space-y-0">
                {[
                  { label: "Server",         value: conn.serverName ?? "—" },
                  { label: "Account Type",   value: conn.accountType ?? "—" },
                  { label: "Trading",        value: conn.tradingEnabled ? "✓ 有効" : "✗ 無効" },
                  { label: "Emergency Stop", value: conn.emergencyStop ? "⚠ 停止中" : "✓ 正常" },
                  { label: "最終 Heartbeat", value: conn.lastHeartbeatAt ? new Date(conn.lastHeartbeatAt).toLocaleString("ja-JP") : "—" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between py-2 border-b last:border-0 text-xs"
                    style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                    <span style={{ color: "#9a9a9a" }}>{label}</span>
                    <span className="font-bold" style={{ color: "#1a1a1a" }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
