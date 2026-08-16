// =================================================================
// GET /api/market-data/status
//
// Gateway barStore + Supabase bar_data の両方から
// Historical Market Data の保存状況を取得して返す。
//
// 用途:
//   - Phase 0 完了確認
//   - 将来の Backtest Engine 起動前の data availability チェック
//   - Backtest UI での「利用可能データ」表示
// =================================================================

import { NextResponse }    from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

// ------------------------------------------------------------------
// 型定義
// ------------------------------------------------------------------

interface GatewaySymbolStat {
  count:           number;
  from_utc:        string | null;
  to_utc:          string | null;
  span_days:       number | null;
  last_updated_ms: number;
}

interface GatewayStatus {
  timestamp:        string;
  total_symbol_tf:  number;
  max_bars_per_tf:  number;
  supabase_enabled: boolean;
  symbols:          Record<string, GatewaySymbolStat>;
}

interface SupabaseSymbolStat {
  symbol:     string;
  timeframe:  string;
  bar_count:  number;
  oldest_bar: string;
  newest_bar: string;
  span_days:  number;
}

// ------------------------------------------------------------------
// ハンドラ
// ------------------------------------------------------------------

export async function GET() {
  const gw     = process.env.MT5_GATEWAY_URL    ?? "http://127.0.0.1:8080";
  const secret = process.env.MT5_GATEWAY_SECRET;

  // 1. Gateway ステータスを取得
  let gateway: GatewayStatus | null = null;
  let gatewayError: string | null   = null;

  try {
    const headers: Record<string, string> = {};
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${gw}/market-data/status`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      gateway = await res.json() as GatewayStatus;
    } else {
      gatewayError = `HTTP ${res.status}`;
    }
  } catch (err) {
    gatewayError = err instanceof Error ? err.message : "Gateway 接続エラー";
  }

  // 2. Supabase bar_data ステータスを取得（RPC関数）
  const db = createAdminClient();
  let supabaseStats: SupabaseSymbolStat[] = [];
  let supabaseError: string | null        = null;
  let totalBarsInSupabase                 = 0;

  try {
    const { data, error } = await db.rpc("get_bar_data_status");
    if (error) {
      supabaseError = error.message;
    } else {
      supabaseStats = (data ?? []) as SupabaseSymbolStat[];
      totalBarsInSupabase = supabaseStats.reduce((s, r) => s + Number(r.bar_count), 0);
    }
  } catch (err) {
    supabaseError = err instanceof Error ? err.message : "Supabase クエリエラー";
  }

  // 3. レスポンス構築
  const supabaseByKey: Record<string, SupabaseSymbolStat> = {};
  for (const row of supabaseStats) {
    supabaseByKey[`${row.symbol}:${row.timeframe}`] = row;
  }

  // 4. 全 symbol:TF の統合ビュー
  const allKeys = new Set([
    ...Object.keys(gateway?.symbols ?? {}),
    ...Object.keys(supabaseByKey),
  ]);

  type HealthStatus = "HEALTHY" | "GATEWAY_ONLY" | "SUPABASE_ONLY" | "NO_DATA";

  interface CombinedStat {
    symbol:                string;
    timeframe:             string;
    gateway_bars:          number | null;
    gateway_from:          string | null;
    gateway_to:            string | null;
    supabase_bars:         number | null;
    supabase_from:         string | null;
    supabase_to:           string | null;
    supabase_span_days:    number | null;
    status:                HealthStatus;
  }

  const combined: Record<string, CombinedStat> = {};
  for (const key of allKeys) {
    const [sym, tf] = key.split(":");
    const gStat   = gateway?.symbols?.[key] ?? null;
    const sStat   = supabaseByKey[key] ?? null;

    let status: HealthStatus = "NO_DATA";
    if (gStat && sStat)       status = "HEALTHY";
    else if (gStat && !sStat) status = "GATEWAY_ONLY";
    else if (!gStat && sStat) status = "SUPABASE_ONLY";

    combined[key] = {
      symbol:             sym,
      timeframe:          tf,
      gateway_bars:       gStat?.count         ?? null,
      gateway_from:       gStat?.from_utc       ?? null,
      gateway_to:         gStat?.to_utc         ?? null,
      supabase_bars:      sStat ? Number(sStat.bar_count)  : null,
      supabase_from:      sStat?.oldest_bar     ?? null,
      supabase_to:        sStat?.newest_bar     ?? null,
      supabase_span_days: sStat ? Number(sStat.span_days)  : null,
      status,
    };
  }

  // 5. サマリー
  const healthy      = Object.values(combined).filter(c => c.status === "HEALTHY").length;
  const gatewayOnly  = Object.values(combined).filter(c => c.status === "GATEWAY_ONLY").length;
  const supabaseOnly = Object.values(combined).filter(c => c.status === "SUPABASE_ONLY").length;

  return NextResponse.json({
    timestamp:         new Date().toISOString(),
    phase:             "Phase 0 — Historical Market Data",

    summary: {
      total_symbol_tf:       allKeys.size,
      healthy:               healthy,
      gateway_only:          gatewayOnly,
      supabase_only:         supabaseOnly,
      total_supabase_bars:   totalBarsInSupabase,
      gateway_connected:     gateway !== null,
      supabase_enabled:      gateway?.supabase_enabled ?? false,
    },

    gateway: {
      connected:        gateway !== null,
      error:            gatewayError,
      total_symbol_tf:  gateway?.total_symbol_tf ?? 0,
      max_bars_per_tf:  gateway?.max_bars_per_tf ?? 0,
    },

    supabase: {
      error:      supabaseError,
      total_bars: totalBarsInSupabase,
      symbol_tfs: supabaseStats.length,
    },

    symbols: combined,
  });
}
