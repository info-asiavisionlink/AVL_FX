# STAGE 1 — STEP 02: PRE-ADD BACKTEST FLOW
**Date:** 2026-08-22  
**Status:** COMPLETED  
**Category:** UI / API / Backtest Flow / Strategy Registration

---

## 変更概要

EA追加フローを「設計 → 保存 → 後からBacktest」から「設計 → Backtest → 承認 → 保存」へ変更。

### Before
```
AI設計 → Preview → 保存 → 後でBacktest
```

### After
```
AI設計 → Preview Backtest自動実行 → ユーザー承認 → 正式保存（Backtest同時昇格）
```

---

## 変更ファイル

| ファイル | 種別 | 内容 |
|---------|------|------|
| `src/infrastructure/backtest/BacktestService.ts` | 改修 | `runBacktestCore`・`TradeForPromotion`・`promotePreviewBacktest`追加、`runBacktestJob`リファクタ |
| `src/app/api/ai/strategy/preview-backtest/route.ts` | 新規 | DB登録なしでBacktestを実行するAPI |
| `src/app/api/strategies/route.ts` | 改修 | `previewBacktestData`受け取り・`promotePreviewBacktest`呼び出し |
| `src/presentation/components/ea/AIEABuilder.tsx` | 全面改修 | 新フロー実装（5ステップ）・Result画面・FAILED警告・UNSUPPORTED対応 |
| `src/presentation/components/ea/EACommandCenter.tsx` | 改修 | `StrategyDraftCard`強化（Backtest表示・Live placeholder） |

---

## 新APIエンドポイント

### `POST /api/ai/strategy/preview-backtest`

```typescript
// Request
{ spec: StrategySpec }

// Response
{
  success: true,
  report: BacktestReport,
  trades: TradeForPromotion[],
  barCount: number,
  directionBreakdown: { buy: DirStat; sell: DirStat },
  warnings: string[],
}

// Error cases
- UNSUPPORTED条件が含まれる → 422 { unsupported: string[] }
- バーデータなし → 500 エラー
```

---

## BacktestService 拡張

### `runBacktestCore(params)` — 新規エクスポート
- DB書き込みなし
- StrategySpecを直接受け取りBacktest実行
- `{ report, trades, barCount, warnings }` を返す

### `TradeForPromotion` — 新規エクスポート型
- JSON境界を越えるシリアライズ可能なTrade型
- `BacktestTrade` と同一フィールド構成

### `promotePreviewBacktest(params)` — 新規エクスポート
- Preview Backtest結果を正式DB記録へ昇格
- `backtest_jobs`（COMPLETED）+ `backtest_results` + `backtest_trades` を作成
- 既存strategyIdに紐付け

### `runBacktestJob` リファクタリング
- コア実行部分を `runBacktestCore` 呼び出しに置き換え
- DB I/O部分は残存（後方互換維持）

---

## AIEABuilder フロー変更

### 新ステップ型
```typescript
type Step =
  | "input"        // 3欄入力
  | "generating"   // AI Spec生成中
  | "backtesting"  // Preview Backtest実行中（自動）
  | "result"       // Spec + Backtest結果表示
  | "saving"       // 正式保存中
  | "done";        // 完了
```

### handleBuild() 新フロー
1. POST /api/ai/strategy/build → Spec生成
2. UNSUPPORTED条件チェック → 有り: `result`へ(バックテスト無し)
3. POST /api/ai/strategy/preview-backtest → Backtest実行
4. `result`ステップへ

### Result画面 (新設)
- Strategy Summary (Entry/TP/SL compact表示)
- Backtest Result: TOTAL PIPS・Stats Grid・BUY/SELL breakdown・Session・Verdict
- UNSUPPORTED時: REQUIRES EXTENSION バッジ + エラーメッセージ

### CTA フッター
- UNSUPPORTED: [← 修正する] のみ
- 通常: [キャンセル] [← 修正する] [EA を追加する]
- FAILED警告時: [← 追加しない] [それでも追加する]

### 正式保存 (handleFormalSave)
```typescript
POST /api/strategies {
  spec,
  raw_prompt: "[ENTRY]\n...\n[TAKE_PROFIT]\n...\n[STOP_LOSS]\n...",
  previewBacktestData: { report, trades, barCount }
}
```
→ strategy_registry + backtest_job(COMPLETED) + backtest_results + backtest_trades を同時作成

---

## StrategyDraftCard 強化

### 追加表示
- Total Pips（大きく）
- WIN RATE / PF / MAX DD グリッド
- LIVE PERFORMANCE: NO LIVE TRADES YET（placeholder）
- 起動ボタン: disabled（Live Trading 未実装）
- 詳細ボタン → StrategyDetailModal

---

## データフロー

```
自然言語 [3欄]
↓ POST /api/ai/strategy/build
StrategySpec
↓ POST /api/ai/strategy/preview-backtest (DB書き込みなし)
PreviewReport + Trades
↓ User Approval
↓ POST /api/strategies { spec + previewBacktestData }
strategy_registry (DRAFT, backtest_status=PASSED/FAILED)
backtest_jobs (COMPLETED)
backtest_results
backtest_trades
↓
StrategyDraftCard (実データ表示)
↓
詳細 → StrategyDetailModal BACKTEST タブで結果確認可能
```

---

## テスト項目

| ID | 内容 | 状態 |
|----|------|------|
| ADD01 | AI設計後に正式Strategyがまだ作成されない | TypeScript確認済 |
| ADD02 | Preview Backtestが実行される | API実装済 |
| ADD03 | Backtest result表示（PIPS/WR/PF/DD） | UI実装済 |
| ADD04 | キャンセルでstrategy_registryに登録されない | フロー上保証 |
| ADD05 | EAを追加するで正式保存 | 実装済 |
| ADD06 | magic_number採番 | 既存ロジック流用 |
| ADD07 | Backtest結果が正式Strategyへ紐付く | promotePreviewBacktest実装済 |
| ADD08 | 同じBacktestを再実行しない | previewBacktestDataを昇格 |
| ADD09 | FAILED Strategyでも警告付き追加可能 | showFailedWarning実装済 |
| ADD10 | Unsupported conditionではBacktestしない | API側で422返す |
| ADD11 | 追加後REAL Strategy Card表示 | StrategyDraftCard更新済 |
| ADD12 | Card詳細→既存StrategyDetailModal | 既存onDetail流用 |
| ADD13 | Live PerformanceをBacktest Performanceと混同しない | 明示的分離済 |
| TypeScript | tsc --noEmit | エラー0 |

---

## 制約・注意事項

```
□ BUY/SELL breakdown表示: trades配列がない場合は非表示
□ UNSUPPORTED条件ありのStrategyはEA追加不可（Backtest要件）
□ Live Trading機能（起動ボタン）: 未実装 placeholder
□ Multi-symbol Strategy: 未対応（preview-backtestでもエラー）
□ Backtest期間: AVAILABLE（全データ）固定
```
