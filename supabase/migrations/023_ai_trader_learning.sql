-- =================================================================
-- 023_ai_trader_learning.sql
-- AI Trader Learning System
--
-- trade_decisions:     AI が下した判断の記録（承認前も含む）
-- trade_outcomes:      実際の取引結果（execution_command と紐付け）
-- trade_reviews:       AI が行うトレード振り返り
-- experience_memories: 検証を経た知見（仮説ではなく確認済み経験）
--
-- 安全ルール:
--   - experience_memories への直接 ACTIVE 化は禁止
--   - 仮説 → Walk Forward → Paper → Validated の段階を必須とする
--   - AI が自動でバージョンを書き換えることは禁止
-- =================================================================

-- ─── trade_decisions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_decisions (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  ai_trader_id     UUID          NOT NULL
                   REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  ai_trader_version_id UUID      REFERENCES public.ai_trader_versions(id),
  user_id          UUID          NOT NULL REFERENCES auth.users(id),
  scenario_id      UUID          REFERENCES public.ai_trader_scenarios(id),

  -- 判断内容
  decision         TEXT          NOT NULL
                   CHECK (decision IN ('BUY', 'SELL', 'WAIT', 'EXIT')),

  market           TEXT          NOT NULL DEFAULT 'GOLD',
  symbol           TEXT          NOT NULL DEFAULT 'GOLD#',

  -- 価格情報（判断時点）
  reference_price  NUMERIC,
  suggested_sl     NUMERIC,
  suggested_tp     NUMERIC,
  suggested_volume NUMERIC,

  -- AI の判断理由
  reasoning        TEXT,

  -- 市場コンテキスト（判断時の最新バー要約）
  market_context   JSONB         NOT NULL DEFAULT '{}',

  -- 承認状態
  status           TEXT          NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN (
                     'PENDING',   -- ユーザー承認待ち
                     'APPROVED',  -- ユーザーが承認 → execution_command 発行
                     'REJECTED',  -- ユーザーが却下
                     'EXPIRED',   -- タイムアウト（未承認のまま無効）
                     'CANCELLED'  -- AI が判断を撤回
                   )),

  -- 承認・却下時の execution_command ID
  command_id       UUID          REFERENCES public.execution_commands(id),

  -- 有効期限（未承認のまま放置しない）
  expires_at       TIMESTAMPTZ   NOT NULL,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ   -- 承認・却下されたとき
);

CREATE INDEX IF NOT EXISTS idx_trade_decisions_trader
  ON public.trade_decisions (ai_trader_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_decisions_user
  ON public.trade_decisions (user_id, status, created_at DESC);

-- ─── trade_outcomes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_outcomes (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  decision_id      UUID          NOT NULL UNIQUE
                   REFERENCES public.trade_decisions(id) ON DELETE CASCADE,
  ai_trader_id     UUID          NOT NULL
                   REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id          UUID          NOT NULL REFERENCES auth.users(id),

  -- 結果
  outcome          TEXT          NOT NULL
                   CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN', 'CANCELLED')),

  entry_price      NUMERIC,
  exit_price       NUMERIC,
  pips             NUMERIC,        -- 正 = 利益、負 = 損失
  profit_usd       NUMERIC,

  entry_time       TIMESTAMPTZ,
  exit_time        TIMESTAMPTZ,

  -- MT5 チケット（Source of Truth は MT5）
  broker_ticket    BIGINT,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_outcomes_trader
  ON public.trade_outcomes (ai_trader_id, created_at DESC);

-- ─── trade_reviews ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_reviews (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  outcome_id       UUID          NOT NULL UNIQUE
                   REFERENCES public.trade_outcomes(id) ON DELETE CASCADE,
  ai_trader_id     UUID          NOT NULL
                   REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id          UUID          NOT NULL REFERENCES auth.users(id),

  -- AI の振り返り
  review_text      TEXT,           -- 日本語の振り返り文
  what_worked      TEXT,           -- うまくいった点
  what_failed      TEXT,           -- うまくいかなかった点
  hypothesis       TEXT,           -- 今後の仮説

  -- 信頼度
  confidence       INTEGER         CHECK (confidence BETWEEN 1 AND 5),

  -- 検証フラグ（仮説を Walk Forward で検証したか）
  validated        BOOLEAN         NOT NULL DEFAULT false,
  validated_at     TIMESTAMPTZ,

  created_at       TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ─── experience_memories ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.experience_memories (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  ai_trader_id     UUID          NOT NULL
                   REFERENCES public.ai_traders(id) ON DELETE CASCADE,
  user_id          UUID          NOT NULL REFERENCES auth.users(id),

  -- 知見の内容
  title            TEXT          NOT NULL,
  insight          TEXT          NOT NULL,   -- 検証済みの知見
  market_condition TEXT,         -- どんな相場状況で有効か

  -- 元となったレビュー
  source_review_id UUID          REFERENCES public.trade_reviews(id),

  -- 安全ルール: HYPOTHESIS → VALIDATED の段階必須
  -- AI は自動で VALIDATED にできない
  status           TEXT          NOT NULL DEFAULT 'HYPOTHESIS'
                   CHECK (status IN (
                     'HYPOTHESIS',  -- 仮説段階（まだ使わない）
                     'TESTING',     -- Walk Forward / Paper で検証中
                     'VALIDATED',   -- 検証通過（AI Trader が参照可能）
                     'REJECTED'     -- 検証で棄却
                   )),

  confidence       INTEGER         CHECK (confidence BETWEEN 1 AND 5),

  created_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_experience_memories_trader
  ON public.experience_memories (ai_trader_id, status);

-- ─── RLS ──────────────────────────────────────────────────────────
ALTER TABLE public.trade_decisions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_outcomes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_reviews        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experience_memories  ENABLE ROW LEVEL SECURITY;

-- trade_decisions: ユーザー自身のみ読み書き + ステータス変更（ユーザーは status 変更のみ）
CREATE POLICY "trade_decisions_own" ON public.trade_decisions
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "trade_outcomes_own" ON public.trade_outcomes
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "trade_reviews_own" ON public.trade_reviews
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "experience_memories_own" ON public.experience_memories
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Service Role
CREATE POLICY "trade_decisions_svc"     ON public.trade_decisions     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "trade_outcomes_svc"      ON public.trade_outcomes      FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "trade_reviews_svc"       ON public.trade_reviews       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "experience_memories_svc" ON public.experience_memories FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.trade_decisions IS
  'AI Trader の取引判断記録。PENDING = ユーザー承認待ち。'
  'AI が直接 APPROVED にすることは禁止（必ずユーザーが承認する）。';

COMMENT ON TABLE public.experience_memories IS
  'AI Trader の検証済み知見。HYPOTHESIS から Walk Forward → VALIDATED の段階必須。'
  'AI が自動で VALIDATED にすることは禁止。';
