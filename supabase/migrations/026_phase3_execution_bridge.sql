-- =================================================================
-- 026_phase3_execution_bridge.sql
-- Phase 3 Execution Bridge — 既存テーブルへのパッチ
--
-- 変更内容:
--   execution_commands : strategy_id nullable化 + ai_trader_id/ai_position_id FK追加
--   trade_decisions    : decision CHECK を拡張（ENTER_LONG/SHORT 等）
--   ai_positions       : command_id FK 追加
-- =================================================================

-- ─── execution_commands へのパッチ ──────────────────────────────

-- strategy_id は AI Trader 起点のコマンドでは null を許容
ALTER TABLE public.execution_commands
  ALTER COLUMN strategy_id DROP NOT NULL;

-- AI Trader 追跡用 FK
ALTER TABLE public.execution_commands
  ADD COLUMN IF NOT EXISTS ai_trader_id   UUID REFERENCES public.ai_traders(id) ON DELETE SET NULL;

ALTER TABLE public.execution_commands
  ADD COLUMN IF NOT EXISTS ai_position_id UUID REFERENCES public.ai_positions(id) ON DELETE SET NULL;

-- strategy_id か ai_trader_id のどちらかは必須
ALTER TABLE public.execution_commands
  DROP CONSTRAINT IF EXISTS execution_commands_requires_origin;
ALTER TABLE public.execution_commands
  ADD CONSTRAINT execution_commands_requires_origin
    CHECK (strategy_id IS NOT NULL OR ai_trader_id IS NOT NULL);

-- ─── trade_decisions の decision CHECK 拡張 ──────────────────────
-- 既存: BUY / SELL / WAIT / EXIT
-- 追加: ENTER_LONG / ENTER_SHORT / MANAGE_POSITION / INVALIDATE
--       WATCH / LONG_SETUP / SHORT_SETUP（AI 応答との整合性）

ALTER TABLE public.trade_decisions
  DROP CONSTRAINT IF EXISTS trade_decisions_decision_check;

ALTER TABLE public.trade_decisions
  ADD CONSTRAINT trade_decisions_decision_check
    CHECK (decision IN (
      'BUY', 'SELL', 'WAIT', 'EXIT',         -- 既存
      'ENTER_LONG', 'ENTER_SHORT',             -- Phase 3: 実行候補
      'MANAGE_POSITION', 'INVALIDATE',         -- Phase 3: ポジション管理
      'WATCH', 'LONG_SETUP', 'SHORT_SETUP'     -- Phase 2: セットアップ確認
    ));

-- ─── ai_positions に execution_command_id FK 追加 ───────────────
-- （025 で ai_positions を作成後、execution_commands への逆参照）

ALTER TABLE public.ai_positions
  ADD COLUMN IF NOT EXISTS execution_command_id UUID
    REFERENCES public.execution_commands(id) ON DELETE SET NULL;

-- ─── ai_positions: exit_command_id を追加 ──────────────────────
ALTER TABLE public.ai_positions
  ADD COLUMN IF NOT EXISTS exit_command_id UUID
    REFERENCES public.execution_commands(id) ON DELETE SET NULL;

-- ─── ai_positions: review_id ────────────────────────────────────
ALTER TABLE public.ai_positions
  ADD COLUMN IF NOT EXISTS review_dispatched BOOLEAN NOT NULL DEFAULT false;

-- ─── インデックス追加 ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_execution_commands_ai_trader
  ON public.execution_commands (ai_trader_id)
  WHERE ai_trader_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_commands_ai_position
  ON public.execution_commands (ai_position_id)
  WHERE ai_position_id IS NOT NULL;

-- ─── Supabase DB migration 適用後の確認メモ ─────────────────────
-- execution_commands.strategy_id が nullable になったことを確認
-- trade_decisions.decision に ENTER_LONG/ENTER_SHORT が追加されたことを確認
-- ai_positions.execution_command_id / exit_command_id が追加されたことを確認
