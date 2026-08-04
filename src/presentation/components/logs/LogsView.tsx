"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAIOSStore } from "@/application/stores/aiOSStore";
import { Trash2, Download } from "lucide-react";

const TYPE_COLORS: Record<string, string> = {
  ok:     "text-green-400",
  warn:   "text-yellow-400",
  ai:     "text-purple-300",
  signal: "text-cyan-400",
  order:  "text-orange-400",
  info:   "text-gray-500",
};

const TYPE_LABELS: Record<string, string> = {
  ok: "OK", warn: "WARN", ai: "AI", signal: "SIGNAL", order: "ORDER", info: "INFO",
};

export function LogsView() {
  const { aiLogs, clearLogs } = useAIOSStore();
  const [filter, setFilter] = useState<string>("all");

  const filters = ["all", "signal", "order", "ai", "ok", "warn", "info"];
  const displayed = filter === "all" ? aiLogs : aiLogs.filter(l => l.type === filter);

  const handleDownload = () => {
    const content = displayed
      .map(l => `[${new Date(l.ts).toLocaleString("ja-JP")}] [${l.type.toUpperCase()}] ${l.text}`)
      .join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `avl_ai_logs_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">SYSTEM LOGS</span>
          <span className="text-[8px] text-gray-700 font-mono">· {aiLogs.length} entries</span>
        </div>

        {/* フィルター */}
        <div className="flex gap-1 flex-wrap">
          {filters.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-2 py-0.5 text-[7px] font-mono border transition-all",
                filter === f ? "border-cyan-600/50 text-cyan-400 bg-cyan-900/20" : "border-[#0d1520] text-gray-700 hover:text-gray-400"
              )}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex gap-1.5 ml-auto">
          <button onClick={handleDownload} className="text-gray-600 hover:text-gray-300" title="ダウンロード">
            <Download size={12} />
          </button>
          <button onClick={clearLogs} className="text-gray-600 hover:text-red-400" title="クリア">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* ログ一覧 */}
      <div className="flex-1 overflow-y-auto border border-[#0d1520] bg-[#060a12] p-2 font-mono">
        {displayed.length === 0 ? (
          <p className="text-[8px] text-gray-700 p-2">ログがありません</p>
        ) : (
          <div className="space-y-0.5">
            {[...displayed].reverse().map((log) => (
              <div key={log.id} className="flex items-start gap-2 hover:bg-[#0d1520]/50 px-1 py-0.5">
                <span className="text-[7px] text-gray-700 shrink-0 mt-0.5 w-20">
                  {new Date(log.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className={cn("text-[7px] shrink-0 w-12", TYPE_COLORS[log.type] ?? "text-gray-500")}>
                  [{TYPE_LABELS[log.type] ?? log.type}]
                </span>
                {log.symbol && (
                  <span className="text-[7px] text-cyan-600 shrink-0">{log.symbol}</span>
                )}
                <p className="text-[8px] text-gray-400 leading-snug">{log.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
