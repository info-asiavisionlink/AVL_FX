import { Sidebar } from "./Sidebar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-[#131722]">
      <Sidebar />
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
