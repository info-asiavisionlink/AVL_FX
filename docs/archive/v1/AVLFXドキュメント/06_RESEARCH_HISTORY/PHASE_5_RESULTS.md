# PHASE 5 RESEARCH RESULTS
**Status:** TERMINATED — 全仮説棄却  
**Research Period:** 2026-08-21  
**Script:** `scripts/phase5f_anatomy.ts` 他  
**Verdict:** EMA21 Pullback仮説、全条件で否定

---

## 研究目的

EMA21プルバック戦略（価格がEMA21まで戻ったら順張りエントリー）の有効性を検証。

---

## 検証したサブフェーズ

| Phase | 内容 | 結果 |
|-------|------|------|
| 5-A〜C | EMA21プルバック（LONG/SHORT対称） | WEAK |
| 5-D | RSI CROSS_UP/DOWN 50モメンタム | REJECTED |
| 5-E | RSI State Filter仮説 | FAILED (MARGINALLY SUPPORTED) |
| 5-F | Trade Anatomy分析（MFE/MAE解剖） | WR=20.3%、WEAK |
| 5-G | 環境フィルター検証（EMA21仮説） | TERMINATED |

---

## Phase 5-F 主要数値

```
総取引数: 2,290
勝率: 20.3%
MFE中央値: 0.90 pips
MAE中央値: -5.10 pips
→ 平均的に含み益より含み損の方が3〜6倍大きい

エントリータイミング: 不良
SL設計: 不適切（初期実装の問題）
```

---

## 結論

> **EMA21 Pullback仮説は実データで棄却。**

勝率20.3%では持続可能な戦略の基礎にならない。  
Phase 6で新しいアプローチに移行。

---

## 教訓

1. EMA21への「プルバック」は実際には深く押しすぎることが多い
2. 順張り戦略でもMFE < MAEなら期待値は負
3. WR 20%ではSL:TP比をどれだけ有利にしても難しい
