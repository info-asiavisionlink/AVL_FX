-- =================================================================
-- 027_phase35_safety_gate.sql
-- Phase 3.5: Demo Execution Safety Gate
--
-- 変更内容:
--   mt5_connections  : account balance/equity/margin をリアルタイム保存
--   symbol_specs     : Broker Symbol Specification キャッシュ（NEW）
--   ai_positions     : PENDING_OPEN status 追加 / decision_id UNIQUE index
--   watcher_state    : RISK_CHECK / DRY_RUN 状態追加
-- =================================================================

-- ─── mt5_connections への balance/equity カラム追加 ──────────────
-- Bridge EA が Heartbeat で送ってくる実口座データを保存する。
-- Risk Engine はこれを Source of Truth として使用する。

ALTER TABLE public.mt5_connections
  ADD COLUMN IF NOT EXISTS balance              NUMERIC         DEFAULT 0,
  ADD COLUMN IF NOT EXISTS equity               NUMERIC         DEFAULT 0,
  ADD COLUMN IF NOT EXISTS margin               NUMERIC         DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_margin          NUMERIC         DEFAULT 0,
  ADD COLUMN IF NOT EXISTS margin_level         NUMERIC,        -- equity/margin * 100
  ADD COLUMN IF NOT EXISTS account_balance_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_max_age_seconds    INTEGER  DEFAULT 30;

COMMENT ON COLUMN public.mt5_connections.balance IS
  'MT5 AccountInfoDouble(ACCOUNT_BALANCE) — Heartbeat で更新。Risk Engine の Source of Truth。';
COMMENT ON COLUMN public.mt5_connections.equity IS
  'MT5 AccountInfoDouble(ACCOUNT_EQUITY) — Lot計算の基準値。';
COMMENT ON COLUMN public.mt5_connections.free_margin IS
  'MT5 AccountInfoDouble(ACCOUNT_MARGIN_FREE) — Margin check の基準値。';
COMMENT ON COLUMN public.mt5_connections.account_balance_updated_at IS
  'balance/equity の最終更新時刻。account_max_age_seconds を超えたら EXECUTION DENIED。';

-- ─── symbol_specs（Broker Symbol Specification キャッシュ）────────
-- Bridge EA が起動時・定期的に送信するシンボルスペック。
-- Risk Engine はこれを使って tick_value based Lot 計算を行う。

CREATE TABLE IF NOT EXISTS public.symbol_specs (
  id                 UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id            UUID          NOT NULL REFERENCES auth.users(id),
  connection_id      UUID          NOT NULL REFERENCES public.mt5_connections(id) ON DELETE CASCADE,

  -- シンボル識別
  symbol             TEXT          NOT NULL,  -- Canonical symbol (e.g., GOLD)
  broker_symbol      TEXT          NOT NULL,  -- Actual MT5 symbol (e.g., GOLD#, XAUUSD)

  -- Lot/Volume 仕様
  contract_size      NUMERIC,                -- SYMBOL_TRADE_CONTRACT_SIZE (e.g., 100 for GOLD)
  volume_min         NUMERIC,                -- SYMBOL_VOLUME_MIN
  volume_max         NUMERIC,                -- SYMBOL_VOLUME_MAX
  volume_step        NUMERIC,                -- SYMBOL_VOLUME_STEP

  -- Tick/Point 仕様
  tick_size          NUMERIC,                -- SYMBOL_TRADE_TICK_SIZE
  tick_value         NUMERIC,                -- SYMBOL_TRADE_TICK_VALUE (in deposit currency)
  point_size         NUMERIC,                -- SYMBOL_POINT
  digits             INTEGER,                -- SYMBOL_DIGITS

  -- Stop 仕様
  stops_level_points INTEGER,               -- SYMBOL_TRADE_STOPS_LEVEL (in points)
  stops_level_price  NUMERIC,               -- stops_level_points * point_size

  -- 通貨
  currency_profit    TEXT,                  -- SYMBOL_CURRENCY_PROFIT
  currency_margin    TEXT,                  -- SYMBOL_CURRENCY_MARGIN

  -- Margin 仕様
  margin_initial     NUMERIC,               -- SYMBOL_MARGIN_INITIAL (per lot)
  margin_maintenance NUMERIC,               -- SYMBOL_MARGIN_MAINTENANCE

  -- スプレッド（参考値）
  spread_current     INTEGER,               -- SYMBOL_SPREAD (in points)
  max_spread_allowed INTEGER  DEFAULT 50,   -- 許容スプレッド上限（Risk Engineで設定可能）

  -- 更新管理
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 同一接続・シンボルはUNIQUE
  UNIQUE (connection_id, broker_symbol)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_symbol_specs_user_symbol
  ON public.symbol_specs (user_id, symbol);

CREATE INDEX IF NOT EXISTS idx_symbol_specs_connection
  ON public.symbol_specs (connection_id);

-- RLS
ALTER TABLE public.symbol_specs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "symbol_specs_own"
    ON public.symbol_specs FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "symbol_specs_service_role"
    ON public.symbol_specs FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE public.symbol_specs IS
  'Bridge EA から送信される MT5 Symbol Specification キャッシュ。'
  'Risk Engine の Lot 計算と Stop Level 検証の Source of Truth。';

-- ─── ai_positions: PENDING_OPEN status 追加 ──────────────────────
-- MT5 約定前は PENDING_OPEN として管理する。
-- OPEN への遷移は execution_command が FILLED になったときのみ。

ALTER TABLE public.ai_positions
  DROP CONSTRAINT IF EXISTS ai_positions_status_check;

ALTER TABLE public.ai_positions
  ADD CONSTRAINT ai_positions_status_check
    CHECK (status IN ('PENDING_OPEN', 'OPEN', 'CLOSING', 'CLOSED', 'ERROR'));

-- decision_id UNIQUE（同一 Decision から複数 Position を作れない）
-- ERROR / CLOSED は除外（再試行シナリオ対応）
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_positions_decision_unique
  ON public.ai_positions (decision_id)
  WHERE decision_id IS NOT NULL
    AND status NOT IN ('ERROR', 'CLOSED');

-- ─── watcher_state: RISK_CHECK / DRY_RUN 追加 ─────────────────────
ALTER TABLE public.ai_traders
  DROP CONSTRAINT IF EXISTS ai_traders_watcher_state_check;

ALTER TABLE public.ai_traders
  ADD CONSTRAINT ai_traders_watcher_state_check
    CHECK (watcher_state IN (
      'SLEEPING', 'WATCHING', 'TRIGGERED', 'ANALYZING',
      'RISK_CHECK', 'EXECUTING', 'POSITION', 'REVIEWING', 'ERROR',
      'DRY_RUN'   -- Dry Run モード（実注文なし）
    ));

-- ─── cron_schedules（Cron Idempotency 用）──────────────────────────
-- bar_time=0 の Cron イベントを dedup するために使う。
-- schedule_bucket: "trader_id:trigger_type:YYYY-MM-DDTHH:00" 形式

CREATE TABLE IF NOT EXISTS public.cron_schedules (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id       UUID          NOT NULL REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id         UUID          NOT NULL REFERENCES auth.users(id),
  trigger_type    TEXT          NOT NULL,
  schedule_bucket TEXT          NOT NULL,   -- YYYY-MM-DDTHH:MM (1時間または15分単位)
  dispatched      BOOLEAN       NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一 trader × trigger × bucket = 1回のみ
  UNIQUE (trader_id, trigger_type, schedule_bucket)
);

CREATE INDEX IF NOT EXISTS idx_cron_schedules_trader
  ON public.cron_schedules (trader_id, created_at DESC);

ALTER TABLE public.cron_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "cron_schedules_service_role"
    ON public.cron_schedules FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── lastM5Close 永続化（Gateway 再起動後の dedup 用）──────────────
CREATE TABLE IF NOT EXISTS public.gateway_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.gateway_state (key, value)
  VALUES ('last_m5_close_time_GOLD', '0')
  ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.gateway_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "gateway_state_service_role"
    ON public.gateway_state FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
