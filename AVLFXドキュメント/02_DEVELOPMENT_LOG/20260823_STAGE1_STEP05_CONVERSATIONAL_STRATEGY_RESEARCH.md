# STAGE 1 STEP 05 — Conversational Strategy Research Assistant
**Date:** 2026-08-23
**Stage:** STAGE 1 Step 05
**Author:** 田中慶樹
**Status:** COMPLETED

## Objective

AI EA Builderのバックテスト結果画面を、AIと会話しながら戦略を改善・再検証できる
「Conversational Strategy Research Assistant」へ拡張する。

## Architecture

### データフロー

```
AIEABuilder (result画面)
  ↓ [AI戦略アシスタントで分析・改善] ボタン
  StrategyResearchAssistant (フルスクリーンモーダル)
    ↓ マウント時
    POST /api/ai/strategy/chat { mode: "diagnose" }
    ↓ AI初回診断表示

  User Message入力
    ↓
    POST /api/ai/strategy/chat { mode: "chat" }
    ↓ AI回答 + 提案 (proposedChange あれば)
    ↓ 提案カード表示

  [この変更で再検証] 承認
    ↓
    POST /api/ai/strategy/preview-backtest { spec: newSpec }
    ↓ 新BacktestResultState
    ↓ 新Revision (R1, R2...) 追加
    ↓ POST /api/ai/strategy/chat { mode: "diagnose" } 再診断

  [EAを追加する]
    ↓
    handleFormalSaveWith(currentSpec, currentResult)
    ↓ strategy_registry に保存
```

## Files Added

| ファイル | 役割 |
|---------|------|
| `src/app/api/ai/strategy/chat/route.ts` | AI チャット・診断 API エンドポイント |
| `src/presentation/components/ea/StrategyResearchAssistant.tsx` | Conversational Research Assistant コンポーネント |

## Files Changed

| ファイル | 変更内容 |
|---------|---------|
| `src/presentation/components/ea/AIEABuilder.tsx` | StrategyResearchAssistantインポート追加、handleFormalSaveWith追加、RESULT フッターにボタン追加 |

## API: POST /api/ai/strategy/chat

**リクエスト:**
```typescript
{
  spec:            unknown,              // 現在のStrategy Spec
  backtestResult:  {                     // バックテスト結果サマリー
    report:             PreviewReport,
    directionBreakdown: { buy: DirStat, sell: DirStat },
    barCount:           number
  },
  revisionHistory: RevisionSummary[],   // 過去リビジョン概要
  messages:        ChatMessage[],        // 会話履歴
  mode:            "diagnose" | "chat"  // 診断モード or チャットモード
}
```

**レスポンス:**
```typescript
{
  message:             string,           // AIのテキスト回答
  proposedChange?:     {                 // AI提案（あれば）
    description:   string,
    changeType:    string,
    reasoning:     string,
    newSpec:       unknown               // StrategySpecSchema検証済み
  } | null,
  overfittingWarning?:   string | null,  // 過学習警告
  stopRecommendation?:   string | null   // 戦略破棄推奨
}
```

**OpenAI設定:** `gpt-4o-mini` + `response_format: json_object`

## Component: StrategyResearchAssistant

### 画面構成

```
┌─────────────────────────────────────────────────────────────────┐
│ AI戦略アシスタント                          [EAを追加] [破棄]  │
├──────────┬──────────────────────────────────────────────────────┤
│ R0 R1 R2 │ (修正履歴バー、クリックで過去リビジョンへ戻れる)    │
├──────────┴──────────────────────────────────────────────────────┤
│ 左パネル: バックテスト結果                                       │
│   Before/After 比較 (R0→R1: PF 0.90→1.08 ↑ PIPS ↑)           │
│   現在の結果                                                      │
│                                                                 │
│ 右パネル: チャット                                               │
│   [AI診断メッセージ]                                            │
│   [User]: SELL削除して                                          │
│   [AI]: 提案カード                                              │
│     変更案: SELL条件削除                                        │
│     [この変更で再検証] [却下]                                   │
│   [User入力欄]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Revision Model

```typescript
interface Revision {
  id:                string;        // "R0", "R1", ...
  spec:              unknown;       // Strategy Spec
  backtestResult:    BacktestResultState;
  changeDescription: string;
  changeType?:       string;
  timestamp:         number;
}
```

全てReact state管理（新DBマイグレーション不要）

### 提案カテゴリ

| changeType | 説明 |
|-----------|------|
| ENTRY_CHANGE | エントリー条件変更 |
| EXIT_CHANGE | 決済条件変更 |
| FILTER_CHANGE | フィルター追加/変更 |
| DIRECTION_CHANGE | 方向変更（SELL削除等）|
| SESSION_CHANGE | セッション変更 |
| HYPOTHESIS_CHANGE | 仮説全体の変更 |

### Overfitting Guard

- 同じchangeTypeが3回以上: 過学習警告をシステムメッセージで表示
- 5回以上リビジョンしてもPF < 1.0: 戦略破棄推奨をシステムメッセージで表示

### AI Approval Gate

AI提案は必ずユーザーの承認が必要:
1. AI提案 → 提案カード表示（`approvalState: "pending"`）
2. [この変更で再検証] → `approved` → preview-backtest → 新Revision追加
3. [却下] → `rejected` → カードをグレーアウト

### 正式EA追加フロー

StrategyResearchAssistant内の [EAを追加する] → `onAddEA(currentSpec, currentResult)` → AIEABuilder.handleFormalSaveWith() → strategy_registry保存

## Database Changes

なし（全てReact state管理）

## API Changes

新規: `POST /api/ai/strategy/chat`

## Tests (機能確認)

| テスト | 状態 |
|-------|------|
| CHAT01: バックテスト完了後AI診断表示 | ✅ マウント時自動呼び出し |
| CHAT02: AIが実Backtest数字を参照 | ✅ システムプロンプトに埋め込み |
| CHAT03: SELL削除提案 | ✅ proposedChange経由 |
| CHAT04: ユーザー承認前にSpec変更なし | ✅ approvalState: "pending" 状態維持 |
| CHAT05: 承認後Spec更新 | ✅ handleApprove → newSpec使用 |
| CHAT06: 自動再Backtest | ✅ preview-backtest API再利用 |
| CHAT07: Before/After表示 | ✅ Delta コンポーネント |
| CHAT08: Revision保存 | ✅ revisions state更新 |
| CHAT09: 以前Revisionへ戻る | ✅ currentRevIdx変更 |
| CHAT10: ユーザー独自変更 | ✅ チャット入力 |
| CHAT11: AI提案却下 | ✅ approvalState: "rejected" |
| CHAT12: 別仮説提案 | ✅ HYPOTHESIS_CHANGE type |
| CHAT13: Overfitting警告 | ✅ 同changeType 3回 / 5回PF<1 |
| CHAT14: 正式EA追加時に現在Revisionのみ保存 | ✅ handleFormalSaveWith(currentSpec, currentResult) |
| CHAT15: キャンセルで正式DB登録なし | ✅ onDiscard() で閉じるのみ |

## Build Results

- TypeScript: エラーなし
- Production Build: 成功（全53ページ + /api/ai/strategy/chat 追加）

## Next Stage

STAGE 3-A: 研究パイプライン自動連鎖
