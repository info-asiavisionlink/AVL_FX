-- ============================================================
-- 014: ユーザーサブスクリプション管理テーブル
-- ============================================================

-- user_subscriptions: Stripe決済状態とプランを管理
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                      uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 uuid    REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  plan                    text    NOT NULL DEFAULT 'free',
  max_concurrent_eas      int     NOT NULL DEFAULT 0,
  status                  text    NOT NULL DEFAULT 'active', -- active | canceled | past_due
  current_period_end      timestamptz,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

-- RLS: ユーザーは自分のサブスクリプションのみ閲覧可能
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_subscription"
  ON user_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Adminはサービスロールで操作（Webhookハンドラー用）

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id
  ON user_subscriptions(user_id);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_customer
  ON user_subscriptions(stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_sub
  ON user_subscriptions(stripe_subscription_id);

-- ユーザー登録時に自動でFreeプランを作成するトリガー
CREATE OR REPLACE FUNCTION handle_new_user_subscription()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO user_subscriptions (user_id, plan, max_concurrent_eas, status)
  VALUES (NEW.id, 'free', 0, 'active')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
CREATE TRIGGER on_auth_user_created_subscription
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user_subscription();
