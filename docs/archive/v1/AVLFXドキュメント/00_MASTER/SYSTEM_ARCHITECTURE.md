# SYSTEM ARCHITECTURE
**Status:** IMPLEMENTED — reflects current codebase  
**Last Updated:** 2026-09-06  
**Source of Truth:** apps/, services/gateway/, mt5/, supabase/migrations/

---

## Overview: 2システム構成

AVL-FXは以下の2つの独立したアプリケーションで構成されます。

| System | 対象 | URL | 役割 |
|--------|------|-----|------|
| **AVLFX Trading View** | 一般ユーザー | avlfx.vercel.app (本番) | チャート・AI・バックテスト・Live Trading |
| **AVLFX Console** | 管理者のみ | console.avlfx.vercel.app | Market Dataインフラ管理 |

---

## Repository Structure (after refactor 2026-09-06)

```
AVL_FX/
├── apps/
│   ├── trading-view/          ← AVLFX Trading View (Next.js)
│   │   ├── src/
│   │   │   ├── app/           ← Pages & API Routes
│   │   │   ├── components/    ← UI Components
│   │   │   ├── domain/        ← Business Logic
│   │   │   └── infrastructure/← Supabase / Gateway clients
│   │   ├── package.json
│   │   └── vercel.json
│   │
│   └── console/               ← AVLFX Console (Next.js, Admin Only)
│       ├── src/
│       │   ├── app/
│       │   │   ├── (admin)/   ← Admin pages (auth-guarded)
│       │   │   │   ├── dashboard/
│       │   │   │   ├── market-data/
│       │   │   │   ├── historical/
│       │   │   │   ├── mt5/
│       │   │   │   ├── gateway/
│       │   │   │   └── system/
│       │   │   ├── login/
│       │   │   └── api/auth/
│       │   ├── lib/
│       │   │   └── admin-auth.ts  ← Server-side admin check
│       │   └── middleware.ts      ← Auth guard
│       └── vercel.json
│
├── services/
│   └── gateway/               ← MT5 ↔ Supabase Bridge (Node.js Express)
│       ├── src/
│       │   ├── index.ts       ← Main server
│       │   ├── barDataStore.ts
│       │   ├── executionStore.ts
│       │   └── syncJobStore.ts
│       ├── Dockerfile
│       └── package.json
│
├── mt5/
│   ├── data-manager/          ← Admin MT5専用 EA
│   │   ├── AVL_DataManager_v2.mq5
│   │   └── AVL_DataManager_v2.ex5
│   └── execution-bridge/      ← User MT5専用 EA
│       ├── AVL_ExecutionBridge.mq5
│       ├── AVL_FX_Bridge.mq5
│       └── AVL_FX_Bridge.ex5
│
├── supabase/                  ← Migrations (shared)
├── ea/                        ← Legacy (mt5/に移行済み)
├── scripts/                   ← Research & analysis scripts
└── AVLFXドキュメント/
```

---

## データフロー全体図

### ADMIN MARKET DATA PIPELINE

```
Admin MT5 (管理者専用口座)
     │
     │  HTTP POST  (AVL_DataManager_v2.mq5)
     ↓
services/gateway  [Node.js Express on Railway]
     │
     │  Supabase SDK (UPSERT)
     ↓
Supabase [PostgreSQL + RLS]
  bar_data / ticks / market data
     │
     │  Supabase SDK (SELECT)
     ↓
apps/trading-view
  Chart / AI / Backtest / Research
```

### USER LIVE TRADING PIPELINE

```
apps/trading-view
  User Strategy → Live Trading UI
     │
     │  HTTP POST (Execution commands)
     ↓
services/gateway
     │
     │  WebSocket / HTTP
     ↓
User MT5 (AVL_ExecutionBridge.mq5)
     │
     │  OrderSend()
     ↓
Broker (XM, etc.)
```

### CONSOLE → ADMIN MARKET DATA

```
AVLFX Console (Admin browser)
     │
     │  Direct Supabase query (service_role)
     ↓
Supabase
     │
     │  Gateway health check
     ↓
services/gateway /health
     │
     │  Real-time data
     ↓
Admin MT5 status
```

---

## 1. AVLFX Trading View

**役割:** 一般ユーザー向けトレーディングアプリ

### 主要機能
- AVL AI チャット
- Market Chart (Lightweight Charts)
- Watchlist
- Market Analysis
- EA Command Center
- AI EA Builder
- Strategy作成 / Backtest / Analysis
- Live Trading
- Live Performance
- User MT5 Connection

### データソース
- **Market Data:** Supabase `bar_data` テーブル (Console管轄のAdmin MT5が蓄積)
- **Live Data:** Gateway WebSocket (tick / positions)
- **User Data:** Supabase (RLS で自分のデータのみ)

### 重要原則
Trading View自身はAdmin MT5へ直接接続しない。
Market DataはConsoleが管理するパイプライン経由のみ。

---

## 2. AVLFX Console

**役割:** 管理者専用 Platform Control Plane

### アクセス制限
- Supabase Auth + ADMIN_EMAILS環境変数 による2重確認
- Middlewareで全ページをガード
- ユーザーには非公開

### 管理機能
| ページ | 機能 |
|--------|------|
| `/dashboard` | システム全体の概要・Pipeline健全性 |
| `/market-data` | Tick/Bar リアルタイム監視・ポジション・口座 |
| `/historical` | bar_data統計・Symbol×TF別データ量 |
| `/mt5` | Admin MT5接続状態・EA管理 |
| `/gateway` | Gateway状態・APIエンドポイント一覧 |
| `/system` | End-to-end pipeline健全性チェック |

---

## 3. Gateway (services/gateway)

**役割:** MT5 ↔ Supabase ↔ Trading View データブリッジ

**Deploy:** Railway (Docker)

### EA → Server (認証あり)
| Endpoint | 役割 |
|----------|------|
| `POST /connect` | EA起動通知 |
| `POST /tick` | Tickストリーム |
| `POST /bar` | リアルタイムBar |
| `POST /bars/bulk` | Historical Bar一括 |
| `POST /positions` | ポジションストリーム |
| `POST /account` | 口座情報 |
| `POST /heartbeat` | 死活監視 |

### Browser → Server (読み取り専用)
| Endpoint | 役割 |
|----------|------|
| `GET /health` | サーバー状態 |
| `GET /bars/:sym/:tf` | 過去Bar (Trading View) |
| `GET /tick/:sym` | 最新Tick |
| `GET /positions` | ポジション一覧 |
| `GET /account` | 口座情報 |
| `GET /symbols` | シンボル一覧 |
| `WS /ws` | リアルタイムストリーム |

---

## 4. MT5 Layer

### data-manager (Admin MT5専用)
```
mt5/data-manager/
├── AVL_DataManager_v2.mq5   ← 8ストリーム送信EA
└── AVL_DataManager_v2.ex5
```
- Admin MT5にのみインストール
- Market Data取得 → Gateway POST

### execution-bridge (User MT5専用)
```
mt5/execution-bridge/
├── AVL_ExecutionBridge.mq5  ← Live Trading注文実行
├── AVL_FX_Bridge.mq5        ← Gateway双方向ブリッジ
└── AVL_FX_Bridge.ex5
```
- ユーザー自身のMT5にインストール
- Trading View → Gateway → このEA → 注文実行

---

## 5. Supabase (共通Data Infrastructure)

### 主要テーブル
| テーブル | 書き込み元 | 読み取り元 |
|---------|-----------|-----------|
| `bar_data` | Gateway (Admin MT5経由) | Trading View, Console |
| `ticks` | Gateway | Console |
| `strategies` | Trading View | Trading View |
| `backtest_results` | Trading View | Trading View |
| `live_positions` | Trading View | Trading View |

---

## 環境変数分離

### Trading View (.env.local)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL=  ← 読み取り専用
OPENAI_API_KEY=
STRIPE_SECRET_KEY=
```

### Console (.env.local)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=         ← Console専用 (service_role)
MT5_GATEWAY_URL=                   ← Admin Gateway URL
MT5_GATEWAY_SECRET=                ← Admin認証secret
ADMIN_EMAILS=admin@example.com     ← アクセス許可メール
```

### Gateway (.env)
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
GATEWAY_SECRET=
PORT=3002
```

---

## Security

- **Admin Secrets分離:** `MT5_GATEWAY_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` はConsoleのみ
- **Trading View:** publicキーのみ。service_roleは一切保持しない
- **Console:** ADMIN_EMAILS allowlist。Middlewareで全ページガード
- **Gateway:** `x-gateway-secret` ヘッダー認証。EA→Gateway間のみ
