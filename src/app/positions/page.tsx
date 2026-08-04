import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { PositionsView }  from "@/presentation/components/positions/PositionsView";

export default function PositionsPage() {
  return (
    <DashboardShell>
      <PositionsView />
    </DashboardShell>
  );
}
