import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/presentation/providers/AppProviders";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AVL FX",
  description: "AI-powered FX Trading Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${geistMono.variable} h-full`}>
      <body className="h-full antialiased font-mono" style={{ background: "#f8f7f4", color: "#1a1a1a" }}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
