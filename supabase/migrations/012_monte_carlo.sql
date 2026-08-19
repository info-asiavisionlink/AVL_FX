-- =================================================================
-- 012_monte_carlo.sql
-- Monte Carlo Simulation 結果の永続化
--
-- Phase 4-C: Monte Carlo Simulation
--
-- 設計原則:
--   - Trade Order Shuffle (Fisher-Yates) のみ対応
--   - AI 非依存: 純粋統計計算
--   - Data Leakage 防止:
--       MC 結果は Optimization / Walk Forward に影響しない
--       Version の自動作成は禁止
--   - Probability of Drawdown Threshold:
--       "Ruin" は誤解を招くため probability_of_drawdown_threshold を使用
--       UI では "P(DD ≥ X%)" と表示
--   - Profit Factor: NULL = infinite (BacktestReporter.safePF() と同定義)
--   - Re-run Backtest:
--       MC 実行時に runBacktest() を再実行してトレードを取得する。
--       実行コンテキスト (symbol, timeframe, period, balance) を保存。
--       既存 backtest_trades テーブルは変更しない。
--   - Strategy Version 追跡:
--       strategy_version_id で実行時の正確な Spec を特定可能。
--       strategy_versions.spec_snapshot を参照すれば MC に使用した Spec を完全再現できる。
--       Version 変更後も過去の MC 結果は正しい Version に紐付いて保持される。
-- =================================================================

CREATE TABLE IF NOT EXISTS public.monte_carlo_results (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id         UUID          NOT NULL
                      REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  -- MC 実行時点の Strategy Version (NULL = バージョン管理開始前の稀なケース)
  -- strategy_versions.spec_snapshot でこの MC に使用した正確な Spec を再現可能
  strategy_version_id UUID
                      REFERENCES public.strategy_versions(id) ON DELETE SET NULL,

  -- Simulation 設定
  method              TEXT          NOT NULL DEFAULT 'TRADE_ORDER_SHUFFLE'
                      CHECK (method IN ('TRADE_ORDER_SHUFFLE')),

  iterations          INTEGER       NOT NULL
                      CHECK (iterations BETWEEN 100 AND 50000),

  -- 再現性保証用シード (符号なし32ビット整数 → BIGINT)
  seed                BIGINT        NOT NULL,

  -- P(maxDrawdownPct >= drawdown_threshold_pct) の閾値
  -- UI では "P(DD ≥ X%)" と表示する ("Ruin" は使用しない)
  drawdown_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 20.0,

  -- 使用したトレード数
  trade_count         INTEGER       NOT NULL,

  -- 実行コンテキスト (runBacktest() に渡したパラメータ)
  symbol              TEXT          NOT NULL,
  main_timeframe      TEXT          NOT NULL,
  period_label        TEXT          NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (period_label IN ('AVAILABLE', '1M', '3M', '6M', '1Y')),
  data_from           TIMESTAMPTZ,
  data_to             TIMESTAMPTZ,
  initial_balance     NUMERIC(12,2) NOT NULL DEFAULT 10000,

  -- Original (シャッフル前) シーケンスのメトリクス
  original_final_pips        NUMERIC(10,2)  NOT NULL,
  original_final_profit      NUMERIC(12,2)  NOT NULL,
  original_max_dd_pct        NUMERIC(6,2)   NOT NULL,
  -- NULL = infinite (BacktestReporter.safePF() と同定義: grossLoss=0, grossProfit>0)
  original_profit_factor     NUMERIC(10,4),
  original_win_rate          NUMERIC(6,2)   NOT NULL,
  original_max_cons_losses   INTEGER        NOT NULL,

  -- Probability メトリクス (直接カラム: クエリしやすくするため JSONB から切り出し)
  probability_of_loss                 NUMERIC(8,6) NOT NULL,
  probability_of_drawdown_threshold   NUMERIC(8,6) NOT NULL,

  -- Original シーケンスの Percentile ランク (0-100)
  original_percentile_rank            NUMERIC(5,2) NOT NULL,

  -- Percentile Distribution (JSONB)
  -- {
  --   "finalPips":            {"p5": .., "p10": .., "p25": .., "p50": .., "p75": .., "p90": .., "p95": ..},
  --   "maxDrawdownPct":       {"p5": .., ...},
  --   "profitFactor":         {"p5": .., ...},  -- null = infinite
  --   "maxConsecutiveLosses": {"p5": .., ...}
  -- }
  distributions                       JSONB NOT NULL,

  -- パフォーマンス
  execution_ms        INTEGER,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monte_carlo_results_strategy
  ON public.monte_carlo_results (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monte_carlo_results_version
  ON public.monte_carlo_results (strategy_version_id)
  WHERE strategy_version_id IS NOT NULL;

COMMENT ON TABLE public.monte_carlo_results IS
  'Phase 4-C: Monte Carlo Simulation 結果。'
  'Method: Trade Order Shuffle (Fisher-Yates)。'
  'AI 非依存: 純粋統計計算。'
  'この結果は Optimization / Walk Forward に影響させない (Data Leakage 防止)。';

COMMENT ON COLUMN public.monte_carlo_results.strategy_version_id IS
  'MC 実行時点の Strategy Version ID。'
  'strategy_versions.spec_snapshot を参照すれば、この MC に使用した正確な StrategySpec を再現可能。'
  'Version 変更後も過去の MC 結果は正しい Version に紐付いて保持される (ON DELETE SET NULL)。'
  'NULL = strategy_versions テーブルにバージョン未登録の稀なケース。';

COMMENT ON COLUMN public.monte_carlo_results.seed IS
  '同一 seed + 同一 trades + 同一 iterations → 完全に同一の結果 (Mulberry32 PRNG)。';

COMMENT ON COLUMN public.monte_carlo_results.drawdown_threshold_pct IS
  'P(maxDrawdownPct >= drawdown_threshold_pct) の閾値 (%)。'
  'デフォルト 20%。UI では "P(DD ≥ X%)" と表示し、"破産" とは表示しない。';

COMMENT ON COLUMN public.monte_carlo_results.original_profit_factor IS
  'NULL = infinite (grossLoss=0, grossProfit>0)。'
  'BacktestReporter.safePF() / WalkForwardEngine.recomputeMetricsFromTrades() と同定義。';

COMMENT ON COLUMN public.monte_carlo_results.probability_of_loss IS
  'P(finalPips < 0): 最終 Pips がマイナスになる確率 (0.0–1.0)。';

COMMENT ON COLUMN public.monte_carlo_results.probability_of_drawdown_threshold IS
  'P(maxDrawdownPct >= drawdown_threshold_pct): DD が閾値以上になる確率 (0.0–1.0)。'
  '"Probability of Ruin" とは命名しない (20%DD は破産とは異なる)。';

COMMENT ON COLUMN public.monte_carlo_results.original_percentile_rank IS
  'P(simulation finalPips ≤ original finalPips) × 100。'
  'UI では "Original Sequence: P[XX]" と表示。Robustness Score ではない。';

COMMENT ON COLUMN public.monte_carlo_results.distributions IS
  'Percentile Distribution JSONB (P5/P10/P25/P50/P75/P90/P95)。'
  'profitFactor の null = infinite (JSON Infinity は保存しない)。';

-- RLS: Phase 4-C では service_role のみ書き込み可。READ は全ユーザー許可。
