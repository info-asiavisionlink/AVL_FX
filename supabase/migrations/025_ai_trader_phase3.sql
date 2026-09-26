-- =================================================================
-- 025_ai_trader_phase3.sql
-- Phase 3: Autonomous Demo Execution
--
-- 変更内容:
--   ai_traders         : execution_mode / kill_switch / daily_stats / watcher_state拡張
--   ai_trader_versions : magic_number（専用）/ position_size_mode
--   ai_positions       : オープンポジション追跡（NEW）
--   system_settings    : グローバルKill Switch等（NEW）
-- =================================================================

-- ─── ai_traders への列追加 ───────────────────────────────────────

-- 実行モード（デフォルト: ANALYSIS_ONLY）
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'ANALYSIS_ONLY'
    CHECK (execution_mode IN ('ANALYSIS_ONLY', 'MANUAL_APPROVAL', 'DEMO_AUTONOMOUS'));
    -- LIVE_AUTONOMOUS は意図的に除外（Phase 4以降）

-- Trader単位Kill Switch
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS kill_switch BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS kill_switch_reason TEXT;

-- 当日リスク統計（日付が変わったらリセット）
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS daily_stats_date DATE;        -- 統計の対象日
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS daily_trade_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS daily_loss_usd NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS daily_consecutive_losses INTEGER NOT NULL DEFAULT 0;

-- watcher_state に POSITION を追加（既存CHECKを変更）
ALTER TABLE public.ai_traders
  DROP CONSTRAINT IF EXISTS ai_traders_watcher_state_check;
ALTER TABLE public.ai_traders
  ADD CONSTRAINT ai_traders_watcher_state_check
    CHECK (watcher_state IN (
      'SLEEPING', 'WATCHING', 'TRIGGERED', 'ANALYZING',
      'RISK_CHECK', 'EXECUTING', 'POSITION', 'REVIEWING', 'ERROR'
    ));

-- ─── ai_trader_versions への列追加 ──────────────────────────────

-- Trader専用Magic Number（900001〜999999 レンジで管理）
-- strategy_registry.magic_number とは独立して使用
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS magic_number INTEGER UNIQUE;  -- UNIQUE: 他Traderと衝突しない

-- リスク限度（execution時に参照）
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS max_daily_trades INTEGER NOT NULL DEFAULT 5;
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS max_daily_loss_usd NUMERIC NOT NULL DEFAULT 100.0;
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS max_consecutive_losses INTEGER NOT NULL DEFAULT 3;
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS max_total_exposure_lots NUMERIC NOT NULL DEFAULT 0.2;
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS market_data_max_age_seconds INTEGER NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.ai_trader_versions.magic_number IS
  '900001〜999999 レンジで AI Trader 専用に割り当てる MT5 Magic Number。'
  'strategy_registry.magic_number とは別管理。';

-- ─── ai_positions（オープンポジション追跡）──────────────────────

CREATE TABLE IF NOT EXISTS public.ai_positions (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 所有者
  ai_trader_id        UUID        NOT NULL REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  ai_trader_version_id UUID       REFERENCES public.ai_trader_versions(id),
  user_id             UUID        NOT NULL REFERENCES auth.users(id),

  -- 参照トレール
  scenario_id         UUID        REFERENCES public.ai_trader_scenarios(id),
  decision_id         UUID        REFERENCES public.trade_decisions(id),
  command_id          UUID        REFERENCES public.execution_commands(id),

  -- MT5識別
  magic_number        INTEGER     NOT NULL,
  symbol              TEXT        NOT NULL DEFAULT 'GOLD#',
  side                TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),

  -- MT5チケット（Bridge EA から取得）
  order_ticket        BIGINT,
  position_ticket     BIGINT,
  entry_deal_ticket   BIGINT,
  exit_deal_ticket    BIGINT,

  -- 価格・数量
  volume              NUMERIC     NOT NULL,
  entry_price         NUMERIC,
  stop_loss           NUMERIC,
  take_profit         NUMERIC,
  exit_price          NUMERIC,

  -- 損益
  realized_profit     NUMERIC,
  realized_pips       NUMERIC,

  -- 状態
  status              TEXT        NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'CLOSED', 'ERROR')),

  -- タイムスタンプ
  opened_at           TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  duration_seconds    INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_positions_trader
  ON public.ai_positions (ai_trader_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_positions_magic
  ON public.ai_positions (magic_number, status);

CREATE INDEX IF NOT EXISTS idx_ai_positions_position_ticket
  ON public.ai_positions (position_ticket);

-- RLS
ALTER TABLE public.ai_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_positions_own"
  ON public.ai_positions FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "ai_positions_service_role"
  ON public.ai_positions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── system_settings（グローバルKill Switch等）───────────────────

CREATE TABLE IF NOT EXISTS public.system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- グローバル Kill Switch（初期値: ENABLED）
INSERT INTO public.system_settings (key, value, description)
  VALUES (
    'demo_execution_enabled',
    'false',                              -- 管理者が明示的にtrueにするまで無効
    'DEMO_AUTONOMOUS実行を許可するグローバルスイッチ。falseの場合は全AI Traderの自律実行を停止。'
  )
  ON CONFLICT (key) DO NOTHING;

-- RLS（読み取りは全ユーザー、書き込みはservice_roleのみ）
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "system_settings_read"
  ON public.system_settings FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "system_settings_service_role"
  ON public.system_settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.system_settings IS
  'システム全体の設定値。demo_execution_enabled=trueになるまでDEMO自律実行は停止。';

COMMENT ON TABLE public.ai_positions IS
  'AI Traderが開いたポジションを追跡するテーブル。'
  'MT5チケット番号（order/position/deal）を保存し、'
  'ポジションクローズ時に自動的にtrade_outcomeを生成する。';
