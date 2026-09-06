# MT5 DataManager

Admin MT5専用。Market Dataを取得しGatewayへ送信するEA。

## Files

- `AVL_DataManager_v2.mq5` — Tick/Bar取得 → Gateway POST
- `AVL_DataManager_v2.ex5` — コンパイル済みバイナリ

## Role

Admin MT5 (管理者専用口座) にのみインストール。
一般ユーザーのMT5には不要。

## Data Flow

Admin MT5 → [this EA] → Gateway → Supabase → Trading View
