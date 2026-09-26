-- =================================================================
-- 024_ai_trader_watcher.sql
-- Event-Driven AI Trader Watcher
--
-- 変更内容:
--   ai_traders       : watcher_state, last_watcher_check_at, last_analysis_at 追加
--   ai_trader_scenarios: recheck_triggers_v2(JSONB), trigger_type, m5_bar_time 追加
--   watcher_events   : M5確定イベントの重複防止テーブル（新規）
-- =================================================================

-- ─── ai_traders への列追加 ───────────────────────────────────────
ALTER TABLE public.ai_traders
  ADD COLUMN IF NOT EXISTS watcher_state         TEXT         DEFAULT 'SLEEPING'
    CHECK (watcher_state IN ('SLEEPING','WATCHING','TRIGGERED','ANALYZING','ERROR')),
  ADD COLUMN IF NOT EXISTS last_watcher_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_analysis_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.ai_traders.watcher_state IS
  'Market Watcherが管理する現在の監視状態。'
  'SLEEPING=監視不要 WATCHING=監視中 TRIGGERED=トリガー成立 ANALYZING=AI分析中 ERROR=エラー';

-- ─── ai_trader_scenarios への列追加 ─────────────────────────────
ALTER TABLE public.ai_trader_scenarios
  ADD COLUMN IF NOT EXISTS recheck_triggers_v2 JSONB        DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS trigger_type        TEXT,
  ADD COLUMN IF NOT EXISTS m5_bar_time         BIGINT;

COMMENT ON COLUMN public.ai_trader_scenarios.recheck_triggers_v2 IS
  '構造化された再評価トリガー。例: [{"type":"PRICE_ENTERS_ZONE","low":3650,"high":3660}]';

COMMENT ON COLUMN public.ai_trader_scenarios.trigger_type IS
  'このシナリオを生成したトリガー種別（FIRST_RUN / PRICE_ENTERS_ZONE 等）';

COMMENT ON COLUMN public.ai_trader_scenarios.m5_bar_time IS
  'このシナリオを生成したM5バーの時刻（Unix秒）。重複防止に使用。';

-- ─── watcher_events（重複防止テーブル）──────────────────────────
CREATE TABLE IF NOT EXISTS public.watcher_events (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id            UUID        NOT NULL REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id              UUID        NOT NULL REFERENCES auth.users(id),
  symbol               TEXT        NOT NULL,
  m5_bar_time          BIGINT      NOT NULL,
  trigger_type         TEXT        NOT NULL,
  triggered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  analysis_dispatched  BOOLEAN     NOT NULL DEFAULT false,
  analysis_result      TEXT,

  -- 同一M5バー × 同一トリガーの重複防止
  UNIQUE (trader_id, m5_bar_time, trigger_type)
);

CREATE INDEX IF NOT EXISTS idx_watcher_events_trader
  ON public.watcher_events (trader_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_watcher_events_symbol_bar
  ON public.watcher_events (symbol, m5_bar_time);

-- RLS
ALTER TABLE public.watcher_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watcher_events_own"
  ON public.watcher_events FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "watcher_events_service_role"
  ON public.watcher_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.watcher_events IS
  'M5確定イベントの処理記録。(trader_id, m5_bar_time, trigger_type) のUNIQUE制約で重複AI呼び出しを防止する。';
