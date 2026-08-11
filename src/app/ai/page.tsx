"use client";

import { DashboardShell } from "@/presentation/components/layout/DashboardShell";
import { AIBrainPanel }   from "@/presentation/components/os/AIBrainPanel";
import { useAIBrain }     from "@/presentation/hooks/useAIBrain";
import { usePriceStore }  from "@/application/stores/priceStore";

function AIBrainPage() {
  const brain       = useAIBrain();
  const { activeSymbol } = usePriceStore();

  return (
    <div className="flex flex-1 overflow-hidden">
      <AIBrainPanel
        state={brain}
        onRun={brain.run}
        onReset={brain.reset}
        symbol={activeSymbol}
      />
    </div>
  );
}

export default function AiRoute() {
  return (
    <DashboardShell>
      <AIBrainPage />
    </DashboardShell>
  );
}
