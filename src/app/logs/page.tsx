import { DashboardShell }    from "@/presentation/components/layout/DashboardShell";
import { TraderActivityLog } from "@/presentation/components/logs/TraderActivityLog";

export default function LogsPage() {
  return (
    <DashboardShell>
      <TraderActivityLog />
    </DashboardShell>
  );
}
