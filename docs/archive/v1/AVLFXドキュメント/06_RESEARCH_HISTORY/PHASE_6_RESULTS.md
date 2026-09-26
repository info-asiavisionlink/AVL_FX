# PHASE 6 RESEARCH RESULTS
**Status:** ALL TERMINATED — 全仮説棄却  
**Research Period:** 2026-08-21  
**Scripts:** `scripts/phase6a_screening.ts` 〜 `scripts/phase6g_regime_confirmation.ts`  
**Verdict:** H1 Mean Reversion / Breakout / Momentum系、全方向で否定

---

## Phase別サマリー

| Phase | 内容 | 最終結論 |
|-------|------|---------|
| 6-A | 3仮説スクリーニング（Breakout/Momentum/MeanRev） | **ALL REJECTED** PF 0.28〜0.33 |
| 6-B | Execution/Exit Audit | Same-bar SL=64%問題発見（コスト設計の根本問題） |
| 6-C | Exit Model再設計（SL=3×ATR） | PF=0.811 — シグナル不足 |
| 6-D | H1/H4時間足検証 | H1 OOS PF=1.054（際どい） |
| 6-E | 4仮説比較 | LONG/SHORT非対称発見（LONG PF=1.100 > SHORT PF=0.765） |
| 6-F | 方向性監査（LONG vs SHORT） | **TEMPORARY_REGIME_EFFECT** |
| 6-G | Regime仮説確認（DOWN_REGIME × LONG） | **NO_EDGE** |

---

## Phase 6-F 重要発見

```
EURUSD LONG/SHORT 非対称性の実態:

  2025年（+1438pip UP相場）: LONG PF=1.198  SHORT PF=0.634
  2026年（-39pip DOWN相場）: LONG PF=0.952  SHORT PF=1.151

結論: LONG優位は2025年UP相場への方向バイアスだった
分類: TEMPORARY_REGIME_EFFECT
```

---

## Phase 6-G 決定的結果

```
DOWN_REGIME × H1 MR LONG の Vol-matched比較:
  Strategy PF:         1.114
  Same-Regime Random:  1.292  ← ランダムを下回る

結論: Regime自体のバイアスが見かけ上のエッジを偽装していた
分類: NO_EDGE
```

---

## Phase 6 で学んだこと（重要）

1. **Same-Regime Random Control が必須**: ATRバケットや相場環境をマッチさせたランダムと比較しなければ偽エッジを見逃す
2. **短期バックテストの方向バイアス**: 市場全体がUPの時期にLONG戦略を検証すると過大評価される
3. **Regime分類は後付けしない**: Phase 6-Gでは「DOWN_REGIME LONGが良かった」発見後にその仮説を検証したため、Post-hoc hypothesisの問題が残る

---

## 結論

> **H1 Mean Reversion / Breakout / Momentum系アプローチで、  
> Volatility-matched Random Controlを上回る再現可能なエッジは見つからなかった。**

Phase 7でOHLC価格構造探索に移行。
