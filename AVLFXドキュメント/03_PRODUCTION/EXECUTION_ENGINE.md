# EXECUTION ENGINE
**Status:** NOT_IMPLEMENTED  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 3-C, 5-B

---

## 現状

> **実際の注文執行エンジンは存在しない。BacktestEngineはシミュレーションのみ。**

---

## BacktestEngine との違い

| 項目 | BacktestEngine（実装済み） | Execution Engine（未実装） |
|-----|--------------------------|--------------------------|
| 目的 | 過去データでのシミュレーション | リアル市場での執行 |
| データ | bar_data（過去OHLC） | MT5リアルタイムTick |
| 注文 | 仮想（計算のみ） | 実際のMT5 OrderSend |
| SL/TP | 計算値（正確） | ブローカーの実執行（スリッページあり） |
| 動作環境 | Next.js API / Research script | MT5 EA（MQL5） |

---

## 設計思想

```
BacktestEngine（TypeScript）で検証した戦略ロジックを、
MQL5で同等に再現したStrategy EAを作成する。

両者のロジックが異なると バックテスト乖離（out-of-sample gap）が発生する。
→ MQL5生成時の最重要課題
```

---

## 将来実装内容

```
1. シグナル評価（Strategy SpecのEntry Conditionsに基づく）
2. ポジションサイズ計算（risk_per_trade%から算出）
3. SL/TP計算（ATR × multiplier等）
4. OrderSend / OrderModify / OrderClose
5. Magic Number による自識別
6. ポジション重複防止
7. 最大同時ポジション数制限
```
