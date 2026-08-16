-- =================================================================
-- 002_bar_data.sql
-- Historical Market Data (OHLC Bar) 永続化テーブル
--
-- 設計原則:
--   - MT5 MqlRates.time は UTC秒 (このブローカーで実証済み)
--   - time_utc = new Date(bar.time_ms).toISOString() でそのまま保存
--   - Timezone変換不要
--   - PK (symbol, timeframe, time_utc) で重複排除
--   - 将来の Backtest Engine の唯一のデータソースとなる
--
-- 検証済み:
--   H4バー time_sec % 14400 == 0 (UTC境界) → true
--   H4バー (time_sec - 10800) % 14400 == 0 (UTC+3境界) → false
--   D1バー は全て 00:00:00 UTC 開始
-- =================================================================

CREATE TABLE IF NOT EXISTS public.bar_data (
  symbol     TEXT           NOT NULL,
  timeframe  TEXT           NOT NULL,
  time_utc   TIMESTAMPTZ    NOT NULL,
  open       NUMERIC(12, 5) NOT NULL,
  high       NUMERIC(12, 5) NOT NULL,
  low        NUMERIC(12, 5) NOT NULL,
  close      NUMERIC(12, 5) NOT NULL,
  volume     INTEGER        NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT bar_data_pkey PRIMARY KEY (symbol, timeframe, time_utc)
);

-- バックテストクエリ最適化: symbol + timeframe + 時刻範囲
CREATE INDEX IF NOT EXISTS idx_bar_data_lookup
  ON public.bar_data (symbol, timeframe, time_utc DESC);

-- symbol単体の横断検索用
CREATE INDEX IF NOT EXISTS idx_bar_data_symbol_time
  ON public.bar_data (symbol, time_utc DESC);

-- テーブルコメント
COMMENT ON TABLE public.bar_data IS
  'MT5→Gateway→Supabase パイプラインで蓄積されるOHLC Market Data。'
  'time_utc は UTC タイムスタンプ（MqlRates.time をUTCとして保存）。'
  '将来の Backtest Engine の主要データソース。';

COMMENT ON COLUMN public.bar_data.time_utc IS
  'バー開始時刻 (UTC)。MqlRates.time (UTC秒) × 1000ms → ISO変換済み。'
  '検証済み: H4バーが14400秒倍数(UTC境界)に整列している。';

-- =================================================================
-- RLS
-- =================================================================

ALTER TABLE public.bar_data ENABLE ROW LEVEL SECURITY;

-- 認証済みユーザーは読み取り可
CREATE POLICY "bar_data_select"
  ON public.bar_data
  FOR SELECT
  TO authenticated
  USING (true);

-- service_role のみ書き込み可（Gateway が使用する）
CREATE POLICY "bar_data_insert"
  ON public.bar_data
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "bar_data_update"
  ON public.bar_data
  FOR UPDATE
  TO service_role
  USING (true);

-- =================================================================
-- ステータス集計関数（GET /api/market-data/status から呼び出す）
-- =================================================================

CREATE OR REPLACE FUNCTION public.get_bar_data_status()
RETURNS TABLE (
  symbol         TEXT,
  timeframe      TEXT,
  bar_count      BIGINT,
  oldest_bar     TIMESTAMPTZ,
  newest_bar     TIMESTAMPTZ,
  span_days      NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    symbol,
    timeframe,
    COUNT(*)                                                    AS bar_count,
    MIN(time_utc)                                               AS oldest_bar,
    MAX(time_utc)                                               AS newest_bar,
    ROUND(
      EXTRACT(EPOCH FROM (MAX(time_utc) - MIN(time_utc))) / 86400, 1
    )                                                           AS span_days
  FROM public.bar_data
  GROUP BY symbol, timeframe
  ORDER BY symbol, timeframe;
$$;

GRANT EXECUTE ON FUNCTION public.get_bar_data_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_bar_data_status() TO service_role;
