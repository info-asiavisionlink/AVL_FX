import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { NewsView }       from "@/presentation/components/news/NewsView";

export default function NewsPage() {
  return (
    <DashboardShell>
      <NewsView />
    </DashboardShell>
  );
}
