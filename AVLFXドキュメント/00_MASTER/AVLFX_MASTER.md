# AVL-FX MASTER DOCUMENT
**Status:** LIVING DOCUMENT  
**Last Updated:** 2026-08-22  
**Source of Truth:** Repository code + Supabase migrations + this document  
**Authority:** This is the single source of truth for system understanding

---

## 目次

1. [システムの目的](#1-システムの目的)
2. [Final Product Vision](#2-final-product-vision)
3. [System Architecture](#3-system-architecture)
4. [現在の完成状態](#4-現在の完成状態)
5. [コンポーネント別完成度](#5-コンポーネント別完成度)
6. [現在のStage](#6-現在のstage)
7. [残存Missing Components](#7-残存missing-components)
8. [Final Completion Roadmap](#8-final-completion-roadmap)

---

## 1. システムの目的

AVL-FX（AVL AI FX Trading OS）は、**AI支援型FXトレーディング研究・運用プラットフォーム**。

### Core Mission

> 「自然言語でStrategy（EA）を設計 → AI・統計で多角的に検証 → 検証済み戦略のみMT5で運用」

### 解決する問題

1. **Strategy設計の高い障壁**: MQL5をコーディングしなくても戦略を記述できる
2. **過去検証の煩雑さ**: バックテスト・最適化・Walk Forward・Monte Carloを統合UIで実行
3. **過学習リスク**: 単一バックテストではなく多段階検証でカーブフィッティングを防ぐ
4. **主観的判断**: AIがファクトベースで戦略を分析・評価

---

## 2. Final Product Vision

### 完成形のユーザー体験

```
[USER]
  ↓ 「EURUSDのH1でRSI反転戦略を作りたい」（自然言語）
  
[AI EA BUILDER]
  ↓ OpenAI → Strategy Spec JSON生成 → Preview・確認 → DB保存
  
[RESEARCH PIPELINE（自動連鎖）]
  ↓ Backtest → AI Analysis → Optimization → Walk Forward → Monte Carlo → Interpretation
  
[FINAL VERDICT]
  ↓ VALIDATED（全ステップ通過）/ REJECTED（いずれかで失敗）
  
[MQL5 EA GENERATION]  ← 未実装
  ↓ Validated Strategy → .mq5ファイル自動生成
  
[MT5 DEPLOYMENT]  ← 未実装
  ↓ magic_numberで識別 → MT5上でライブ稼働
  
[MONITORING]  ← 未実装
  ↓ ポジション・損益・リスク リアルタイム監視
```

### 3つの永続的な制約

1. **Research First**: 戦略は必ず検証を通過してからしかデプロイしない
2. **No Look-ahead**: バックテストで未来データを参照しない
3. **AI = Assistant**: AIは意思決定しない。ファクト提示と推奨のみ

---

## 3. System Architecture

### 全体構成

```
┌─────────────────────────────────────────────────────────────────┐
│  MetaTrader 5（XM Broker）                                       │
│  ┌─────────────────────────────┐ ┌───────────────────────────┐  │
│  │ AVL_DataManager_v2.mq5     │ │ AVL_FX_Bridge.mq5         │  │
│  │ (Data Manager — 売買なし)   │ │ (UI接続専用)              │  │
│  └──────────────┬──────────────┘ └──────────────┬────────────┘  │
└─────────────────┼───────────────────────────────┼───────────────┘
                  │ HTTP POST                      │ WebSocket
                  ↓                               ↓
┌─────────────────────────────────────────────────────────────────┐
│  Gateway (gateway/src/index.ts)  Express + WebSocket            │
│  - barDataStore.ts : Supabase UPSERT                           │
│  - syncJobStore.ts : DataSync Job管理                           │
└─────────────────────────────────────────────────────────────────┘
                  │ Supabase SDK
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  Supabase (PostgreSQL)                                           │
│  bar_data / strategy_registry / backtest_* /                   │
│  strategy_ai_analyses / optimization_* /                        │
│  walk_forward_jobs / monte_carlo_results /                      │
│  strategy_phase4d_interpretations / market_data_sync_jobs       │
└─────────────────────────────────────────────────────────────────┘
                  │ Supabase SDK
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  Next.js Web App (src/)                                         │
│  ┌───────────────┐ ┌──────────────────────────────────────────┐ │
│  │ /app/api/*    │ │ /src/infrastructure/backtest/            │ │
│  │ API Routes    │ │ BacktestEngine / OptimizationEngine /   │ │
│  │               │ │ WalkForwardEngine / MonteCarloEngine /  │ │
│  │               │ │ InterpretationEngine / BacktestAnalyzer │ │
│  └───────────────┘ └──────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ /src/presentation/components/                               ││
│  │ EA Command Center / AI EA Builder / Strategy Detail Modal   ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### MT5 Architecture

```
AVL_DataManager_v2.mq5
├── g_Symbol = Symbol()  (チャートにアタッチしたシンボルのみOHLC配信)
├── Stream 1: Tick (100ms throttle)
├── Stream 2: OHLC (M1/M5/M15/M30/H1/H4/D1/W1 — 確定バー検出)
├── Stream 3: Market Watch (全MW symbol tick, 3sec)
├── Stream 4: Indicators (EMA/ATR/RSI/MACD/ADX等, 30sec)
├── Stream 5: Orders/Positions (5sec)
├── Stream 6: Account (5sec)
├── Stream 7: History (30日, 5min)
├── History Sync: 任意月数のOHLC一括取得
└── DataSync: Incremental Sync Job (任意symbol/TF対応)
```

### Supabase Schema (抜粋)

```sql
bar_data               PK: (symbol TEXT, timeframe TEXT, time_utc TIMESTAMPTZ)
strategy_registry      PK: id UUID  status: DRAFT/ACTIVE/PAUSED/ARCHIVED
backtest_jobs          FK: strategy_id  status: PENDING/RUNNING/COMPLETED/FAILED
backtest_results       FK: job_id
backtest_trades        FK: job_id
strategy_ai_analyses   FK: strategy_id, job_id
strategy_improvements  FK: strategy_id
strategy_versions      FK: strategy_id
optimization_jobs      FK: strategy_id
walk_forward_jobs      FK: strategy_id
monte_carlo_results    FK: strategy_id / job_id
strategy_phase4d_interpretations  FK: strategy_id
market_data_sync_jobs  symbol / timeframe / mode(FORWARD|BACKFILL)
```

---

## 4. 現在の完成状態

**最終更新:** 2026-09-03（Legal Pages + Resend連携完了）

### 完成済み ✅

| カテゴリ | 内容 |
|---------|------|
| Market Data収集 | MT5→Gateway→Supabase パイプライン |
| OHLC蓄積 | bar_data (EURUSD H1: 590日分, H4: 2347日分) |
| AI EA Builder | 自然言語→Strategy Spec→Preview→DB保存 |
| Backtest Engine | フルスペック実装（look-ahead安全、confirmed-bar） |
| AI Analysis | OpenAI によるファクトベース分析 |
| Improvement Proposal | AI改善提案 |
| Version管理 | Strategy Spec バージョン履歴・ロールバック |
| Parameter Optimization | グリッドサーチ + Stable Zone検出 |
| Walk Forward Validation | 時系列IS/OOS繰り返し検証 |
| Monte Carlo Simulation | N回リサンプリング、Ruin Probability |
| Cross-Phase Interpretation | 全研究フェーズの統合AI解釈 |
| Strategy Detail UI | 6タブ（OVERVIEW/BACKTEST/TRADES/ANALYSIS/VERSIONS/OPTIMIZE） |
| Research Scripts | Phase 5〜8 の手動研究スクリプト群 |
| Legal Pages | 利用規約・プライバシー・特定商取引法・お問い合わせ（/legal/*） |
| Contact API | Resend連携メール送信（RESEND_API_KEY・FROM_EMAIL設定済み） |

### 未実装 ❌

| カテゴリ | 内容 |
|---------|------|
| 研究パイプライン自動連鎖 | Backtest完了後の自動次ステップ起動 |
| Final Research Verdict | VALIDATED/REJECTED/ROBUST ステータス |
| MQL5 EA自動生成 | Strategy Spec → .mq5ファイル |
| MT5 Live Deployment | 生成EAをMT5に配備 |
| ライブトレード | Strategy EAによる実際の発注 |
| EA Commander上部パネル | MOCK_EA_PROFILES（5件固定）を実データ化 |
| Cross-Asset Data | DXY連続/US10Y（XMブローカー非対応） |
| Strategy Status UI | ACTIVE/PAUSED手動変更UI |

---

## 5. コンポーネント別完成度

| コンポーネント | 完成度 | 状態 |
|--------------|--------|------|
| Market Data Layer | 90% | 実稼働中、一部シンボルのH1データが短い |
| AI EA Builder | 98% | 3欄入力分離（Entry/TP/SL）・3セクションPreview・REQUIRES EXTENSIONバッジ完成 |
| Backtest Engine | 95% | 37+テストPASS、本番使用可能 |
| Research Engines (7種) | 90% | 全実装済み、自動連鎖のみ未実装 |
| Strategy Detail UI | 85% | 6タブ全動作、マイナーUX改善余地あり |
| EA Command Center | 50% | 上部パネルMOCK、下部のみ実データ |
| Production Trading | 5% | Magic Number割当のみ。EA生成・デプロイ未実装 |
| **総合** | **~65%** | コア研究機能完成、Production向け機能未実装 |

---

## 6. 現在のStage

### 現在位置

```
STAGE 0: Infrastructure ✅ COMPLETE
  → MT5連携、Gateway、Supabase、基本API

STAGE 1: Research Foundation ✅ COMPLETE  
  → AI EA Builder、Backtest、全7研究エンジン

STAGE 2: Research Execution ✅ COMPLETE
  → Phase 5〜8研究実施（EURUSD単体OHLCアプローチ終了）

STAGE 3: Production Foundation ← 現在ここ
  → 研究パイプライン自動化、Final Verdict、MQL5生成、MT5デプロイ

STAGE 4: UI/UX Polish
  → MOCK廃止、Strategy lifecycle、Cross-Asset

STAGE 5: Production Live
  → ライブトレード、モニタリング、リスク管理
```

---

## 7. 残存Missing Components

### P0 — 次フェーズで実装すべきもの

```
□ 研究パイプライン自動連鎖
  「Full Research実行」ボタン1つ → 7ステップ自動実行
  
□ Final Research Verdict
  strategy_registry.statusに VALIDATED/REJECTED を追加
  全ステップ通過条件を定義して自動判定

□ MQL5 EA Code Generation
  Validated Strategy → .mq5ファイル生成

□ MT5 Live Deployment
  生成EAをMT5に配備する仕組み（magic_number連携）
```

### P1 — 品質改善

```
□ EA Command Center上部パネルの実データ化
  MOCK_EA_PROFILES → strategy_registryの実データで表示

□ Strategy Status UI
  ACTIVE/PAUSED/ARCHIVEDへのUI操作
  
□ 外部データプロバイダー統合（Cross-Asset）
  FRED (US10Y) + Alpha Vantage/Polygon (DXY連続)
```

### P2 — 将来フェーズ

```
□ Paper Trading
□ Live Position Monitoring  
□ Risk Engine
□ 別シンボル研究（USDJPY等）
□ Session-based Pattern研究
```

---

## 8. Final Completion Roadmap

```
STAGE 3: Production Foundation（推定3〜6週間）
  3-A: 研究パイプライン自動連鎖
  3-B: Final Verdict ステータスシステム
  3-C: MQL5 EA Code Generation
  3-D: MT5 Deployment Pipeline

STAGE 4: UI/UX Polish（推定2〜3週間）
  4-A: MOCK廃止 → 実データ化
  4-B: Strategy Lifecycle UI
  4-C: Cross-Asset Data Integration
  4-D: Production Dashboard

STAGE 5: Production Live（推定4〜8週間）
  5-A: Paper Trading
  5-B: Live Trading（小額）
  5-C: Risk Engine
  5-D: Monitoring & Alerting
  5-E: Final Production Audit

FINAL: AVL-FX Production OS
  → 自然言語から検証済みEAを生成・MT5で運用できる完成系
```

---

*このMASTERドキュメントはすべての実装決定の参照元です。*  
*コードとの矛盾が発生した場合は、実コードを正として本ドキュメントを更新してください。*
