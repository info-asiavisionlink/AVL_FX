# STAGE 1 — STEP 01: AI EA BUILDER 3条件入力分離
**Date:** 2026-08-22  
**Status:** COMPLETED  
**Category:** UI / AI Prompt / Strategy Creation

---

## 変更概要

AI EA Builder の入力欄を、1つの自然言語フリーテキストから3つの明確な入力欄に分離した。

**Before:**
```
[どんなEAを作りますか？]
[textarea — Entry/Exit/Risk をまとめて記述]
```

**After:**
```
[エントリー条件  ENTRY CONDITIONS  必須]
[textarea — シンボル・時間足・売買条件・フィルター]

[利確条件  TAKE PROFIT  必須]
[textarea — 利益確定条件]

[損切り条件  STOP LOSS  必須]
[textarea — 損切り条件]
```

---

## 変更ファイル

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `src/presentation/components/ea/AIEABuilder.tsx` | 全面改修 | 3欄UI・新Preview・新ハンドラ・小コンポーネント再設計 |
| `src/app/api/ai/strategy/build/route.ts` | 機能追加 | 3フィールド入力受付・新3セクションプロンプト・SL/TP存在確認 |
| `src/lib/strategySchema.ts` | 軽微追加 | `conditionToJapanese` に NEAR_EMA / SUPPORT_RESISTANCE / PRICE_ACTION 追加 |

---

## UI変更詳細

### 新しい InputSection コンポーネント

```
ラベル（日本語）+ サブラベル（英語）+ 必須マーク
説明文
textarea（ENTRY: 5行 / TP・SL: 3行）
入力済み → accent colorボーダー
未記入 → グレーボーダー
```

### 新しい PreviewSection コンポーネント

```
── TITLE ──────────────────  (divider + title + divider)
[accent color ボーダーボックス]
  内容
```

### 3セクションPreview

1. **ENTRY CONDITIONS** — Symbol/TF/Conditions(日本語)/Filters
2. **TAKE PROFIT** — `tpToJapanese()` ヘルパーで変換
3. **STOP LOSS** — `slToJapanese()` ヘルパーで変換

### REQUIRES EXTENSION バッジ

AIが `condition: "UNSUPPORTED: ..."` を設定した場合:
- Amber色の ⚠ アイコン
- 元の条件テキスト（日本語）
- `[REQUIRES EXTENSION]` バッジ

### 例文ボタン

3件 → クリックで3欄同時入力（EntryのみPreviewのため簡略表示）

### 修正フロー

`← 修正する` → 3入力欄に戻る。入力内容は全て保持される（`input` ステートが InputState 型で保持）

---

## API変更詳細

### 新リクエストボディ（推奨）

```typescript
{
  entry_conditions_text:       string;  // min 10文字
  take_profit_conditions_text: string;  // min 3文字
  stop_loss_conditions_text:   string;  // min 3文字
}
```

### 後方互換

```typescript
{ prompt: string }  // 旧形式 — 旧プロンプトで処理
```

### 新ユーザーメッセージ構造

```
=== ENTRY CONDITIONS ===
{entryText}

=== TAKE PROFIT CONDITIONS ===
{tpText}

=== STOP LOSS CONDITIONS ===
{slText}
```

### 追加バリデーション（新形式のみ）

- 合計文字数 ≤ 3000
- Zod通過後に `exit_conditions.stop_loss` 存在確認
- Zod通過後に `exit_conditions.take_profit` 存在確認

---

## Prompt変更詳細

### 新システムプロンプト（`buildSystemPrompt3Field`）

追加したルール:
1. **セクションマッピング明示** — ENTRY/TP/SL を明示的に分離指定
2. **未対応条件の扱い** — `UNSUPPORTED:` プレフィックスで報告
3. **セッション除外変換** — 「ロンドン除外」→ sessions = ["TOKYO", "NEW_YORK", "SYDNEY"]
4. **RR Ratio明示** — 「RR 1:2」→ `{ method: "RR_RATIO", rr_ratio: 2.0 }`
5. **SL/TP パターン集** — 代表的な自然言語→スキーマ変換例

---

## raw_prompt 保存形式

Migrationなし。既存の `raw_prompt TEXT` カラムに以下フォーマットで保存:

```
[ENTRY]
{entryText}

[TAKE_PROFIT]
{takeProfitText}

[STOP_LOSS]
{stopLossText}
```

---

## 既存への影響

| 対象 | 影響 |
|-----|------|
| BacktestEngine | 変更なし |
| OptimizationEngine | 変更なし |
| WalkForwardEngine | 変更なし |
| MonteCarloEngine | 変更なし |
| StrategyDetailModal | 変更なし |
| EACommandCenter | 変更なし |
| strategy_registry スキーマ | 変更なし（Migration不要） |
| StrategySpecSchema（Zod） | 変更なし（conditionToJapanese のみ追加） |
| `{ prompt }` 旧APIフォーマット | 後方互換を維持 |

---

## テスト項目（手動確認項目）

### UI
- [x] 3入力欄が表示される
- [x] ENTRY空欄では生成ボタンが無効
- [x] TP空欄では生成ボタンが無効
- [x] SL空欄では生成ボタンが無効
- [x] 例文クリックで3欄同時入力
- [x] ← 修正するで3欄内容保持
- [x] Previewに3セクション表示

### 型チェック
- [x] `npx tsc --noEmit` — エラー0

---

## 制約・既知の制限

```
□ 曜日制限（金曜不可等）— スキーマ非対応、UNSUPPORTED として記録
□ セッション除外 — sessions の反転で近似
□ Dow Theory / ローソク足パターン — REQUIRES EXTENSION バッジ表示、精度限定
□ 保存後のSpec編集 — 未実装（今回スコープ外）
```
