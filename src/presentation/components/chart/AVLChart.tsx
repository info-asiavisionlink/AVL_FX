"use client";

// =================================================================
// AVLChart v3.1 — MT5 直結チャート
// =================================================================
//
// 設計原則
//   EAから送られたOHLC・時刻をそのままLightweight Chartsに渡す。
//   このコンポーネントでOHLC生成・時刻補正・価格計算は行わない。
//
// データフロー
//   ① WebSocket onBar を先に購読（バーを取りこぼさない）
//   ② GET /bars で過去バーを取得 → series.setData()
//   ③ ① で受け取った差分バーを series.update()
//
// 時刻について
//   EAが送る rates[0].time は秒単位。
//   念のため ms（13桁）で届いた場合も秒に正規化する。
// =================================================================

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import { usePriceStore }      from "@/application/stores/priceStore";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";
import type { Timeframe }     from "@/types";
import { Loader2 }            from "lucide-react";

// -----------------------------------------------------------------
// 時間足 → MT5 文字列
// -----------------------------------------------------------------
const TF_TO_MT5: Record<Timeframe, string> = {
  M1: "M1", M5: "M5", M15: "M15", M30: "M30",
  H1: "H1", H4: "H4", D1: "D1",  W1: "W1", MN: "MN",
};

// -----------------------------------------------------------------
// チャートテーマ
// -----------------------------------------------------------------
const CHART_THEME = {
  layout: {
    background: { type: ColorType.Solid, color: "#131722" },
    textColor: "#9ca3af",
    fontFamily: "monospace",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: "#1a1d2e" },
    horzLines: { color: "#1a1d2e" },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: "#4a4d5a", labelBackgroundColor: "#2a2d3a" },
    horzLine: { color: "#4a4d5a", labelBackgroundColor: "#2a2d3a" },
  },
  rightPriceScale: { borderColor: "#2a2d3a" },
  timeScale: { borderColor: "#2a2d3a", timeVisible: true, secondsVisible: false },
} as const;

const CANDLE_STYLE = {
  upColor:         "#26a69a",
  downColor:       "#ef5350",
  borderUpColor:   "#26a69a",
  borderDownColor: "#ef5350",
  wickUpColor:     "#26a69a",
  wickDownColor:   "#ef5350",
} as const;

const BAR_COUNT = 500;

/**
 * 時刻を秒に正規化する。
 * EAは rates[0].time（秒）を送るが、旧EA等でmsが来た場合も対応。
 */
function toSec(t: number): number {
  return t > 1_000_000_000_000 ? Math.floor(t / 1000) : t;
}

// -----------------------------------------------------------------
// AVLChart
// -----------------------------------------------------------------

export function AVLChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // チャートに描画済みの最終バー時刻（秒）
  const lastTimeRef  = useRef<number>(0);
  const unsubBarRef  = useRef<(() => void) | null>(null);
  // 初期ロード中にWebSocketで届いたバーのバッファ
  const pendingRef   = useRef<CandlestickData[]>([]);
  const loadingRef   = useRef(false);

  const [ohlc,    setOhlc]    = useState<{ o: number; h: number; l: number; c: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [noData,  setNoData]  = useState(false);

  const { activeSymbol, activeTimeframe } = usePriceStore();
  const { status }                        = useConnectionStore();

  // ---------------------------------------------------------------
  // チャート初期化 — ResizeObserver で確定サイズが取得できてから生成
  // ---------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let chart: IChartApi | null = null;
    let series: ISeriesApi<"Candlestick"> | null = null;

    const initChart = (w: number, h: number) => {
      if (chart || w === 0 || h === 0) return; // 既に初期化済み or サイズ未確定
      chart  = createChart(el, { ...CHART_THEME, width: w, height: h });
      series = chart.addSeries(CandlestickSeries, CANDLE_STYLE);

      chart.subscribeCrosshairMove((param) => {
        if (!param.seriesData.size) { setOhlc(null); return; }
        const d = param.seriesData.get(series!) as CandlestickData | undefined;
        if (d) setOhlc({ o: d.open, h: d.high, l: d.low, c: d.close });
      });

      chartRef.current  = chart;
      seriesRef.current = series;
    };

    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (!chart) {
        initChart(width, height);
      } else {
        chart.applyOptions({ width, height });
      }
    });
    obs.observe(el);

    // 既にサイズがある場合は即時初期化
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      initChart(rect.width, rect.height);
    }

    return () => {
      obs.disconnect();
      if (chart) {
        chart.remove();
        chartRef.current  = null;
        seriesRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------
  // データロード
  // ---------------------------------------------------------------
  const loadChart = useCallback(async () => {
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series || !chart) return;

    // 前回の購読・状態をリセット
    if (unsubBarRef.current) { unsubBarRef.current(); unsubBarRef.current = null; }
    lastTimeRef.current  = 0;
    pendingRef.current   = [];
    loadingRef.current   = false;
    setNoData(false);

    if (status !== "connected") {
      series.setData([]);
      return;
    }

    const client = ConnectionManager.instance.client;
    if (!client) return;

    const tf = TF_TO_MT5[activeTimeframe] ?? "H1";

    // -------------------------------------------------------
    // ① WebSocket 購読を先に開始
    //    → getBars 中にバーが届いても取りこぼさない
    // -------------------------------------------------------
    unsubBarRef.current = client.onBar(activeSymbol, tf, (bar) => {
      const s    = seriesRef.current;
      if (!s) return;

      const t = toSec(bar.time);
      const candle: CandlestickData = {
        time:  t as Time,
        open:  bar.open,
        high:  bar.high,
        low:   bar.low,
        close: bar.close,
      };

      if (loadingRef.current) {
        // 初期ロード中 → バッファに積む
        pendingRef.current.push(candle);
        return;
      }

      if (lastTimeRef.current === 0) {
        // 初期データなし → このバーでチャートを開始
        s.setData([candle]);
        lastTimeRef.current = t;
        setNoData(false);
        chart.timeScale().fitContent();
        return;
      }

      // 逆行スキップ
      if (t < lastTimeRef.current) return;

      s.update(candle);
      lastTimeRef.current = Math.max(lastTimeRef.current, t);
    });

    // -------------------------------------------------------
    // ② 過去バーを REST で取得（Vercel プロキシ経由でCORSを回避）
    // -------------------------------------------------------
    loadingRef.current = true;
    setLoading(true);

    let bars: Awaited<ReturnType<typeof client.getBars>> = [];
    try {
      const p = new URLSearchParams({ symbol: activeSymbol, tf, count: String(BAR_COUNT) });
      const res = await fetch(`/api/mt5/bars/simple?${p}`, {
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) bars = await res.json();
    } catch { bars = []; }

    loadingRef.current = false;
    setLoading(false);

    if (bars.length > 0) {
      // EAから受け取ったOHLCをそのまま渡す（加工禁止）
      const lwBars: CandlestickData[] = bars.map((b) => ({
        time:  toSec(b.time) as Time,
        open:  b.open,
        high:  b.high,
        low:   b.low,
        close: b.close,
      }));

      series.setData(lwBars);
      lastTimeRef.current = toSec(bars[bars.length - 1].time);
      chart.timeScale().fitContent();
      setNoData(false);

      // ③ 初期ロード中にバッファに溜まったバーを反映
      for (const candle of pendingRef.current) {
        const t = candle.time as number;
        if (t >= lastTimeRef.current) {
          series.update(candle);
          lastTimeRef.current = Math.max(lastTimeRef.current, t);
        }
      }
    } else {
      // 過去バーなし → WebSocket バーを待つ（購読は ① で設定済み）
      setNoData(true);
    }

    pendingRef.current = [];
  }, [activeSymbol, activeTimeframe, status]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => { loadChart().catch(console.error); });
    return () => {
      cancelAnimationFrame(raf);
      if (unsubBarRef.current) { unsubBarRef.current(); unsubBarRef.current = null; }
    };
  }, [loadChart]);

  // ---------------------------------------------------------------
  // レンダリング
  // ---------------------------------------------------------------
  const isLive = status === "connected";

  return (
    <div className="relative w-full h-full bg-[#131722]">
      {ohlc && <OHLCLegend symbol={activeSymbol} timeframe={activeTimeframe} ohlc={ohlc} />}

      <div ref={containerRef} className="w-full h-full" />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#131722]/60 pointer-events-none">
          <Loader2 size={24} className="text-blue-500 animate-spin" />
        </div>
      )}

      {isLive && !loading && noData && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <Loader2 size={20} className="text-blue-500/50 animate-spin" />
          <p className="text-xs text-gray-600">MT5 EA からのデータを待っています...</p>
          <p className="text-[10px] text-gray-700">AVL_FX_Bridge.mq5 をチャートにアタッチしてください</p>
        </div>
      )}

      <div className={`absolute bottom-2 right-3 text-[10px] font-mono pointer-events-none select-none ${isLive ? "text-green-700" : "text-gray-700"}`}>
        {isLive ? "MT5 Live" : "切断中"}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// OHLC 凡例
// -----------------------------------------------------------------
function OHLCLegend({
  symbol, timeframe, ohlc,
}: {
  symbol: string;
  timeframe: Timeframe;
  ohlc: { o: number; h: number; l: number; c: number };
}) {
  const f    = (v: number) => v.toFixed(5);
  const isUp = ohlc.c >= ohlc.o;

  return (
    <div className="absolute top-2 left-3 flex items-center gap-3 text-[11px] font-mono pointer-events-none select-none z-10">
      <span className="text-gray-400 font-semibold">{symbol}</span>
      <span className="text-gray-500 text-[10px]">{timeframe}</span>
      <span className="text-gray-500">O <span className="text-gray-200">{f(ohlc.o)}</span></span>
      <span className="text-gray-500">H <span className="text-green-400">{f(ohlc.h)}</span></span>
      <span className="text-gray-500">L <span className="text-red-400">{f(ohlc.l)}</span></span>
      <span className="text-gray-500">C <span className={isUp ? "text-green-400" : "text-red-400"}>{f(ohlc.c)}</span></span>
    </div>
  );
}
