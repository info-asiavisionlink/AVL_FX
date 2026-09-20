import { NextRequest, NextResponse } from "next/server";
import { getUpcomingEvents } from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const currencies = (searchParams.get("currencies") ?? "USD,EUR,JPY,GBP").split(",");
  const hours = Number(searchParams.get("hours") ?? 24);

  try {
    const events = await getUpcomingEvents(currencies, hours);
    return NextResponse.json(
      events.length > 0
        ? events.map(e => ({
            time:     e.event_time,
            currency: e.currency,
            title:    e.title,
            impact:   e.impact === 3 ? "HIGH" : e.impact === 2 ? "MEDIUM" : "LOW",
            forecast: e.forecast ?? null,
            previous: e.previous ?? null,
            actual:   e.actual ?? null,
          }))
        : [],
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
