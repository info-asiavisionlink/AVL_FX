# 環境変数リファレンス
**Status:** REFERENCE — `.env.local` 実ファイルベース  
**Last Updated:** 2026-09-10  
**Source of Truth:** `.env.local` (gitignore済み — 値は絶対にコミットしない)

> **セキュリティ注意:** このドキュメントにはキー名と用途のみを記載する。実際の値は `.env.local` を参照。

---

## Supabase

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase プロジェクト URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Supabase anon/publishable key（ブラウザ用） |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | Supabase service_role key（API Routes / RLSバイパス用） |
| `SUPABASE_PAT` | **Secret** | Supabase Personal Access Token（CLI・管理API操作用） |

---

## MT5 Gateway（Railway）

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL` | Public | Gateway HTTP エンドポイント（本番: Railway URL） |
| `NEXT_PUBLIC_MT5_GATEWAY_WS_URL` | Public | Gateway WebSocket エンドポイント（本番: Railway wss://） |
| `MT5_GATEWAY_URL` | Server | Gateway HTTP URL（Server-side API Routes用） |
| `MT5_GATEWAY_SECRET` | **Secret** | Gateway 認証シークレット |
| `MT5_WEBSOCKET_PORT` | Server | WebSocket ポート番号（デフォルト: 8080） |

**本番 URL:** `https://remarkable-cooperation-production-7341.up.railway.app`  
**ローカル開発:** コメントアウトされた `http://127.0.0.1:8080` に切り替え可

---

## OpenAI

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `OPENAI_API_KEY` | **Secret** | OpenAI API キー |
| `OPENAI_MODEL` | Server | 使用モデル（現在: `gpt-4.1`） |
| `OPENAI_REALTIME_MODEL` | Server | Realtime API モデル（現在: `gpt-realtime-2.1`） |

---

## Twelve Data API

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `TWELVE_DATA_API_KEY` | **Secret** | Twelve Data 市場データ API キー（外部データ取得用） |

---

## Stripe（決済）

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `STRIPE_SECRET_KEY` | **Secret** | Stripe シークレットキー（`sk_test_` or `sk_live_`） |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Public | Stripe 公開キー（フロントエンド用） |
| `STRIPE_WEBHOOK_SECRET` | **Secret** | Stripe Webhook 署名検証シークレット（`whsec_`） |
| `STRIPE_PRICE_STARTER` | Server | Starter プラン 価格ID（`price_...`） |
| `STRIPE_PRICE_PRO` | Server | Pro プラン 価格ID（`price_...`） |
| `STRIPE_PRICE_BUSINESS` | Server | Business プラン 価格ID（`price_...`） |

> **現状:** テスト用プレースホルダー値。本番運用前に Stripe Dashboard で価格ID を作成・設定が必要。

---

## Google OAuth（Supabase Auth Provider）

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `GOOGLE_CLIENT_ID` | Server | Google OAuth クライアントID（Supabase Auth 連携） |
| `GOOGLE_CLIENT_SECRET` | **Secret** | Google OAuth クライアントシークレット |

---

## Resend（メール送信）

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `RESEND_API_KEY` | **Secret** | Resend API キー（コンタクトフォームのメール送信） |
| `FROM_EMAIL` | Server | 送信元メールアドレス（`noreply@asiavision.link`） |

---

## Next.js / Vercel

| 変数名 | 公開/秘密 | 用途 |
|--------|-----------|------|
| `APP_URL` | Server | アプリ URL（ローカル: `http://localhost:3000`） |
| `NODE_ENV` | Server | 実行環境（`development` / `production`） |
| `VERCEL_OIDC_TOKEN` | **Secret** | Vercel CLI が自動生成する OIDC トークン（手動設定不要） |

---

## Vercel 本番環境への設定方法

```bash
# 個別追加
vercel env add VARIABLE_NAME

# ローカル .env.local から一括 pull（Vercel 側 → ローカル）
vercel env pull .env.local
```

> Vercel Dashboard → Project Settings → Environment Variables でも設定可能。

---

## 未設定・要注意

| 変数名 | 状態 | 対応方針 |
|--------|------|---------|
| `STRIPE_SECRET_KEY` | プレースホルダー | Stripe Dashboard でキー取得後に設定 |
| `STRIPE_PRICE_*` | プレースホルダー | Stripe Dashboard で商品・価格を作成後に設定 |
| `STRIPE_WEBHOOK_SECRET` | プレースホルダー | Stripe Webhook エンドポイント登録後に設定 |
