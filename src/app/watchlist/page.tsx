import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { WatchlistPanel } from "@/presentation/components/watchlist/WatchlistPanel";

export default function WatchlistPage() {
  return (
    <DashboardShell>
      <div className="flex-1 bg-[#f8f7f4]">
        <WatchlistPanel />
      </div>
    </DashboardShell>
  );
}
