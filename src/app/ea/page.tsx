import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { EACommandCenter } from "@/presentation/components/ea/EACommandCenter";

export default function EAPage() {
  return (
    <DashboardShell>
      <EACommandCenter />
    </DashboardShell>
  );
}
