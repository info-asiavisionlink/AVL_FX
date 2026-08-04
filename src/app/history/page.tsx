import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { HistoryView }    from "@/presentation/components/history/HistoryView";

export default function HistoryPage() {
  return (
    <DashboardShell>
      <HistoryView />
    </DashboardShell>
  );
}
