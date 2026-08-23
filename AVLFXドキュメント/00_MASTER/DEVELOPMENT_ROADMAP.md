# DEVELOPMENT ROADMAP
**Status:** ACTIVE — 定期更新必要  
**Last Updated:** 2026-08-22  
**Current Stage:** STAGE 3 開始前

---

## 現在のPrimary Goal

> **AVL-FX本体の完成**を最優先とする。  
> 新しいResearch Phaseを無制限に増やすのではなく、  
> 既存Research結果を使ったプロダクト完成にリソースを集中する。

---

## Stage 定義

### STAGE 0: Infrastructure ✅ COMPLETE

**内容:** MT5・Gateway・Supabase・Next.jsの基盤構築

**完了確認:**
- [x] AVL_DataManager_v2.mq5 稼働中
- [x] Gateway → Supabase UPSERT パイプライン
- [x] bar_data スキーマ（汎用 symbol/timeframe/time_utc）
- [x] market_data_sync_jobs（DataSync）
- [x] Next.js基本構造

---

### STAGE 1: Research Foundation ✅ COMPLETE

**内容:** AI EA Builder と全研究エンジンの実装

**完了確認:**
- [x] AI EA BUILDER（OpenAI → Strategy Spec → Preview → Save）
- [x] BacktestEngine（confirmed-bar安全、7+種統計）
- [x] BacktestReporter（PASSED/CONDITIONAL/FAILED判定）
- [x] AI Analysis（BacktestAnalyzer → OpenAI → Fact検証）
- [x] Parameter Optimization（GridSearch + Stable Zone）
- [x] Walk Forward Validation
- [x] Monte Carlo Simulation
- [x] Cross-Phase Interpretation
- [x] Strategy Version管理
- [x] StrategyDetailModal（6タブ全実装）

---

### STAGE 2: Research Execution ✅ COMPLETE

**内容:** EURUSD実データを使ったStrategy研究（Phase 5〜8）

**完了確認:**
- [x] Phase 5: EMA21 Pullback → TERMINATED
- [x] Phase 6: Breakout/Momentum/MeanRev → ALL TERMINATED
- [x] Phase 7: OHLC Price Structure → TERMINATED
- [x] Phase 8-A: Cross-Asset Data Audit → INSUFFICIENT（外部プロバイダー必要）

**Research結論:** EURUSD単体OHLCアプローチで再現可能なエッジは発見されなかった。  
→ 詳細は `06_RESEARCH_HISTORY/` 参照。

---

### STAGE 3: Production Foundation ← **現在ここ**

**目標:** Research結果からMT5でライブ運用できる基盤を構築する

**3-A: 研究パイプライン自動連鎖**

```
目標:
  「Full Research実行」ボタン1つ → 7ステップ自動順次実行
  
実装内容:
  - API Orchestration層（各APIを順次呼ぶ）
  - 進捗表示UI
  - エラーハンドリング（途中失敗時のリトライ・スキップ設定）
  
必要ファイル:
  - POST /api/strategies/[id]/research-pipeline（新規）
  - StrategyDetailModal: [Full Research]ボタン追加

完了条件:
  - ボタン1つで全7ステップが順次実行完了すること
  - 各ステップの進捗がUIで視認できること
```

**3-B: Final Research Verdict**

```
目標:
  全ステップ通過後に VALIDATED / REJECTED を自動判定する
  
実装内容:
  - strategy_registry.status に VALIDATED / REJECTED 追加（Migration）
  - 判定ロジック（各ステップの合否条件を定義）
  - VerdictDisplayUI

判定条件案（確定前に議論が必要）:
  - Backtest: verdict=PASSED
  - Walk Forward: OOS PF平均 >= 1.0
  - Monte Carlo: Ruin Probability <= 5%
  - AI Interpretation: recommendation=PROCEED

完了条件:
  - 全条件を満たすとVALIDATED自動設定
  - 一つでも失敗するとREJECTED自動設定
```

**3-C: MQL5 EA Code Generation**

```
目標:
  Validated Strategy → .mq5ファイル自動生成

実装内容:
  - Strategy Spec → MQL5コードテンプレートマッピング
  - POST /api/strategies/[id]/generate-ea（新規）
  - .mq5ファイルダウンロード機能

注意:
  - MQL5コード品質は手動確認が必要
  - 全条件をサポートできるテンプレートは段階的に拡張

完了条件:
  - 基本的な Entry/Exit/SL/TP を持つMQL5コードが生成される
  - magic_numberが正しく埋め込まれる
```

**3-D: MT5 Deployment Pipeline**

```
目標:
  生成したEAをMT5に配備するフローを確立

実装内容（手動フロー先行）:
  - .mq5ファイルをMT5のExperts/フォルダに配置
  - MT5でコンパイル → チャートにアタッチ
  - magic_numberでAVL-FXと紐付け

将来の自動化:
  - MT5外部APIやゲートウェイ経由でEAを遠隔操作（検討段階）

完了条件:
  - ドキュメント化された手動デプロイ手順が存在する
  - magic_number による策略識別が機能する
```

---

### STAGE 4: UI/UX Polish

**目標:** MOCKを廃止し、本番品質のUIに仕上げる

**4-A: MOCK廃止**
```
- MOCK_EA_PROFILES → strategy_registryの実データ表示
- EA Command Center上部パネルの実データ化
```

**4-B: Strategy Lifecycle UI**
```
- ACTIVE/PAUSED/ARCHIVED の手動変更UI
- VALIDATED/REJECTED バッジ表示
```

**4-C: Cross-Asset Data Integration（条件付き）**
```
前提: 外部データプロバイダーの契約決定が必要
候補: FRED(US10Y無料) + Polygon.io/Alpha Vantage(DXY)
作業: 新規ingestスクリプト → bar_data（スキーマ変更不要）
```

**4-D: Production Dashboard**
```
- 稼働中EA別パフォーマンスUI
- Portfolio全体のリスク表示
```

---

### STAGE 5: Production Live

**目標:** 実際のライブトレードを安全に開始する

**5-A: Paper Trading**
```
- リアルポジションなしでStrategyシグナルを模擬実行
- P&L追跡
```

**5-B: Live Trading（小額）**
```
- 戦略EAがMT5で実際に発注
- AVL-FXでポジション監視
```

**5-C: Risk Engine**
```
- 最大ドローダウン上限
- 日次損失上限
- ポジションサイズ管理
- 自動緊急停止
```

**5-D: Monitoring & Alerting**
```
- ポジション・損益リアルタイム更新
- Alert設定（DD超過、連敗等）
- パフォーマンスvsバックテスト乖離検知
```

**5-E: Final Production Audit**
```
- セキュリティ監査
- パフォーマンステスト
- 本番運用マニュアル
```

---

## 更新ルール

- Stageが完了したら ✅ COMPLETE を付与
- 各タスク完了後に `02_DEVELOPMENT_LOG/` に記録
- 計画が変わった場合はその理由も記録する
- 新しいResearch Phaseを追加する前にSTAGE完成が先
