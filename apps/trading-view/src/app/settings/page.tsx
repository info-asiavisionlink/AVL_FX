import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { SettingsPage } from "@/presentation/components/settings/SettingsPage";

export default function Settings() {
  return (
    <DashboardShell>
      <SettingsPage />
    </DashboardShell>
  );
}
