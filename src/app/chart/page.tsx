import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { Header } from "@/presentation/components/layout/Header";
import { WatchlistPanel } from "@/presentation/components/watchlist/WatchlistPanel";
import { EconomicCalendarPanel } from "@/presentation/components/economic-calendar/EconomicCalendarPanel";
import { AVLChart } from "@/presentation/components/chart/AVLChart";
import { MT5Gate } from "@/presentation/components/common/MT5Gate";

export default function ChartPage() {
  return (
    <DashboardShell>
      <div className="hidden md:flex flex-col w-64 shrink-0 border-r overflow-hidden" style={{ background: "#fff", borderColor: "rgba(0,0,0,0.08)" }}>
        <div className="flex-1 overflow-hidden border-b" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
          <WatchlistPanel />
        </div>
        <div className="flex-1 overflow-hidden">
          <EconomicCalendarPanel />
        </div>
      </div>
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <div className="flex-1 overflow-hidden">
          <MT5Gate feature="リアルタイムチャート">
            <AVLChart />
          </MT5Gate>
        </div>
      </div>
    </DashboardShell>
  );
}
