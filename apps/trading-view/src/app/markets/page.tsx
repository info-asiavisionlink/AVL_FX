import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { MarketsView }    from "@/presentation/components/markets/MarketsView";

export default function MarketsPage() {
  return (
    <DashboardShell>
      <MarketsView />
    </DashboardShell>
  );
}
