"use client";

import { useState, useEffect, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConnectionStore } from "@/application/stores/connectionStore";

interface LogEntry {
  id: number;
  level: "INFO" | "WARN" | "ERROR";
  msg: string;
  color?: string;
  time: string; // toLocaleTimeString の結果をクライアント側で格納
}

let nextId = 0;
function makeEntry(level: LogEntry["level"], msg: string, color?: string): LogEntry {
  return { id: nextId++, level, msg, color, time: new Date().toLocaleTimeString("ja-JP") };
}

export function BottomPanel() {
  const [height] = useState(160);
  const { status, connectedAt } = useConnectionStore();

  // ログエントリはクライアント側でのみ生成（SSR/hydration ミスマッチを回避）
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const prevStatusRef = useRef<string>("");

  useEffect(() => {
    // マウント時に起動ログを追加
    setLogs([makeEntry("INFO", "AVL FX v2 起動")]);
  }, []);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === prev) return;

    if (status === "connected" && connectedAt) {
      const t = new Date(connectedAt).toLocaleTimeString("ja-JP");
      setLogs((l) => [...l, makeEntry("INFO", `MT5 Gateway 接続済み — ${t}`, "text-green-400")]);
    } else if (status === "connecting") {
      setLogs((l) => [...l, makeEntry("INFO", "MT5 Gateway に接続中...", "text-yellow-400")]);
    } else if (status === "disconnected" || status === "error") {
      setLogs((l) => [...l, makeEntry("WARN", "MT5 Gateway 未接続")]);
    }
  }, [status, connectedAt]);

  return (
    <div
      className="shrink-0 border-t border-[#2a2d3a] bg-[#1a1d29]"
      style={{ height }}
    >
      <Tabs defaultValue="log" className="h-full flex flex-col">
        <TabsList className="shrink-0 h-8 bg-transparent border-b border-[#2a2d3a] rounded-none px-2 justify-start gap-1">
          {[
            { value: "log",     label: "ログ"       },
            { value: "orders",  label: "注文履歴"    },
            { value: "signals", label: "シグナル履歴" },
          ].map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-6 text-xs rounded data-[state=active]:bg-[#2a2d3a] data-[state=active]:text-white text-gray-400"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ログ */}
        <TabsContent value="log" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full px-3 py-2">
            <div className="text-xs text-gray-500 font-mono space-y-0.5">
              {logs.map((entry) => (
                <LogLine key={entry.id} {...entry} />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* 注文履歴 */}
        <TabsContent value="orders" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full px-3 py-2">
            <p className="text-xs text-gray-600">注文履歴はありません</p>
          </ScrollArea>
        </TabsContent>

        {/* シグナル履歴 */}
        <TabsContent value="signals" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full px-3 py-2">
            <p className="text-xs text-gray-600">シグナル履歴はありません</p>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LogLine({ level, msg, color, time }: LogEntry) {
  const levelColor = color ?? (level === "WARN" ? "text-yellow-400" : level === "ERROR" ? "text-red-400" : "text-blue-400");
  return (
    <p>
      <span className="text-gray-700">[{time}]</span>{" "}
      <span className={levelColor}>{level}</span>{" "}
      {msg}
    </p>
  );
}
