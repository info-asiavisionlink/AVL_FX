# FINAL PRODUCT VISION
**Status:** DESIGN DOCUMENT — 未実装部分含む  
**Last Updated:** 2026-08-22  
**Source of Truth:** このドキュメントは目標仕様。実装済み部分はAVLFX_MASTER.md参照

---

## Vision Statement

> **AVL-FX は「アイデアを入力すると、検証済み戦略が運用されるまでを自動化するAI Trading OS」**

個人トレーダーが持つ以下の課題を解決する:

| 課題 | AVL-FXの解決策 |
|-----|--------------|
| EA設計にMQL5知識が必要 | 自然言語で記述→AIがStrategy Specに変換 |
| バックテストが手動で煩雑 | 統合UIで全ステップ自動実行 |
| 過学習（カーブフィット）が見えない | Walk Forward + Monte Carloで統計的に排除 |
| 何が本当に機能するかわからない | AIが全結果をFactベースで解釈し最終判定 |
| 検証済みEAをMT5に載せるのが難しい | Validated戦略を自動でMQL5化→MT5デプロイ |
| 稼働中EAの監視が大変 | リアルタイムポジション・リスク監視ダッシュボード |

---

## 完成形のユーザー体験（End-to-End）

### Step 1: Strategy作成（現在: 実装済み）

```
[EA Command Center] → [+ EA追加]
→ [AI EA BUILDER] テキスト入力
  「EURUSDのH1。EMAが上向きでRSIが30以下から反転したらBUY。
   SLはATR×2、TPはATR×3。ロンドン時間のみ。」
→ OpenAI → Strategy Spec JSON生成
→ Preview確認（Symbol/TF/Entry/Exit/Filters）
→ 「保存して登録」→ DB保存 (status=DRAFT)
```

### Step 2: Research Pipeline（現在: 各ステップ実装済み・自動連鎖は未実装）

```
[Full Research実行]ボタン（未実装）
→ 自動で順次実行:
  1. Backtest        (BacktestEngine)
  2. AI Analysis     (OpenAI + BacktestAnalyzer)
  3. Optimization    (OptimizationEngine + IS/OOS)
  4. Walk Forward    (WalkForwardEngine)
  5. Monte Carlo     (MonteCarloEngine)
  6. Interpretation  (InterpretationEngine + OpenAI)
→ 全ステップ完了後 Final Verdict 判定（未実装）
  VALIDATED: 全通過
  REJECTED: いずれかで失敗
  INCONCLUSIVE: データ不足
```

### Step 3: MQL5 生成（未実装）

```
[EA化する]ボタン（未実装）
→ Validated Strategy → MQL5コード自動生成
→ .mq5ファイルダウンロード
→ MT5の策略に配置
```

### Step 4: MT5 デプロイ（未実装）

```
[MT5に配備]ボタン（未実装）
→ magic_number をStrategyEAに設定
→ MT5でStrategyEAをチャートにアタッチ
→ AVL-FXダッシュボードで監視開始
```

### Step 5: 監視・管理（未実装）

```
→ [Monitoring Dashboard]
   - 稼働中EA別ポジション・損益
   - リスク指標（DD, 連敗数）
   - パフォーマンスvsバックテスト比較
   - Alert設定
   - 緊急停止ボタン
```

---

## 最終UIビジョン

### EA Command Center（最終形）

```
┌────────────────────────────────────────────────────┐
│  AVL-FX COMMAND CENTER                              │
│                                                    │
│  [稼働中 3] [検証済 7] [研究中 2] [棄却済 5]         │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  RSI REVERSAL EURUSD                        │  │
│  │  ● LIVE    PF: 1.42  WR: 61%  DD: 8.2%    │  │
│  │  H1 EURUSD / VALIDATED 2026-07-15           │  │
│  │  [詳細] [停止]                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  EMA TREND FOLLOW                           │  │
│  │  ○ RESEARCH  Backtest→Optimize中...         │  │
│  │  [詳細] [キャンセル]                         │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  [+ 新しいStrategy]                                │
└────────────────────────────────────────────────────┘
```

### Strategy Detail（最終形）

```
Tabs: OVERVIEW | BACKTEST | ANALYSIS | OPTIMIZE | VERSIONS | LIVE

LIVE タブ（未実装）:
→ リアルタイムポジション
→ 実績 vs バックテスト比較
→ 緊急停止
```

---

## Strategy Status モデル（最終形）

```
DRAFT
  ↓ (バックテスト開始)
RESEARCHING
  ↓ (全ステップ通過)
VALIDATED
  ↓ (MQL5化 + MT5配備)
LIVE
  ↓ (パフォーマンス不足)
PAUSED
  ↓ (廃止確定)
ARCHIVED

※ いずれかのResearchステップで失敗:
REJECTED

現在実装されているstatus:
  DRAFT / ACTIVE / PAUSED / ARCHIVED のみ（VALIDATED/REJECTED等は未実装）
```

---

## 設計原則（永続）

1. **Research First**: 未検証戦略はデプロイしない
2. **No Look-ahead**: バックテストでの未来データ参照を禁止
3. **AI = Assistant**: AIが自動で取引判断を下さない
4. **Fact-based**: 推測ではなくデータから分析する
5. **Transparent**: 何がどのフェーズを通過したかを常に明示する
6. **Conservative**: False Positiveより False Negativeを選ぶ（過剰承認より過剰棄却）

---

*このVisionドキュメントは完成形の目標を記述しています。*  
*実装状況は AVLFX_MASTER.md の「現在の完成状態」セクションを参照してください。*
