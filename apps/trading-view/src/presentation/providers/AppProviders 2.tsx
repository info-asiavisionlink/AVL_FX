"use client";

import { TooltipProvider } from "@/components/ui/tooltip";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={0}>
      {children}
    </TooltipProvider>
  );
}
