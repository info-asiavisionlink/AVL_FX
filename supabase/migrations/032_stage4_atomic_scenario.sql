-- Stage 4: atomic H1 scenario transition.
-- The advisory transaction lock serializes retries for one Trader while the
-- unique (Trader, H1 bar) index makes the operation idempotent.

CREATE OR REPLACE FUNCTION public.create_h1_scenario_atomic(
  p_trader_id UUID,
  p_user_id UUID,
  p_trader_version_id UUID,
  p_h1_bar_time BIGINT,
  p_payload JSONB
)
RETURNS TABLE (id UUID, scenario_version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_version INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_trader_id::TEXT, 0));

  SELECT s.id, s.scenario_version INTO v_id, v_version
    FROM public.ai_trader_scenarios s
   WHERE s.ai_trader_id = p_trader_id AND s.h1_bar_time = p_h1_bar_time
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_version;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(s.scenario_version), 0) + 1 INTO v_version
    FROM public.ai_trader_scenarios s WHERE s.ai_trader_id = p_trader_id;

  INSERT INTO public.ai_trader_scenarios (
    ai_trader_id, user_id, ai_trader_version_id, scenario_version,
    h1_bar_time, is_active, state, bias, scenario_text, watch_zone_low,
    watch_zone_high, invalidate_below, invalidate_above, recheck_triggers,
    recheck_triggers_v2, market, reference_price, bar_time, ai_model,
    ai_reasoning, trigger_type, entry_side, entry_price_low, entry_price_high,
    suggested_sl, suggested_tp, suggested_volume, key_levels,
    fundamental_notes, market_view, risk_context, reasoning_summary,
    next_30min_outlook, applied_knowledge
  )
  VALUES (
    p_trader_id, p_user_id, p_trader_version_id, v_version, p_h1_bar_time,
    true, COALESCE(p_payload->>'state', 'WATCHING'), p_payload->>'bias',
    p_payload->>'scenario_text', (p_payload->>'watch_zone_low')::NUMERIC,
    (p_payload->>'watch_zone_high')::NUMERIC, (p_payload->>'invalidate_below')::NUMERIC,
    (p_payload->>'invalidate_above')::NUMERIC, COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'recheck_triggers','[]'::JSONB))), '{}'),
    COALESCE(p_payload->'recheck_triggers_v2','[]'::JSONB), p_payload->>'market',
    (p_payload->>'reference_price')::NUMERIC, to_timestamp(p_h1_bar_time),
    p_payload->>'ai_model', p_payload->>'ai_reasoning', 'H1_STRATEGY',
    p_payload->>'entry_side', (p_payload->>'entry_price_low')::NUMERIC,
    (p_payload->>'entry_price_high')::NUMERIC, (p_payload->>'suggested_sl')::NUMERIC,
    (p_payload->>'suggested_tp')::NUMERIC, (p_payload->>'suggested_volume')::NUMERIC,
    p_payload->'key_levels', p_payload->>'fundamental_notes', p_payload->>'market_view',
    p_payload->>'risk_context', p_payload->>'reasoning_summary',
    p_payload->>'next_30min_outlook', COALESCE(p_payload->'applied_knowledge','[]'::JSONB)
  ) RETURNING ai_trader_scenarios.id INTO v_id;

  UPDATE public.ai_trader_scenarios AS s
     SET is_active = false, state = 'INVALIDATED', updated_at = now()
   WHERE s.ai_trader_id = p_trader_id AND s.is_active = true AND s.id <> v_id;

  RETURN QUERY SELECT v_id, v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.create_h1_scenario_atomic(UUID, UUID, UUID, BIGINT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_h1_scenario_atomic(UUID, UUID, UUID, BIGINT, JSONB) TO service_role;
