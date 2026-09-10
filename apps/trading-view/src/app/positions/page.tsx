import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { PositionsView }  from "@/presentation/components/positions/PositionsView";
import { MT5Gate }        from "@/presentation/components/common/MT5Gate";

export default function PositionsPage() {
  return (
    <DashboardShell>
      <MT5Gate feature="ポジション・口座情報">
        <PositionsView />
      </MT5Gate>
    </DashboardShell>
  );
}
