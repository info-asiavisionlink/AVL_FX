-- =================================================================
-- 018: Strategy Signal Model
--
-- SignalとExecution Commandを分離する。
--
-- Signal:
--   「StrategyEvaluatorがBUY/SELLと判断した」事実の記録
--
-- Execution Command:
--   「Risk/Safety確認後、実際にMT5へ注文を依頼する」Contract
--
-- Signal → Command は必ずしも1:1ではない。
-- Riskで弾かれた場合、Signalは記録されるがCommandは発行されない。
-- これにより「なぜこの取引が行われたか」を追跡できる。
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_signals (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Strategy追跡
  strategy_id           UUID          NOT NULL REFERENCES public.strategy_registry(id),
  connection_id         UUID          REFERENCES public.mt5_connections(id),

  -- シグナル内容
  symbol                TEXT          NOT NULL,
  timeframe             TEXT          NOT NULL,
  direction             TEXT          NOT NULL
                        CHECK (direction IN ('BUY', 'SELL', 'EXIT_LONG', 'EXIT_SHORT')),

  -- タイミング
  signal_time           TIMESTAMPTZ   NOT NULL,   -- シグナル生成時刻
  bar_time              TIMESTAMPTZ   NOT NULL,   -- 評価対象バーの時刻

  reference_price       NUMERIC,
  suggested_sl          NUMERIC,
  suggested_tp          NUMERIC,

  -- 実行状態
  execution_status      TEXT          NOT NULL DEFAULT 'PENDING'
                        CHECK (execution_status IN (
                          'PENDING',    -- Risk/Safety確認待ち
                          'EXECUTED',   -- Commandを発行した
                          'REJECTED',   -- Risk/Safetyで棄却
                          'SKIPPED',    -- Emergency Stop等で無視
                          'EXPIRED'     -- 処理前に期限切れ
                        )),

  -- Signal → Command追跡
  command_id            UUID          REFERENCES public.execution_commands(id),

  -- StrategyEvaluatorの出力詳細（デバッグ・監査用）
  reason                JSONB,
  metadata              JSONB,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- signal_id FK を execution_commands に追加
ALTER TABLE public.execution_commands
  ADD CONSTRAINT fk_execution_commands_signal_id
  FOREIGN KEY (signal_id) REFERENCES public.strategy_signals(id);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_strategy_signals_strategy_id
  ON public.strategy_signals (strategy_id);

CREATE INDEX IF NOT EXISTS idx_strategy_signals_connection_id
  ON public.strategy_signals (connection_id);

CREATE INDEX IF NOT EXISTS idx_strategy_signals_signal_time
  ON public.strategy_signals (signal_time DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_signals_symbol_tf
  ON public.strategy_signals (symbol, timeframe);

-- RLS
ALTER TABLE public.strategy_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strategy_signals_select_own"
  ON public.strategy_signals FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM public.strategy_registry WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "strategy_signals_service_role"
  ON public.strategy_signals FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.strategy_signals IS
  'StrategyEvaluatorが生成したシグナルの記録。'
  'ExecutionCommandとは分離。Risk棄却されたSignalも記録される。'
  'Signal → Command → MT5の完全な監査証跡を保持。';
