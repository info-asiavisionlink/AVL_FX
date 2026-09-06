import type { EconomicEvent, ImpactLevel } from "@/types";

export interface IEconomicCalendarRepository {
  getEvents(params: {
    from: number;
    to: number;
    currencies?: string[];
    minImpact?: ImpactLevel;
  }): Promise<EconomicEvent[]>;
}
