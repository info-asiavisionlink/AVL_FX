import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { name, email, subject, message } = await req.json();

  if (!name || !email || !subject || !message) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Resend未設定時はログのみ（開発環境）
    console.log("[contact]", { name, email, subject });
    return NextResponse.json({ ok: true });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL ?? "noreply@asiavision.link",
      to:   "info@asiavision.link",
      reply_to: email,
      subject: `[AVL FX お問い合わせ] ${subject}`,
      text: `お名前: ${name}\nメール: ${email}\n種別: ${subject}\n\n${message}`,
    }),
  });

  if (!res.ok) {
    console.error("[contact] Resend error", await res.text());
    return NextResponse.json({ error: "send failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
