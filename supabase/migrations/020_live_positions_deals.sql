-- =================================================================
-- 020: Live Positions / Deals
--
-- Source of Truth の明確化:
--   MT5/Broker = Position/Deal の最終権威
--   AVL-FX DB  = MT5のミラー（Operational State）
--
--   DBだけを見てBroker Positionが存在すると断定しない。
--   MT5側との定期同期で整合性を確認する設計。
--
-- live_positions: 現在保有中のポジション（MT5 PositionのMirror）
-- live_deals:     約定済みDeal履歴（Live Performance計算の基盤）
--
-- Note: live_orders（Pending Order）は将来追加予定。
--       現フェーズではFill-or-Kill相当のMarket Orderのみを想定。
-- =================================================================

-- ─── live_positions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_positions (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 所有者
  user_id               UUID          NOT NULL REFERENCES auth.users(id),
  connection_id         UUID          NOT NULL REFERENCES public.mt5_connections(id),

  -- Strategy追跡
  strategy_id           UUID          REFERENCES public.strategy_registry(id),
  magic_number          INTEGER,

  -- MT5 Position識別（同一Connection内で一意）
  position_ticket       BIGINT        NOT NULL,
  symbol                TEXT          NOT NULL,
  direction             TEXT          NOT NULL CHECK (direction IN ('BUY', 'SELL')),

  -- ポジション情報
  volume                NUMERIC       NOT NULL,
  open_price            NUMERIC       NOT NULL,
  current_price         NUMERIC,
  stop_loss             NUMERIC,
  take_profit           NUMERIC,

  -- 損益（MT5から定期同期）
  unrealized_pnl        NUMERIC,
  commission            NUMERIC,
  swap                  NUMERIC,

  -- タイムスタンプ
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,

  -- ポジション状態
  status                TEXT          NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'CLOSED', 'PARTIAL')),

  -- 監査証跡（どのCommandから生まれたか）
  open_command_id       UUID          REFERENCES public.execution_commands(id),
  close_command_id      UUID          REFERENCES public.execution_commands(id),

  last_synced_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一Connection内でposition_ticketは一意
  UNIQUE (connection_id, position_ticket)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_live_positions_user_id
  ON public.live_positions (user_id);

CREATE INDEX IF NOT EXISTS idx_live_positions_connection_id
  ON public.live_positions (connection_id);

CREATE INDEX IF NOT EXISTS idx_live_positions_strategy_id
  ON public.live_positions (strategy_id);

CREATE INDEX IF NOT EXISTS idx_live_positions_status
  ON public.live_positions (status)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_live_positions_magic_symbol
  ON public.live_positions (magic_number, symbol)
  WHERE status = 'OPEN';

-- ─── live_deals ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_deals (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 所有者
  user_id               UUID          NOT NULL REFERENCES auth.users(id),
  connection_id         UUID          NOT NULL REFERENCES public.mt5_connections(id),

  -- Strategy追跡
  strategy_id           UUID          REFERENCES public.strategy_registry(id),
  magic_number          INTEGER,

  -- MT5 Deal識別（同一Connection内で一意）
  deal_ticket           BIGINT        NOT NULL,
  order_ticket          BIGINT,
  position_ticket       BIGINT,

  -- Deal内容
  symbol                TEXT          NOT NULL,
  deal_type             TEXT          NOT NULL CHECK (deal_type IN ('BUY', 'SELL')),
  entry_type            TEXT          CHECK (entry_type IN ('IN', 'OUT', 'INOUT')),

  volume                NUMERIC       NOT NULL,
  price                 NUMERIC       NOT NULL,
  profit                NUMERIC,
  commission            NUMERIC,
  swap                  NUMERIC,

  deal_time             TIMESTAMPTZ   NOT NULL,

  -- 監査証跡
  command_id            UUID          REFERENCES public.execution_commands(id),

  synced_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一Connection内でdeal_ticketは一意
  UNIQUE (connection_id, deal_ticket)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_live_deals_user_id
  ON public.live_deals (user_id);

CREATE INDEX IF NOT EXISTS idx_live_deals_connection_id
  ON public.live_deals (connection_id);

CREATE INDEX IF NOT EXISTS idx_live_deals_strategy_id
  ON public.live_deals (strategy_id);

CREATE INDEX IF NOT EXISTS idx_live_deals_deal_time
  ON public.live_deals (deal_time DESC);

CREATE INDEX IF NOT EXISTS idx_live_deals_position_ticket
  ON public.live_deals (position_ticket);

-- ─── RLS ────────────────────────────────────────────────────────

ALTER TABLE public.live_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "live_positions_select_own"
  ON public.live_positions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "live_positions_service_role"
  ON public.live_positions FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

ALTER TABLE public.live_deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "live_deals_select_own"
  ON public.live_deals FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "live_deals_service_role"
  ON public.live_deals FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.live_positions IS
  'MT5 Live PositionのMirror。Source of TruthはMT5/Broker。'
  'DBだけを見てPositionが存在すると断定しない。MT5との定期同期が必要。';

COMMENT ON TABLE public.live_deals IS
  'MT5約定済みDealの履歴。Live Performance計算の基盤データ。'
  'DEAL_ENTRY_IN（エントリー）とDEAL_ENTRY_OUT（決済）を別行で記録。';
