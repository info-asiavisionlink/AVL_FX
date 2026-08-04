"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Wifi, WifiOff, Loader2, RefreshCw, Cable } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { ConnectionManager } from "@/infrastructure/connection/ConnectionManager";
import type { MT5GatewayConfig } from "@/infrastructure/connection/types";
import type { GatewayHealthResponse } from "@/infrastructure/connection/types";

// --------------------------------------------------
// 接続状態設定
// --------------------------------------------------
const STATUS_CONFIG = {
  disconnected: { label: "未接続",    dot: "bg-gray-500",                   text: "text-gray-400",  badge: "border-gray-600 text-gray-500"   },
  connecting:   { label: "接続中...", dot: "bg-yellow-400 animate-pulse",   text: "text-yellow-400",badge: "border-yellow-600 text-yellow-400" },
  connected:    { label: "接続済み",  dot: "bg-green-400",                  text: "text-green-400", badge: "border-green-600 text-green-400"  },
  error:        { label: "エラー",    dot: "bg-red-500",                    text: "text-red-400",   badge: "border-red-700 text-red-400"     },
} as const;

const DEFAULT_CONFIG: Omit<MT5GatewayConfig, "id" | "name" | "type"> = {
  gatewayUrl:  "http://localhost:8080",
  wsUrl:       "ws://localhost:8080",
  secret:      "",
  autoConnect: true,
};

// --------------------------------------------------
// MT5ConnectionPage
// --------------------------------------------------
export function MT5ConnectionPage() {
  const { config, status, error, connectedAt, connect, disconnect } = useConnectionStore();

  // フォーム状態（localStorage の値を初期値として使用）
  const [gatewayUrl,  setGatewayUrl]  = useState(config?.gatewayUrl  ?? DEFAULT_CONFIG.gatewayUrl);
  const [wsUrl,       setWsUrl]       = useState(config?.wsUrl       ?? DEFAULT_CONFIG.wsUrl);

  // Gateway URL から WebSocket URL を自動導出するヘルパー
  const deriveWsUrl = (httpUrl: string) =>
    httpUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

  const handleGatewayUrlChange = (val: string) => {
    setGatewayUrl(val);
    setWsUrl(deriveWsUrl(val));
  };
  const [secret,      setSecret]      = useState(config?.secret      ?? DEFAULT_CONFIG.secret);
  const [autoConnect, setAutoConnect] = useState(config?.autoConnect ?? DEFAULT_CONFIG.autoConnect);
  const [showSecret,  setShowSecret]  = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [health,      setHealth]      = useState<GatewayHealthResponse | null>(null);

  // 接続済みの場合は Gateway 情報を取得
  useEffect(() => {
    if (status !== "connected") { setHealth(null); return; }
    const client = ConnectionManager.instance.client;
    if (!client) return;
    client.getHealth().then(setHealth);
  }, [status]);

  // config が外部（localStorage）から変わったらフォームを同期
  useEffect(() => {
    if (!config) return;
    setGatewayUrl(config.gatewayUrl);
    setWsUrl(config.wsUrl);
    setSecret(config.secret);
    setAutoConnect(config.autoConnect);
  }, [config]);

  // --------------------------------------------------
  // 接続処理
  // --------------------------------------------------
  const handleConnect = async () => {
    if (!gatewayUrl || !wsUrl) {
      toast.error("Gateway URL と WebSocket URL を入力してください。");
      return;
    }

    setLoading(true);
    const cfg: MT5GatewayConfig = {
      id: "mt5_main",
      name: "MT5 Gateway",
      type: "mt5_gateway",
      gatewayUrl: gatewayUrl.replace(/\/$/, ""),
      wsUrl:      wsUrl.replace(/\/$/, ""),
      secret,
      autoConnect,
    };

    const result = await connect(cfg);
    setLoading(false);

    if (result.success) {
      toast.success("MT5 Gateway へ正常に接続しました。", {
        description: `${cfg.gatewayUrl}`,
        duration: 4000,
      });
    } else {
      toast.error("Gateway へ接続できません。", {
        description: result.error ?? "接続先を確認してください。",
        duration: 6000,
      });
    }
  };

  // --------------------------------------------------
  // 切断処理
  // --------------------------------------------------
  const handleDisconnect = () => {
    disconnect();
    toast.info("MT5 Gateway から切断しました。");
  };

  const cfg = STATUS_CONFIG[status];
  const isConnected   = status === "connected";
  const isConnecting  = status === "connecting" || loading;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0f1117] p-6">
      <div className="max-w-2xl mx-auto space-y-4">

        {/* ページタイトル */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-lg bg-blue-600/20 border border-blue-600/30 flex items-center justify-center">
            <Cable size={18} className="text-blue-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">MT5 接続設定</h1>
            <p className="text-xs text-gray-500">MetaTrader5 Gateway との接続を管理します</p>
          </div>
        </div>

        {/* ① 接続状態カード */}
        <Card className="bg-[#1a1d29] border-[#2a2d3a]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-300">接続状態</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className={cn("w-2.5 h-2.5 rounded-full", cfg.dot)} />
                <span className={cn("text-sm font-medium", cfg.text)}>{cfg.label}</span>
              </div>
              <Badge variant="outline" className={cn("text-xs", cfg.badge)}>
                {status === "connected" ? <Wifi size={10} className="mr-1" /> : <WifiOff size={10} className="mr-1" />}
                {cfg.label}
              </Badge>
            </div>

            {/* エラーメッセージ */}
            {status === "error" && error && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded p-2 whitespace-pre-line">
                {error}
              </p>
            )}

            {/* 接続時刻 */}
            {isConnected && connectedAt && (
              <p className="text-xs text-gray-600">
                接続確立: {new Date(connectedAt).toLocaleTimeString("ja-JP")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ② 接続設定フォームカード */}
        <Card className="bg-[#1a1d29] border-[#2a2d3a]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-300">接続設定</CardTitle>
            <CardDescription className="text-xs text-gray-600">
              設定は自動的にブラウザへ保存されます
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Gateway URL */}
            <div className="space-y-1.5">
              <Label className="text-xs text-gray-400">Gateway URL</Label>
              <Input
                value={gatewayUrl}
                onChange={(e) => handleGatewayUrlChange(e.target.value)}
                placeholder="http://localhost:8080"
                disabled={isConnected || isConnecting}
                className="bg-[#0f1117] border-[#2a2d3a] text-gray-200 text-sm font-mono h-9 focus:border-blue-600 disabled:opacity-50"
              />
              <p className="text-[10px] text-gray-600">EA からのデータ受信 / REST API エンドポイント</p>
            </div>

            {/* WebSocket URL */}
            <div className="space-y-1.5">
              <Label className="text-xs text-gray-400">WebSocket URL</Label>
              <Input
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
                placeholder="ws://localhost:8080"
                disabled={isConnected || isConnecting}
                className="bg-[#0f1117] border-[#2a2d3a] text-gray-200 text-sm font-mono h-9 focus:border-blue-600 disabled:opacity-50"
              />
              <p className="text-[10px] text-gray-600">リアルタイム価格配信用 WebSocket（Gateway URL から自動設定）</p>
            </div>

            {/* 認証キー */}
            <div className="space-y-1.5">
              <Label className="text-xs text-gray-400">認証キー</Label>
              <div className="relative">
                <Input
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="MT5_GATEWAY_SECRET"
                  disabled={isConnected || isConnecting}
                  className="bg-[#0f1117] border-[#2a2d3a] text-gray-200 text-sm font-mono h-9 pr-10 focus:border-blue-600 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <p className="text-[10px] text-gray-600">Gateway の .env の MT5_GATEWAY_SECRET と合わせる（空欄可）</p>
            </div>

            {/* 自動接続 */}
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs text-gray-300">起動時に自動接続</p>
                <p className="text-[10px] text-gray-600">ブラウザを開くたびに自動的に接続します</p>
              </div>
              <Switch
                checked={autoConnect}
                onCheckedChange={setAutoConnect}
                disabled={isConnecting}
                className="data-[state=checked]:bg-blue-600"
              />
            </div>
          </CardContent>
        </Card>

        {/* ③ 操作ボタン */}
        <div className="flex gap-3">
          {!isConnected ? (
            <Button
              onClick={handleConnect}
              disabled={isConnecting || !gatewayUrl || !wsUrl}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-10 gap-2 disabled:opacity-50"
            >
              {isConnecting
                ? <><Loader2 size={15} className="animate-spin" />接続中...</>
                : <><Wifi size={15} />接続する</>
              }
            </Button>
          ) : (
            <>
              <Button
                onClick={handleDisconnect}
                variant="outline"
                className="flex-1 border-[#2a2d3a] text-gray-300 hover:bg-[#2a2d3a] hover:text-white h-10 gap-2"
              >
                <WifiOff size={15} />切断
              </Button>
              <Button
                onClick={async () => {
                  const client = ConnectionManager.instance.client;
                  if (!client) return;
                  const h = await client.getHealth();
                  setHealth(h);
                  toast.info("Gateway 情報を更新しました。");
                }}
                variant="outline"
                size="icon"
                className="border-[#2a2d3a] text-gray-400 hover:bg-[#2a2d3a] h-10 w-10"
              >
                <RefreshCw size={14} />
              </Button>
            </>
          )}
        </div>

        {/* ④ Gateway 情報（接続済み時のみ表示）*/}
        {isConnected && health && (
          <Card className="bg-[#1a1d29] border-[#2a2d3a]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">Gateway 情報</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1.5">
                <InfoRow label="ステータス"       value={health.status === "ok" ? "正常稼働" : "異常"} valueClass={health.status === "ok" ? "text-green-400" : "text-red-400"} />
                <InfoRow label="EA 接続"         value={health.ea ? `${health.ea.symbol} / アカウント: ${health.ea.account}` : "EA 未接続"} valueClass={health.ea ? "text-gray-200" : "text-gray-500"} />
                <InfoRow label="配信シンボル"     value={health.symbols.length > 0 ? health.symbols.join(", ") : "なし"} />
                <InfoRow label="接続クライアント" value={`${health.clients} 件`} />
                <InfoRow label="稼働時間"         value={formatUptime(health.uptime)} />
                <InfoRow label="メモリ使用"       value={health.memory} />
              </dl>
            </CardContent>
          </Card>
        )}

        {/* ⑤ 設定手順（未接続時のみ表示）*/}
        {!isConnected && (
          <Card className="bg-[#1a1d29] border-[#2a2d3a]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">接続手順</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-xs text-gray-500">
                <li className="flex gap-2"><span className="text-blue-500 font-bold shrink-0">1.</span>Gateway を起動: <code className="text-gray-400 bg-[#0f1117] px-1 rounded">npm run gateway:dev</code></li>
                <li className="flex gap-2"><span className="text-blue-500 font-bold shrink-0">2.</span>MT5 で EA（AVL_FX_Bridge.mq5）をチャートにアタッチ</li>
                <li className="flex gap-2"><span className="text-blue-500 font-bold shrink-0">3.</span>MT5 → ツール → オプション → EA → WebRequest 許可リストに Gateway URL を追加</li>
                <li className="flex gap-2"><span className="text-blue-500 font-bold shrink-0">4.</span>上の「接続する」ボタンをクリック</li>
              </ol>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------
// サブコンポーネント
// --------------------------------------------------
function InfoRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <dt className="text-gray-500 shrink-0">{label}</dt>
      <dd className={cn("text-gray-300 text-right font-mono", valueClass)}>{value}</dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60)   return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`;
  return `${Math.floor(seconds / 3600)} 時間 ${Math.floor((seconds % 3600) / 60)} 分`;
}
