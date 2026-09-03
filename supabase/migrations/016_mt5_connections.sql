-- =================================================================
-- 016: MT5 Connection Model
--
-- Architecture: 共通Execution Bridge EA方式
--   - StrategyごとにEAを生成しない
--   - 1ユーザー = 1 MT5接続 + 共通Bridge EA
--   - Connection Token でAVL-FXとMT5をpairing
--
-- Security:
--   - MT5 Passwordは保存しない
--   - connection_token_hash のみ保存（SHA-256）
--   - RLS: user_idで完全分離
-- =================================================================

CREATE TABLE IF NOT EXISTS public.mt5_connections (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- ユーザー紐付け（RLS基点）
  user_id               UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 接続認証（Tokenをhash保存。平文は保存しない）
  connection_token_hash TEXT          NOT NULL,

  -- ブローカー情報
  broker                TEXT          NOT NULL,
  server_name           TEXT          NOT NULL,
  mt5_login             BIGINT        NOT NULL,
  account_currency      TEXT          NOT NULL DEFAULT 'USD',
  account_type          TEXT          NOT NULL DEFAULT 'DEMO'
                        CHECK (account_type IN ('REAL', 'DEMO')),

  -- MT5口座モード（Hedging/Nettingで挙動が異なる）
  account_mode          TEXT          NOT NULL DEFAULT 'HEDGING'
                        CHECK (account_mode IN ('HEDGING', 'NETTING')),

  leverage              INTEGER,

  -- 接続状態
  status                TEXT          NOT NULL DEFAULT 'DISCONNECTED'
                        CHECK (status IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR')),

  -- Safety Flags
  emergency_stop        BOOLEAN       NOT NULL DEFAULT false,
  trading_enabled       BOOLEAN       NOT NULL DEFAULT false,

  -- タイムスタンプ
  last_heartbeat_at     TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ,
  disconnected_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一ユーザーが同じMT5 login/serverを二重登録しない
  UNIQUE (user_id, mt5_login, server_name)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_mt5_connections_user_id
  ON public.mt5_connections (user_id);

CREATE INDEX IF NOT EXISTS idx_mt5_connections_status
  ON public.mt5_connections (status);

-- RLS
ALTER TABLE public.mt5_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mt5_connections_select_own"
  ON public.mt5_connections FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "mt5_connections_insert_own"
  ON public.mt5_connections FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "mt5_connections_update_own"
  ON public.mt5_connections FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "mt5_connections_delete_own"
  ON public.mt5_connections FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Service Role（API Route / Gateway更新用）
CREATE POLICY "mt5_connections_service_role"
  ON public.mt5_connections FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.mt5_connections IS
  'MT5とAVL-FXの接続管理。共通Execution Bridge EA方式で1ユーザー1接続。'
  'MT5 Passwordは保存しない。Connection Tokenのhashのみ保存。';

COMMENT ON COLUMN public.mt5_connections.connection_token_hash IS
  'Bridge EAとのpairing用Token（SHA-256 hash）。平文は保存しない。';

COMMENT ON COLUMN public.mt5_connections.emergency_stop IS
  'true の場合、このConnectionからのすべての新規注文をブロックする。';

COMMENT ON COLUMN public.mt5_connections.trading_enabled IS
  'false の場合、Signal生成はされるがExecution Commandを発行しない。';
