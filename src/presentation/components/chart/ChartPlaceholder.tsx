"use client";

import { usePriceStore } from "@/application/stores/priceStore";
import { BarChart2 } from "lucide-react";

export function ChartPlaceholder() {
  const { activeSymbol, activeTimeframe } = usePriceStore();

  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-4" style={{ background: "#f8f7f4" }}>
      <BarChart2 size={40} style={{ color: "#d0cfc9" }} />
      <div className="text-center">
        <p className="font-semibold text-sm" style={{ color: "#4a4a4a" }}>
          {activeSymbol} / {activeTimeframe}
        </p>
        <p className="text-xs mt-1" style={{ color: "#9a9a9a" }}>
          チャートを表示するには MT5 に接続してください
        </p>
      </div>
    </div>
  );
}
