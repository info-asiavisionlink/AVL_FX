"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { RefreshCw, ExternalLink, Clock, Rss } from "lucide-react";
import type { NewsItem } from "@/app/api/news/route";

// ── 定数 ──────────────────────────────────────────────────────────

const CURRENCIES = ["ALL", "USD", "EUR", "JPY", "GBP", "AUD", "CAD", "XAU"] as const;
type CcyFilter = typeof CURRENCIES[number];

const CCY_COLOR: Record<string, string> = {
  USD: "text-green-400 border-green-800/50 bg-green-900/15",
  EUR: "text-blue-400 border-blue-800/50 bg-blue-900/15",
  JPY: "text-red-400 border-red-800/50 bg-red-900/15",
  GBP: "text-yellow-400 border-yellow-800/50 bg-yellow-900/15",
  AUD: "text-cyan-400 border-cyan-800/50 bg-cyan-900/15",
  CAD: "text-orange-400 border-orange-800/50 bg-orange-900/15",
  XAU: "text-amber-400 border-amber-800/50 bg-amber-900/15",
};

// ── ユーティリティ ─────────────────────────────────────────────────

function timeAgo(unix: number): string {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60)    return `${s}秒前`;
  if (s < 3600)  return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

// ── NewsCard ──────────────────────────────────────────────────────

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <article className="border border-[#0d1520] bg-[#060a12] hover:border-cyan-900/50 hover:bg-[#080d15] transition-all group">
      <div className="p-3">
        {/* メタ行: ソース・タグ・時刻 */}
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className="text-[7px] font-mono font-bold text-cyan-600/70 border border-cyan-900/40 px-1.5 py-0.5 shrink-0">
            {item.source}
          </span>
          {item.tags.slice(0, 3).map(tag => (
            <span key={tag} className={cn(
              "text-[7px] font-mono font-bold px-1.5 py-0.5 border shrink-0",
              CCY_COLOR[tag] ?? "text-gray-500 border-gray-800/50"
            )}>
              {tag}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-1 text-[7px] text-gray-700 font-mono shrink-0">
            <Clock size={7}/>
            <span>{timeAgo(item.datetime)}</span>
          </div>
        </div>

        {/* タイトル */}
        <h3 className="text-[11px] font-semibold text-gray-200 leading-snug mb-1.5 group-hover:text-cyan-100 transition-colors line-clamp-2">
          {item.title}
        </h3>

        {/* 本文抜粋 */}
        {item.excerpt && (
          <p className="text-[8px] text-gray-600 leading-relaxed line-clamp-2 mb-2">
            {item.excerpt}
          </p>
        )}

        {/* リンク */}
        {item.url && (
          <div className="flex justify-end">
            <a href={item.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[7px] font-mono text-cyan-800 hover:text-cyan-400 transition-colors">
              <ExternalLink size={8}/> READ MORE
            </a>
          </div>
        )}
      </div>
    </article>
  );
}

// ── NewsView ──────────────────────────────────────────────────────

export function NewsView() {
  const [items,    setItems]    = useState<NewsItem[]>([]);
  const [ccy,      setCcy]      = useState<CcyFilter>("ALL");
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const load = useCallback(async (currency: CcyFilter) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/news?currency=${currency}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { items: NewsItem[]; source: string; fetchedAt?: string; error?: string };
      if (d.error) setError(d.error);
      setItems(d.items ?? []);
      setFetchedAt(d.fetchedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(ccy); }, [load, ccy]);

  // 5分ごとに自動更新
  useEffect(() => {
    const id = setInterval(() => load(ccy), 5 * 60_000);
    return () => clearInterval(id);
  }, [load, ccy]);

  return (
    <div className="flex flex-col h-full bg-[#04060d] overflow-hidden">

      {/* ── ヘッダー ── */}
      <div className="shrink-0 border-b border-[#0d1520] bg-[#03050b] px-4 py-3">
        <div className="flex items-center gap-3 mb-3">
          <Rss size={14} className="text-cyan-500/70"/>
          <div>
            <p className="text-[8px] font-mono text-cyan-500/50 tracking-[0.3em] leading-none">AVL AI</p>
            <p className="text-[13px] font-black font-mono tracking-wider text-cyan-300 leading-none">
              FX NEWS FEED
            </p>
          </div>
          <div className="flex-1"/>
          <button onClick={() => load(ccy)} disabled={loading}
            className="text-gray-600 hover:text-gray-300 p-1 transition-colors">
            <RefreshCw size={11} className={loading ? "animate-spin" : ""}/>
          </button>
        </div>

        {/* 通貨フィルター */}
        <div className="flex gap-1 flex-wrap">
          {CURRENCIES.map(c => (
            <button key={c} onClick={() => setCcy(c)}
              className={cn(
                "text-[8px] font-mono font-bold px-2 py-0.5 border transition-all",
                ccy === c
                  ? c === "ALL"
                    ? "border-gray-600 text-gray-200 bg-gray-800/30"
                    : (CCY_COLOR[c] ?? "border-cyan-700/60 text-cyan-400 bg-cyan-900/20")
                  : "border-[#0d1520] text-gray-700 hover:text-gray-500"
              )}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ── ステータスバー ── */}
      <div className="shrink-0 px-4 py-1 border-b border-[#0d1520] bg-[#03050b] flex items-center gap-2">
        <span className="text-[8px] font-mono text-gray-700">
          📡 Yahoo Finance RSS
        </span>
        {fetchedAt && !error && (
          <span className="text-[8px] font-mono text-gray-800">
            · {new Date(fetchedAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} JST
          </span>
        )}
        {error && (
          <span className="text-[8px] font-mono text-red-600/70">⚠ {error}</span>
        )}
        {!loading && items.length > 0 && (
          <span className="ml-auto text-[8px] font-mono text-gray-800">{items.length}件</span>
        )}
      </div>

      {/* ── ニュースリスト ── */}
      <div className="flex-1 overflow-y-auto avl-scroll px-3 py-2 space-y-1.5">
        {loading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-gray-700">
            <RefreshCw size={12} className="animate-spin"/>
            <span className="text-[9px] font-mono">取得中...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Rss size={18} className="text-gray-800"/>
            <p className="text-[9px] font-mono text-gray-700">
              {error ? "ニュースを取得できません" : `${ccy} 関連のニュースなし`}
            </p>
          </div>
        ) : (
          items.map(item => <NewsCard key={item.id} item={item}/>)
        )}
      </div>
    </div>
  );
}
