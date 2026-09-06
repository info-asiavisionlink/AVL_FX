# MT5 Execution Bridge

User MT5専用。Live Trading注文実行ブリッジ。

## Files

- `AVL_ExecutionBridge.mq5` — 注文実行 (STAGE 3-B)
- `AVL_FX_Bridge.mq5` — Gateway双方向ブリッジ
- `AVL_FX_Bridge.ex5` — コンパイル済みバイナリ

## Role

ユーザー自身のMT5口座にインストール。
Trading ViewからのLive Trading命令を受信し、実際の注文を実行。

## Data Flow

Trading View → Gateway → [this EA] → User MT5 → Broker
