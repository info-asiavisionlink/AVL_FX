# PHASE 7 RESEARCH RESULTS
**Status:** ALL TERMINATED — 両候補否定  
**Research Period:** 2026-08-21  
**Scripts:** `scripts/phase7a_price_structure_edge.ts`, `scripts/phase7b_candidate_confirmation.ts`  
**Verdict:** EURUSD H1 OHLCのみを使った価格構造アプローチで再現可能なエッジなし

---

## Phase 7-A: Price Structure Edge Discovery

### 検証したシグナルファミリー

| Signal | 定義 | BULL | BEAR |
|--------|------|------|------|
| S1 | Large Range Bar (range >= 1.5×ATR) | PROMISING | WEAK |
| S2 | Close Location Value (CLV >= 0.80) | WEAK | CONTRARIAN |
| S3 | Range Expansion (TR >= 1.5×medianTR10) | PROMISING | WEAK |
| S4 | Inside Bar Break（確定後ブレイクアウト） | PROMISING ★ | WEAK |
| S5 | 3-Bar Directional Pressure | WEAK | CONTRARIAN |
| S6 | Extended Move (5bar cumulative >= 2.0×ATR) | **STRONG_CANDIDATE** | CONTRARIAN |

### Phase 7-A の上位候補

```
S6 BULL (Extended Move): 10-bar edge delta +5.2% (N=794, STRONG sample)
  → 5-bar上昇後にさらに上昇 = 継続シグナル

S4 BULL (Inside Bar Break): 5-bar edge delta +4.7% (N=214, VALID)
  → H4でも +4.5% 確認（唯一H4クロスチェック通過）
  
CONTRARIAN パターン多数:
  S6 BEAR: -7.5% (down後にUPリバーサル = 強い平均回帰)
  S5 BEAR: -5.7%
  S4 BEAR: -8.8%
```

---

## Phase 7-B: Candidate Confirmation（Vol-Matched Bootstrap）

### S4 Inside Break BULL

```
Phase 7-A (unmatched random): +4.7%
Phase 7-B (vol-matched random): +0.8% ← 大幅縮小

H4 long-history: -3.1% ← 否定

理由: ATRバケットなしのランダムとの比較が不公平だった
     高ATR局面を選ぶS4が、低ATR randomと比較したため見かけ上良く見えた

分類: NO_EDGE
```

### S6 Extended Move BULL

```
Phase 7-A: +5.2% (10-bar)
Phase 7-B vol-matched: +3.3%
ただし: market bias差し引き後の net edge = +1.3% のみ

クラスタリング問題:
  rawN=795 → 独立サンプル(eventN)=258 (67.6%が5bar以内にクラスター)

Temporal stability: FAIL
  1st-half 59.5% vs 2nd-half 45.5% → 2025 UP相場依存

H4 long-history: -6.8% ← 強く否定（2020-2026データ）

分類: MARKET_BIAS_ONLY
```

---

## Phase 7の重大教訓

1. **Vol-matched Random Controlは必須**: 同じATRバケットから random drawしないと偽陽性になる
2. **クラスタリング**: N=795でも独立サンプルは258のみ — 生Nを信じてはいけない
3. **H4長期データが決定的**: H1 1.5年だけでなくH4 6年でも確認が必要
4. **市場バイアスの分離**: 「LONGなら何でも有利だった期間」との分離が重要

---

## Phase 7 結論

> **EURUSD H1 OHLC のみを使った全6ファミリー × 2方向 = 12仮説で、  
> Volatility Matching + H4 Bootstrap + 時系列分割の全てに耐えるエッジは発見できなかった。**

Phase 7 price-pattern family TERMINATED。

Phase 8へ: 単一シンボルOHLCから、クロスアセット情報への転換。
