export const metadata = { title: "プライバシーポリシー | AVL FX" };

const NG   = "#00ff88";
const CYAN = "#00e5ff";

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[14px] font-black tracking-widest mt-10 mb-4 pb-2"
    style={{ color: NG, borderBottom: "1px solid rgba(0,255,136,0.15)" }}>{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-mono leading-relaxed mb-3" style={{ color: "#94a3b8" }}>{children}</p>;
}
function Li({ children }: { children: React.ReactNode }) {
  return <li className="text-[11px] font-mono leading-relaxed mb-1.5 pl-4" style={{ color: "#94a3b8" }}>• {children}</li>;
}

export default function PrivacyPage() {
  return (
    <article>
      <div className="mb-8">
        <p className="text-[10px] font-mono mb-2" style={{ color: "#475569" }}>最終更新日: 2026年9月1日</p>
        <h1 className="text-2xl font-black tracking-[0.15em]" style={{ color: "#e2e8f0" }}>プライバシーポリシー</h1>
      </div>

      <P>
        AVL FX（以下「本サービス」）は、ユーザーの個人情報の保護を重要な責務と考えています。
        本プライバシーポリシーでは、収集する情報の種類、利用目的、管理方法について説明します。
      </P>

      <H2>1. 収集する情報</H2>
      <P>本サービスは以下の情報を収集します。</P>
      <ul className="mb-4 space-y-1">
        <Li><strong style={{ color: "#e2e8f0" }}>アカウント情報：</strong>メールアドレス、パスワード（ハッシュ化）、Googleアカウント情報（Google ログイン利用時）</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>決済情報：</strong>Stripeによる決済処理。クレジットカード情報はStripe社が管理し、当社では保持しません。</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>利用データ：</strong>作成したEA設定、バックテスト結果、AI分析ログ</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>MT5接続データ：</strong>口座番号、取引履歴（ポジション管理のため）</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>ログデータ：</strong>IPアドレス、アクセス日時、ブラウザ情報</Li>
      </ul>

      <H2>2. 情報の利用目的</H2>
      <ul className="mb-4 space-y-1">
        <Li>本サービスの提供・運営・改善</Li>
        <Li>ユーザー認証・アカウント管理</Li>
        <Li>サブスクリプション・決済処理</Li>
        <Li>サポート対応・お問い合わせへの回答</Li>
        <Li>不正アクセス・不正利用の検知・防止</Li>
        <Li>サービスに関する重要なお知らせの送付</Li>
      </ul>

      <H2>3. 第三者への提供</H2>
      <P>収集した個人情報は、以下の場合を除き第三者に提供しません。</P>
      <ul className="mb-4 space-y-1">
        <Li>ユーザーの同意がある場合</Li>
        <Li>法令に基づく場合</Li>
        <Li>人の生命・身体・財産の保護のために必要な場合</Li>
      </ul>

      <H2>4. 業務委託先（サブプロセッサー）</H2>
      <P>本サービスは以下のサービスを利用しており、これらに必要最低限の情報が提供されます。</P>
      <ul className="mb-4 space-y-1">
        <Li><strong style={{ color: "#e2e8f0" }}>Supabase Inc.（米国）</strong>：データベース・認証管理</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>Vercel Inc.（米国）</strong>：ウェブホスティング</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>Stripe Inc.（米国）</strong>：決済処理</Li>
        <Li><strong style={{ color: "#e2e8f0" }}>OpenAI（米国）</strong>：AI分析機能</Li>
      </ul>
      <P>これらの事業者は各社のプライバシーポリシーに従い情報を管理します。</P>

      <H2>5. Cookieの利用</H2>
      <P>
        本サービスはセッション管理のためにCookieを使用します。
        ブラウザの設定でCookieを無効にすることができますが、
        サービスの一部機能が使用できなくなる場合があります。
      </P>

      <H2>6. 個人情報の保管・セキュリティ</H2>
      <ul className="mb-4 space-y-1">
        <Li>通信はSSL/TLS暗号化により保護されます</Li>
        <Li>パスワードはbcryptアルゴリズムでハッシュ化して保管します</Li>
        <Li>Row Level Security（RLS）により、ユーザーは自身のデータのみアクセスできます</Li>
      </ul>

      <H2>7. データの保存期間</H2>
      <ul className="mb-4 space-y-1">
        <Li>アカウント情報：退会から1年間</Li>
        <Li>取引・バックテストデータ：退会から1年間</Li>
        <Li>アクセスログ：90日間</Li>
      </ul>

      <H2>8. ユーザーの権利</H2>
      <P>ユーザーは以下の権利を有します。</P>
      <ul className="mb-4 space-y-1">
        <Li>保有する個人情報の開示請求</Li>
        <Li>個人情報の訂正・削除請求</Li>
        <Li>個人情報の利用停止請求</Li>
      </ul>
      <P>
        権利行使のご要望は、
        <a href="/legal/contact" style={{ color: CYAN }}>お問い合わせフォーム</a>
        よりご連絡ください。
      </P>

      <H2>9. プライバシーポリシーの変更</H2>
      <P>
        本ポリシーは必要に応じて変更することがあります。
        重要な変更については、本サービス上でお知らせします。
      </P>

      <H2>10. お問い合わせ</H2>
      <P>
        個人情報の取り扱いに関するお問い合わせは、
        <a href="/legal/contact" style={{ color: CYAN }}>お問い合わせフォーム</a>
        またはメール（<a href="mailto:info@asiavision.link" style={{ color: CYAN }}>info@asiavision.link</a>）にてお受けします。
      </P>

      <div className="mt-12 pt-6 text-right" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-mono" style={{ color: "#334155" }}>制定日: 2026年9月1日</p>
      </div>
    </article>
  );
}
