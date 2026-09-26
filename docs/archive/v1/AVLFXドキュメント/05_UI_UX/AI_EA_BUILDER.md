# AI EA BUILDER
**Status:** PRODUCTION_READY  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/presentation/components/ea/AIEABuilder.tsx`, `src/app/api/ai/strategy/build/route.ts`

---

## 概要

自然言語でStrategy（EA）の条件を記述すると、AIがStrategy Spec JSONに変換するモーダルUI。

入力を **エントリー条件 / 利確条件 / 損切り条件** の3欄に分離し、ユーザーが「いつ入るか」「いつ利益確定するか」「いつ損切りするか」を明確に指定できる設計。

---

## フロー

```
input → generating → preview → saving → done
```

---

## Step 1: input — 3欄入力

```
┌─────────────────────────────────────────────┐
│ エントリー条件   ENTRY CONDITIONS   必須     │
│ シンボル・時間足・売買条件・フィルターを入力  │
│ [textarea × 5行]                            │
├─────────────────────────────────────────────┤
│ 利確条件         TAKE PROFIT        必須     │
│ 利益確定する条件を自然言語で入力             │
│ [textarea × 3行]                            │
├─────────────────────────────────────────────┤
│ 損切り条件       STOP LOSS          必須     │
│ 損切りする条件を自然言語で入力               │
│ [textarea × 3行]                            │
├─────────────────────────────────────────────┤
│ 例文（クリックで3欄に入力）× 3件            │
└─────────────────────────────────────────────┘

バリデーション:
  ENTRY:       10文字以上
  TAKE PROFIT: 3文字以上
  STOP LOSS:   3文字以上
  全欄入力済みで [▶ AI で設計する] ボタン活性化
```

### 入力できる内容（ENTRY）

- Symbol / Timeframe
- BUY / SELL エントリー条件
- インジケーター: RSI, EMA, SMA, MACD, ADX, ATR, BOLLINGER_BANDS, STOCHASTIC, PRICE_ACTION, MARKET_STRUCTURE, SUPPORT_RESISTANCE
- セッション: 東京/ロンドン/NY時間 の許可・除外
- スプレッド制限
- マルチタイムフレーム条件

### 入力できる内容（TAKE PROFIT）

- ATR × N 倍
- 直近高値 / 直近安値
- N pips
- リスクリワード 1:N

### 入力できる内容（STOP LOSS）

- ATR × N 倍
- 直近安値 / 直近高値
- N pips
- % ベース

---

## Step 2: generating

```
POST /api/ai/strategy/build {
  entry_conditions_text,
  take_profit_conditions_text,
  stop_loss_conditions_text
}
→ OpenAI json_objectモード（3セクション分離プロンプト）
→ StrategySpec JSON生成
→ Zodバリデーション
→ SL/TP 存在確認（新形式では必須）
```

---

## Step 3: preview — 3セクション表示

```
[Strategy名]  [DAY_TRADE]

── ENTRY CONDITIONS ──────────────────────────
  SYMBOL    [EURUSD]
  TIMEFRAME [M5]

  CONDITIONS — AND:
    ● M5 RSI(14) 30以下から上向き転換
    ⚠ 高値安値切り上げ  [REQUIRES EXTENSION]  ← 未対応条件

  FILTERS:
    SPREAD  最大 2 pips
    SESSION 東京 / NY
    TREND   H1 EMA(21) ↗ 上昇

── TAKE PROFIT ───────────────────────────────
  ATR(14) × 3

── STOP LOSS ────────────────────────────────
  ATR(14) × 2

RISK  1.0% / トレード
[DRAFT] バックテスト未実施

[← 修正する]  [保存して登録]
```

### REQUIRES EXTENSION ラベル

AIが利用可能なインジケーターで表現できない条件（ダウ理論・ローソク足パターン等）は、
Amber色で `REQUIRES EXTENSION` バッジを表示する。

バックテストでは MARKET_STRUCTURE / PRICE_ACTION として扱われる（精度は限定的）。

← 修正する を押すと3入力欄に戻る。入力内容は保持される。

---

## Step 4: saving / done

```
POST /api/strategies { spec, raw_prompt }
  raw_prompt 形式:
    [ENTRY]
    <entryText>

    [TAKE_PROFIT]
    <takeProfitText>

    [STOP_LOSS]
    <stopLossText>

→ strategy_registry INSERT
  status=DRAFT, backtest_status=NOT_TESTED
  magic_number=20001+
→ onSaved(strategy) コールバック
→ [✓ 登録完了]
```

---

## OpenAI プロンプト設計

**モデル:** `OPENAI_MODEL_STRATEGY` env var（デフォルトGPT-4系）

### 3セクション分離プロンプト（新形式）

ユーザーメッセージのフォーマット:
```
=== ENTRY CONDITIONS ===
{entryText}

=== TAKE PROFIT CONDITIONS ===
{tpText}

=== STOP LOSS CONDITIONS ===
{slText}
```

セクションマッピングルール（AIへの指示）:
```
ENTRY  → symbols, timeframes, strategy_type, entry_conditions, filters
TP     → exit_conditions.take_profit のみ
SL     → exit_conditions.stop_loss のみ
混在禁止: TPの内容をentry_conditionsに入れない
混在禁止: SLの内容をentry_conditionsに入れない
```

### セッション変換ルール

| ユーザー入力 | sessions フィールド |
|-------------|-------------------|
| ロンドン時間のみ | ["LONDON"] |
| NY時間のみ | ["NEW_YORK"] |
| ロンドン・NY時間 | ["LONDON", "NEW_YORK"] |
| ロンドン時間はエントリーしない | ["TOKYO", "NEW_YORK", "SYDNEY"] |
| 東京時間はエントリーしない | ["LONDON", "NEW_YORK", "SYDNEY"] |

### 未対応条件の扱い

ダウ理論・ローソク足パターン・サポレジゾーン・曜日制限など、スキーマで表現できない条件:
```
indicator: "MARKET_STRUCTURE" or "PRICE_ACTION"
condition: "UNSUPPORTED: <元の日本語記述>"
```

→ Preview で Amber の `REQUIRES EXTENSION` バッジとして表示される。

### 後方互換（旧形式）

`{ prompt }` フィールドが送信された場合（旧形式）:
- 旧システムプロンプト使用
- SL/TP の存在確認なし
- 既存コードとの互換性を維持

---

## バリデーション

| レイヤー | 内容 |
|---------|------|
| フロント | ENTRY≥10文字、TP≥3文字、SL≥3文字で生成ボタン活性化 |
| API入力 | 同上、合計3000文字以内 |
| Zod | ホワイトリスト検証（インジケーター・TF・セッション等） |
| SL/TP確認 | 新形式では両方必須（欠落時エラー） |

---

## 例文

**例1: RSI スキャルピング**
- ENTRY: EURUSDのM5。H1の価格がEMA21より上で上昇トレンド。M5のRSIが30以下から上向きに反転したらBUY。ロンドン時間はエントリーしない。スプレッド2pips以下。
- TP: ATR14の3倍で利確。
- SL: ATR14の2倍で損切り。

**例2: EMA トレンドフォロー**
- ENTRY: USDJPYのH1。EMA21がEMA200より上でBUY。ADX25以上。NY時間のみ。
- TP: リスクリワード1:2
- SL: 直近安値

**例3: ゴールド スイング**
- ENTRY: GOLDのH4。上昇トレンド中にRSI50付近から反発したらBUY。
- TP: 直近高値
- SL: ATR × 2

---

## 制約・注意事項

```
□ 保存後のStrategy Spec編集機能 — 未実装（UI操作なし）
□ Dow Theory / ローソク足パターン — REQUIRES EXTENSION（バックテスト精度限定的）
□ 曜日制限（金曜不可等）— スキーマ非対応、UNSUPPORTED として記録
□ セッション除外 — sessions の反転で近似（除外専用フィールドなし）
```
