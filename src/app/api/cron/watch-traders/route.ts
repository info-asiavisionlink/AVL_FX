// =================================================================
// POST /api/cron/watch-traders
// Vercel Cron: */5 * * * * (5分ごと)
//
// 【役割】Gateway M5通知のフォールバック
//
// GatewayがM5確定を通知できない場合（Gateway停止・ネットワーク断）の
// 保険として動作する。通常はGatewayからの/api/watcher/m5-closeが
// Market Watcherのメイントリガーとなる。
//
// 評価トリガー:
//   FIRST_RUN   : シナリオが存在しない（作成直後）
//   SCHEDULE    : 最終分析から指定分以上経過
//   PRICE_*     : 価格条件（現在価格が監視ゾーンに入った等）
//   VOLATILITY  : ATRスパイク
//
// 重複防止:
//   watcher_events テーブルで同一M5バー×トリガーの重複を防ぐ。
//   cron由来のイベントは bar_time = 0 として登録（cronからは正確なM5時刻不明）
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET    = process.env.CRON_SECRET      ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL  ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "";
const WATCHER_SECRET = process.env.WATCHER_SECRET   ?? "";

// フォールバック再分析間隔（価格監視は5分ごと。AIは30分ごとに自動実行）
const FALLBACK_REANALYZE_MINUTES = parseInt(process.env.WATCHER_SCHEDULE_MINUTES ?? "30", 10);

interface Bar { time: number; open: number; high: number; low: number; close: number; }

async function fetchCurrentPrice(connectionId: string, symbol: string): Promise<{ price: number; atr: number }> {
  if (!GATEWAY_URL) return { price: 0, atr: 0 };
  try {
    const connHeaders = {
      Authorization: `Bearer ${GATEWAY_SECRET}`,
      "x-connection-id": connectionId,
      "x-internal-service-auth": GATEWAY_SECRET,
    };
    const [tickRes, barRes] = await Promise.all([
      fetch(`${GATEWAY_URL}/connections/${connectionId}/tick/${encodeURIComponent(symbol)}`, {
        headers: connHeaders, signal: AbortSignal.timeout(4_000),
      }),
      fetch(`${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/H4?count=20`, {
        headers: connHeaders, signal: AbortSignal.timeout(4_000),
      }),
    ]);

    let price = 0;
    if (tickRes.ok) {
      const t = await tickRes.json() as { bid?: number };
      price = t.bid ?? 0;
    }

    let atr = 0;
    if (barRes.ok) {
      const bars = await barRes.json() as Bar[];
      if (bars.length >= 2) {
        const trs = bars.slice(-14).map((b, i, arr) => {
          if (i === 0) return b.high - b.low;
          const prev = arr[i - 1];
          return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
        });
        atr = trs.reduce((a, b) => a + b, 0) / trs.length;
      }
    }

    return { price, atr };
  } catch { return { price: 0, atr: 0 }; }
}

interface ScenarioRow {
  watch_zone_low:      number | null;
  watch_zone_high:     number | null;
  invalidate_below:    number | null;
  invalidate_above:    number | null;
  recheck_triggers_v2: Array<{ type: string; low?: number; high?: number; value?: number }> | null;
}

function evaluateWatcherTrigger(
  scenario: ScenarioRow | null,
  price:    number,
  atr:      number,
  lastAnalysisAt: Date | null,
): { trigger: boolean; reason: string } {
  if (!scenario) return { trigger: true, reason: "FIRST_RUN" };

  if (lastAnalysisAt) {
    const mins = (Date.now() - lastAnalysisAt.getTime()) / 60_000;
    // フォールバック用クールダウン
    if (mins < 5) return { trigger: false, reason: "COOLDOWN" };
  } else {
    return { trigger: true, reason: "FIRST_RUN" };
  }

  // 構造化トリガーを評価
  const triggersV2 = scenario.recheck_triggers_v2;
  if (triggersV2 && triggersV2.length > 0 && price > 0) {
    for (const trig of triggersV2) {
      if (trig.type === "PRICE_ENTERS_ZONE" && trig.low !== undefined && trig.high !== undefined) {
        if (price >= trig.low && price <= trig.high) return { trigger: true, reason: "PRICE_ENTERS_ZONE" };
      }
      if (trig.type === "PRICE_ABOVE" && trig.value !== undefined && price > trig.value) {
        return { trigger: true, reason: "PRICE_ABOVE" };
      }
      if (trig.type === "PRICE_BELOW" && trig.value !== undefined && price < trig.value) {
        return { trigger: true, reason: "PRICE_BELOW" };
      }
      if (trig.type === "VOLATILITY_SPIKE" && atr > 80) {
        return { trigger: true, reason: "VOLATILITY_SPIKE" };
      }
    }
  }

  // 旧形式フォールバック
  if (price > 0 && scenario.watch_zone_low !== null && scenario.watch_zone_high !== null) {
    if (price >= scenario.watch_zone_low && price <= scenario.watch_zone_high) {
      return { trigger: true, reason: "PRICE_ENTERS_ZONE" };
    }
  }

  // SCHEDULE: 長時間再分析なし（フォールバック用）
  if (lastAnalysisAt) {
    const mins = (Date.now() - lastAnalysisAt.getTime()) / 60_000;
    if (mins >= FALLBACK_REANALYZE_MINUTES) return { trigger: true, reason: "SCHEDULE_FALLBACK" };
  }

  return { trigger: false, reason: "WATCHING" };
}

export async function POST(req: NextRequest) {
  if (CRON_SECRET && req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  const { data: traders } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, watcher_state, last_analysis_at, execution_mode")
    .eq("status", "ACTIVE")
    .neq("execution_mode", "STOPPED");

  if (!traders || traders.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, triggered: 0, source: "cron_fallback" });
  }

  let triggered = 0;
  const results: { trader: string; trigger: string; status: string }[] = [];

  for (const trader of traders) {
    try {
      // 現在のシナリオ
      const { data: scenario } = await db
        .from("ai_trader_scenarios")
        .select("watch_zone_low,watch_zone_high,invalidate_below,invalidate_above,recheck_triggers_v2")
        .eq("ai_trader_id", trader.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // MT5接続
      const { data: conn } = await db
        .from("mt5_connections")
        .select("id, last_heartbeat_at")
        .eq("user_id", trader.user_id as string)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const mt5Online = conn &&
        (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;

      const symbol = trader.market === "GOLD" ? "GOLD#" : trader.market as string;
      let price = 0;
      let atr   = 0;

      if (mt5Online) {
        const result = await fetchCurrentPrice(conn!.id, symbol);
        price = result.price;
        atr   = result.atr;
      }

      const lastAnalysisAt = trader.last_analysis_at
        ? new Date(trader.last_analysis_at as string) : null;

      const { trigger, reason } = evaluateWatcherTrigger(
        scenario as ScenarioRow | null, price, atr, lastAnalysisAt
      );

      await db.from("ai_traders").update({
        watcher_state:         trigger ? "TRIGGERED" : "WATCHING",
        last_watcher_check_at: new Date().toISOString(),
      }).eq("id", trader.id);

      if (!trigger) {
        results.push({ trader: trader.name as string, trigger: "none", status: reason });
        // ゾーン外・クールダウン等のスキップをwatcher_eventsに記録（ログ表示用）
        const loggable = ["PRICE_BELOW", "PRICE_ABOVE", "WATCHING", "COOLDOWN"].includes(reason);
        if (loggable && scenario) {
          await db.from("watcher_events").insert({
            trader_id:           trader.id,
            user_id:             trader.user_id as string,
            symbol,
            m5_bar_time:         Date.now(),
            trigger_type:        `SKIP_${reason}`,
            analysis_dispatched: false,
            analysis_result:     price > 0 ? `現在価格=${price.toFixed(2)} / ゾーン=${scenario.watch_zone_low?.toFixed(2)}〜${scenario.watch_zone_high?.toFixed(2)}` : reason,
          }).then(() => {});
        }
        continue;
      }

      // Watcher エンドポイントへ委譲（ロジック一元化）
      let analyzeStatus = "skipped";
      if (APP_URL && WATCHER_SECRET) {
        const watchRes = await fetch(`${APP_URL}/api/watcher/m5-close`, {
          method:  "POST",
          headers: {
            "Content-Type":    "application/json",
            "x-watcher-secret": WATCHER_SECRET,
          },
          body: JSON.stringify({
            symbol,
            // Use the most recently confirmed closed M5 bar time.
            // isClosedBar requires bar_time + 5min <= now; subtracting one
            // interval from the current floored M5 boundary gives a
            // guaranteed-closed bar that m5-close will accept.
            bar_time:      Math.floor(Date.now() / 1000 / 300) * 300 - 300,
            current_price: price,
            source:        "cron_fallback",
          }),
          signal: AbortSignal.timeout(50_000),
        });
        analyzeStatus = watchRes.ok ? "dispatched_via_watcher" : `watcher_failed_${watchRes.status}`;
      } else if (APP_URL) {
        // Watcher secret未設定の場合は直接analyzeを呼ぶ（後方互換）
        const analyzeRes = await fetch(`${APP_URL}/api/traders/${trader.id}/analyze`, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "x-cron-secret": CRON_SECRET,
            "x-user-id":     trader.user_id as string,
          },
          signal: AbortSignal.timeout(45_000),
        });
        analyzeStatus = analyzeRes.ok ? "analyzed" : `failed_${analyzeRes.status}`;
      }

      triggered++;
      results.push({ trader: trader.name as string, trigger: reason, status: analyzeStatus });

    } catch (e) {
      results.push({
        trader: trader.name as string,
        trigger: "error",
        status: String(e).slice(0, 80),
      });
    }
  }

  return NextResponse.json({
    ok:       true,
    source:   "cron_fallback",
    checked:  traders.length,
    triggered,
    results,
  });
}

// Vercel Cron invokes this route with GET. Keep the POST implementation as
// the single execution path, but expose an explicit GET handler so the
// production route is emitted as a GET endpoint by the Next.js build.
export async function GET(req: NextRequest) {
  return POST(req);
}
