import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { MarketDataCoveragePanel } from "@/presentation/components/market-data/MarketDataCoveragePanel";

export default function MarketDataPage() {
  return (
    <DashboardShell>
      <MarketDataCoveragePanel />
    </DashboardShell>
  );
}
