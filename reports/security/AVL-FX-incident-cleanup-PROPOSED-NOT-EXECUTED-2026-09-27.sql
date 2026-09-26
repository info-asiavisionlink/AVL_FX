-- =====================================================================
-- PROPOSED — NOT EXECUTED — REQUIRES OWNER HUMAN GATE (Decision B)
-- Target: Production Supabase bsmofroshpmomjwfxigh (Trading View)
-- Scope : ONLY the rows written by the 2026-09-26T15:27:46Z test run.
-- Fails closed: any count / identity mismatch raises and rolls back.
-- strategy_registry is NOT modified (previous value not provable).
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_job      CONSTANT uuid := 'e007b9f3-67ff-4d96-aa0f-3ae3d4e759a2';
  v_result   CONSTANT uuid := '681f708d-ab22-48fe-ac52-e45053f1b420';
  v_strategy CONSTANT uuid := '4582c579-8990-4790-a000-e33b2f68acbb';
  n int;
BEGIN
  -- 1. Verify the exact incident rows (identity + time window)
  SELECT count(*) INTO n FROM public.backtest_jobs
   WHERE id = v_job AND strategy_id = v_strategy AND status = 'COMPLETED'
     AND period_label = 'AVAILABLE' AND bar_count = 1026
     AND created_at BETWEEN '2026-09-26T15:27:45Z' AND '2026-09-26T15:27:47Z';
  IF n <> 1 THEN RAISE EXCEPTION 'ABORT: job verification % <> 1', n; END IF;

  SELECT count(*) INTO n FROM public.backtest_results WHERE job_id = v_job;
  IF n <> 1 THEN RAISE EXCEPTION 'ABORT: results % <> 1', n; END IF;
  SELECT count(*) INTO n FROM public.backtest_results WHERE id = v_result AND job_id = v_job AND strategy_id = v_strategy;
  IF n <> 1 THEN RAISE EXCEPTION 'ABORT: result id mismatch'; END IF;

  SELECT count(*) INTO n FROM public.backtest_trades WHERE job_id = v_job;
  IF n <> 51 THEN RAISE EXCEPTION 'ABORT: trades % <> 51', n; END IF;
  SELECT count(*) INTO n FROM public.backtest_trades WHERE job_id = v_job AND strategy_id <> v_strategy;
  IF n <> 0 THEN RAISE EXCEPTION 'ABORT: trade strategy mismatch %', n; END IF;

  -- Other FK children of backtest_jobs must be empty (CASCADE would hide them)
  SELECT count(*) INTO n FROM public.strategy_ai_analyses WHERE job_id = v_job;
  IF n <> 0 THEN RAISE EXCEPTION 'ABORT: strategy_ai_analyses reference job (%)', n; END IF;
  SELECT count(*) INTO n FROM public.strategy_versions WHERE best_job_id = v_job;
  IF n <> 0 THEN RAISE EXCEPTION 'ABORT: strategy_versions reference job (%)', n; END IF;

  -- 2. Delete children explicitly (do not rely on CASCADE), then the job
  DELETE FROM public.backtest_trades  WHERE job_id = v_job;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 51 THEN RAISE EXCEPTION 'ABORT: deleted trades %', n; END IF;
  DELETE FROM public.backtest_results WHERE id = v_result AND job_id = v_job;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'ABORT: deleted results %', n; END IF;
  DELETE FROM public.backtest_jobs    WHERE id = v_job;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'ABORT: deleted jobs %', n; END IF;

  -- 3. Post-verify: the strategy keeps exactly its original 2026-09-19 job/result
  SELECT count(*) INTO n FROM public.backtest_jobs WHERE strategy_id = v_strategy;
  IF n <> 1 THEN RAISE EXCEPTION 'ABORT: remaining jobs for strategy % <> 1', n; END IF;
  SELECT count(*) INTO n FROM public.backtest_jobs WHERE id = '5edaa25b-2c36-4132-a93e-e954bd7ca62d';
  IF n <> 1 THEN RAISE EXCEPTION 'ABORT: original 09-19 job missing'; END IF;

  -- strategy_registry: intentionally untouched (see incident report §6).
END $$;

-- Review the DO block output, then COMMIT manually. Default is ROLLBACK.
ROLLBACK;
