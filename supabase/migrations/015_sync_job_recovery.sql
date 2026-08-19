-- =================================================================
-- 015_sync_job_recovery.sql
-- Data Phase B Hardening — stale RUNNING job 自動復旧
--
-- 問題:
--   EA / MT5 / Gateway が停止した場合、RUNNING な Sync Job が
--   永久にスタックする。UNIQUE INDEX により新 job も作れなくなる。
--
-- 解決:
--   claim_next_sync_job() を CREATE OR REPLACE して
--   stale RUNNING job (updated_at < now - 5 min) を
--   自動的に PENDING に戻してから次の claim を行う。
--
-- 保持するフィールド:
--   current_from / current_to / target_from / target_to
--   → resume 起点として使用するため絶対に変更しない
--
-- 変更するフィールド:
--   status: RUNNING → PENDING
--   started_at: NULL (再実行するため)
--   error_message: 'Recovered stale RUNNING job (auto-recovery)'
--   updated_at: now()
--
-- Concurrent safety:
--   UPDATE は row-level lock を取得するため
--   複数 Gateway が同時に呼び出しても安全。
--   SKIP LOCKED は SELECT FOR UPDATE にのみ適用。
--
-- 注意:
--   Migration 014 の claim_next_sync_job() を CREATE OR REPLACE で
--   上書きする。既存の grants / dependencies は維持される。
-- =================================================================

-- stale タイムアウト定数 (5 分)
-- Gateway 側の SYNC_JOB_STALE_SECONDS と合わせること。
-- この値を変更する場合は両方を同期させる。
DO $$
BEGIN
  COMMENT ON TABLE public.market_data_sync_jobs IS
    'Data Phase B — Incremental Sync Job。'
    'claim_next_sync_job() で atomic に PENDING→RUNNING へ遷移する。'
    'stale RUNNING job (5分以上 updated_at が更新されない) は'
    '自動的に PENDING に戻される (015_sync_job_recovery)。';
EXCEPTION WHEN OTHERS THEN NULL; -- テーブル未作成時のエラーを抑制
END;
$$;

-- ------------------------------------------------------------------
-- claim_next_sync_job() — stale recovery + atomic claim
--
-- 処理順:
--   1. stale RUNNING job を PENDING に戻す (current_from/to を保持)
--   2. PENDING job を 1 件 FOR UPDATE SKIP LOCKED でロック
--   3. RUNNING に遷移して返す
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_next_sync_job(p_symbol TEXT DEFAULT NULL)
RETURNS SETOF public.market_data_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id           UUID;
  v_stale_cutoff TIMESTAMPTZ := now() - INTERVAL '5 minutes';
BEGIN
  -- ----------------------------------------------------------------
  -- Step 1: stale RUNNING job を PENDING に戻す
  --
  -- 対象: status = 'RUNNING' AND updated_at < now - 5min
  --       AND (p_symbol IS NULL OR symbol = p_symbol)
  --
  -- 保持: current_from, current_to, target_from, target_to, received_bars, sent_bars
  -- リセット: started_at = NULL, error_message = recovery message
  --
  -- COMPLETED / FAILED / PAUSED は絶対に変更しない。
  -- ----------------------------------------------------------------
  UPDATE public.market_data_sync_jobs
  SET
    status        = 'PENDING',
    started_at    = NULL,
    error_message = 'Recovered stale RUNNING job (auto-recovery after 5min timeout)',
    updated_at    = now()
  WHERE
    status      = 'RUNNING'
    AND updated_at < v_stale_cutoff
    AND (p_symbol IS NULL OR symbol = p_symbol);
  -- current_from, current_to, target_from, target_to, received_bars, sent_bars は保持

  -- ----------------------------------------------------------------
  -- Step 2: PENDING job を 1 件 atomic claim
  -- ----------------------------------------------------------------
  SELECT id INTO v_id
  FROM public.market_data_sync_jobs
  WHERE
    status = 'PENDING'
    AND (p_symbol IS NULL OR symbol = p_symbol)
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NULL THEN
    RETURN; -- PENDING job なし
  END IF;

  -- RUNNING に遷移して返す
  RETURN QUERY
  UPDATE public.market_data_sync_jobs
  SET
    status     = 'RUNNING',
    started_at = now(),
    updated_at = now()
  WHERE id = v_id
  RETURNING *;
END;
$$;

-- grants は REPLACE 後も維持されるが念のため再付与
GRANT EXECUTE ON FUNCTION public.claim_next_sync_job(TEXT) TO service_role;

-- ------------------------------------------------------------------
-- recover_stale_sync_jobs() — 独立した recovery 関数
--
-- Gateway の定期 health-check などから呼べる独立した関数。
-- claim を伴わないため複数 caller から安全に呼び出せる。
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recover_stale_sync_jobs(
  p_stale_minutes INTEGER DEFAULT 5
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.market_data_sync_jobs
  SET
    status        = 'PENDING',
    started_at    = NULL,
    error_message = 'Recovered stale RUNNING job (manual recovery)',
    updated_at    = now()
  WHERE
    status      = 'RUNNING'
    AND updated_at < now() - (p_stale_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recover_stale_sync_jobs(INTEGER) TO service_role;
