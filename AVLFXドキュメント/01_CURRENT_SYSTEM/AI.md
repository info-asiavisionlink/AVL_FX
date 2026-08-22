# AI LAYER
**Status:** IMPLEMENTED — OpenAI使用、Claude Codeは開発ツール  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/app/api/ai/`, `src/infrastructure/backtest/BacktestAnalyzer.ts`

---

## AI の役割分担

| AI | 用途 | 状態 |
|-----|------|------|
| **OpenAI** | Strategy Spec生成・Backtest分析・改善提案・Cross-Phase解釈 | `IMPLEMENTED` |
| **Claude (Anthropic)** | Claude Code（開発ツール）。AVL-FXシステム内では未使用 | 開発用のみ |

---

## 1. AI EA Builder（Strategy Spec生成）

**エンドポイント:** `POST /api/ai/strategy/build`

**モデル:** `process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat`

### 入力フォーマット

```typescript
// 新形式（推奨）— UI から送信
{
  entry_conditions_text:       string;  // 10文字以上
  take_profit_conditions_text: string;  // 3文字以上
  stop_loss_conditions_text:   string;  // 3文字以上
}

// 旧形式（後方互換）
{ prompt: string }
```

### プロセス

```
3欄テキスト受信 + バリデーション（合計3000文字以内）
↓
3セクション分離ユーザーメッセージ構築:
  === ENTRY CONDITIONS ===
  {entryText}
  === TAKE PROFIT CONDITIONS ===
  {tpText}
  === STOP LOSS CONDITIONS ===
  {slText}
↓
OpenAI Chat Completions API（json_objectモード）
↓
Strategy Spec JSON
↓
StrategySpecSchema.safeParse() でZodバリデーション
↓
SL/TP 存在確認（新形式では必須）
↓
{ success: true, spec: StrategySpec } を返す
（保存はしない — /api/strategies でSEPARATEに保存）
```

### Systemプロンプトの核心（新形式）

```
CRITICAL SECTION MAPPING:
  ENTRY  → symbols, timeframes, entry_conditions, filters
  TP     → exit_conditions.take_profit のみ
  SL     → exit_conditions.stop_loss のみ
  セクション混在禁止

未対応条件の処理:
  indicator: MARKET_STRUCTURE / PRICE_ACTION
  condition: "UNSUPPORTED: <原文>"

WHITELISTS:
  Indicators: RSI, EMA, SMA, MACD, ADX, ATR, BOLLINGER_BANDS, STOCHASTIC,
              PRICE_ACTION, MARKET_STRUCTURE, SUPPORT_RESISTANCE
  Timeframes: M1, M5, M15, M30, H1, H4, D1, W1
  Sessions: TOKYO, LONDON, NEW_YORK, SYDNEY
  SL methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE
  TP methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE

ABSOLUTE PROHIBITIONS:
  - MQL5/JavaScript/Python/実行可能コードを出力しない
  - パフォーマンス保証をしない
  - ホワイトリスト外のインジケーターを使用しない
```

---

## 2. AI Backtest Analysis

**エンドポイント:** `POST /api/strategies/[id]/analyze`

**モデル:** `MODELS.chatFast`（高速モデル）

### 処理フロー

```
BacktestAnalyzer.buildAnalysisContext(report, trades, spec)
→ コンテキスト（統計サマリー＋個別取引集計）を構築

BacktestAnalyzer.buildAnalysisPrompt(context)
→ systemPrompt + userPrompt を生成

OpenAI Chat Completions（json_objectモード）
→ AI分析 JSON 出力

BacktestAnalyzer.parseAnalysisResponse(rawText)
→ Zodスキーマでパース

BacktestAnalyzer.validateFactIntegrity(facts, context)
→ Backtestデータと矛盾するFactを除去

strategy_ai_analyses に INSERT
```

### AI分析の出力構造

```typescript
interface AIAnalysis {
  summary:          string;
  facts:            AnalysisFact[];      // Backtestで確認された事実
  observations:     string[];            // 観察傾向
  hypotheses:       string[];            // 仮説（未確認）
  weaknesses:       string[];            // 弱点
  strengths:        string[];            // 強み
  session_analysis: Record<string, string>;
  risk_analysis:    string[];
  recommendations:  string[];
  confidence:       "HIGH" | "MEDIUM" | "LOW";
  data_quality_note?: string;
}
```

### Fact Integrity Check（重要）

```
AIが生成したFactsを、実際のBacktest数値と照合する。
例: "勝率70%以上" → 実際の勝率が60%なら除去。

→ AIのハルシネーションによる誤ったFactを排除する仕組み
```

---

## 3. AI Improvement Proposal

**エンドポイント:** `POST /api/strategies/[id]/improve`

- 最新のAI分析 + 現在のStrategy Specから改善案を生成
- 改善後のSpec JSONを strategy_improvements に保存
- ユーザーが承認してVersionとして保存するかは手動判断

---

## 4. Cross-Phase AI Interpretation

**エンドポイント:** `POST /api/strategies/[id]/interpret`

```
InterpretationEngine がコンテキスト構築:
  - Backtest結果
  - AI Analysis
  - Optimization結果
  - Walk Forward結果
  - Monte Carlo結果

OpenAI が4フェーズ横断で解釈:
  BACKTEST_ANALYSIS: バックテスト評価
  OPTIMIZATION:     最適化安定性
  WALK_FORWARD:     時系列ロバスト性
  MONTE_CARLO:      確率的期待値

→ strategy_phase4d_interpretations に保存
```

---

## 5. AI Chat（市場分析）

**エンドポイント:** `POST /api/ai/chat`

- 市場状況・価格分析についての自然言語Q&A
- Strategy Researchとは独立したAI機能

---

## openai-client.ts

```typescript
// src/infrastructure/ai/openai-client.ts

export const MODELS = {
  chat:       "gpt-4o",         // デフォルトチャット
  chatFast:   "gpt-4o-mini",    // 高速・低コスト（AI Analysis用）
} as const;

export function getOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
```

---

## AI セキュリティ原則

1. **コード生成禁止**: AI EA BuilderではMQL5/JavaScript/Python等の実行可能コードを生成しない
2. **ホワイトリスト方式**: 許可されたindicator/TF/symbol以外はZodで全て拒否
3. **Fact検証**: AI分析のFactsはBacktestデータと照合して矛盾を除去
4. **人間の確認**: AI出力は常にPreview/確認ステップを通る（自動実行しない）

---

## 未実装のAI機能

| 機能 | 状態 |
|-----|------|
| シグナル生成（リアルタイム） | `NOT_IMPLEMENTED` |
| 自動取引判断 | `NOT_IMPLEMENTED`（設計上永続的に禁止） |
| Final Verdict 自動判定 | `NOT_IMPLEMENTED` |
