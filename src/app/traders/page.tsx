import { DashboardShell }          from "@/presentation/components/layout/DashboardShell";
import { AITraderCommandCenter } from "@/presentation/components/trader/AITraderCommandCenter";

export default function TradersPage() {
  return (
    <DashboardShell>
      <AITraderCommandCenter />
    </DashboardShell>
  );
}
