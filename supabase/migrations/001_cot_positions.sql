-- cot_positions: CFTC COT週次データ保存テーブル
-- ソース: CFTC Legacy Futures-Only Report (Non-Commercial positions)
-- 更新頻度: 週1回（毎週金曜にCFTCが公開）

CREATE TABLE IF NOT EXISTS cot_positions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE        NOT NULL,
  currency    CHAR(3)     NOT NULL,
  contract_name TEXT      NOT NULL,
  long_contracts  INTEGER NOT NULL,
  short_contracts INTEGER NOT NULL,
  net_contracts   INTEGER NOT NULL,
  long_pct    NUMERIC(5, 2),
  short_pct   NUMERIC(5, 2),
  net_pct     NUMERIC(5, 2),
  source      VARCHAR(20) NOT NULL DEFAULT 'CFTC',
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- report_date + currency の組み合わせは一意（同一週の重複保存を防ぐ）
ALTER TABLE cot_positions
  ADD CONSTRAINT cot_positions_date_currency_unique UNIQUE (report_date, currency);

-- クエリ最適化インデックス
CREATE INDEX IF NOT EXISTS idx_cot_positions_currency_date
  ON cot_positions (currency, report_date DESC);

-- RLS: 読み取りは全員許可、書き込みはサービスロールのみ
ALTER TABLE cot_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cot_read_public"
  ON cot_positions FOR SELECT
  USING (true);

-- サービスロールはRLSをバイパスするため書き込みポリシー不要
