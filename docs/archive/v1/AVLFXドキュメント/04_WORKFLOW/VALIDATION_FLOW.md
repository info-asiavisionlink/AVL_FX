# VALIDATION FLOW
**Status:** PARTIAL — 各検証エンジン実装済み・総合判定は未実装  
**Last Updated:** 2026-08-22

---

## 検証の目的

```
バックテストPF > 1.0  ≠  良い戦略

単一期間のバックテストは以下を見逃す:
  - カーブフィッティング（過去への過学習）
  - 相場環境依存（特定期間のみ機能）
  - 取引順序の偶然性
  - パラメーター感度（少し変えると崩れる）

AVL-FXの多段階検証:
  これらを統計的に排除する
```

---

## 検証の階層

### Level 1: Backtest（最低条件）

```
目的: 戦略に基本的な期待値があるか
合格基準: PF >= 1.0 AND N >= 30 AND totalPips > 0
何を見ていない: カーブフィット / 相場依存 / 取引順序
```

### Level 2: AI Analysis（質的評価）

```
目的: Backtestの数値を解釈し、隠れたリスクを特定
出力: Facts / Weaknesses / Risk Analysis
何を見ている: セッション偏り / 連敗パターン / リスク特性
```

### Level 3: Parameter Optimization（パラメーター安定性）

```
目的: 最良パラメーターが偶然ではなく安定しているか
合格基準: Stable Zone存在（近傍パラメーターでもOOS PF >= 1.0）
何を見ている: パラメーター感度（過最適化の排除）
```

### Level 4: Walk Forward（時系列ロバスト性）

```
目的: 様々な相場期間で継続して機能するか
合格基準: OOS PF平均 >= 1.0（目安）
何を見ている: 時系列安定性（相場環境変化への対応）
```

### Level 5: Monte Carlo（確率的リスク）

```
目的: 取引順序の偶然性を排除した真の期待値分布
合格基準: Ruin Probability <= 5%（目安）
何を見ている: 最悪ケースの確率的評価
```

### Level 6: Cross-Phase Interpretation（統合評価）

```
目的: 全ステップを横断した総合AI判断
出力: 4フェーズの評価 + 最終推奨
何を見ている: 各フェーズの一貫性 / 総合的な戦略品質
```

---

## 最終判定（未実装）

```
現状: 総合判定の自動化は未実装
未来: strategy_registry.statusに VALIDATED/REJECTED を追加

VALIDATED の条件案（確定前に設計が必要）:
  □ Backtest: verdict = PASSED
  □ Walk Forward: OOS PF平均 >= 1.0
  □ Monte Carlo: Ruin Probability <= 5%
  □ AI Interpretation: 重大な警告なし
  □ サンプル数: N >= 50（全期間）

REJECTED の条件:
  □ 上記のいずれか1つでも満たさない
```

---

## 現在の「PASSED」の意味

```
backtest_status = "PASSED":
  → BacktestのverdicがPASSED（PF>1, N>=30, totalPips>0）
  → Walk Forward・Monte Carlo通過は含まない

つまり、現時点で「PASSED」と表示されていても:
  "バックテストがプラスだった" の意味のみ
  "戦略として採用して良い" ではない
```
