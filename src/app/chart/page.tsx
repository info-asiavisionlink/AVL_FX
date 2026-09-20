import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { Header } from "@/presentation/components/layout/Header";
import { AVLChart } from "@/presentation/components/chart/AVLChart";
import { MT5Gate } from "@/presentation/components/common/MT5Gate";

export default function ChartPage() {
  return (
    <DashboardShell>
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <div className="flex-1 overflow-hidden">
          <MT5Gate feature="リアルタイムチャート">
            <AVLChart />
          </MT5Gate>
        </div>
      </div>
    </DashboardShell>
  );
}
