# Stage 1 Step 06: ローソク足パターン・トレーリングストップ・複数TP 実装

**日付**: 2026-08-23  
**コミット**: 428cd95  
**デプロイ**: https://avl-gjcoepa1j-asia-link-ais-projects-ff6dd464.vercel.app (Production READY)

---

## 追加された機能

### 1. ローソク足パターン認識 (PRICE_ACTION)

`evaluator.ts` に8種のキャンドルスティックパターン判定を実装。

| パターン | condition | 対応方向 |
|---------|-----------|---------|
| ピンバー | PIN_BAR | BULLISH / BEARISH |
| エンゴルフィング | ENGULFING | BULLISH / BEARISH |
| ハンマー | HAMMER | BULLISH のみ |
| シューティングスター | SHOOTING_STAR | BEARISH のみ |
| ドジ | DOJI | BULLISH / BEARISH |
| インサイドバー | INSIDE_BAR | BULLISH / BEARISH |
| モーニングスター | MORNING_STAR | BULLISH のみ |
| イブニングスター | EVENING_STAR | BEARISH のみ |

**スキーマ例:**
```json
{ "indicator": "PRICE_ACTION", "operator": "BULLISH", "condition": "PIN_BAR", "timeframe": "H1" }
```

### 2. トレーリングストップ (trailing_stop)

`exit_conditions.trailing_stop` に3方式を実装。

| method | パラメータ | 説明 |
|--------|-----------|------|
| ATR | multiplier, period | ATR の N 倍距離で追随 |
| FIXED_PIPS | pips | 固定 pips 距離 |
| PERCENTAGE | pct | 価格の N% 距離 |

`activation_pips`: 発動前に最低 N pips の利益が必要（省略で即発動）

**スキーマ例:**
```json
"trailing_stop": { "method": "ATR", "multiplier": 2.0, "activation_pips": 10 }
```

### 3. 複数TP / 段階決済 (take_profits[])

`exit_conditions.take_profits` で最大3レベルの部分決済を実装。

- `portion`: このレベルでクローズする割合 (0.5 = 50%)
- 全レベルの portion 合計 = 1.0 推奨
- 既存の `take_profit` と共存可（take_profits が優先）

**スキーマ例:**
```json
"take_profits": [
  { "method": "ATR", "multiplier": 1.5, "portion": 0.5 },
  { "method": "ATR", "multiplier": 3.0, "portion": 0.5 }
]
```

---

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/strategySchema.ts` | TrailingStopSchema・take_profits・BULLISH/BEARISH operator 追加 |
| `src/infrastructure/backtest/evaluator.ts` | evalCandlePattern 関数 (8種)・PRICE_ACTION case 追加 |
| `src/infrastructure/backtest/PositionManager.ts` | TPLevel型・updateTrailingStop・checkPartialExits 追加 |
| `src/infrastructure/backtest/BacktestEngine.ts` | calcTPItemPrice・calcTrailDistance・MultiTP/TrailingStop ループ統合 |
| `src/app/api/ai/strategy/build/route.ts` | AI プロンプトに3機能の使用例を追加 |
| テストファイル (6本) | PrecomputedIndicators 新フィールド対応・test 30 期待値修正 |

---

## テスト結果

| テストファイル | 結果 |
|-------------|------|
| evaluator.test.ts | 40/40 PASS |
| phase5a.test.ts | PASS |
| phase5c.test.ts | PASS |
| phase5d.test.ts | PASS |
| phase5e.test.ts | PASS |
| phase6a.test.ts | 24/24 PASS |
| phase6b.test.ts | 26/26 PASS |

TypeScript: エラーなし (tsc --noEmit 終了コード 0)

---

## 既知の制限

- ローソク足パターンの判定はバックテストエンジン内での評価のみ。MT5 EA コード生成には別途対応が必要
- DOJI / INSIDE_BAR は方向が不確定なため、BULLISH/BEARISH 指定で意図を明示する
- 複数TP使用時、最終レベルのヒット後に残ポジションがゼロになれば自動クローズ
