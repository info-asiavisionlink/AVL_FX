# EA CREATION FLOW
**Status:** PARTIAL — 保存まで完了。Research自動化・EA生成は未実装  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/presentation/components/ea/AIEABuilder.tsx`, `/api/strategies`

---

## 現在実装されているフロー

```
STEP 1: EA Command Center を開く（/ea）
  ↓
STEP 2: [+ EA追加] ボタンをクリック
  ↓ AIEABuilderモーダルが開く
  
STEP 3: 3欄に条件を入力
  ┌─ エントリー条件（ENTRY CONDITIONS）必須 10文字以上 ─┐
  │  シンボル・時間足・売買条件・セッション・フィルター  │
  │  例: EURUSDのM5。RSI30以下から反転したらBUY。       │
  │       ロンドン時間除外。スプレッド2pips以下。        │
  └─────────────────────────────────────────────────────┘
  ┌─ 利確条件（TAKE PROFIT）必須 3文字以上 ─────────────┐
  │  例: ATR14の3倍                                     │
  └─────────────────────────────────────────────────────┘
  ┌─ 損切り条件（STOP LOSS）必須 3文字以上 ──────────────┐
  │  例: ATR14の2倍                                     │
  └─────────────────────────────────────────────────────┘
  ↓
STEP 4: [AI で設計する] ボタン
  ↓ POST /api/ai/strategy/build {
      entry_conditions_text,
      take_profit_conditions_text,
      stop_loss_conditions_text
    }
  ↓ OpenAI（3セクション分離プロンプト）
  ↓ Strategy Spec JSON生成（約5〜15秒）
  ↓ Zodバリデーション + SL/TP存在確認
  
STEP 5: Preview確認（PREVIEW ステップ）— 3セクション表示
  ENTRY CONDITIONS:
    - SYMBOL / TIMEFRAME
    - CONDITIONS リスト（未対応条件は REQUIRES EXTENSION バッジ）
    - FILTERS（SESSION / SPREAD / TREND）
  TAKE PROFIT:
    - 利確方法（ATR×N / RR1:N / 直近高値 等）
  STOP LOSS:
    - 損切り方法（ATR×N / 直近安値 等）
  RISK:
    - リスク%
  [DRAFT] バックテスト未実施 — 保存後に実行できます
  
  選択肢:
    [← 修正する] → 3入力欄に戻る（入力内容は保持）
    [保存して登録] → 次のステップへ
  ↓
STEP 6: [保存して登録] → POST /api/strategies
  ↓ strategy_registry に INSERT
    status = DRAFT
    backtest_status = NOT_TESTED
    magic_number = 20001+ (自動連番)
    enabled = false
    raw_prompt = "[ENTRY]\n...\n\n[TAKE_PROFIT]\n...\n\n[STOP_LOSS]\n..."
  
STEP 7: EA Command Center下部にStrategyCardが追加される
  ↓ [詳細] ボタンでStrategyDetailModalを開く
```

---

## 未実装のステップ

```
STEP 8（未実装）: [Full Research実行] ← 自動パイプライン
  → Backtest → AI Analysis → Optimization → WalkForward → MonteCarlo → Interpretation

STEP 9（未実装）: Final Verdict 判定
  → VALIDATED / REJECTED

STEP 10（未実装）: [EA化する] → MQL5コード生成

STEP 11（未実装）: [MT5に配備] → MT5でライブ運用開始
```

---

## 現在の手動研究フロー（実装済み）

StrategyDetailModalの各タブで手動実行:

```
[BACKTESTタブ] → [バックテスト実行] → 結果確認
↓ (手動で次タブへ)
[ANALYSISタブ] → [AI分析実行] → 分析結果確認
↓ (手動で次タブへ)
[OPTIMIZEタブ] → [最適化実行] → Stable Zone確認
              → [Walk Forward実行] → OOS PF確認
              → [Monte Carlo実行] → Ruin Risk確認
↓ (手動で次タブへ)
[ANALYSISタブ] → [Cross-Phase解釈] → 総合AI判断確認
↓
[手動判断] → 次のアクション決定
```

---

## Strategy Spec スキーマ

```typescript
interface StrategySpec {
  name:            string;               // 3〜50文字
  strategy_type:   "SCALPING" | "DAY_TRADE" | "SWING";
  description?:    string;
  symbols:         AllowedSymbol[];      // e.g. ["EURUSD"]
  timeframes:      AllowedTimeframe[];   // e.g. ["H1"]
  entry_conditions: {
    logic:      "AND" | "OR";
    conditions: IndicatorCondition[];
  };
  exit_conditions?: {
    stop_loss?:   { method: SLMethod; multiplier?: number; pips?: number; };
    take_profit?: { method: TPMethod; multiplier?: number; rr_ratio?: number; };
  };
  filters?: {
    max_spread_pips?: number;
    sessions?:        AllowedSession[];
    trend_filter?:    { timeframe; indicator; period?; direction; };
    min_adx?:         number;
  };
  risk: { risk_per_trade: number };  // 0.01〜5.0 (%)
}
```
