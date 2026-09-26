# EA COMMAND CENTER
**Status:** PRODUCTION_READY — 全DB駆動・モック完全削除済み  
**Last Updated:** 2026-08-23  
**Source of Truth:** `src/presentation/components/ea/EACommandCenter.tsx`  
**URL:** /ea

---

## Production仕様

### 基本方針

- 表示されるデータは全て `strategy_registry` + `backtest_results` から取得する実データのみ
- モックデータ・サンプルデータ・デモデータは一切使用しない
- 取得できない情報は「バックテスト未実施」「まだライブ取引はありません」等の実状態を表示する

---

## 画面構成

### ヘッダー

```
EA コマンドセンター
EAの作成・検証・稼働を管理

                              [+ EA 追加]
```

### 統計バー（実DB件数）

```
EA 合計: {strategy_registry 件数}
稼働中:  0 (ライブ未実装)
停止中:  {strategy_registry 件数}
```

**削除済み（モック）:**
- AI 推奨 / 非推奨 バッジ — AI評価エンジン未実装のため削除

---

## Empty State（EA 0件）

```
         ⊕

EAがまだ登録されていません

右上の「+ EA 追加」からトレード条件を入力し、
バックテストを確認してEAを追加してください。

        [ ＋ EA 追加 ]
```

---

## EA カード仕様（StrategyDraftCard）

```
[EA名]
○ 停止中  #magic_number

[Symbol]  [TF]

──────────────────
バックテスト            [合格/条件付/不合格]
  合計 PIPS: +XXX.X
  勝率: XX%  PF: X.XX  最大DD: X.X%
──────────────────
ライブ運用成績
  まだライブ取引はありません
──────────────────
[ ▶ 起動（準備中） ]   ← disabled / Live Trading 未実装
[ 詳細 →           ]
```

### バックテストデータソース

- `GET /api/strategies/[id]/backtest` → 最新 backtest_results を取得
- 未実施の場合: 「バックテスト未実施」
- 読み込み中: 「読み込み中...」

### ライブ運用成績

- Live Trading 未実装（STAGE 5予定）のため常に「まだライブ取引はありません」

### 起動ボタン

- **disabled** 状態 (cursor-not-allowed)
- タイトル: `ライブトレード: 未実装 (STAGE 5 で実装予定)`

---

## 削除済みコンポーネント（Production化で削除）

| 削除対象 | 理由 |
|---------|------|
| `MOCK_EA_PROFILES` | モックデータ（RSI SCALPER等5件） |
| `mockData.ts` ファイル | 不要になったため削除 |
| `EACard` コンポーネント | MOCK_EA_PROFILES専用のため削除 |
| `AI EA セレクター` セクション | AIランキングが全モックデータのため削除 |
| `損失パターン・モック分析` セクション | モック分析のため削除 |
| `モック・デモ` バッジ | Production化済みのため削除 |
| `AI推奨/非推奨` 統計バッジ | AI評価エンジン未実装のため削除 |
| `recColor`, `recLabel`, `impactColor`, `impactLabel` helper | 上記削除により不要 |

---

## データフロー

```
EACommandCenter
  ↓ mount時
  GET /api/strategies
  ↓ 取得結果
  setStrategies(data.strategies)
  ↓ 各カードのマウント時
  GET /api/strategies/[id]/backtest
  ↓
  setBtData(result)
```

---

## 将来の拡張（未実装）

| 機能 | 実装予定 Stage |
|------|--------------|
| EA 起動ボタン（Live Trading連携） | STAGE 5-B |
| AI EA セレクター（実スコア） | STAGE 4-D以降 |
| 損失パターン分析（実取引データ） | STAGE 5-D |
| 稼働中/停止中 リアルタイム状態 | STAGE 5-B |
| ライブ運用成績 | STAGE 5-B |
