# AVLFX Trading View — ロードマップ
## GOLD Specialized Customer Trading System
### 最終更新: 2026-09

---

## 責任範囲

Trading ViewはCustomer向けGOLD取引システムです。
Console（AVL管理側）との責任を厳密に分離します。

| Trading View の責任 | Console の責任 |
|---|---|
| GOLDリアルタイムチャート | GOLD Historical Data管理 |
| EA / Strategy Builder（UI） | Strategy Registry（Master） |
| Backtest UI | Research API（Backtest実行） |
| Positions / Trade History | Customer管理・Contract管理 |
| MT5接続・Bridge | Console Gateway・DataManager |

---

## 現状監査（コードベース確認済み）

### ✅ DONE（実装完了 / 維持）

- strategy_registry テーブル（magic_number・JSONB条件）
- strategy_versions テーブル（バージョン履歴）
- strategy_signals テーブル（Signal → Command分離）
- strategy_runtime_state テーブル（STOPPED/RUNNING/ERROR）
- execution_commands テーブル（strategy_id・magic_number・command_id・position_ticket・deal_ticket）
- mt5_connections テーブル（account_mode: HEDGING/NETTING）
- live_positions / live_deals テーブル
- backtest_jobs / backtest_results テーブル
- BacktestEngine.ts（メインエンジン）
- evaluator.ts（Pure Function）
- WalkForwardEngine / MonteCarloEngine / OptimizationEngine
- BacktestAnalyzer / BacktestReporter
- AI EA Builder（Strategy自然言語作成）
- Strategy Improvement / Interpretation
- MT5接続・Bridge・Execution
- News API / Economic Calendar API

### ❌ 削除予定

- user_subscriptions テーブル（Stripe SaaS）
- /api/stripe/ 各ルート
- Pricing UI（pricing/page.tsx）
- src/presentation/components/os/ （DashboardOS・AI Brain・3D）
- useRealtimeAgent.ts（Voice / OpenAI Realtime）
- Three.js・GSAP依存
- Autonomous AI Order

### 🔄 移行必要

- BacktestService.ts: bar_data Supabase直接参照 → Research API経由
- Public Strategy ID対応（Console側Strategy ImportからのID参照）

---

## Hedging / Netting 設計方針

```
mt5_connections.account_mode: 'HEDGING' | 'NETTING'（DB実装済み）
```

- **Hedging**（推奨）: 同GOLDシンボルで複数Strategy（BUY+SELL）を同時保有可
- **Netting**: 同シンボルのポジションが相殺される → 複数Strategy混在で意図せず決済の危険
- **現在**: HEDGINGデフォルト。Nettingアカウントでの複数Strategy同時稼働は制約を明記する

---

## 実装Stage（Console完成後に着手）

### TV-1 SaaS削除
- user_subscriptions 削除
- Stripe API 削除
- Pricing UI 削除
- Public Signup 見直し

### TV-2 JARVIS / 3D削除
- DashboardOS・AI Brain削除
- Voice削除
- Three.js・GSAP削除
- Autonomous AI Order削除

### TV-3 Research API移行
- BacktestServiceをResearch API経由に移行
- Console Supabase直接参照を廃止

### TV-4 GOLD専用UX
- GOLD特化UI整理
- News/Calendar（USD・Fed・CPI・NFP関連強化）

### TV-5 Customer MT5 Onboarding改善
- AVL_FX_Bridge.ex5（コンパイル済みバイナリ提供）
- セットアップガイド整備

### TV-6 Strategy ID Import
- Console発行のPublic Strategy IDからImport機能
- Importは特定Versionのspec_snapshotコピー

---

*責任境界: AVL-FX Console Roadmapが先行。Trading Viewは Console C1〜C9完成後に本格着手。*
