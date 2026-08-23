# CURRENT STATUS
**Status:** REFERENCE — コードから直接検証済み  
**Last Updated:** 2026-08-23 (EA Command Center Production化 / テストEA削除)  
**Source of Truth:** 実コード・Supabase migrations・実データ  

> **このファイルはコードに基づいた事実のみを記載する。推測は書かない。**

---

## 凡例

| マーク | 意味 |
|--------|------|
| `PRODUCTION_READY` | 本番使用可能。テスト済み |
| `IMPLEMENTED` | 実装済み。動作確認済み |
| `PARTIAL` | 一部実装。制限あり |
| `PLANNED` | 計画済みだが未実装 |
| `MOCK` | ハードコードされたダミーデータを使用中 |
| `NOT_IMPLEMENTED` | 未実装 |

---

## Market Data（データ収集）

| 機能 | 状態 | 詳細 |
|-----|------|------|
| MT5 Tick受信 | `PRODUCTION_READY` | Gateway経由でリアルタイム |
| MT5 OHLC受信 | `PRODUCTION_READY` | 8時間足、確定バー検出 |
| Supabase bar_data保存 | `PRODUCTION_READY` | UTC検証済み |
| History Sync | `PRODUCTION_READY` | 任意月数、チャンク分割 |
| DataSync (Incremental) | `PRODUCTION_READY` | FORWARD/BACKFILL、任意symbol |
| Market Watch配信 | `PRODUCTION_READY` | 全MW symbolのtick |
| EURUSD H1 データ | `PRODUCTION_READY` | 590日分 (2025-01-08〜2026-08-21) |
| EURUSD H4 データ | `PRODUCTION_READY` | 2347日分 (2020-03-18〜2026-08-21) |
| DXY連続データ | `NOT_IMPLEMENTED` | USDX-SEP26 (先物) 35日のみ |
| US10Y データ | `NOT_IMPLEMENTED` | XMブローカー非対応 |
| マルチシンボルリアルタイム | `PARTIAL` | DataSyncは任意symbol対応、リアルタイムは単一チャートのみ |

---

## AI EA Builder（戦略設計）

| 機能 | 状態 | 詳細 |
|-----|------|------|
| 自然言語入力 | `PRODUCTION_READY` | 10〜2000文字 |
| OpenAI Strategy Spec生成 | `PRODUCTION_READY` | json_objectモード |
| Zodバリデーション | `PRODUCTION_READY` | ホワイトリスト方式 |
| Preview確認画面 | `PRODUCTION_READY` | 4ステップUI |
| DB保存（strategy_registry） | `PRODUCTION_READY` | DRAFT/magic_number自動付与 |
| 編集・修正 | `PARTIAL` | Previewからの戻りのみ。保存後の編集はなし |
| Strategy型（AI禁止事項） | `PRODUCTION_READY` | MQL5コード生成は明示禁止 |

---

## Backtest Engine

| 機能 | 状態 | 詳細 |
|-----|------|------|
| シグナル評価 | `PRODUCTION_READY` | evaluator.ts + _evaluatorOverride |
| confirmed-bar安全 | `PRODUCTION_READY` | getLastConfirmedBarIndex()使用 |
| コスト計算 | `PRODUCTION_READY` | spread + slippage込み |
| Diagnostic Override | `IMPLEMENTED` | _spreadOverride / _slippageOverride（研究用コスト上書き） |
| IS/OOS分割 | `PRODUCTION_READY` | 70/30分割 |
| 統計計算 | `PRODUCTION_READY` | 13+種の指標 |
| Session別統計 | `PRODUCTION_READY` | TOKYO/LONDON/NEW_YORK |
| Verdict判定 | `PRODUCTION_READY` | PASSED/CONDITIONAL/FAILED |
| 実行速度 | `PRODUCTION_READY` | 5,000本 ≈ 14ms |
| 単一シンボル制約 | `PARTIAL` | Multi-symbol未対応（設計上の制約） |

---

## AI Analysis

| 機能 | 状態 | 詳細 |
|-----|------|------|
| AI分析実行 | `PRODUCTION_READY` | BacktestAnalyzer → OpenAI |
| Fact Integrity Check | `PRODUCTION_READY` | Backtestデータと矛盾するFactを除去 |
| AI改善提案 | `PRODUCTION_READY` | strategy_improvements保存 |
| Cross-Phase解釈 | `PRODUCTION_READY` | 全研究フェーズ統合AI解釈 |

---

## Strategy Version管理

| 機能 | 状態 | 詳細 |
|-----|------|------|
| バージョン保存 | `PRODUCTION_READY` | strategy_versions |
| バージョン比較 | `PRODUCTION_READY` | VersionComparator |
| ロールバック | `PRODUCTION_READY` | POST /versions/[v]/restore |

---

## Parameter Optimization

| 機能 | 状態 | 詳細 |
|-----|------|------|
| グリッドサーチ | `PRODUCTION_READY` | 全パラメーター組み合わせ |
| IS/OOS分割評価 | `PRODUCTION_READY` | Stable Zone検出 |
| Stability Score | `PRODUCTION_READY` | 0〜1スコア |
| 結果DB保存 | `PRODUCTION_READY` | optimization_jobs/candidates |
| パラメーター適用 | `PRODUCTION_READY` | /optimize/[jobId]/apply |

---

## Walk Forward Validation

| 機能 | 状態 | 詳細 |
|-----|------|------|
| WF実行 | `PRODUCTION_READY` | 複数ウィンドウIS→OOS繰り返し |
| OOS PF分布 | `PRODUCTION_READY` | 各ウィンドウ結果 |
| DB保存 | `PRODUCTION_READY` | walk_forward_jobs |

---

## Monte Carlo Simulation

| 機能 | 状態 | 詳細 |
|-----|------|------|
| MC実行 | `PRODUCTION_READY` | Nイテレーションリサンプリング |
| Ruin Probability | `PRODUCTION_READY` | 計算・表示 |
| 95%信頼区間 | `PRODUCTION_READY` | 計算・表示 |
| DB保存 | `PRODUCTION_READY` | monte_carlo_results |

---

## UI

| 機能 | 状態 | 詳細 |
|-----|------|------|
| EA Command Center | `PRODUCTION_READY` | 全DB駆動・Empty State実装・モック完全削除 |
| UI日本語ラベル管理 | `IMPLEMENTED` | src/lib/ui-labels.ts — 全enum値を日本語化（集中管理） |
| Strategy Detail OVERVIEW | `PRODUCTION_READY` | Spec全項目表示（日本語UI） |
| Strategy Detail BACKTEST | `PRODUCTION_READY` | Backtest実行・結果・チャート |
| Strategy Detail TRADES | `PRODUCTION_READY` | 個別取引履歴 |
| Strategy Detail ANALYSIS | `PRODUCTION_READY` | AI分析・改善提案・Cross-Phase解釈 |
| Strategy Detail VERSIONS | `PRODUCTION_READY` | バージョン履歴・比較・ロールバック |
| Strategy Detail OPTIMIZE | `PRODUCTION_READY` | 最適化・Walk Forward・Monte Carlo |

---

## Production / Live Trading

| 機能 | 状態 | 詳細 |
|-----|------|------|
| 研究パイプライン自動連鎖 | `NOT_IMPLEMENTED` | 各ステップ手動実行が必要 |
| Final Verdict (VALIDATED/REJECTED) | `NOT_IMPLEMENTED` | statusはDRAFT/ACTIVE等のみ |
| MQL5 EA生成 | `NOT_IMPLEMENTED` | Strategy Spec → .mq5は未実装 |
| MT5 Deployment | `NOT_IMPLEMENTED` | magic_number割当済みだが配備仕組みなし |
| ライブトレード | `NOT_IMPLEMENTED` | Strategy EAは存在しない |
| Paper Trading | `NOT_IMPLEMENTED` | 計画段階 |
| Risk Engine | `NOT_IMPLEMENTED` | 計画段階 |
| Monitoring Dashboard | `NOT_IMPLEMENTED` | 計画段階 |

---

## 現在のデータベース（migrations適用済み）

| Migration | テーブル | 状態 |
|-----------|---------|------|
| 001 | cot_positions | ✅ Applied |
| 002 | bar_data | ✅ Applied |
| 003 | bar_data RLS | ✅ Applied |
| 004 | strategy_registry | ✅ Applied |
| 005 | backtest_jobs/results/trades | ✅ Applied |
| 007 | strategy_ai_analyses | ✅ Applied |
| 008 | strategy_improvements | ✅ Applied |
| 009 | strategy_versions | ✅ Applied |
| 010 | optimization_jobs/candidates | ✅ Applied |
| 011 | walk_forward_jobs | ✅ Applied |
| 012 | monte_carlo_results | ✅ Applied |
| 013 | strategy_phase4d_interpretations | ✅ Applied |
| 014 | market_data_sync_jobs | ✅ Applied |
| 015 | sync_job_recovery | ✅ Applied |
| 006 | **欠番** | migration 006は存在しない |

---

*このファイルを更新するタイミング: 実装が完了・変更・廃止されたとき*
