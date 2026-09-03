import Link from "next/link";

const NG   = "#00ff88";
const CYAN = "#00e5ff";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen"
      style={{ background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)" }}>

      {/* ヘッダー */}
      <header className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-lg font-black tracking-[0.2em]"
            style={{ color: NG, textShadow: `0 0 16px ${NG}60` }}>
            AVL FX
          </Link>
          <nav className="flex items-center gap-4">
            <Link href="/legal/terms"    className="text-[9px] font-mono transition-opacity hover:opacity-80" style={{ color: "#475569" }}>利用規約</Link>
            <Link href="/legal/privacy"  className="text-[9px] font-mono transition-opacity hover:opacity-80" style={{ color: "#475569" }}>プライバシーポリシー</Link>
            <Link href="/legal/tokushoho" className="text-[9px] font-mono transition-opacity hover:opacity-80" style={{ color: "#475569" }}>特定商取引法</Link>
            <Link href="/legal/contact"  className="text-[9px] font-mono transition-opacity hover:opacity-80" style={{ color: CYAN }}>お問い合わせ</Link>
          </nav>
        </div>
      </header>

      {/* コンテンツ */}
      <main className="max-w-4xl mx-auto px-6 py-12">
        {children}
      </main>

      {/* フッター */}
      <footer className="border-t mt-16" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-4xl mx-auto px-6 py-6 flex flex-wrap gap-4 justify-between items-center">
          <p className="text-[8px] font-mono" style={{ color: "#334155" }}>
            © {new Date().getFullYear()} AVL FX. All rights reserved.
          </p>
          <div className="flex gap-4">
            <Link href="/legal/terms"     className="text-[8px] font-mono" style={{ color: "#334155" }}>利用規約</Link>
            <Link href="/legal/privacy"   className="text-[8px] font-mono" style={{ color: "#334155" }}>プライバシーポリシー</Link>
            <Link href="/legal/tokushoho" className="text-[8px] font-mono" style={{ color: "#334155" }}>特定商取引法</Link>
            <Link href="/pricing"         className="text-[8px] font-mono" style={{ color: "#334155" }}>料金プラン</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
