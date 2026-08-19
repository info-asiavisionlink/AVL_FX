-- =================================================================
-- 014_market_data_sync_jobs.sql
-- Data Phase B — Incremental Sync Job Management
--
-- 設計原則:
--   - Supabase bar_data を Source of Truth とする
--   - PENDING→RUNNING は PostgreSQL レベルで atomic に claim する
--   - Gateway in-memory barStore に依存しない
--   - Phase A の History Sync と共存（追加のみ、既存変更なし）
--
-- Sync Modes:
--   FORWARD  : newest_bar 以降を MT5 から取得
--   BACKFILL : oldest_bar 以前を MT5 から取得
-- =================================================================

CREATE TABLE IF NOT EXISTS public.market_data_sync_jobs (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          TEXT           NOT NULL,
  timeframe       TEXT           NOT NULL,
  mode            TEXT           NOT NULL CHECK (mode IN ('FORWARD', 'BACKFILL')),

  -- 同期対象範囲 (Unix epoch 秒)
  -- FORWARD : target_from = newest + tfSec, target_to = NULL (EA が TimeCurrent() を使用)
  -- BACKFILL: target_from = user 指定, target_to = oldest bar time
  target_from     BIGINT,
  target_to       BIGINT,

  -- ジョブ状態
  status          TEXT           NOT NULL DEFAULT 'PENDING'
                                 CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','PAUSED')),

  -- 進捗
  progress_pct    INTEGER        NOT NULL DEFAULT 0,
  received_bars   INTEGER        NOT NULL DEFAULT 0,
  sent_bars       INTEGER        NOT NULL DEFAULT 0,
  failed_batches  INTEGER        NOT NULL DEFAULT 0,

  -- Resume 用: EA が処理中の現在位置
  current_from    BIGINT,
  current_to      BIGINT,

  -- エラー情報
  error_message   TEXT,

  -- タイムスタンプ
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------
-- インデックス
-- ------------------------------------------------------------------

-- PENDING ジョブを効率的に取得
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_created
  ON public.market_data_sync_jobs (status, created_at ASC)
  WHERE status = 'PENDING';

-- RUNNING ジョブ確認用
CREATE INDEX IF NOT EXISTS idx_sync_jobs_strategy
  ON public.market_data_sync_jobs (symbol, timeframe, status);

-- 同一 symbol/timeframe の active ジョブを1件に制限
-- PENDING または RUNNING が 1 件以下になる一意制約
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_one_active
  ON public.market_data_sync_jobs (symbol, timeframe)
  WHERE status IN ('PENDING', 'RUNNING');

-- ------------------------------------------------------------------
-- updated_at 自動更新トリガー
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_sync_job_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_jobs_updated_at
  BEFORE UPDATE ON public.market_data_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_sync_job_updated_at();

-- ------------------------------------------------------------------
-- claim_next_sync_job() — atomic job claim
--
-- PENDING ジョブを 1 件だけ RUNNING に遷移させて返す。
-- FOR UPDATE SKIP LOCKED により複数 Gateway が同時実行しても安全。
-- EA symbol でフィルタリング（NULL の場合は全 symbol）。
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_next_sync_job(p_symbol TEXT DEFAULT NULL)
RETURNS SETOF public.market_data_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- 対象 PENDING ジョブを 1 件ロック取得
  SELECT id INTO v_id
  FROM public.market_data_sync_jobs
  WHERE status = 'PENDING'
    AND (p_symbol IS NULL OR symbol = p_symbol)
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- RUNNING に遷移
  RETURN QUERY
  UPDATE public.market_data_sync_jobs
  SET status     = 'RUNNING',
      started_at = now(),
      updated_at = now()
  WHERE id = v_id
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_next_sync_job(TEXT) TO service_role;

-- ------------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------------

ALTER TABLE public.market_data_sync_jobs ENABLE ROW LEVEL SECURITY;

-- 認証済みユーザー: 読み取り可
CREATE POLICY "sync_jobs_select"
  ON public.market_data_sync_jobs
  FOR SELECT TO authenticated
  USING (true);

-- service_role: 全操作可
CREATE POLICY "sync_jobs_service_all"
  ON public.market_data_sync_jobs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------
-- コメント
-- ------------------------------------------------------------------

COMMENT ON TABLE public.market_data_sync_jobs IS
  'Data Phase B — Incremental Sync Job。'
  'MT5 EA が polling して FORWARD/BACKFILL の bar 同期を実行する。'
  'claim_next_sync_job() で atomic に PENDING→RUNNING へ遷移する。';
