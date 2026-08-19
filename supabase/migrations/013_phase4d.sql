-- =================================================================
-- 013_phase4d.sql
-- Phase 4-D AI Cross-Phase Interpretation 結果の永続化
--
-- Phase 4-D: Cross-Phase AI Interpretation
--
-- 設計原則:
--   - Phase 3-A / 4-A / 4-B / 4-C の結果を横断解釈する
--   - STRICTLY READ-ONLY:
--       この Migration が書き込むテーブルは strategy_phase4d_interpretations のみ
--       strategy_registry / strategy_versions / optimization_jobs /
--       walk_forward_jobs / monte_carlo_results は変更しない
--   - 将来予測禁止: AI Output は Fact-based Observation のみ
--   - Confidence は AI が生成しない → コードで決定論的に計算して保存
--   - Version 追跡: strategy_version_id で実行時の正確な Spec を特定可能
--   - 全フェーズ Optional: 一部未実施でも実行可能 (Graceful Degradation)
--   - 数値 Integrity 違反は integrity_violations に記録 (透明性確保)
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_phase4d_interpretations (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id         UUID          NOT NULL
                      REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  -- 実行時点の Strategy Version (strategy_versions.spec_snapshot で正確な Spec 再現可能)
  strategy_version_id UUID
                      REFERENCES public.strategy_versions(id) ON DELETE SET NULL,

  -- 各フェーズのソース ID (nullable: そのフェーズ未実施の場合)
  analysis_id    UUID REFERENCES public.strategy_ai_analyses(id)         ON DELETE SET NULL,
  wf_job_id      UUID REFERENCES public.walk_forward_jobs(id)            ON DELETE SET NULL,
  mc_result_id   UUID REFERENCES public.monte_carlo_results(id)          ON DELETE SET NULL,
  opt_job_id     UUID REFERENCES public.optimization_jobs(id)            ON DELETE SET NULL,

  -- 利用可能だったフェーズ一覧
  -- 例: ["BACKTEST_ANALYSIS", "WALK_FORWARD", "MONTE_CARLO"]
  available_phases      JSONB         NOT NULL DEFAULT '[]',

  -- 使用モデル名 (MODELS.chat に対応)
  model                 TEXT          NOT NULL,

  -- AI に渡したコンテキスト全体 (再現性・監査用)
  -- InterpretationContext を JSON シリアライズしたもの
  input_snapshot        JSONB         NOT NULL DEFAULT '{}',

  -- ── AI 出力 ──────────────────────────────────────────────────────

  -- 総括 (2-4文。予測禁止、Factベースのみ)
  overall_assessment    TEXT          NOT NULL DEFAULT '',

  -- フェーズ別 Observation [{phase, observation, supporting_data}]
  phase_observations    JSONB         NOT NULL DEFAULT '[]',

  -- フェーズ横断 Synthesis [{type, observation, phases_involved}]
  -- type: CONVERGENCE | DIVERGENCE | UNCERTAINTY
  cross_phase_synthesis JSONB         NOT NULL DEFAULT '[]',

  -- リスク次元 [{dimension, assessment, data_source}]
  -- dimension: SEQUENCE_RISK | OOS_GENERALIZATION | DRAWDOWN_RISK | SAMPLE_QUALITY | PARAMETER_STABILITY
  risk_dimensions       JSONB         NOT NULL DEFAULT '[]',

  -- 限界の明示 (最低2件必須)
  limitations           JSONB         NOT NULL DEFAULT '[]',

  -- Confidence (0-100): AI が生成しない → コードで決定論的に計算
  -- calcDeterministicConfidence() の出力をそのまま保存
  confidence            INTEGER       NOT NULL
                        CHECK (confidence BETWEEN 0 AND 100),

  -- データ完全性に関する注記
  data_completeness_note TEXT         NOT NULL DEFAULT '',

  -- 数値 Integrity 違反記録 (透明性確保)
  -- validateInterpretationIntegrity() が検出した違反の一覧
  -- 空配列 = 違反なし (正常)
  integrity_violations  JSONB         NOT NULL DEFAULT '[]',

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Indexes ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_phase4d_strategy
  ON public.strategy_phase4d_interpretations (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_phase4d_strategy_version
  ON public.strategy_phase4d_interpretations (strategy_version_id)
  WHERE strategy_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_phase4d_analysis
  ON public.strategy_phase4d_interpretations (analysis_id)
  WHERE analysis_id IS NOT NULL;

-- ── Comments ─────────────────────────────────────────────────────────

COMMENT ON TABLE public.strategy_phase4d_interpretations IS
  'Phase 4-D: AI による 4 フェーズ横断解釈。'
  'Phase 3-A(Backtest分析) + Phase 4-A(最適化) + Phase 4-B(WF) + Phase 4-C(MC) を統合。'
  'STRICTLY READ-ONLY: 他のテーブルを変更しない。'
  'Confidence は AI 生成でなくコードで決定論的に計算。'
  'Version 自動作成禁止 / Parameter 推奨禁止 / 将来予測禁止。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.strategy_version_id IS
  'MC 実行時点の Strategy Version ID。'
  'strategy_versions.spec_snapshot を参照すれば解釈に使用した正確な StrategySpec を再現可能。'
  'ON DELETE SET NULL: Version 削除後も解釈は保持される。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.available_phases IS
  '実際に利用可能だったフェーズ一覧。'
  '例: ["BACKTEST_ANALYSIS", "WALK_FORWARD", "MONTE_CARLO"]。'
  'AI はこれに基づいてコンテキスト不足を認識し、未実施フェーズを推測しない。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.input_snapshot IS
  'AI に渡した InterpretationContext の完全なコピー (再現性・監査用)。'
  'この snapshot + model + overall_assessment で解釈を完全に再現・検証可能。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.confidence IS
  'calcDeterministicConfidence() の出力 (0-100)。'
  'AI が生成した自己評価ではなくコードで計算した値。'
  '利用可能フェーズ数に基づくベース値 + ペナルティ (sampleSizeWarning/-15 等)。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.integrity_violations IS
  'validateInterpretationIntegrity() が検出した数値矛盾の一覧。'
  '空配列 = 検証クリア。'
  '非空 = AI が述べた数値がコンテキストと一致しなかった項目 (監査ログとして保持)。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.phase_observations IS
  '[{phase, observation, supporting_data}]。'
  'phase: BACKTEST_ANALYSIS | OPTIMIZATION | WALK_FORWARD | MONTE_CARLO。'
  'observation: Fact ベース (予測禁止)。'
  'supporting_data: 対応するコンテキスト数値を明示。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.cross_phase_synthesis IS
  '[{type, observation, phases_involved}]。'
  'type: CONVERGENCE | DIVERGENCE | UNCERTAINTY。'
  'CONVERGENCE: 複数フェーズが整合するシグナルを示す場合のみ使用。';

COMMENT ON COLUMN public.strategy_phase4d_interpretations.limitations IS
  'このデータから結論できないことの明示的な記述。最低2件必須。'
  '例: 将来の実運用での収益性はこれらの結果から結論できない。';

-- RLS: Phase 4-D では service_role のみ書き込み可。READ は全ユーザー許可。
