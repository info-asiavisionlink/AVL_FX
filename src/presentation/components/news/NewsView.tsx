"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/application/stores/settingsStore";
import { RefreshCw, ExternalLink, Clock } from "lucide-react";

interface NewsItem {
  id:       string;
  title:    string;
  url:      string;
  excerpt:  string;
  source:   string;
  datetime: number;
  symbols:  string[];
}

const SYMBOLS = ["EUR/USD", "USD/JPY", "GBP/USD", "XAU/USD", "ALL"] as const;
type SymFilter = typeof SYMBOLS[number];

function timeAgo(unix: number): string {
  const secs = Math.floor(Date.now() / 1000) - unix;
  if (secs < 60)    return `${secs}秒前`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}分前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}時間前`;
  return `${Math.floor(secs / 86400)}日前`;
}

export function NewsView() {
  const [items,   setItems]   = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [symFilter, setSymFilter] = useState<SymFilter>("ALL");
  const { settings } = useSettingsStore();

  const load = useCallback(async (sym: SymFilter) => {
    setLoading(true);
    try {
      const key    = settings.twelveDataKey;
      const target = sym === "ALL" ? "EUR/USD" : sym;
      const url    = `/api/news?symbol=${encodeURIComponent(target)}&limit=20${key ? `&key=${key}` : ""}`;
      const res    = await fetch(url);
      if (res.ok) setItems(await res.json() as NewsItem[]);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [settings.twelveDataKey]);

  useEffect(() => { void load(symFilter); }, [load, symFilter]);

  // 自動更新 120秒
  useEffect(() => {
    const id = setInterval(() => load(symFilter), 120_000);
    return () => clearInterval(id);
  }, [load, symFilter]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">FX NEWS FEED</span>
        </div>

        {/* シンボルフィルター */}
        <div className="flex gap-1 flex-wrap">
          {SYMBOLS.map(s => (
            <button key={s}
              onClick={() => setSymFilter(s)}
              className={cn("px-2 py-0.5 text-[7px] font-mono border transition-all",
                symFilter === s
                  ? "border-cyan-600/50 text-cyan-400 bg-cyan-900/20"
                  : "border-[#0d1520] text-gray-600 hover:text-gray-400"
              )}>
              {s}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {!settings.twelveDataKey && (
            <span className="text-[7px] text-yellow-600/70 font-mono">DEMO DATA — Settings で API キーを設定</span>
          )}
          <button onClick={() => load(symFilter)} disabled={loading}
            className="text-gray-600 hover:text-gray-300">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* ニュースリスト */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {loading && items.length === 0 ? (
          <div className="border border-[#0d1520] bg-[#060a12] p-6 text-center">
            <p className="text-[9px] text-gray-600 font-mono">ニュース読み込み中...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="border border-[#0d1520] bg-[#060a12] p-6 text-center">
            <p className="text-[9px] text-gray-600 font-mono">ニュースがありません</p>
          </div>
        ) : (
          items.map(item => (
            <article key={item.id}
              className="border border-[#0d1520] bg-[#060a12] p-3 hover:border-cyan-800/40 transition-colors group">
              {/* メタ */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[7px] text-cyan-600/60 font-mono border border-cyan-900/30 px-1.5">
                  {item.source}
                </span>
                {item.symbols.length > 0 && item.symbols.map(s => (
                  <span key={s} className="text-[7px] text-gray-600 font-mono border border-[#0d1520] px-1">
                    {s}
                  </span>
                ))}
                <div className="ml-auto flex items-center gap-1 text-[7px] text-gray-700 font-mono">
                  <Clock size={7} />
                  {timeAgo(item.datetime)}
                </div>
              </div>

              {/* タイトル */}
              <h3 className="text-[10px] text-gray-200 font-mono leading-snug mb-1.5 group-hover:text-cyan-200 transition-colors">
                {item.title}
              </h3>

              {/* 本文抜粋 */}
              {item.excerpt && (
                <p className="text-[8px] text-gray-600 font-mono leading-relaxed line-clamp-2">
                  {item.excerpt}
                </p>
              )}

              {/* リンク */}
              {item.url && item.url !== "#" && (
                <div className="mt-2 flex justify-end">
                  <a href={item.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[7px] text-cyan-700 hover:text-cyan-400 font-mono transition-colors">
                    <ExternalLink size={8} /> READ MORE
                  </a>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
