-- =================================================================
-- 022_ai_trader_scenarios.sql
-- AI Trader Scenario Memory
--
-- AI Trader が現在の相場に対して持つシナリオを記録する。
-- シナリオはVersion管理され、invalidate条件に達するまで保持される。
--
-- 設計:
--   - 1 AI Trader = 1 アクティブシナリオ（複数持てるが active = true は1つ）
--   - AI が自分のシナリオを直接書き換えてはいけない
--   - Market Watcher トリガーで再評価し、必要な場合のみ更新
-- =================================================================

CREATE TABLE IF NOT EXISTS public.ai_trader_scenarios (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 所有者
  ai_trader_id     UUID          NOT NULL
                   REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id          UUID          NOT NULL REFERENCES auth.users(id),

  -- アクティブ状態
  is_active        BOOLEAN       NOT NULL DEFAULT true,

  -- シナリオ内容（AI が生成した JSON）
  state            TEXT          NOT NULL DEFAULT 'WAITING'
                   CHECK (state IN ('WAITING','WATCHING','CONSIDERING','DECIDED','INVALID')),

  bias             TEXT          CHECK (bias IN ('LONG', 'SHORT', 'NEUTRAL')),

  scenario_text    TEXT,         -- 自然言語シナリオ説明

  -- 監視ゾーン（オプション）
  watch_zone_low   NUMERIC,
  watch_zone_high  NUMERIC,

  -- 無効化条件
  invalidate_below NUMERIC,
  invalidate_above NUMERIC,

  -- 再チェックトリガー
  recheck_triggers TEXT[]        NOT NULL DEFAULT '{}',

  -- 参照データ
  market           TEXT          NOT NULL DEFAULT 'GOLD',
  reference_price  NUMERIC,
  bar_time         TIMESTAMPTZ,  -- このシナリオを作成した時点のバー時刻

  -- AI生成メタ
  ai_model         TEXT,
  ai_reasoning     TEXT,         -- AIの判断理由

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_trader_scenarios_trader
  ON public.ai_trader_scenarios (ai_trader_id, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_trader_scenarios_user
  ON public.ai_trader_scenarios (user_id, is_active);

-- RLS
ALTER TABLE public.ai_trader_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_trader_scenarios_own"
  ON public.ai_trader_scenarios FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "ai_trader_scenarios_service_role"
  ON public.ai_trader_scenarios FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_trader_scenarios IS
  'AI Trader の現在のシナリオメモリ。'
  'Market Watcher トリガーで再評価し、必要な場合のみ更新する。'
  'AI が直接 ACTIVE Knowledge に書き込むことは禁止。';
