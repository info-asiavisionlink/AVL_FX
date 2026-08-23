# SAFETY PRINCIPLES
**Status:** DESIGN DOCUMENT — コードには未実装  
**Last Updated:** 2026-08-22

---

## 永続的な安全原則

これらの原則はシステムの全フェーズを通じて守られなければならない。

### 1. Research First（研究優先）
すべての戦略は検証を通過してからのみデプロイされる。  
バックテスト単体ではなく、Walk Forward + Monte Carloも通過すること。

### 2. No Look-Ahead（先読み禁止）
バックテストで未来のデータを参照しない。  
BacktestEngineの `getLastConfirmedBarIndex()` が保証する。

### 3. Human Approval Required（人間の承認が必要）
- Strategy保存: Preview確認後に「保存して登録」ボタン押下が必要
- Research実行: 各ステップを手動でトリガー
- Live Deployment: 自動デプロイは禁止

### 4. AI = Assistant（AIは意思決定しない）
- AIはFactを提示し推奨を出す
- 最終判断は常に人間が行う
- 「AIが推奨したから」でdeployしない

### 5. Conservative Evaluation（保守的評価）
False Positive（悪い戦略を通す）より  
False Negative（良い戦略を棄却）を選ぶ。

### 6. Emergency Stop Always Available（緊急停止は常に利用可能）
ライブ運用中は、緊急停止が常に単一操作で実行できること。

---

## 現在のセキュリティ実装

| 項目 | 実装状態 | 詳細 |
|-----|---------|------|
| AI Code Injection防止 | ✅ 実装済み | AIプロンプトでMQL5生成を明示禁止 |
| Input Validation | ✅ 実装済み | Zodスキーマホワイトリスト方式 |
| Look-ahead防止 | ✅ 実装済み | getLastConfirmedBarIndex() |
| Supabase RLS | ✅ 実装済み | service_role のみ書き込み |
| Magic Number衝突防止 | ✅ 実装済み | UNIQUE制約（20001〜連番） |
| Risk Engine | ❌ 未実装 | ライブ前に必須 |
| Emergency Stop | ❌ 未実装 | ライブ前に必須 |
