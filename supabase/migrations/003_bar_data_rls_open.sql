-- =================================================================
-- 003_bar_data_rls_open.sql
-- bar_data の RLS を無効化する
--
-- 理由:
--   bar_data は FX OHLC 市場データ（完全公開情報）。
--   ユーザー固有データではないため RLS は不要。
--   Gateway の Supabase キー設定に関わらず書き込み可能にする。
-- =================================================================

ALTER TABLE public.bar_data DISABLE ROW LEVEL SECURITY;

-- 既存ポリシーをすべて削除（不要になったため）
DROP POLICY IF EXISTS "bar_data_select" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_insert" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_update" ON public.bar_data;
