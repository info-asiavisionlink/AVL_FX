# FRONTEND
**Status:** PARTIAL — EA Command Center上部はMOCK、それ以外は実装済み  
**Last Updated:** 2026-08-22  
**Source of Truth:** `src/app/`, `src/presentation/components/`

---

## 技術スタック

| 項目 | 内容 |
|-----|------|
| Framework | Next.js 15 (App Router) |
| UI Library | React 19 |
| 言語 | TypeScript |
| スタイリング | Tailwind CSS + インラインスタイル（Neon UIデザイン） |
| チャートライブラリ | lightweight-charts (TradingView) |
| トースト通知 | sonner |

---

## ページ構成

| URL | コンポーネント | 状態 | 説明 |
|-----|--------------|------|------|
| `/` | Dashboard | `IMPLEMENTED` | 市場概況 |
| `/ea` | EACommandCenter | `PARTIAL` | Strategy管理（上部MOCK） |
| `/chart` | AVLChart | `IMPLEMENTED` | MT5リアルタイムチャート |
| `/ai` | AI Page | `IMPLEMENTED` | AI市場分析チャット |
| `/calendar` | Calendar | `IMPLEMENTED` | 経済指標 |
| `/history` | History | `IMPLEMENTED` | 取引履歴 |
| `/logs` | Logs | `IMPLEMENTED` | システムログ |

---

## EA Command Center（/ea）

**ファイル:** `src/presentation/components/ea/EACommandCenter.tsx`

### データ源の二重構造（重要）

```
上部パネル:  MOCK_EA_PROFILES（5件ハードコード）← mockData.ts
  - EA合計カウンター
  - AI セレクター（EURUSD最適EA表示）
  - 損失パターン分析
  - EAプロフィールカード5枚（RSI SCALPER等）

下部パネル: strategy_registry DB実データ ← /api/strategies
  - StrategyCard リスト（DB登録済みStrategy）
  - バックテスト結果の表示
  - 詳細ボタン → StrategyDetailModal
```

### 状態管理

```typescript
const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
// → useEffect で /api/strategies を fetch

const [detailStrategy, setDetailStrategy] = useState<StrategyRecord | null>(null);
// → StrategyDetailModal を開く

const [eaStatuses] = useState<Record<string, EAStatus>>(
  () => Object.fromEntries(MOCK_EA_PROFILES.map((p) => [p.id, p.status]))
);
// → MOCK_EA_PROFILESのステータス（RUNNING/STOPPED）
```

---

## AI EA Builder

**ファイル:** `src/presentation/components/ea/AIEABuilder.tsx`

### 3欄入力 → 5ステップUI

```
input → generating → preview → saving → done

input:      3欄入力（ENTRY / TAKE PROFIT / STOP LOSS）+ 例文3件
generating: POST /api/ai/strategy/build → OpenAI
preview:    3セクション確認表示
  ── ENTRY CONDITIONS ──
    Symbol / Timeframe
    Conditions（日本語表示、未対応条件は REQUIRES EXTENSION バッジ）
    Filters（Spread/Session/Trend/ADX）
  ── TAKE PROFIT ──
    利確方法（ATR×N / RR1:N / 直近高値 等）
  ── STOP LOSS ──
    損切り方法（ATR×N / 直近安値 等）
  RISK / DRAFTバッジ
  [← 修正する（3欄保持）] / [保存して登録]
saving:     POST /api/strategies → DB保存
done:       完了表示
```

### データフロー

```typescript
// 1. AI呼び出し（3フィールド方式）
POST /api/ai/strategy/build
body: {
  entry_conditions_text:       string;  // 10文字以上
  take_profit_conditions_text: string;  // 3文字以上
  stop_loss_conditions_text:   string;  // 3文字以上
}
→ { success: true, spec: StrategySpec }

// 2. DB保存
POST /api/strategies
body: { spec: StrategySpec, raw_prompt: string }
// raw_prompt = "[ENTRY]\n...\n\n[TAKE_PROFIT]\n...\n\n[STOP_LOSS]\n..."
→ { strategy: StrategyRecord }  // status=DRAFT, magic_number=20001+
```

---

## Strategy Detail Modal

**ファイル:** `src/presentation/components/ea/StrategyDetailModal.tsx`（3489行）

### 6タブ

```typescript
type Tab = "OVERVIEW" | "BACKTEST" | "TRADES" | "ANALYSIS" | "VERSIONS" | "OPTIMIZE";
const [tab, setTab] = useState<Tab>("OVERVIEW");
```

| タブ | 状態 | 主な内容 |
|-----|------|---------|
| OVERVIEW | `PRODUCTION_READY` | Spec全項目（Entry/Exit/Filters） |
| BACKTEST | `PRODUCTION_READY` | 実行・統計・エクイティカーブ・IS/OOS |
| TRADES | `PRODUCTION_READY` | 個別取引テーブル |
| ANALYSIS | `PRODUCTION_READY` | AI分析・改善提案・Cross-Phase解釈 |
| VERSIONS | `PRODUCTION_READY` | バージョン一覧・比較・ロールバック |
| OPTIMIZE | `PRODUCTION_READY` | 最適化・Walk Forward・Monte Carlo |

### BACKTESTタブ の動作

```
[バックテスト実行] ボタン
→ POST /api/strategies/[id]/backtest
→ ポーリング: GET /api/backtest/job/:id
→ COMPLETED → 結果表示

結果表示:
  - 統計サマリー（PF, WR, Pips, DD等）
  - エクイティカーブ（lightweight-charts）
  - セッション別統計（東京/ロンドン/NY）
  - IS期間 / OOS期間 別結果
  - verdict（PASSED/CONDITIONAL/FAILED）
```

### OPTIMIZEタブ の構成

```
OptimizeTab
  ├── Parameter Optimization セクション
  │   → POST /api/strategies/[id]/optimize
  │   → IS/OOS stability table + Stable Zone表示
  │
  ├── WalkForwardSection
  │   → POST /api/strategies/[id]/walk-forward
  │   → 各ウィンドウOOS PF表示
  │
  └── MonteCarloSection
      → POST /api/strategies/[id]/monte-carlo
      → 信頼区間・Ruin Probability表示
```

---

## Mock データの詳細

**ファイル:** `src/presentation/components/ea/mockData.ts`

```typescript
export const MOCK_EA_PROFILES: EAProfile[] = [
  { id: "ea-001", name: "RSI SCALPER",     status: "RUNNING", ... },
  { id: "ea-002", name: "GOLD MOMENTUM",   status: "STOPPED", ... },
  { id: "ea-003", name: "TREND FOLLOWER",  status: "RUNNING", ... },
  { id: "ea-004", name: "RANGE EA",        status: "STOPPED", ... },
  { id: "ea-005", name: "MOMENTUM SWING",  status: "STOPPED", ... },
];
export const MOCK_AI_SELECTOR_SYMBOL = "EURUSD";
```

**これらは完全にフィクションデータです。実際の取引実績ではありません。**

---

## デザインシステム

```typescript
// カラー定数（全コンポーネントで統一）
const NG      = "#00ff88";   // Neon Green — 主要アクセント
const CYAN    = "#00e5ff";   // Cyan — 情報・時間足
const AMBER   = "#fbbf24";   // Amber — 警告・注意
const RED     = "#ff4466";   // Red — 損失・エラー
const DARK    = "#04060d";   // Dark — 背景
```

---

## 環境変数（フロントエンド）

```bash
NEXT_PUBLIC_SUPABASE_URL=     # ブラウザからアクセス可能
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # ブラウザからアクセス可能
```

---

## 未実装のUIコンポーネント

| 機能 | 状態 | 備考 |
|-----|------|------|
| Full Research ボタン | `NOT_IMPLEMENTED` | 全ステップ自動実行 |
| Final Verdict 表示 | `NOT_IMPLEMENTED` | VALIDATED/REJECTED バッジ |
| Strategy Status 変更UI | `NOT_IMPLEMENTED` | ACTIVE/PAUSEDへの変更 |
| Live Trading タブ | `NOT_IMPLEMENTED` | リアルタイムポジション |
| Paper Trading | `NOT_IMPLEMENTED` | 模擬実行 |
| Monitoring Dashboard | `NOT_IMPLEMENTED` | 稼働中EA監視 |
