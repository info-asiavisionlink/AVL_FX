import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { MT5ConnectionPage } from "@/presentation/components/mt5/MT5ConnectionPage";

export default function MT5Page() {
  return (
    <DashboardShell>
      <div className="flex-1 overflow-y-auto">
        <MT5ConnectionPage />
      </div>
    </DashboardShell>
  );
}
