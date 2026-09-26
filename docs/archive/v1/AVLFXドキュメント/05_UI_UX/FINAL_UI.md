# FINAL UI VISION
**Status:** DESIGN DOCUMENT — 一部未実装  
**Last Updated:** 2026-08-22

---

## 完成形の目標

```
現在のUI完成度: 約75%

完成している部分:
  - AI EA Builder（モーダル完全動作）
  - Strategy Detail Modal（6タブ全実装）
  - Market Data表示系

未完成の部分:
  - EA Command Center上部パネル（MOCK）
  - Final Verdict表示
  - Live Trading タブ
  - Monitoring Dashboard
  - Strategy Status 変更UI
```

---

## EA Command Center — 最終形イメージ

```
┌───────────────────────────────────────────────────────────┐
│  AVL-FX EA COMMAND CENTER                                 │
│                                                           │
│  ● LIVE 3  ◎ VALIDATED 7  ○ RESEARCHING 2  ✗ REJECTED 5 │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │ RSI REVERSAL EURUSD                               │   │
│  │ ● LIVE  | PF: 1.42  WR: 61%  DD: 8.2%          │   │
│  │ EURUSD H1  Magic#20001  VALIDATED 2026-07-15     │   │
│  │ [詳細] [一時停止] [緊急停止]                       │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │ EMA TREND FOLLOWER USDJPY                         │   │
│  │ ○ RESEARCHING  Optimization実行中...              │   │
│  │ USDJPY H4  Magic#20002                            │   │
│  │ [詳細] [キャンセル]                               │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │ REJECTED: GOLD SCALPER  PF=0.82  FAILED           │   │
│  │ 2026-08-10 (Walk Forward OOS PF平均 < 1.0)       │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  [+ 新しいStrategy]                                       │
└───────────────────────────────────────────────────────────┘
```

---

## Strategy Detail — 最終形のタブ構成

```
現在（実装済み）:
  OVERVIEW | BACKTEST | TRADES | ANALYSIS | VERSIONS | OPTIMIZE

最終形（追加予定）:
  OVERVIEW | BACKTEST | TRADES | ANALYSIS | VERSIONS | OPTIMIZE | LIVE

LIVEタブの内容（未実装）:
  ├── 現在のポジション（MT5リアルタイム）
  ├── 本日のP&L
  ├── バックテスト vs 実績 比較チャート
  ├── 稼働状態（RUNNING/PAUSED/ERROR）
  ├── [一時停止] [再開] [緊急停止] ボタン
  └── ログ（最新20件のシグナル・注文）
```

---

## 実装優先度

```
P0（ワークフロー完成に必須）:
  □ Full Research パイプライン ボタン
  □ Final Verdict (VALIDATED/REJECTED) 表示
  □ Research 進捗インジケーター

P1（品質向上）:
  □ EA Command Center上部MOCK廃止
  □ Strategy Status 変更ドロップダウン
  □ 「古いコメント」の除去（AIEABuilder）
  □ Strategy編集機能（保存後）

P2（将来）:
  □ LIVEタブ
  □ Monitoring Dashboard
  □ Alert設定UI
  □ Portfolio リスクサマリー
```

---

## デザイン原則

```
カラーパレット（変更禁止）:
  Neon Green (#00ff88): 主要アクション / 利益 / 成功
  Cyan (#00e5ff):       情報 / 時間足
  Amber (#fbbf24):      警告 / 注意 / ドラフト
  Red (#ff4466):        損失 / エラー / 危険
  Background (#04060d): 深黒

フォント: font-mono（モノスペース統一）
スタイル: Neon / Glass / Dark cyberpunk
```
