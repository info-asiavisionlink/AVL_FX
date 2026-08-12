"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { RefreshCw, ExternalLink, Clock, Rss, X, ChevronRight } from "lucide-react";
import type { NewsItem } from "@/app/api/news/route";

// ── 定数 ──────────────────────────────────────────────────────────

const CURRENCIES = ["ALL", "USD", "EUR", "JPY", "GBP", "AUD", "CAD", "XAU"] as const;
type CcyFilter = typeof CURRENCIES[number];

const CCY_STYLE: Record<string, string> = {
  USD: "text-green-400 border-green-800/50 bg-green-900/15",
  EUR: "text-blue-400 border-blue-800/50 bg-blue-900/15",
  JPY: "text-red-400 border-red-800/50 bg-red-900/15",
  GBP: "text-yellow-400 border-yellow-800/50 bg-yellow-900/15",
  AUD: "text-cyan-400 border-cyan-800/50 bg-cyan-900/15",
  CAD: "text-orange-400 border-orange-800/50 bg-orange-900/15",
  XAU: "text-amber-400 border-amber-800/50 bg-amber-900/15",
};

// ── ユーティリティ ────────────────────────────────────────────────

function timeAgo(unix: number): string {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60)    return `${s}秒前`;
  if (s < 3600)  return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

function fmtDateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── ArticleModal ──────────────────────────────────────────────────

function ArticleModal({ item, onClose }: { item: NewsItem; onClose: () => void }) {
  return (
    <>
      {/* オーバーレイ */}
      <div
        className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* パネル */}
      <div className="fixed right-0 top-0 bottom-0 w-[480px] max-w-full z-50 bg-[#03060e] border-l border-[#1a2535] flex flex-col shadow-2xl">

        {/* ヘッダー */}
        <div className="shrink-0 border-b border-[#1a2535] px-5 py-4 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[8px] font-mono text-cyan-600/70 border border-cyan-900/40 px-1.5 py-0.5">
                {item.source}
              </span>
              {item.tags.slice(0, 4).map(t => (
                <span key={t} className={cn(
                  "text-[7px] font-mono font-bold px-1.5 py-0.5 border",
                  CCY_STYLE[t] ?? "text-gray-500 border-gray-800/40"
                )}>{t}</span>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[8px] font-mono text-gray-700">
              <Clock size={8}/>
              <span>{fmtDateTime(item.datetime)} JST</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 shrink-0 p-1 transition-colors">
            <X size={16}/>
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-y-auto avl-scroll px-5 py-5">
          {/* 日本語タイトル */}
          <h2 className="text-[16px] font-bold text-white leading-snug mb-2">
            {item.titleJa}
          </h2>
          {/* 英語タイトル */}
          <p className="text-[10px] text-gray-600 font-mono leading-snug mb-5 pb-4 border-b border-[#1a2535]">
            {item.title}
          </p>

          {/* 抜粋 */}
          {item.excerpt ? (
            <>
              <p className="text-[8px] font-mono text-cyan-600/60 tracking-widest mb-2">EXCERPT</p>
              <p className="text-[13px] text-gray-300 leading-relaxed">
                {item.excerpt}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-gray-600 font-mono">抜粋なし</p>
          )}
        </div>

        {/* フッター：元記事リンク */}
        <div className="shrink-0 border-t border-[#1a2535] px-5 py-4">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 border border-cyan-800/50 text-cyan-400 hover:bg-cyan-900/20 transition-colors text-[11px] font-mono font-bold tracking-widest"
          >
            <ExternalLink size={12}/>
            元記事を読む（Yahoo Finance）
          </a>
        </div>
      </div>
    </>
  );
}

// ── NewsCard ──────────────────────────────────────────────────────

function NewsCard({ item, onClick }: { item: NewsItem; onClick: () => void }) {
  return (
    <article
      onClick={onClick}
      className="border border-[#0d1520] bg-[#060a12] hover:border-cyan-900/60 hover:bg-[#08101a] transition-all group cursor-pointer"
    >
      <div className="p-3">
        {/* メタ行 */}
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className="text-[7px] font-mono text-cyan-600/60 border border-cyan-900/30 px-1.5 py-0.5 shrink-0">
            {item.source}
          </span>
          {item.tags.slice(0, 3).map(t => (
            <span key={t} className={cn(
              "text-[7px] font-mono font-bold px-1.5 py-0.5 border shrink-0",
              CCY_STYLE[t] ?? "text-gray-500 border-gray-800/40"
            )}>{t}</span>
          ))}
          <div className="ml-auto flex items-center gap-1 text-[7px] text-gray-700 font-mono shrink-0">
            <Clock size={7}/>
            <span>{timeAgo(item.datetime)}</span>
          </div>
        </div>

        {/* 日本語タイトル（主） */}
        <h3 className="text-[11px] font-semibold text-gray-100 leading-snug mb-1 group-hover:text-cyan-100 transition-colors line-clamp-2">
          {item.titleJa}
        </h3>

        {/* 英語タイトル（副） */}
        <p className="text-[8px] text-gray-600 font-mono leading-snug line-clamp-1 mb-2">
          {item.title}
        </p>

        {/* 続きを読む */}
        <div className="flex items-center justify-end gap-1 text-[7px] font-mono text-gray-700 group-hover:text-cyan-700 transition-colors">
          <span>続きを読む</span>
          <ChevronRight size={9}/>
        </div>
      </div>
    </article>
  );
}

// ── NewsView ──────────────────────────────────────────────────────

export function NewsView() {
  const [items,     setItems]     = useState<NewsItem[]>([]);
  const [ccy,       setCcy]       = useState<CcyFilter>("ALL");
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [selected,  setSelected]  = useState<NewsItem | null>(null);

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

  useEffect(() => {
    const id = setInterval(() => load(ccy), 15 * 60_000);
    return () => clearInterval(id);
  }, [load, ccy]);

  // ESCでモーダルを閉じる
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
                    : (CCY_STYLE[c] ?? "border-cyan-700/60 text-cyan-400 bg-cyan-900/20")
                  : "border-[#0d1520] text-gray-700 hover:text-gray-500"
              )}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ── ステータスバー ── */}
      <div className="shrink-0 px-4 py-1 border-b border-[#0d1520] bg-[#03050b] flex items-center gap-2">
        <span className="text-[8px] font-mono text-gray-700">📡 Yahoo Finance RSS</span>
        {fetchedAt && !error && (
          <span className="text-[8px] font-mono text-gray-800">
            · {new Date(fetchedAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} JST
          </span>
        )}
        {error && <span className="text-[8px] font-mono text-red-600/70">⚠ {error}</span>}
        {!loading && items.length > 0 && (
          <span className="ml-auto text-[8px] font-mono text-gray-800">{items.length}件</span>
        )}
      </div>

      {/* ── ニュースリスト ── */}
      <div className="flex-1 overflow-y-auto avl-scroll px-3 py-2 space-y-1.5">
        {loading ? (
          <div className="flex items-center justify-center h-32 gap-2 text-gray-700">
            <RefreshCw size={12} className="animate-spin"/>
            <span className="text-[9px] font-mono">取得・翻訳中...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Rss size={18} className="text-gray-800"/>
            <p className="text-[9px] font-mono text-gray-700">
              {error ? "ニュースを取得できません" : `${ccy} 関連のニュースなし`}
            </p>
          </div>
        ) : (
          items.map(item => (
            <NewsCard key={item.id} item={item} onClick={() => setSelected(item)}/>
          ))
        )}
      </div>

      {/* ── 記事モーダル ── */}
      {selected && (
        <ArticleModal item={selected} onClose={() => setSelected(null)}/>
      )}
    </div>
  );
}
