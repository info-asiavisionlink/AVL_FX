# BacktestEngine Diagnostic Params + UI日本語化
**Date:** 2026-08-22
**Stage:** MISC（STAGE 2完了後・STAGE 3開始前）
**Author:** 田中慶樹
**Status:** COMPLETED

## Objective

1. BacktestEngine に研究用の Spread/Slippage 上書きパラメーターを追加する
2. StrategyDetailModal の全 UI ラベルを日本語化する（集中管理）

## Starting State

- BacktestEngine: コスト設定はシンボル設定固定（symbol config から取得）
- StrategyDetailModal: 全ラベルが英語ハードコード

## Implementation

### 1. BacktestEngine — Diagnostic Override

`src/infrastructure/backtest/BacktestEngine.ts` の `BacktestInput` に追加:

```typescript
/** 研究用 Diagnostic — Spread を上書き (pips)。デフォルト: symbol config */
_spreadOverride?:   number;
/** 研究用 Diagnostic — Slippage を上書き (pips)。デフォルト: symbol config */
_slippageOverride?: number;
```

`runBacktest()` 内:

```typescript
const _baseCfg = getSymbolConfig(symbol);
const cfg = (_spreadOverride !== undefined || _slippageOverride !== undefined)
  ? { ..._baseCfg, spreadPips: _spreadOverride ?? _baseCfg.spreadPips, slippagePips: _slippageOverride ?? _baseCfg.slippagePips }
  : _baseCfg;
```

**用途:** Phase 6-B Audit で発見したコスト構造問題の診断用。  
実際の研究で「コストゼロなら PF がどう変わるか」を計測するために追加。

### 2. ui-labels.ts — 日本語ラベル集中管理（新規）

`src/lib/ui-labels.ts` を新規作成:

- VERDICT_LABELS: PASSED→合格, CONDITIONAL→条件付, FAILED→不合格 等
- STRATEGY_TYPE_LABELS: SCALPING→スキャルピング 等
- SESSION_LABELS: TOKYO→東京, LONDON→ロンドン, NEW_YORK→NY 等
- TAB_LABELS: OVERVIEW→概要, BACKTEST→バックテスト 等
- その他: DIRECTION, TRADE_RESULT, EXIT_REASON, EA_STATUS, WF_VERDICT, PHASE

**設計原則:**
- DB/API 内部値は変更しない
- UI 表示層でのみこのマップを使用
- `labelOf(map, key)` ヘルパー付き（fallback = key 自体）

### 3. StrategyDetailModal — 全ラベル日本語化

`src/presentation/components/ea/StrategyDetailModal.tsx`:

- ui-labels.ts をインポート
- 全ハードコード英語ラベルを日本語に変更
  - BASIC INFO → 基本情報
  - SYMBOL → シンボル / TIMEFRAME → 時間足
  - TYPE → 種別 / RISK % → リスク %
  - ENTRY CONDITIONS → エントリー条件
  - FILTERS → フィルター / EXIT CONDITIONS → 決済条件
  - MAX SPREAD → 最大スプレッド / SESSIONS → セッション
  - STOP LOSS → 損切り (SL) / TAKE PROFIT → 利確 (TP)
  - VERDICT → 判定 / PERIOD → 期間
  - SAMPLE SIZE LIMITED → サンプル数不足

## Files Added

- `src/lib/ui-labels.ts`（新規）

## Files Changed

- `src/infrastructure/backtest/BacktestEngine.ts`（diagnostic params追加）
- `src/presentation/components/ea/StrategyDetailModal.tsx`（日本語化）

## Database Changes

なし

## API Changes

なし

## Tests

なし（既存のバックテストテストは引き続き通過。diagnostic paramsはオプショナルのためデフォルト動作は変わらない）

## Final Result

- BacktestEngine: `_spreadOverride` / `_slippageOverride` で研究時にコスト上書き可能
- StrategyDetailModal: 全 UI ラベルが日本語表示に統一

## Remaining Issues

なし

## Next Stage

STAGE 3-A: 研究パイプライン自動連鎖
