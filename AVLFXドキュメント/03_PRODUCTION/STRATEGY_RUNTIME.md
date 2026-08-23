# STRATEGY RUNTIME
**Status:** NOT_IMPLEMENTED  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 3-C, 3-D

---

## 現状

> **Strategy Runtime（実際に取引するEA）は存在しない。**

---

## 設計（計画段階）

### Strategy EA の役割

```
AVL_DataManager_v2.mq5: データ収集専用（売買なし）
Strategy EA:            各Strategyの売買ロジック（未実装）
  → 1つの検証済みStrategyに対して1つのStrategy EAを生成する想定
```

### MQL5 生成の基本設計

Strategy Specから以下のMQL5コードを生成する:

```mql5
// 生成されるStrategy EA の骨格
int OnInit() {
  // magic_number = 20001 (strategy_registryから)
  // パラメーター読み込み
}

void OnTick() {
  if (PositionExists()) return;
  
  // Entry評価（Strategy SpecのEntry Conditionsを実装）
  if (CheckEntryConditions()) {
    // SL/TP計算（ATR × multiplier等）
    // OpenBuy() / OpenSell()
  }
  
  // Exit評価（TP/SL ヒット確認）
}
```

### 生成対応が必要なEntry Conditions

```
現在のALLOWED_INDICATORS:
  RSI: RSI(period) CROSS_UP/CROSS_DOWN threshold
  EMA: EMA(period) PRICE_ABOVE/PRICE_BELOW
  SMA: SMA(period) PRICE_ABOVE/PRICE_BELOW
  MACD: MACD HISTOGRAM_POSITIVE/NEGATIVE
  ADX: ADX(period) ABOVE threshold (min_adx filter)
  ATR: ATR(period) [SL/TP計算に使用]
  BOLLINGER_BANDS: 範囲内外
  STOCHASTIC: %K/%D クロス
  PRICE_ACTION: 価格アクション
  MARKET_STRUCTURE: 市場構造（複雑）
  SUPPORT_RESISTANCE: サポレジ（複雑）
```

### 生成難易度

| 条件 | 生成難易度 |
|-----|----------|
| RSI, EMA, SMA | 低（標準インジケーター） |
| ATR SL/TP | 低 |
| Session filter | 中 |
| ADX filter | 低 |
| MACD | 中 |
| BOLLINGER_BANDS | 中 |
| MARKET_STRUCTURE | 高（曖昧な定義） |
| SUPPORT_RESISTANCE | 高（動的な計算が必要） |

---

## 実装アプローチ（案）

### Phase 1: テンプレートベース生成

```
1. 最もシンプルなEntry条件（RSI + EMA組み合わせ）からサポート開始
2. テンプレートMQL5ファイルにパラメーターを挿入
3. コンパイルはユーザーが手動でMT5で実施
```

### Phase 2: 複雑な条件への対応

```
4. MACD/ADX/BB等へ対応を拡張
5. Session filterの実装
6. バリデーション（生成前にサポート可否チェック）
```

---

## 注意事項

- 生成されたMQL5コードの品質チェックは**手動確認が必須**
- 完全自動デプロイは安全リスクがあるため、人間のレビューを挟む
- バックテスト結果と同じロジックをMQL5で再現することが最重要
