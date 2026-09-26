# LIVE DEPLOYMENT FLOW
**Status:** NOT_IMPLEMENTED — 設計段階のみ  
**Last Updated:** 2026-08-22  
**Target Stage:** STAGE 3-D, 5-B

---

## 現状

> **Live Deploymentフロー全体が未実装。**

---

## 想定するデプロイフロー（将来）

```
前提: Strategy が VALIDATED 判定を受けていること

STEP 1: EA生成
  [EA化する] ボタン（未実装）
  → Strategy Spec → MQL5コード生成
  → .mq5ファイルをダウンロード
  → ユーザーが内容を確認（必須）

STEP 2: MT5でコンパイル
  .mq5ファイルを MT5の Experts/ フォルダに配置
  → MT5でコンパイル（Ctrl+F7）
  → エラーがなければ .ex5 ファイル生成

STEP 3: チャートにアタッチ
  対象シンボルのチャートを開く
  → ナビゲーターから Strategy EA をドラッグ
  → magic_number = 20001（strategy_registryと一致）を確認
  → 有効化

STEP 4: Paper Tradingモードで確認（未実装）
  → AVL-FXダッシュボードでシグナルを監視
  → バックテストとの一致確認
  → 最低30日間

STEP 5: ライブ（小額）開始
  → risk_per_trade = 0.01〜0.1% で開始
  → 週次でパフォーマンス確認

STEP 6: スケールアップ
  → 安定稼働確認後に risk_per_trade を段階的に上げる
```

---

## magic_number 管理

```
strategy_registry.magic_number: 20001 から連番（UNIQUE制約）

将来のStrategy EA:
  - OnInit() で MagicNumber を参照
  - ポジション管理で MagicNumber でフィルタリング
  - AVL-FXとの通信で Strategy識別に使用

現在の状態:
  - magic_number は割り当て済み（20001〜）
  - 実際にこれを使うStrategy EAは存在しない
```

---

## MT5とAVL-FXの接続（将来）

```
Strategy EA（MQL5）
  ↓ HTTP POST（既存Gatewayへ）
Gateway（index.ts）
  ↓
Supabase（live_positions?, live_signals?）
  ↓
AVL-FX UI（ポジション・シグナル監視）
```

既存のGatewayインフラ（POST /positions等）を拡張することで  
Strategy EAからのポジション情報もAVL-FXで監視できる設計が可能。
