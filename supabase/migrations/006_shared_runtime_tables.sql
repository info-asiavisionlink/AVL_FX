-- Stage 2: tables required by the existing repository and 015 RLS migration.
-- This migration intentionally precedes 007..015 so a fresh database can
-- apply the historical RLS statements without relying on production state.

CREATE TABLE IF NOT EXISTS public.trade_history (
  ticket BIGINT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  connection_id UUID,
  symbol TEXT NOT NULL,
  type INTEGER NOT NULL,
  volume NUMERIC NOT NULL,
  close_time TIMESTAMPTZ NOT NULL,
  close_price NUMERIC NOT NULL,
  profit NUMERIC NOT NULL DEFAULT 0,
  swap NUMERIC NOT NULL DEFAULT 0,
  commission NUMERIC NOT NULL DEFAULT 0,
  magic INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_history_user_time
  ON public.trade_history (user_id, close_time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_history_symbol_time
  ON public.trade_history (symbol, close_time DESC);

CREATE TABLE IF NOT EXISTS public.economic_events (
  event_id TEXT PRIMARY KEY,
  event_time TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  impact INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 3),
  actual TEXT,
  forecast TEXT,
  previous TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_economic_events_time_currency
  ON public.economic_events (event_time, currency);

CREATE TABLE IF NOT EXISTS public.news_items (
  news_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ NOT NULL,
  symbols TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_items_published
  ON public.news_items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_symbols
  ON public.news_items USING GIN (symbols);
