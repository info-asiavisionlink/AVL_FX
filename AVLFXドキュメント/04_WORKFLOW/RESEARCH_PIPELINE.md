# RESEARCH PIPELINE
**Status:** PARTIAL — 各ステップ実装済み・自動連鎖は未実装  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/app/api/strategies/[id]/`, `src/infrastructure/backtest/`

---

## パイプライン全体像

```
Strategy（DRAFT）
    │
    ▼ STEP 1: Backtest ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/backtest
    │  → BacktestEngine → backtest_jobs/results/trades
    │  → verdict: PASSED / CONDITIONAL / FAILED
    │  → backtest_status: PASSED / FAILED
    │
    ▼ STEP 2: AI Analysis ✅ IMPLEMENTED  
    │  POST /api/strategies/[id]/analyze
    │  → BacktestAnalyzer → OpenAI → strategy_ai_analyses
    │  → Facts / Observations / Weaknesses / Strengths
    │
    ▼ STEP 3: AI Improvement Proposal ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/improve
    │  → 改善案 → strategy_improvements
    │  (任意ステップ)
    │
    ▼ STEP 4: Parameter Optimization ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/optimize
    │  → GridSearch → IS/OOS Stable Zone → optimization_candidates
    │
    ▼ STEP 5: Walk Forward Validation ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/walk-forward
    │  → N期間IS→OOS繰り返し → walk_forward_jobs
    │  → OOS PF分布確認
    │
    ▼ STEP 6: Monte Carlo Simulation ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/monte-carlo
    │  → Nイテレーション → monte_carlo_results
    │  → Ruin Probability / 95%CI
    │
    ▼ STEP 7: Cross-Phase Interpretation ✅ IMPLEMENTED
    │  POST /api/strategies/[id]/interpret
    │  → 全結果統合 → OpenAI → strategy_phase4d_interpretations
    │  → 4フェーズ横断の総合判断
    │
    ▼ Final Verdict ❌ NOT_IMPLEMENTED
       → VALIDATED（全ステップ通過）
       → REJECTED（いずれかで失敗）
```

---

## 各ステップの判定基準（現在実装されているもの）

### STEP 1: Backtest Verdict

```
PASSED:      N >= 30 AND PF >= 1.0 AND totalPips > 0
CONDITIONAL: N < 30 OR 軽度の懸念
FAILED:      PF < 1.0 または N著しく不足
```

### STEP 5: Walk Forward の判定目安（非公式）

```
OOS PF平均 >= 1.0: 良好
OOS PF平均 0.8〜1.0: 要注意
OOS PF平均 < 0.8: 問題あり
```

### STEP 6: Monte Carlo の判定目安（非公式）

```
Ruin Probability <= 5%: 許容可能
Ruin Probability 5〜20%: 要注意
Ruin Probability > 20%: 問題あり
```

---

## 自動連鎖（未実装 — P0）

```typescript
// 将来実装予定
POST /api/strategies/[id]/research-pipeline

処理フロー:
  1. Backtest実行 → PASSED判定まで待機
  2. AI Analysis 実行
  3. Optimization実行
  4. Walk Forward実行
  5. Monte Carlo実行
  6. Cross-Phase解釈実行
  7. Final Verdict判定 → VALIDATED / REJECTED

UIでの進捗表示:
  [●] Backtest    COMPLETED ✓
  [●] Analysis    RUNNING...
  [ ] Optimization
  [ ] Walk Forward
  [ ] Monte Carlo
  [ ] Interpretation
  [ ] Final Verdict
```

---

## Research Scriptsとの違い

| 項目 | UIパイプライン | Research Scripts |
|-----|--------------|-----------------|
| 対象 | Strategy Registry の Strategy | 直接backtestEngineを呼ぶ |
| 目的 | 個別Strategy の検証 | 仮説探索・統計研究 |
| 実行方法 | UIからボタン | `npx tsx scripts/phase*.ts` |
| DB保存 | strategy_registry系 | bar_data直接アクセス |
| ユーザー | トレーダー | 研究者（Claude Code） |

---

## バックテスト実行の前提条件

```
□ bar_data に対象シンボル・TFのデータが存在すること
  （最低30件のトレードが発生するだけのデータ量）

□ Strategy SpecのevaluatorでシグナルがSKIPにならないこと
  （conditions が ALLOWED_INDICATORS の範囲内）

□ SL/TPメソッドが実装されていること
  （ATRは全シンボルで対応済み）
```
