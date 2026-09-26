# PHASE 8 RESEARCH RESULTS
**Status:** IN PROGRESS — Phase 8-A 完了、8-B以降はデータ待ち  
**Research Period:** 2026-08-22  
**Scripts:** `scripts/phase8a_cross_asset_audit.ts`

---

## Phase 8の目的

Phase 5〜7で「EURUSD単体OHLCアプローチ」が全滅した。

Phase 8では問いを変える:

> **「EURUSD自身のOHLCだけでなく、関連市場（DXY、US10Y）の情報を使えば予測できるか？」**

---

## Phase 8-A: Cross-Asset Data Readiness Audit

### 監査結果

| アセット | ブローカー上のシンボル | H1カバレッジ | 状態 |
|---------|---------------------|------------|------|
| EURUSD | EURUSD | 590日（2025-01-08〜）| 利用可能 |
| DXY | **USDX-SEP26**（先物） | **35日のみ** | 不十分 |
| US10Y | 存在しない | N/A | XMブローカー非対応 |

### 重要な発見

```
1. bar_dataスキーマ: 完全に汎用設計 → スキーマ変更不要
2. Gateway/DataSync: 任意シンボルに対応 → インフラ変更不要
3. DXY: 先物(USDX-SEP26)のみ。連続DXYは未対応
   - 先物は期限切れ（2026年9月）
   - ロールオーバーが必要
   - H1は35日のみ（最低2年必要）
4. US10Y: XMブローカーが国債利回りを提供していない
```

### 共通同期ウィンドウ

```
EURUSD H1 start: 2025-01-08
DXY H1 start:    2026-07-01
US10Y:           N/A

Common window: 2026-07-01 〜 2026-08-05 = 35日
→ INSUFFICIENT（最低2年必要に対して大幅不足）
```

### 結論

**CROSS-ASSET RESEARCH READINESS: INSUFFICIENT**

Phase 8-Bに進むには外部データプロバイダーの選定が必要。

---

## Phase 8-B 以降（データ取得後）

```
未着手（外部プロバイダー決定後）

検討候補:
  US10Y: FRED (Federal Reserve) — 無料API
  連続DXY: Polygon.io / Alpha Vantage / Quandl

研究テーマ（8-B）:
  Cross-Asset Lead/Lag Discovery
  → EURUSDが動く前にDXY/US10Yが先行するか？
  → 相関係数、Granger因果、方向一致率

研究テーマ（8-C以降）:
  DXY divergence信号
  Yield spread signal（US-DE yield差等）
```

---

## Phase 8 のためのデータ収集戦略

```
必要なデータ（H1、最低2年）:
  連続DXY指数: ~17,520本（H1、2年）
  US10Y yield: ~17,520本（H1、2年）
  ただしUS10Yはマーケット時間外（22:00〜13:30 UTC）はデータなし

bar_dataへの格納:
  symbol = "DXY" (canonical name)
  symbol = "US10Y"
  timeframe = "H1"
  → スキーマ変更不要、fetchBarsの変更不要
  
ingestスクリプト（新規作成必要）:
  外部API → bar_data への書き込みスクリプト
  Gateway経由 or 直接Supabase INSERT
```
