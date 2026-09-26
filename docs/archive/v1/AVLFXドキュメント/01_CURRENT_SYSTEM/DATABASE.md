# DATABASE
**Status:** IMPLEMENTED — migrations 001〜015 適用済み  
**Last Updated:** 2026-08-22  
**Source of Truth:** `supabase/migrations/` ディレクトリ  
**Related Components:** Gateway (barDataStore.ts), BacktestService, all API routes

---

## 概要

- **DB:** Supabase (PostgreSQL)
- **RLS:** bar_data と strategy_registry グループは異なるRLS設定
- **UTC:** bar_data.time_utc は UTC タイムスタンプ（MqlRates.time をUTCとして保存）

---

## テーブル一覧

### 001: cot_positions

COT（Commitment of Traders）データ保存用。AVL-FXの市場分析AI向け。

---

### 002: bar_data（最重要）

```sql
CREATE TABLE public.bar_data (
  symbol     TEXT           NOT NULL,
  timeframe  TEXT           NOT NULL,
  time_utc   TIMESTAMPTZ    NOT NULL,
  open       NUMERIC(12,5)  NOT NULL,
  high       NUMERIC(12,5)  NOT NULL,
  low        NUMERIC(12,5)  NOT NULL,
  close      NUMERIC(12,5)  NOT NULL,
  volume     INTEGER        NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, time_utc)
);
```

**設計ポイント:**
- PK は `(symbol, timeframe, time_utc)` — 完全汎用設計
- symbolはTEXT型 — 任意ブローカーシンボルを格納可能
- time_utcはUTC（H4バーが14400秒倍数に整列することで検証済み）
- `idx_bar_data_lookup (symbol, timeframe, time_utc DESC)` — バックテスト最適化
- `idx_bar_data_symbol_time (symbol, time_utc DESC)` — クロスシンボルスキャン用

**RLS:**
- SELECT: authenticated ✅
- INSERT/UPDATE: service_role only（Gateway のみ書き込み）

**現在のデータ（主要）:**

| Symbol | TF | 期間 | 本数 |
|--------|-----|------|------|
| EURUSD | H1 | 2025-01-08〜2026-08-21 | 10,067 |
| EURUSD | H4 | 2020-03-18〜2026-08-21 | 10,016 |
| EURUSD | D1 | 1988-03-31〜2026-08-21 | 10,002 |
| USDX-SEP26 | H1 | 2026-07-01〜2026-08-05 | 530 |
| VIX-AUG26 | H1 | 2026-07-02〜2026-08-05 | 533 |
| 他25シンボル | H1 | 2026-07月〜 | 〜535 |

**DB関数:**
```sql
get_bar_data_status() → symbol/timeframe別の統計（bar_count, oldest, newest, span_days）
```

---

### 003: bar_data RLS open

`bar_data_select` policy を緩和（認証なしでの読み取りを開放）。

---

### 004: strategy_registry

```sql
CREATE TABLE public.strategy_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 50),
  strategy_type   TEXT NOT NULL CHECK(strategy_type IN ('SCALPING','DAY_TRADE','SWING')),
  description     TEXT,
  symbols         TEXT[]  NOT NULL DEFAULT '{}',
  timeframes      TEXT[]  NOT NULL DEFAULT '{}',
  entry_conditions JSONB  NOT NULL DEFAULT '{}',
  exit_conditions  JSONB  DEFAULT NULL,
  filters          JSONB  DEFAULT NULL,
  risk             JSONB  NOT NULL DEFAULT '{"risk_per_trade":0.25}',
  magic_number    INTEGER UNIQUE,           -- MT5 EA連携用（20001〜連番）
  enabled         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK(status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  backtest_status TEXT NOT NULL DEFAULT 'NOT_TESTED'
                  CHECK(backtest_status IN ('NOT_TESTED','TESTING','PASSED','FAILED')),
  ai_score        INTEGER CHECK(ai_score BETWEEN 0 AND 100),
  ai_verdict      TEXT,
  raw_prompt      TEXT,  -- 元の自然言語プロンプト
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Status説明:**

| status | 意味 |
|--------|------|
| DRAFT | 作成直後（デフォルト） |
| ACTIVE | 手動変更のみ。UIからの変更機能は現状なし |
| PAUSED | 同上 |
| ARCHIVED | 同上 |

| backtest_status | 意味 |
|----------------|------|
| NOT_TESTED | バックテスト未実施 |
| TESTING | 実行中 |
| PASSED | verdict=PASSED かつ totalPips > 0 |
| FAILED | それ以外 |

**重要:** `PASSED` = Backtestがプラスだったことのみ。Walk Forward・Monte Carlo通過は含まない。

---

### 005: backtest テーブル群

```sql
-- バックテストJOB管理
CREATE TABLE backtest_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id   UUID REFERENCES strategy_registry(id),
  status        TEXT CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  period_label  TEXT,  -- 'AVAILABLE' or 'IS:70/OOS:30' etc.
  cutoff_time   BIGINT,  -- IS/OOS分割点（UTC ms）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- バックテスト統計結果
CREATE TABLE backtest_results (
  job_id           UUID PRIMARY KEY REFERENCES backtest_jobs(id),
  total_trades     INTEGER,
  wins             INTEGER,
  losses           INTEGER,
  win_rate         NUMERIC,
  total_pips       NUMERIC,
  profit_factor    NUMERIC,
  max_drawdown     NUMERIC,
  verdict          TEXT CHECK(verdict IN ('PASSED','CONDITIONAL','FAILED')),
  verdict_reason   TEXT,
  -- 他多数の統計フィールド
);

-- 個別取引履歴
CREATE TABLE backtest_trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES backtest_jobs(id),
  entry_time    TIMESTAMPTZ,
  exit_time     TIMESTAMPTZ,
  direction     TEXT CHECK(direction IN ('BUY','SELL')),
  entry_price   NUMERIC,
  exit_price    NUMERIC,
  pips          NUMERIC,
  result        TEXT CHECK(result IN ('WIN','LOSS','BREAKEVEN','END_OF_DATA')),
  exit_reason   TEXT CHECK(exit_reason IN ('TP','SL','END_OF_DATA')),
  session       TEXT,
  duration_min  NUMERIC
);
```

---

### 007: strategy_ai_analyses

OpenAI によるバックテスト分析結果。

```sql
CREATE TABLE strategy_ai_analyses (
  id           UUID PRIMARY KEY,
  strategy_id  UUID REFERENCES strategy_registry(id),
  job_id       UUID REFERENCES backtest_jobs(id),
  version      INTEGER NOT NULL,
  summary      TEXT,
  facts        JSONB,        -- Backtest dataで確認された事実
  observations JSONB,        -- 観察傾向
  hypotheses   JSONB,        -- 仮説（未確認）
  weaknesses   JSONB,
  strengths    JSONB,
  session_analysis  JSONB,
  risk_analysis     JSONB,
  recommendations   JSONB,
  confidence        TEXT,
  model             TEXT,    -- 使用したOpenAIモデル名
  input_snapshot    JSONB,   -- 入力コンテキストのスナップショット
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 008: strategy_improvements

AI改善提案。

```sql
CREATE TABLE strategy_improvements (
  id              UUID PRIMARY KEY,
  strategy_id     UUID REFERENCES strategy_registry(id),
  analysis_id     UUID REFERENCES strategy_ai_analyses(id),
  proposed_spec   JSONB,   -- 改善後のStrategy Spec
  rationale       TEXT,    -- 改善理由
  -- その他フィールド
);
```

---

### 009: strategy_versions

Strategy Spec のバージョン履歴。

```sql
CREATE TABLE strategy_versions (
  id           UUID PRIMARY KEY,
  strategy_id  UUID REFERENCES strategy_registry(id),
  version      INTEGER NOT NULL,
  spec         JSONB,      -- その時点のStrategy Spec全体
  change_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 010: optimization テーブル群

```sql
CREATE TABLE optimization_jobs (
  id            UUID PRIMARY KEY,
  strategy_id   UUID REFERENCES strategy_registry(id),
  status        TEXT,
  parameter_ranges  JSONB,
  summary       JSONB,   -- stableZoneCount等
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE optimization_candidates (
  id             UUID PRIMARY KEY,
  job_id         UUID REFERENCES optimization_jobs(id),
  parameters     JSONB,
  is_pf          NUMERIC,   -- In-Sample Profit Factor
  oos_pf         NUMERIC,   -- Out-of-Sample Profit Factor
  stability_score NUMERIC,  -- 0〜1
  sample_status  TEXT CHECK(sample_status IN ('NORMAL','LOW_SAMPLE','INSUFFICIENT')),
  -- その他統計フィールド
);
```

---

### 011: walk_forward_jobs

```sql
CREATE TABLE walk_forward_jobs (
  id          UUID PRIMARY KEY,
  strategy_id UUID REFERENCES strategy_registry(id),
  status      TEXT,
  config      JSONB,    -- ウィンドウ設定
  windows     JSONB[],  -- 各ウィンドウの結果
  summary     JSONB,    -- 全体統計
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 012: monte_carlo_results

```sql
CREATE TABLE monte_carlo_results (
  id           UUID PRIMARY KEY,
  strategy_id  UUID REFERENCES strategy_registry(id),
  job_id       UUID,
  iterations   INTEGER,
  ruin_probability  NUMERIC,
  ci95_lo      NUMERIC,   -- 95%信頼区間 下限
  ci95_hi      NUMERIC,   -- 95%信頼区間 上限
  -- その他確率分布フィールド
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 013: strategy_phase4d_interpretations

Cross-Phase AI Interpretation（全研究フェーズの統合解釈）。

---

### 014: market_data_sync_jobs

DataSync Job管理。

```sql
CREATE TABLE market_data_sync_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  mode        TEXT CHECK(mode IN ('FORWARD','BACKFILL')),
  target_from BIGINT,     -- Unix秒
  target_to   BIGINT,     -- Unix秒（FORWARDはNULL）
  status      TEXT CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED','PAUSED')),
  progress_pct INTEGER DEFAULT 0,
  received_bars INTEGER DEFAULT 0,
  current_from BIGINT,   -- Resume起点
  error_message TEXT,
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique制約: 同一symbol/TFのPENDING/RUNNINGは1件のみ
CREATE UNIQUE INDEX idx_sync_jobs_one_active
  ON market_data_sync_jobs (symbol, timeframe)
  WHERE status IN ('PENDING','RUNNING');
```

**DB関数:**
```sql
claim_next_sync_job(p_symbol TEXT) → atomic PENDING→RUNNING遷移
```

---

### 015: sync_job_recovery

stale（応答なし）の RUNNING ジョブを自動回復する仕組み。

---

## 注意事項

- **Migration 006 は存在しない**（番号が飛んでいる）
- RLS はテーブルによって設定が異なる（詳細は各migration参照）
- strategy_registry の status/backtest_status の拡張（VALIDATED等）は**未実施のMigration**
- Cross-Asset研究のためのDXY/US10Yデータを追加する際も bar_data スキーマ変更は不要
