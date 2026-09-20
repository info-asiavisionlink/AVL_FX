import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { LogsView }       from "@/presentation/components/logs/LogsView";

export default function LogsPage() {
  return (
    <DashboardShell>
      <LogsView />
    </DashboardShell>
  );
}
