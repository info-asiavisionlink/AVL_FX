# MT5 LAYER
**Status:** PRODUCTION_READY (Data Manager) / NOT_IMPLEMENTED (Strategy EA)  
**Last Updated:** 2026-08-22  
**Source of Truth:** `ea/AVL_DataManager_v2.mq5`, `ea/AVL_FX_Bridge.mq5`

---

## ファイル構成

| ファイル | 役割 | 状態 |
|---------|------|------|
| `ea/AVL_DataManager_v2.mq5` | 市場データ収集専用EA（売買なし） | `PRODUCTION_READY` |
| `ea/AVL_FX_Bridge.mq5` | Web UI リアルタイム表示専用 | `PRODUCTION_READY` |
| Strategy EA | 各Strategy固有の売買ロジックEA | `NOT_IMPLEMENTED` |

---

## AVL_DataManager_v2.mq5

### 役割の明確化

> **このEAは売買を行わない。MT5から情報を取得してGatewayへ送信するだけ。**

### 8ストリーム

```
Stream 1: Tick Stream
  - トリガー: OnTick()
  - スロットリング: 100ms (InpTickThrottleMs)
  - 内容: bid, ask, spread, digits, time
  - 送信先: POST /tick

Stream 2: OHLC Stream
  - トリガー: OnTick() 毎に全TFの確定バー確認
  - 全8時間足: M1, M5, M15, M30, H1, H4, D1, W1
  - 確定バー検出: 前回時刻との差分で判定
  - 起動時: POST /bars/bulk（最大InpOHLCHistory=5000本/TF）
  - 更新時: POST /bar（単一確定バー）
  - 対象: g_Symbol = Symbol()（チャートにアタッチしたシンボルのみ）

Stream 3: Market Watch
  - トリガー: OnTimer() 3秒毎
  - 内容: 全MarketWatchシンボルのbid/ask/spread/changePct/digits
  - 送信先: POST /symbols/bulk

Stream 4: Indicators
  - トリガー: OnTimer() 30秒毎
  - 内容: H4/H1/M15/M5 各TFの EMA21/200, SMA50, ATR, RSI, MACD, ADX, BB
  - 送信先: POST /indicators

Stream 5: Orders/Positions
  - トリガー: OnTimer() 5秒毎
  - 内容: 全注文・ポジション
  - 送信先: POST /positions

Stream 6: Account
  - トリガー: OnTimer() 5秒毎
  - 内容: balance, equity, margin, freeMargin, leverage
  - 送信先: POST /account

Stream 7: History
  - トリガー: OnTimer() 5分毎
  - 内容: 過去30日の決済Deal
  - 送信先: POST /history

Stream 8: Heartbeat
  - トリガー: OnTimer() 毎回
  - 内容: broker_time
  - 送信先: POST /heartbeat
```

### History Sync（起動時一括取得）

```mql5
// EA入力パラメーター
input bool   InpHistorySyncEnabled   = false;   // true: 起動時に実行
input int    InpHistorySyncMonths    = 12;       // 取得月数（1〜60）
input int    InpHistorySyncChunkDays = 28;       // チャンクサイズ（日）
input int    InpHistorySyncBatchSize = 2000;     // バッチ当たりの最大bar数
input string InpHistorySyncTFs       = "M5";    // 対象TF（カンマ区切り）
```

**動作:** 対象TF × InpHistorySyncMonths 分の過去OHLCをチャンク分割してGatewayへ送信  
**対象:** g_Symbol（チャートのシンボル）のみ

### DataSync（インクリメンタル同期）

```mql5
// EA入力パラメーター
input bool InpDataSyncEnabled   = true;
input int  InpDataSyncPollSec   = 30;  // polling間隔（秒）
```

**動作フロー:**
```
1. 30秒毎に GET /data-commands/pending をポーリング
2. PENDING job を発見 → DataSync_Execute(jobId, symbol, tf, ...) 実行
3. CopyRates(symbol, tf, from, to, rates) ← 任意symbolをサポート
4. チャンク分割で Gateway へ POST /bars/bulk
5. 各チャンク後に POST /data-commands/:id/progress で進捗更新
6. 完了: status=COMPLETED
```

**任意Symbol対応:** g_Symbol に依存しない。Supabase の market_data_sync_jobs に  
任意のsymbol/TFで job を作成すれば、そのシンボルのデータを取得可能。  
（ただしブローカーのMarket Watchにシンボルが存在する必要がある）

### タイムスタンプ検証済み

```
MqlRates.time = UTC秒（ブローカー時刻ではない）

検証: H4バー time_sec % 14400 == 0 → true（UTC境界に整列）
     H4バー (time_sec - 10800) % 14400 == 0 → false（UTC+3境界ではない）

→ ブローカー時刻 ≠ UTC時刻だが、rates[i].timeはUTCであることを確認済み
```

### 入力パラメーター（全設定）

```mql5
input string InpServerURL    = "http://127.0.0.1:8080";  // Gateway URL
input string InpServerSecret = "";                         // 認証シークレット

input bool InpTickEnabled    = true;
input int  InpTickThrottleMs = 100;

input bool InpOHLCEnabled    = true;
input int  InpOHLCHistory    = 5000;   // 起動時に送信するbar数

input bool InpMWEnabled      = true;
input int  InpMWSec          = 3;

input bool InpIndicatorEnabled = true;
input int  InpIndicatorSec     = 30;

input bool InpOrderEnabled    = true;
input int  InpOrderSec        = 5;

input bool InpAccountEnabled  = true;

input bool InpHistoryEnabled   = true;
input int  InpHistoryDays      = 30;
input int  InpHistorySec       = 300;

input int  InpTimerMs          = 500;

input bool   InpHistorySyncEnabled   = false;
input int    InpHistorySyncMonths    = 12;
input int    InpHistorySyncChunkDays = 28;
input int    InpHistorySyncBatchSize = 2000;
input string InpHistorySyncTFs       = "M5";

input bool InpDataSyncEnabled   = true;
input int  InpDataSyncPollSec   = 30;
```

---

## AVL_FX_Bridge.mq5

**役割:** Web UIのリアルタイムチャート・Market Watch・インジケーター表示用。  
**違い:** AVL_DataManager_v2はSupabaseへの永続化がメイン。  
Bridgeはメモリ上のデータをブラウザへ配信することがメイン。

---

## Strategy EA（未実装）

### 現状

> **各戦略固有の売買ロジックEAは存在しない。**

magic_number は strategy_registry で 20001 から連番で割り当てられているが、  
そのmagic_numberを使って実際に取引するStrategy EAは作成されていない。

### 将来（STAGE 3で実装予定）

```
Strategy Spec (JSON)
  ↓ 自動生成（未実装）
.mq5 EA コード
  ↓ MT5でコンパイル
.ex5 EA 実行ファイル
  ↓ MT5チャートにアタッチ（magic_number設定済み）
ライブトレード開始
```

---

## ブローカー環境

| 項目 | 内容 |
|-----|------|
| ブローカー | XM Trading |
| プラットフォーム | MetaTrader 5 |
| タイムゾーン | EET (UTC+2/+3) — ただしrates.timeはUTC |
| 主要DXYシンボル | USDX-SEP26（先物、期限あり） |
| US10Y | 非対応 |

---

## 運用手順

### AVL_DataManager_v2 起動

1. MT5 を起動してログイン
2. `cd gateway && npm run dev` でGatewayを起動
3. EURUSD チャートを開く
4. ナビゲーターから AVL_DataManager_v2 をドラッグ&ドロップ
5. InpServerURL = "http://127.0.0.1:8080" を確認
6. InpHistorySyncEnabled = true、InpHistorySyncTFs = "H1,H4" で起動すると過去データを一括取得

### DXY / US30 等の追加シンボルデータ取得

1. MT5 の Market Watch にシンボルを追加（USDX-SEP26等）
2. Supabase で market_data_sync_jobs に BACKFILL job を INSERT
3. AVL_DataManager_v2 が自動的に DataSync を実行
