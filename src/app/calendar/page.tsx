import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { CalendarView }   from "@/presentation/components/economic-calendar/CalendarView";

export default function CalendarPage() {
  return (
    <DashboardShell>
      <div className="flex-1 overflow-hidden">
        <CalendarView />
      </div>
    </DashboardShell>
  );
}
