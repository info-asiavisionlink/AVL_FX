# Stage 1 Step 07: AI設計EA スクリーニング & 登録

**日付**: 2026-08-23  
**コミット**: d551ba1  
**デプロイ**: Production READY

---

## スクリーニング条件

| 条件 | 値 |
|------|-----|
| 勝率 (WR) | ≥ 30% |
| 月間取引回数 | ≥ 5 回/月 |
| トータルPIPS | > 0 |

データ: EURUSD H1/H4 (H1=~19.7ヶ月, H4=~54ヶ月)

---

## 登録EA一覧 (magic 20006-20012)

| EA名 | WR | PIPS | PF | 月間取引 |
|------|-----|------|-----|---------|
| H1 Ichimoku Cloud BUY | 32.7% | 112.3 | 1.02 | 11.2/mo |
| H1 AO EMA MACD Triple BUY | 30.6% | 668.3 | 1.18 | 9.1/mo |
| H1 Ichimoku MACD BUY | 30.4% | 528.9 | 1.14 | 9.3/mo |
| H1 Ichimoku RSI BUY | 33.5% | 257.6 | 1.06 | 11.2/mo |
| H1 Ichimoku ADX BUY | 35.1% | 474.6 | 1.12 | 9.4/mo |
| H1 AO MACD BUY | 30.1% | 587.0 | 1.16 | 9.3/mo |
| H1 Ichimoku RSI MACD BUY | 30.4% | 528.9 | 1.14 | 9.3/mo |

---

## 主要知見

### 有効な組み合わせ
- **一目均衡表 PRICE_ABOVE_CLOUD**: 最も安定した強気フィルター (WR 30-35%)
- **AO (Awesome Oscillator) ABOVE 0**: モメンタム確認に有効
- **MACD ABOVE_SIGNAL**: エントリー精度向上に貢献
- **H4 EMA21 BULLISH フィルター**: データ期間のUPバイアスと相性が良い

### 有効でなかった組み合わせ
- **SELL戦略**: データ期間のEURUSD上昇バイアスにより全不合格 (WR=22-24%)
- **EMA期間50**: precomputed indicators に存在しない (ema1=21, ema2=200 のみ有効)
- **Donchian PRICE_ABOVE/BELOW**: 実装上ほぼ0信号 (現在バーのhigh/lowを含むため)
- **EMA BULLISH_CROSS (21/200 golden cross)**: 年に数回しか発生しない
- **PSAR 系**: 取引回数は多いがWR低く負のPIPS

### SL/TP 最適値
- **SL = ATR(14) × 2.0** (H1スウィングに適切)
- **TP = RR 2.0-2.5** (WR30%でPF≥1.06)
- トレーリングストップは勝ちを切りすぎる傾向 → 固定TPが良好

---

## スクリプト

```bash
# スクリーニング再実行
npx tsx --env-file=.env.local scripts/add_curated_eas.ts     # 20候補 バッチ1
npx tsx --env-file=.env.local scripts/add_curated_eas_v3.ts  # 10候補 バッチ2
npx tsx --env-file=.env.local scripts/add_curated_eas_v4.ts  # 8候補 バッチ3
```
