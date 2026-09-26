# RISK ENGINE
**Status:** NOT_IMPLEMENTED  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 5-C

---

## 現状

> **Risk Engineは未実装。ライブ運用前に必ず実装が必要。**

---

## 必要な機能

### Portfolio Level Risk

```
□ 最大ドローダウン上限（例: equity -20%で全EA停止）
□ 日次損失上限（例: 1日-5%で全EA停止）
□ 同時ポジション数上限
□ 総リスク（全ポジションSL合計）上限
```

### Strategy Level Risk

```
□ 連敗数上限（例: 5連敗でEA一時停止）
□ 週次損失上限
□ ポジションサイズ上限
□ 単一取引リスク上限（risk_per_trade）
```

### Emergency Stop

```
□ 緊急停止ボタン（UI上で常にアクセス可能）
  → 全ポジション成行クローズ
  → 全EA停止
  
□ 自動緊急停止トリガー
  → DD上限超過
  → 日次損失上限超過
  → MT5接続断
```

---

## 設計原則

1. Risk Engineなしにライブトレード開始禁止
2. 緊急停止は単一ボタン操作で即時実行
3. 自動停止後の再起動は必ず手動確認を要求
4. リスク閾値の変更はログに記録
