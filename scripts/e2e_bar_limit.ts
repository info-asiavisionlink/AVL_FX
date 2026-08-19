import { createAdminClient } from "@/infrastructure/supabase/admin";
async function main() {
  const db = createAdminClient();
  const { data: d1 } = await db.from("bar_data").select("time_utc")
    .eq("symbol","EURUSD").eq("timeframe","M5").order("time_utc",{ascending:true});
  console.log(`No limit → ${d1?.length} rows (DEFAULT ROW LIMIT TEST)`);
  const { data: d2 } = await db.from("bar_data").select("time_utc")
    .eq("symbol","EURUSD").eq("timeframe","M5").order("time_utc",{ascending:true}).limit(10000);
  console.log(`limit(10000) → ${d2?.length} rows`);
  if (d2 && d2.length > 0) {
    console.log(`  First: ${d2[0]!["time_utc"]}  Last: ${d2[d2.length-1]!["time_utc"]}`);
  }
  const { count } = await db.from("bar_data")
    .select("*",{count:"exact",head:true}).eq("symbol","EURUSD").eq("timeframe","M5");
  console.log(`Exact count: ${count}`);
  const { data: h1 } = await db.from("bar_data").select("time_utc")
    .eq("symbol","EURUSD").eq("timeframe","H1").order("time_utc",{ascending:true});
  console.log(`H1 no limit → ${h1?.length} rows`);
}
main().catch(e=>{console.error(e);process.exit(1);});
