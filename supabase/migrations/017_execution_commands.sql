-- =================================================================
-- 017: Execution Command Contract
--
-- AVL-FX → MT5 への唯一の正式注文Contract。
--
-- 設計原則:
--   - command_id UNIQUE → Idempotency保証
--   - expires_at → 古いSignalの遅延実行を防止
--   - Terminal State → 再実行不可（FILLED/REJECTED/FAILED/EXPIRED/CANCELLED）
--   - signal_id → Signal → Command → MT5 の監査証跡
--   - magic_number → MT5上でStrategy単位の注文識別
--
-- Source of Truth:
--   AVL-FX = Command発行者
--   MT5/Broker = 実際の執行（broker_*チケットが最終確認）
-- =================================================================

CREATE TABLE IF NOT EXISTS public.execution_commands (
  id                      UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Idempotency Key（重複Command防止。Gateway/EAが同一IDを再取得しても再注文しない）
  command_id              TEXT          NOT NULL UNIQUE,

  -- 所有者
  user_id                 UUID          NOT NULL REFERENCES auth.users(id),
  connection_id           UUID          NOT NULL REFERENCES public.mt5_connections(id),

  -- Strategy追跡（signal_id → command → MT5の監査証跡）
  strategy_id             UUID          NOT NULL REFERENCES public.strategy_registry(id),
  magic_number            INTEGER       NOT NULL,
  signal_id               UUID,         -- FKは018_strategy_signals後に追加

  -- 注文内容
  action                  TEXT          NOT NULL
                          CHECK (action IN ('BUY', 'SELL', 'CLOSE', 'MODIFY_SL', 'MODIFY_TP')),
  symbol                  TEXT          NOT NULL,
  volume                  NUMERIC       CHECK (volume > 0),

  requested_price         NUMERIC,
  stop_loss               NUMERIC,
  take_profit             NUMERIC,

  -- CLOSE/MODIFY用
  position_ticket         BIGINT,
  order_ticket            BIGINT,

  -- Command State Machine
  -- PENDING → CLAIMED → EXECUTING → FILLED（正常）
  -- PENDING → EXPIRED（期限切れ）
  -- CLAIMING/EXECUTING → FAILED（MT5エラー）
  -- any non-terminal → CANCELLED
  status                  TEXT          NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN (
                            'PENDING',    -- Gateway取得待ち
                            'CLAIMED',    -- EAが取得済み（処理中）
                            'EXECUTING',  -- MT5へ注文送信済み
                            'FILLED',     -- 約定完了（Terminal）
                            'REJECTED',   -- Broker拒否（Terminal）
                            'FAILED',     -- MT5/Gateway障害（Terminal）
                            'EXPIRED',    -- 期限切れ（Terminal）
                            'CANCELLED'   -- 手動キャンセル（Terminal）
                          )),

  -- タイムスタンプ
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ   NOT NULL,  -- 必須: 遅延実行防止
  claimed_at              TIMESTAMPTZ,
  executed_at             TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,

  -- 実行試行回数
  attempt_count           INTEGER       NOT NULL DEFAULT 0,

  -- MT5実行結果（Brokerが最終Source of Truth）
  broker_order_ticket     BIGINT,
  broker_deal_ticket      BIGINT,
  broker_position_ticket  BIGINT,
  execution_price         NUMERIC,
  executed_volume         NUMERIC,

  -- エラー情報
  error_code              INTEGER,
  error_message           TEXT,

  -- 任意メタデータ（デバッグ・拡張用）
  metadata                JSONB
);

-- インデックス
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_commands_command_id
  ON public.execution_commands (command_id);

CREATE INDEX IF NOT EXISTS idx_execution_commands_user_id
  ON public.execution_commands (user_id);

CREATE INDEX IF NOT EXISTS idx_execution_commands_connection_id
  ON public.execution_commands (connection_id);

CREATE INDEX IF NOT EXISTS idx_execution_commands_strategy_id
  ON public.execution_commands (strategy_id);

CREATE INDEX IF NOT EXISTS idx_execution_commands_status
  ON public.execution_commands (status);

CREATE INDEX IF NOT EXISTS idx_execution_commands_status_expires
  ON public.execution_commands (status, expires_at)
  WHERE status = 'PENDING';

-- RLS
ALTER TABLE public.execution_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "execution_commands_select_own"
  ON public.execution_commands FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ユーザーはExecution Commandを直接作成できない
-- Signal → Execution Engineのみが作成可能（Service Role経由）
CREATE POLICY "execution_commands_service_role"
  ON public.execution_commands FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.execution_commands IS
  'AVL-FX → MT5 への唯一の正式注文Contract。'
  'command_id UNIQUEによるIdempotency保証。'
  'Terminal State（FILLED/REJECTED/FAILED/EXPIRED/CANCELLED）に一度到達したら再実行不可。';

COMMENT ON COLUMN public.execution_commands.command_id IS
  'Idempotency Key。UUIDv4推奨。Gateway/EAが同一IDを再取得しても再注文しない。';

COMMENT ON COLUMN public.execution_commands.expires_at IS
  '注文有効期限。EAはこの時刻を過ぎた場合MT5へ送信せずEXPIREDとして報告する。';

COMMENT ON COLUMN public.execution_commands.magic_number IS
  'MT5上でStrategy単位の注文を識別するMagic Number（strategy_registryのmagic_numberと一致）。';

COMMENT ON COLUMN public.execution_commands.signal_id IS
  '発生元Signal ID。Signal → Command → MT5 の監査証跡を保持。';
