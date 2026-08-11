import { Sidebar } from "./Sidebar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden" style={{
      background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)",
    }}>
      <Sidebar />
      <div className="flex flex-1 overflow-hidden relative min-w-0">
        {/* Global depth vignette */}
        <div className="absolute inset-0 pointer-events-none z-0"
          style={{background:"radial-gradient(ellipse 80% 60% at 50% 50%, transparent 30%, rgba(0,0,0,0.6) 100%)"}}/>
        {children}
      </div>
    </div>
  );
}
