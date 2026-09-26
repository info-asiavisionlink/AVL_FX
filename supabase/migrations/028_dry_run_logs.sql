-- =================================================================
-- 028_dry_run_logs.sql
-- Phase 3.6: EXECUTION_DRY_RUN 結果の保存
--
-- Dry Run は execution_commands を PENDING で作成せず、
-- Risk Engine の全チェック結果だけを記録する。
-- =================================================================

CREATE TABLE IF NOT EXISTS public.dry_run_logs (
  id                UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  ai_trader_id      UUID          NOT NULL REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id           UUID          NOT NULL REFERENCES auth.users(id),
  run_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- テストケース識別
  test_label        TEXT,                        -- "CASE_A_SMALL_SL" 等

  -- Decision
  side              TEXT          CHECK (side IN ('BUY', 'SELL', NULL)),
  entry_price       NUMERIC,
  stop_loss         NUMERIC,
  take_profit       NUMERIC,
  sl_distance       NUMERIC,

  -- Account Snapshot（Dry Run 実行時の実値）
  account_type      TEXT,
  account_mode      TEXT,
  balance           NUMERIC,
  equity            NUMERIC,
  free_margin       NUMERIC,
  account_age_sec   INTEGER,

  -- Symbol Spec（Dry Run 実行時の実値）
  broker_symbol     TEXT,
  tick_size         NUMERIC,
  tick_value        NUMERIC,
  contract_size     NUMERIC,
  volume_min        NUMERIC,
  volume_max        NUMERIC,
  volume_step       NUMERIC,
  stops_level_price NUMERIC,
  digits            INTEGER,

  -- Tick（Dry Run 実行時の実値）
  bid               NUMERIC,
  ask               NUMERIC,
  spread_points     INTEGER,
  tick_age_sec      INTEGER,

  -- Risk Calculation
  risk_percent      NUMERIC,
  risk_money        NUMERIC,
  ticks_at_risk     NUMERIC,
  loss_per_lot      NUMERIC,
  raw_lot           NUMERIC,
  normalized_lot    NUMERIC,
  expected_max_loss NUMERIC,     -- normalized_lot × loss_per_lot
  margin_required   NUMERIC,

  -- Exposure
  current_exposure_lots NUMERIC,
  open_position_count   INTEGER,

  -- Result
  approved          BOOLEAN       NOT NULL DEFAULT false,
  denied_reason     TEXT,

  -- Safety確認
  mt5_orders_sent   INTEGER       NOT NULL DEFAULT 0,   -- 常に 0 であること

  -- Override フラグ（テストハーネスがデータを注入したか）
  is_override       BOOLEAN       NOT NULL DEFAULT false,

  CONSTRAINT dry_run_logs_mt5_orders_zero
    CHECK (mt5_orders_sent = 0)  -- Dry Run で MT5 注文は絶対に 0
);

CREATE INDEX IF NOT EXISTS idx_dry_run_logs_trader
  ON public.dry_run_logs (ai_trader_id, run_at DESC);

-- RLS: 全ユーザー自身のログのみ参照可能
ALTER TABLE public.dry_run_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "dry_run_own"
    ON public.dry_run_logs FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "dry_run_service_role"
    ON public.dry_run_logs FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE public.dry_run_logs IS
  'EXECUTION_DRY_RUN 結果ログ。execution_commands は作成しない。'
  'mt5_orders_sent は常に 0 であることを DB レベルで保証。';
