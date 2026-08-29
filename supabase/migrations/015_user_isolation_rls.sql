-- ============================================================
-- 015: ユーザーデータ分離 — user_id 追加 + RLS
-- ============================================================
-- 設計方針:
--   - user_id を strategy_registry と関連テーブルに追加
--   - 既存データ (user_id = NULL) は public/shared として全ユーザーが閲覧可能
--   - ユーザーは自分のデータのみ作成・更新・削除可能
--   - bar_data / economic_events 等の共有データは全ユーザーが読み取り可能

-- ─── strategy_registry ─────────────────────────────────────
ALTER TABLE strategy_registry
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_registry_user_id ON strategy_registry(user_id);

ALTER TABLE strategy_registry ENABLE ROW LEVEL SECURITY;

-- 全ユーザーが読み取り可能（自分のもの + nullのもの）
CREATE POLICY "strategy_registry_read"
  ON strategy_registry FOR SELECT
  TO authenticated
  USING (user_id IS NULL OR user_id = auth.uid());

-- 自分のストラテジーのみ作成可能
CREATE POLICY "strategy_registry_insert"
  ON strategy_registry FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 自分のストラテジーのみ更新可能
CREATE POLICY "strategy_registry_update"
  ON strategy_registry FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- 自分のストラテジーのみ削除可能
CREATE POLICY "strategy_registry_delete"
  ON strategy_registry FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Service Role は全操作可能（API Route 用）
CREATE POLICY "strategy_registry_service_role"
  ON strategy_registry FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── backtest_jobs ──────────────────────────────────────────
ALTER TABLE backtest_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backtest_jobs_read"
  ON backtest_jobs FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM strategy_registry
      WHERE user_id IS NULL OR user_id = auth.uid()
    )
  );

CREATE POLICY "backtest_jobs_service_role"
  ON backtest_jobs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── backtest_results ───────────────────────────────────────
ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backtest_results_read"
  ON backtest_results FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM strategy_registry
      WHERE user_id IS NULL OR user_id = auth.uid()
    )
  );

CREATE POLICY "backtest_results_service_role"
  ON backtest_results FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── backtest_trades ────────────────────────────────────────
ALTER TABLE backtest_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backtest_trades_read"
  ON backtest_trades FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM strategy_registry
      WHERE user_id IS NULL OR user_id = auth.uid()
    )
  );

CREATE POLICY "backtest_trades_service_role"
  ON backtest_trades FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── strategy_ai_analyses ───────────────────────────────────
ALTER TABLE strategy_ai_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strategy_ai_analyses_read"
  ON strategy_ai_analyses FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM strategy_registry
      WHERE user_id IS NULL OR user_id = auth.uid()
    )
  );

CREATE POLICY "strategy_ai_analyses_service_role"
  ON strategy_ai_analyses FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── trade_history (ユーザー別の実取引履歴) ─────────────────
ALTER TABLE trade_history
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE trade_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trade_history_read_own"
  ON trade_history FOR SELECT
  TO authenticated
  USING (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "trade_history_service_role"
  ON trade_history FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ─── 共有データ（全ユーザー読み取り可） ─────────────────────
-- bar_data
ALTER TABLE bar_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bar_data_read" ON bar_data FOR SELECT TO authenticated USING (true);
CREATE POLICY "bar_data_service_role" ON bar_data FOR ALL TO service_role USING (true) WITH CHECK (true);

-- economic_events
ALTER TABLE economic_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "economic_events_read" ON economic_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "economic_events_service_role" ON economic_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- news_items
ALTER TABLE news_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "news_items_read" ON news_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "news_items_service_role" ON news_items FOR ALL TO service_role USING (true) WITH CHECK (true);
