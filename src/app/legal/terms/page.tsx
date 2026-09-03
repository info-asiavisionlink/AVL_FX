export const metadata = { title: "利用規約 | AVL FX" };

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

export default function TermsPage() {
  return (
    <article>
      <div className="mb-8">
        <p className="text-[10px] font-mono mb-2" style={{ color: "#475569" }}>最終更新日: 2026年9月1日</p>
        <h1 className="text-2xl font-black tracking-[0.15em]" style={{ color: "#e2e8f0" }}>利用規約</h1>
      </div>

      <P>
        本利用規約（以下「本規約」）は、AVL FX（以下「本サービス」）の利用条件を定めるものです。
        ユーザーの皆様には、本規約に同意いただいた上で本サービスをご利用いただきます。
      </P>

      <H2>第1条（本サービスの内容）</H2>
      <P>本サービスは、以下の機能を提供するプラットフォームです。</P>
      <ul className="mb-4 space-y-1">
        <Li>AIを活用した自動売買EA（Expert Advisor）の設計・バックテスト支援</Li>
        <Li>過去の市場データ（ヒストリカルデータ）の提供</Li>
        <Li>バックテスト結果の分析・可視化</Li>
        <Li>ユーザーが作成したEAとMT5口座を連携する取引環境の提供</Li>
      </ul>
      <P>
        <strong style={{ color: "#e2e8f0" }}>重要：</strong>
        本サービスはEAの売買・提供を行いません。ユーザー自身がAIとバックテストを活用してEAを設計・作成します。
        運営者はバックテストデータの提供および取引環境の提供のみを行います。
        投資判断はユーザー自身の責任において行うものとします。
      </P>

      <H2>第2条（ユーザー登録）</H2>
      <ul className="mb-4 space-y-1">
        <Li>本サービスの利用には、メールアドレスまたはGoogleアカウントによる登録が必要です。</Li>
        <Li>18歳未満の方はご利用いただけません。</Li>
        <Li>虚偽の情報を登録することを禁止します。</Li>
        <Li>アカウントの管理はユーザー自身の責任とします。</Li>
      </ul>

      <H2>第3条（料金・支払い）</H2>
      <ul className="mb-4 space-y-1">
        <Li>各プランの料金は利用規約ページ（/pricing）に記載の通りです。</Li>
        <Li>支払いはStripeを通じたクレジットカード決済となります。</Li>
        <Li>サブスクリプションは毎月自動更新されます。</Li>
        <Li>月の途中でプランを変更した場合、日割り計算が適用されます。</Li>
        <Li>一度お支払いいただいた料金の返金は原則として行いません。</Li>
      </ul>

      <H2>第4条（解約）</H2>
      <P>
        ユーザーはいつでもサブスクリプションを解約できます。
        解約後は当月末まで引き続きサービスをご利用いただけます。
        解約はダッシュボードの「プランを管理」から行えます。
      </P>

      <H2>第5条（禁止事項）</H2>
      <ul className="mb-4 space-y-1">
        <Li>法令または公序良俗に違反する行為</Li>
        <Li>本サービスのサーバーやネットワークに過大な負荷をかける行為</Li>
        <Li>本サービスの逆コンパイル、リバースエンジニアリング</Li>
        <Li>他のユーザーのアカウントへの不正アクセス</Li>
        <Li>本サービスを利用した第三者への損害を与える行為</Li>
        <Li>マネーロンダリングその他の不正な金融取引への利用</Li>
      </ul>

      <H2>第6条（免責事項）</H2>
      <P>
        本サービスで提供するバックテスト結果・AI分析は、将来の投資成果を保証するものではありません。
        FX取引には元本割れのリスクがあります。
      </P>
      <P>
        運営者は、ユーザーが本サービスを利用して行ったFX取引の損益について、
        一切の責任を負いません。投資はご自身の判断と責任において行ってください。
      </P>
      <P>
        システムの障害・メンテナンス・外部サービス（MT5・Stripe等）の障害による
        サービス停止について、運営者は責任を負いません。
      </P>

      <H2>第7条（個人情報の取り扱い）</H2>
      <P>
        個人情報の取り扱いについては、別途定める
        <a href="/legal/privacy" style={{ color: CYAN }}>プライバシーポリシー</a>
        によります。
      </P>

      <H2>第8条（本規約の変更）</H2>
      <P>
        運営者は、必要と判断した場合に本規約を変更できるものとします。
        変更後の規約は、本サービス上に掲示した時点から効力を生じます。
        変更後も本サービスをご利用の場合、変更に同意したものとみなします。
      </P>

      <H2>第9条（準拠法・裁判管轄）</H2>
      <P>
        本規約の解釈は日本法に準拠します。
        本サービスに関する紛争は、東京地方裁判所を第一審の専属的合意管轄裁判所とします。
      </P>

      <div className="mt-12 pt-6 text-right" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-mono" style={{ color: "#334155" }}>制定日: 2026年9月1日</p>
      </div>
    </article>
  );
}
