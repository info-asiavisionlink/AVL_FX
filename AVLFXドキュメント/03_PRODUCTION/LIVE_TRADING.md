# LIVE TRADING
**Status:** NOT_IMPLEMENTED  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 5

---

## 現状

> **ライブトレードは未実装。AVL-FXは現在、研究・検証専用システムとして動作している。**

---

## 未実装の理由

1. MQL5 EA生成が未実装（Strategy Spec → .mq5ファイルが作れない）
2. MT5 Deploymentが未実装（生成EAをMT5に配備する仕組みがない）
3. Final Verdict（VALIDATED/REJECTED）が未実装（検証完了の判定基準がない）
4. Risk Engineが未実装（ライブ運用に必要な自動停止機能がない）
5. Monitoring Dashboardが未実装（稼働中EAの監視手段がない）

---

## 実装予定（STAGE 3〜5）

### 前提条件

ライブトレードを開始するには以下が全て完成している必要がある:

```
□ STAGE 3-A: 研究パイプライン自動連鎖
□ STAGE 3-B: Final Verdict (VALIDATED/REJECTED)
□ STAGE 3-C: MQL5 EA Code Generation
□ STAGE 3-D: MT5 Deployment Pipeline
□ STAGE 5-A: Paper Trading（シミュレーション確認後）
□ STAGE 5-C: Risk Engine（緊急停止機能）
```

### 想定するライブトレードフロー

```
[Strategy: VALIDATED] ← 全研究ステップ通過
↓
[EA化ボタン] → MQL5コード生成 → .mq5ダウンロード
↓
[MT5にアタッチ] → magic_numberで識別
↓
[Paper Trading] → 実際の発注なしでシミュレーション
↓
[ライブ開始（小額）] → 実際の発注
↓
[AVL-FX Monitoring] → ポジション・損益・リスク監視
↓
[緊急停止ボタン] → DD上限・連敗上限で自動停止
```

---

## 安全原則（設計段階から永続）

1. **Paper Trading First**: ライブ前に必ずPaper Tradingで動作確認
2. **Small First**: 初回ライブは最小ロット（0.01）から
3. **Risk Engine Mandatory**: DD上限・日次損失上限なしにライブ禁止
4. **Human Approval**: 自動デプロイはしない。必ずユーザーが確認して許可
5. **Emergency Stop**: 緊急停止ボタンは常にアクセス可能な位置に配置

---

## 現在のmMagic Number状況

strategy_registry では magic_number が 20001 から連番で割り当てられている。  
これはライブトレードEAとの識別用として予約された番号だが、  
現時点では実際にこのmagic_numberを使用するStrategyEAは存在しない。
