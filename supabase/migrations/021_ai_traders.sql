-- =================================================================
-- 021_ai_traders.sql
-- AI Trader システム
--
-- 設計原則:
--   - ai_traders: トレーダー本体（customer_id = user_id）
--   - ai_trader_versions: Profileスナップショット（削除不可）
--   - ai_trader_knowledge: Version ↔ Knowledge の紐付け（Console IDを参照）
--   - execution_commands / strategy_registry とは将来接続可能
--   - AI が自動的に ACTIVE 化することは禁止
--   - Live Trading は Phase 1 では実装しない
-- =================================================================

-- ─── ai_traders ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_traders (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 所有者（ユーザー分離）
  user_id          UUID          REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 共有用公開ID（cryptographically random、16-32文字英数字）
  public_id        TEXT          NOT NULL UNIQUE
                   CHECK (length(public_id) BETWEEN 16 AND 32),

  -- 基本情報
  name             TEXT          NOT NULL CHECK (length(name) BETWEEN 2 AND 50),
  description      TEXT,

  -- 対象Market（将来USDJPY等へ拡張可能）
  market           TEXT          NOT NULL DEFAULT 'GOLD',

  -- ステータス
  status           TEXT          NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),

  -- 現在の有効バージョン番号
  current_version  INTEGER       NOT NULL DEFAULT 1,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_traders_user_id
  ON public.ai_traders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_traders_public_id
  ON public.ai_traders (public_id);

-- ─── ai_trader_versions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_trader_versions (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  ai_trader_id          UUID          NOT NULL
                        REFERENCES public.ai_traders(id) ON DELETE CASCADE,

  version               INTEGER       NOT NULL CHECK (version >= 1),

  -- AI Traderの人格
  personality           TEXT          NOT NULL DEFAULT 'BALANCED'
                        CHECK (personality IN ('CONSERVATIVE', 'BALANCED', 'AGGRESSIVE')),

  -- 取引スタイル
  trading_style         TEXT          NOT NULL DEFAULT 'TREND_FOLLOWING'
                        CHECK (trading_style IN (
                          'TREND_FOLLOWING', 'BREAKOUT', 'REVERSAL',
                          'PRICE_ACTION', 'MULTI_TIMEFRAME', 'HYBRID'
                        )),

  -- リスク特性
  risk_profile          TEXT          NOT NULL DEFAULT 'MEDIUM'
                        CHECK (risk_profile IN ('VERY_LOW', 'LOW', 'MEDIUM', 'HIGH')),

  -- エントリーの慎重さ
  entry_patience        TEXT          NOT NULL DEFAULT 'NORMAL'
                        CHECK (entry_patience IN ('VERY_PATIENT', 'PATIENT', 'NORMAL', 'AGGRESSIVE')),

  -- ニュースへの警戒度
  news_sensitivity      TEXT          NOT NULL DEFAULT 'MEDIUM'
                        CHECK (news_sensitivity IN ('HIGH', 'MEDIUM', 'LOW')),

  -- ボラティリティへの対応
  volatility_preference TEXT          NOT NULL DEFAULT 'NORMAL'
                        CHECK (volatility_preference IN ('LOW', 'NORMAL', 'HIGH')),

  -- 使用時間足
  timeframes            TEXT[]        NOT NULL DEFAULT '{"H4"}',

  -- リスク管理数値
  minimum_rr            NUMERIC       DEFAULT 1.5 CHECK (minimum_rr > 0),
  max_risk_per_trade    NUMERIC       DEFAULT 1.0 CHECK (max_risk_per_trade > 0),
  max_positions         INTEGER       DEFAULT 1 CHECK (max_positions >= 1),

  -- AIへの追加指示（自然言語）
  instructions          TEXT,

  -- AI生成時の設定メタデータ（モデル名・温度等）
  model_config          JSONB         NOT NULL DEFAULT '{}',

  -- ユーザーが入力した自然言語プロンプト原文
  raw_prompt            TEXT,

  -- 将来の Strategy/Execution 基盤との接続用
  -- strategy_id: 将来的にai_traderがMT5に注文するとき参照するstrategy
  strategy_id           UUID          REFERENCES public.strategy_registry(id),

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一Trader内でVersionは一意（削除不可・上書き禁止）
  UNIQUE(ai_trader_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_trader_versions_trader
  ON public.ai_trader_versions (ai_trader_id, version DESC);

-- ─── ai_trader_knowledge ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_trader_knowledge (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  ai_trader_version_id  UUID          NOT NULL
                        REFERENCES public.ai_trader_versions(id) ON DELETE CASCADE,

  -- Console側のknowledge ID（Console DBへ直接FKは張らない）
  knowledge_id          TEXT          NOT NULL,

  -- Knowledge更新で既存Traderの挙動が変わらないようにVersion固定
  knowledge_version     INTEGER,

  -- 選択時のタイトルスナップショット（Console側が変わっても参照可能）
  knowledge_title       TEXT,
  knowledge_category    TEXT,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE(ai_trader_version_id, knowledge_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_trader_knowledge_version
  ON public.ai_trader_knowledge (ai_trader_version_id);

-- ─── RLS ──────────────────────────────────────────────────────────
-- ai_traders: ユーザー分離
ALTER TABLE public.ai_traders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_traders_select_own"
  ON public.ai_traders FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "ai_traders_insert_own"
  ON public.ai_traders FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "ai_traders_update_own"
  ON public.ai_traders FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "ai_traders_delete_own"
  ON public.ai_traders FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "ai_traders_service_role"
  ON public.ai_traders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ai_trader_versions: 親を通したユーザー分離
ALTER TABLE public.ai_trader_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_trader_versions_select"
  ON public.ai_trader_versions FOR SELECT TO authenticated
  USING (
    ai_trader_id IN (
      SELECT id FROM public.ai_traders WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "ai_trader_versions_service_role"
  ON public.ai_trader_versions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ai_trader_knowledge: 親バージョンを通したユーザー分離
ALTER TABLE public.ai_trader_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_trader_knowledge_select"
  ON public.ai_trader_knowledge FOR SELECT TO authenticated
  USING (
    ai_trader_version_id IN (
      SELECT v.id FROM public.ai_trader_versions v
      JOIN public.ai_traders t ON t.id = v.ai_trader_id
      WHERE t.user_id = auth.uid()
    )
  );

CREATE POLICY "ai_trader_knowledge_service_role"
  ON public.ai_trader_knowledge FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── コメント ─────────────────────────────────────────────────────
COMMENT ON TABLE public.ai_traders IS
  'AI Trader 本体。customer_id=user_id によるユーザー分離。'
  'public_idで将来的なTrader共有が可能。';

COMMENT ON TABLE public.ai_trader_versions IS
  'AI Trader の Profile スナップショット。削除・上書き禁止。'
  'Rollback は新しい Version として作成する。'
  'strategy_idで将来のMT5 Execution基盤に接続可能。';

COMMENT ON TABLE public.ai_trader_knowledge IS
  'AI Trader Version ↔ Trading Knowledge の紐付け。'
  'knowledge_versionで選択時点のVersion固定（再現性保持）。'
  'Console Supabase への直接FK は張らない（API境界を守る）。';

COMMENT ON COLUMN public.ai_trader_versions.strategy_id IS
  '将来的にAI TraderがMT5注文時に使用するStrategy ID。'
  'Phase 1では未使用。Phase 3でExecution Engine接続時に設定する。';
