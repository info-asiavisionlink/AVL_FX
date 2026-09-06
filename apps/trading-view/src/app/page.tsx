import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { DashboardOS }    from "@/presentation/components/os/DashboardOS";

export default function HomePage() {
  return (
    <DashboardShell>
      <DashboardOS />
    </DashboardShell>
  );
}
