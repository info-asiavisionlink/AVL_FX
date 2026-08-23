# PAPER TRADING
**Status:** NOT_IMPLEMENTED  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 5-A

---

## 現状

> **Paper Tradingは未実装。ライブの前段階として必要。**

---

## 目的

```
Validated Strategy → Paper Trading → Live Trading

Paper Trading段階:
  - 実際の発注はしない
  - リアルタイムティックに対してシグナルを評価
  - 仮想ポジション・仮想P&Lを追跡
  - バックテストとの乖離を確認
```

---

## 実装アプローチ（案）

```
1. リアルタイムTick（MT5 Gateway）を使ってシグナル評価
2. 仮想OrderをDB（paper_trades?）に記録
3. 仮想P&Lを計算してUIに表示
4. バックテスト統計との比較

実装難易度: MEDIUM
前提: Strategy EAがなくても、
     TypeScriptでリアルタイムシグナル評価ができれば可能
```

---

## Paper Trading → Live の移行条件（案）

```
□ Paper Trading期間: 最低30日
□ Paper Trading結果がバックテストと±20%以内
□ Ruin Risk < 5%（Monte Carlo確認）
□ 手動での最終承認
```
