export const metadata = { title: "特定商取引法に基づく表記 | AVL FX" };

const NG = "#00ff88";

function Row({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <td className="py-3 pr-6 text-[10px] font-mono font-bold align-top whitespace-nowrap w-40"
        style={{ color: "#64748b" }}>{label}</td>
      <td className="py-3 text-[11px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>
        {value}
        {note && <span className="block text-[9px] mt-1" style={{ color: "#475569" }}>{note}</span>}
      </td>
    </tr>
  );
}

export default function TokushohoPage() {
  return (
    <article>
      <div className="mb-8">
        <p className="text-[10px] font-mono mb-2" style={{ color: "#475569" }}>最終更新日: 2026年9月1日</p>
        <h1 className="text-2xl font-black tracking-[0.15em]" style={{ color: "#e2e8f0" }}>特定商取引法に基づく表記</h1>
      </div>

      <div className="rounded-xl overflow-hidden"
        style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
        <table className="w-full">
          <tbody>
            <Row label="販売事業者"
              value="ASIAVISIONLINK"
            />
            <Row label="運営責任者"
              value="田中慶樹"
            />
            <Row label="所在地"
              value={<>〒104-0061<br />東京都中央区銀座1丁目12-4</>}
            />
            <Row label="電話番号"
              value={<>お問い合わせフォームをご利用ください<br /><a href="/legal/contact" style={{ color: "#00e5ff" }}>→ お問い合わせフォーム</a></>}
              note="電話対応は行っておりません"
            />
            <Row label="メールアドレス"
              value={<a href="mailto:info@asiavision.link" style={{ color: "#00e5ff" }}>info@asiavision.link</a>}
            />
            <Row label="サービス名"
              value="AVL FX（エーブイエル エフエックス）"
            />
            <Row label="サービス内容"
              value={
                <>
                  FX自動売買EA（Expert Advisor）のバックテスト・AI分析プラットフォーム。
                  ユーザーがAIを活用してEAを設計・検証し、MT5口座と連携して取引できる環境を提供します。
                  <br />※ EAの売買・投資助言・資産運用は行いません。
                </>
              }
            />
            <Row label="販売価格"
              value={
                <ul className="space-y-1">
                  <li>スタータープラン：¥5,000 / 月（税込）</li>
                  <li>プロプラン：¥50,000 / 月（税込）</li>
                  <li>ビジネスプラン：¥200,000 / 月（税込）</li>
                </ul>
              }
              note="消費税10%を含む"
            />
            <Row label="支払方法"
              value="クレジットカード（VISA / Mastercard / American Express / JCB）"
            />
            <Row label="支払時期"
              value="初回：お申し込み時に即時決済。以降：毎月自動更新（月払い）"
            />
            <Row label="サービス提供時期"
              value="決済完了後、即時ご利用いただけます"
            />
            <Row label="返品・キャンセル"
              value={
                <>
                  サブスクリプションはいつでもキャンセル可能です。
                  キャンセル後は当月末まで引き続きご利用いただけます。
                  <br />デジタルコンテンツの性質上、決済後の返金は原則としてお受けできません。
                  ただし、サービスに重大な瑕疵がある場合はこの限りではありません。
                </>
              }
            />
            <Row label="動作環境"
              value="最新版のChrome / Safari / Firefox / Edge。MT5はWindows/Mac対応版"
            />
          </tbody>
        </table>
      </div>

      <div className="mt-8 p-4 rounded-lg" style={{ background: "rgba(0,229,255,0.04)", border: "1px solid rgba(0,229,255,0.12)" }}>
        <p className="text-[10px] font-black tracking-widest mb-2" style={{ color: "#00e5ff" }}>免責事項</p>
        <p className="text-[10px] font-mono leading-relaxed" style={{ color: "#64748b" }}>
          本サービスはFX取引の補助ツールを提供するものであり、投資助言・資産運用を行うものではありません。
          FX取引は元本割れのリスクを伴います。バックテスト結果は過去のデータに基づくものであり、
          将来の投資成果を保証するものではありません。投資判断はユーザー自身の責任においてお願いします。
        </p>
      </div>

      <div className="mt-12 pt-6 text-right" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-mono" style={{ color: "#334155" }}>制定日: 2026年9月1日</p>
      </div>
    </article>
  );
}
