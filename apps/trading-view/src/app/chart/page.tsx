import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { Header } from "@/presentation/components/layout/Header";
import { WatchlistPanel } from "@/presentation/components/watchlist/WatchlistPanel";
import { EconomicCalendarPanel } from "@/presentation/components/economic-calendar/EconomicCalendarPanel";
import { AVLChart } from "@/presentation/components/chart/AVLChart";

export default function ChartPage() {
  return (
    <DashboardShell>
      <div className="hidden md:flex flex-col w-64 shrink-0 border-r border-[#2a2d3a] bg-[#1a1d29] overflow-hidden">
        <div className="flex-1 overflow-hidden border-b border-[#2a2d3a]">
          <WatchlistPanel />
        </div>
        <div className="flex-1 overflow-hidden">
          <EconomicCalendarPanel />
        </div>
      </div>
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <div className="flex-1 overflow-hidden">
          <AVLChart />
        </div>
      </div>
    </DashboardShell>
  );
}
