// =================================================================
// barDataStore.ts — Supabase bar_data 永続化モジュール
//
// 責務:
//   - bar_data テーブルへの UPSERT（bulk / single）
//   - バッチ分割でSupabaseレート制限を回避
//   - エラー時もGatewayの通常処理を止めない（fire-and-forget）
//   - SUPABASE_URL / SUPABASE_SERVICE_KEY 未設定時は無効化
//
// Timezone:
//   bar.time は UTC ミリ秒（MqlRates.time × 1000）
//   new Date(bar.time).toISOString() でそのまま time_utc に保存
//   offset 変換不要（H4バーがUTC境界に整列していることで実証済み）
// =================================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

// ------------------------------------------------------------------
// 設定
// ------------------------------------------------------------------

const BATCH_SIZE = parseInt(process.env.SUPABASE_BATCH_SIZE ?? "500", 10);
const BATCH_DELAY_MS = parseInt(process.env.SUPABASE_BATCH_DELAY_MS ?? "50", 10);

// ------------------------------------------------------------------
// Supabase クライアント（遅延初期化）
// ------------------------------------------------------------------

let _client: SupabaseClient | null = null;
let _initialized = false;
let _enabled = false;

function getClient(): SupabaseClient | null {
  if (_initialized) return _enabled ? _client : null;
  _initialized = true;

  const url = process.env.SUPABASE_URL;
  // env var 名のゆらぎに対応（SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY どちらでも可）
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[barData] SUPABASE_URL / SUPABASE_SERVICE_KEY(またはSUPABASE_SERVICE_ROLE_KEY) 未設定 → bar_data保存スキップ");
    return null;
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: ws as any }, // Node.js 20 は native WebSocket 非対応のため ws を指定
  });
  _enabled = true;
  console.log("[barData] Supabase接続準備完了 → bar_data に永続化します");
  return _client;
}

// ------------------------------------------------------------------
// 内部型
// ------------------------------------------------------------------

export interface BarRecord {
  time:   number; // UTC ミリ秒
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface BarRow {
  symbol:    string;
  timeframe: string;
  time_utc:  string; // UTC ISO 文字列
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

function toRow(symbol: string, timeframe: string, bar: BarRecord): BarRow {
  return {
    symbol:    symbol.toUpperCase(),
    timeframe: timeframe.toUpperCase(),
    time_utc:  new Date(bar.time).toISOString(), // UTC ms → ISO (UTC)
    open:      bar.open,
    high:      bar.high,
    low:       bar.low,
    close:     bar.close,
    volume:    bar.volume ?? 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ------------------------------------------------------------------
// upsertBulkBars — 起動時 bulk 送信 / 定期再送に使用
// バッチ分割して Supabase に UPSERT する
// ------------------------------------------------------------------

export async function upsertBulkBars(
  symbol:    string,
  timeframe: string,
  bars:      BarRecord[]
): Promise<void> {
  const db = getClient();
  if (!db || bars.length === 0) return;

  const rows = bars.map(b => toRow(symbol, timeframe, b));
  const key  = `${symbol.toUpperCase()}:${timeframe.toUpperCase()}`;
  let   saved = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const { error } = await db
      .from("bar_data")
      .upsert(batch, {
        onConflict:       "symbol,timeframe,time_utc",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn(`[barData] bulk upsert error ${key} batch[${i}..${i + BATCH_SIZE}]:`, error.message);
    } else {
      saved += batch.length;
    }

    // バッチ間のwait（Supabase負荷軽減）
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS);
  }

  if (saved > 0) {
    console.log(`[barData] ${key}: ${saved}/${rows.length}本 → Supabase保存完了`);
  }
}

// ------------------------------------------------------------------
// upsertSingleBar — 確定バー1本を保存
// upsertBar() で新バー検出時（前バーが確定した瞬間）に呼ぶ
// ------------------------------------------------------------------

export async function upsertSingleBar(
  symbol:    string,
  timeframe: string,
  bar:       BarRecord
): Promise<void> {
  const db = getClient();
  if (!db) return;

  const row = toRow(symbol, timeframe, bar);

  const { error } = await db
    .from("bar_data")
    .upsert(row, {
      onConflict:       "symbol,timeframe,time_utc",
      ignoreDuplicates: false, // 確定バーは値を上書きする
    });

  if (error) {
    console.warn(
      `[barData] single upsert error ${symbol}:${timeframe} ${row.time_utc}:`,
      error.message
    );
  }
}

// ------------------------------------------------------------------
// syncBarStoreToSupabase — 起動時の初回同期（全barStore → Supabase）
// Gateway 起動時に既存 bars.json データを Supabase に一括保存
// ------------------------------------------------------------------

export async function syncBarStoreToSupabase(
  barStore: Map<string, BarRecord[]>
): Promise<void> {
  const db = getClient();
  if (!db) return;

  console.log("[barData] 起動時同期: barStore → Supabase bar_data ...");
  let totalSaved = 0;

  for (const [key, bars] of barStore.entries()) {
    if (bars.length === 0) continue;

    const [symbol, timeframe] = key.split(":");
    if (!symbol || !timeframe) continue;

    const rows = bars.map(b => toRow(symbol, timeframe, b));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await db
        .from("bar_data")
        .upsert(batch, {
          onConflict:       "symbol,timeframe,time_utc",
          ignoreDuplicates: true,
        });

      if (error) {
        console.warn(`[barData] sync error ${key} batch[${i}]:`, error.message);
      } else {
        totalSaved += batch.length;
      }

      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`[barData] 起動時同期完了: 合計 ${totalSaved} 本 → Supabase`);
}

// ------------------------------------------------------------------
// isEnabled — 設定確認用
// ------------------------------------------------------------------

export function isEnabled(): boolean {
  return getClient() !== null;
}
