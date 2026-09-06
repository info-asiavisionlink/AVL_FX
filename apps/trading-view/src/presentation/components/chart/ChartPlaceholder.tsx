"use client";

import { usePriceStore } from "@/application/stores/priceStore";
import { BarChart2 } from "lucide-react";

// TradingView Charting Library は別途ライセンス取得後に実装
// Phase1: このプレースホルダーをライブラリに差し替える
export function ChartPlaceholder() {
  const { activeSymbol, activeTimeframe } = usePriceStore();

  return (
    <div className="flex flex-col items-center justify-center w-full h-full bg-[#131722] gap-4">
      <BarChart2 size={48} className="text-gray-700" />
      <div className="text-center">
        <p className="text-gray-400 font-semibold">
          {activeSymbol} / {activeTimeframe}
        </p>
        <p className="text-xs text-gray-600 mt-1">
          TradingView Charting Library をここに表示
        </p>
        <p className="text-xs text-gray-700 mt-0.5">
          public/charting_library/ にライブラリを配置してください
        </p>
      </div>
    </div>
  );
}
