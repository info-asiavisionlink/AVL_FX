import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AVLFX Console",
  description: "AVL-FX Platform Administration Console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
