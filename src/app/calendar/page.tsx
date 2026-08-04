import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { EconomicCalendarPanel } from "@/presentation/components/economic-calendar/EconomicCalendarPanel";

export default function CalendarPage() {
  return (
    <DashboardShell>
      <div className="flex-1 bg-[#0f1117]">
        <EconomicCalendarPanel />
      </div>
    </DashboardShell>
  );
}
