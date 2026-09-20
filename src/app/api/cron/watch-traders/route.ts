// =================================================================
// POST /api/cron/watch-traders
// Vercel Cron: */5 * * * * (5分ごと)
//
// ACTIVE な AI Trader の Market Watcher。
// 軽量な条件チェックのみ行い、トリガー条件が揃った Trader のみ
// /api/traders/[id]/analyze を呼ぶ（全員無条件にAIを起動しない）。
//
// トリガー条件（いずれか）:
//   - PRICE_ENTERS_ZONE: 監視ゾーンに価格が入った
//   - VOLATILITY_SPIKE: 直近5本のATRが通常比150%以上
//   - SCHEDULE: 最終分析から指定時間以上経過
//   - FIRST_RUN: シナリオがまだない
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime   = "nodejs";
export const dynamic   = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET    = process.env.CRON_SECRET      ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL  ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

// 最低再分析間隔（分）
const MIN_REANALYZE_INTERVAL_MINUTES = 60;

interface Bar { time: number; open: number; high: number; low: number; close: number; }

async function fetchLastBars(connectionId: string, symbol: string, count = 10): Promise<Bar[]> {
  if (!GATEWAY_URL) return [];
  try {
    const url = `${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/H4?count=${count}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    return (await res.json()) as Bar[];
  } catch { return []; }
}

function calcATR(bars: Bar[]): number {
  if (bars.length < 2) return 0;
  const trs = bars.slice(-14).map((b, i, arr) => {
    if (i === 0) return b.high - b.low;
    const prev = arr[i - 1];
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function shouldTrigger(
  scenario:    Record<string, unknown> | null,
  currentPrice: number,
  currentATR:   number,
  baselineATR:  number,
  lastAnalysis: Date | null,
): { trigger: boolean; reason: string } {
  // FIRST_RUN: まだシナリオがない
  if (!scenario) return { trigger: true, reason: "FIRST_RUN" };

  // SCHEDULE: 長時間再分析がない
  if (lastAnalysis) {
    const minutesSince = (Date.now() - lastAnalysis.getTime()) / 60_000;
    if (minutesSince >= MIN_REANALYZE_INTERVAL_MINUTES) {
      return { trigger: true, reason: "SCHEDULE" };
    }
  } else {
    return { trigger: true, reason: "FIRST_RUN" };
  }

  // PRICE_ENTERS_ZONE: 監視ゾーンに入った
  const low  = scenario.watch_zone_low  as number | null;
  const high = scenario.watch_zone_high as number | null;
  if (low !== null && high !== null && currentPrice >= low && currentPrice <= high) {
    return { trigger: true, reason: "PRICE_ENTERS_ZONE" };
  }

  // VOLATILITY_SPIKE: ATRが通常の150%超
  if (baselineATR > 0 && currentATR > baselineATR * 1.5) {
    return { trigger: true, reason: "VOLATILITY_SPIKE" };
  }

  return { trigger: false, reason: "" };
}

export async function POST(req: NextRequest) {
  if (CRON_SECRET && req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // ACTIVE な AI Trader を全件取得
  const { data: traders } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version")
    .eq("status", "ACTIVE");

  if (!traders || traders.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, triggered: 0 });
  }

  let triggered = 0;
  const results: { trader: string; trigger: string; status: string }[] = [];

  for (const trader of traders) {
    try {
      // 現在のシナリオ取得
      const { data: scenario } = await db
        .from("ai_trader_scenarios")
        .select("*").eq("ai_trader_id", trader.id).eq("is_active", true)
        .order("created_at", { ascending: false }).limit(1).single();

      // MT5接続確認
      const { data: conn } = await db
        .from("mt5_connections").select("id, last_heartbeat_at")
        .eq("user_id", trader.user_id).order("created_at", { ascending: false }).limit(1).single();

      const mt5Online = conn && (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;
      const symbol = trader.market === "GOLD" ? "GOLD#" : trader.market as string;

      let currentPrice = 0;
      let currentATR   = 0;
      let baselineATR  = 0;

      if (mt5Online) {
        const recentBars = await fetchLastBars(conn.id, symbol, 20);
        const oldBars    = await fetchLastBars(conn.id, symbol, 5);

        if (recentBars.length) {
          currentPrice = recentBars[recentBars.length - 1].close;
          currentATR   = calcATR(recentBars.slice(-5));
          baselineATR  = calcATR(recentBars);
        }

        void oldBars; // suppress unused warning
      }

      const lastAnalysis = scenario ? new Date(scenario.updated_at as string) : null;
      const { trigger, reason } = shouldTrigger(scenario, currentPrice, currentATR, baselineATR, lastAnalysis);

      if (trigger) {
        // 内部API呼び出し（self-call）は避け、DB直接更新で analyze をキューに入れる方式
        // 実際の analyze は別のフローで呼ぶため、ここでは "needs_analysis" フラグを立てる
        await db.from("ai_traders")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", trader.id);

        // analyze を直接呼ぶ（Vercel Functions 内からの自己呼び出し）
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

        // Note: Service Role を使って内部 API を呼ぶ
        // Trade decision は PENDING として保存されるので自動実行はない
        const analyzeRes = await fetch(`${baseUrl}/api/traders/${trader.id}/analyze`, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "x-cron-secret": CRON_SECRET,
            "x-user-id":     trader.user_id as string, // サービスロール認証
          },
          signal: AbortSignal.timeout(45_000),
        });

        triggered++;
        results.push({ trader: trader.name as string, trigger: reason, status: analyzeRes.ok ? "analyzed" : "failed" });
      } else {
        results.push({ trader: trader.name as string, trigger: "none", status: "skipped" });
      }
    } catch (e) {
      results.push({ trader: trader.name as string, trigger: "error", status: String(e).slice(0, 100) });
    }
  }

  return NextResponse.json({
    ok:      true,
    checked: traders.length,
    triggered,
    results,
  });
}
