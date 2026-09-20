// =================================================================
// AccountSimulator.ts — 仮想口座シミュレーター (Phase 2-C)
//
// Drawdown / Balance / Equity を記録する Pure Class。
// Supabase / MT5 非依存。
// =================================================================

export interface AccountState {
  initialBalance: number;
  balance:        number;
  equity:         number;    // balance + 浮動損益（Phase 2-C では realized のみ）
  peakBalance:    number;
  maxDrawdown:    number;    // 絶対額
  maxDrawdownPct: number;    // % (peakBalance 比)
  totalPips:      number;    // 累積 pips（正=利益）
  realizedProfit: number;    // 累積実現損益 (account currency)
  tradeCount:     number;
  winCount:       number;
  lossCount:      number;
}

export class AccountSimulator {
  private s: AccountState;

  constructor(initialBalance = 10_000) {
    this.s = {
      initialBalance,
      balance:        initialBalance,
      equity:         initialBalance,
      peakBalance:    initialBalance,
      maxDrawdown:    0,
      maxDrawdownPct: 0,
      totalPips:      0,
      realizedProfit: 0,
      tradeCount:     0,
      winCount:       0,
      lossCount:      0,
    };
  }

  recordTrade(trade: {
    pips:   number;
    profit: number;
    result: "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
  }): void {
    const { pips, profit, result } = trade;

    this.s.balance        += profit;
    this.s.equity          = this.s.balance;
    this.s.totalPips      += pips;
    this.s.realizedProfit += profit;
    this.s.tradeCount++;

    if (result === "WIN")  this.s.winCount++;
    if (result === "LOSS") this.s.lossCount++;

    if (this.s.balance > this.s.peakBalance) {
      this.s.peakBalance = this.s.balance;
    }

    const dd    = this.s.peakBalance - this.s.balance;
    const ddPct = this.s.peakBalance > 0 ? dd / this.s.peakBalance * 100 : 0;
    if (dd > this.s.maxDrawdown) {
      this.s.maxDrawdown    = dd;
      this.s.maxDrawdownPct = ddPct;
    }
  }

  getState(): Readonly<AccountState> { return { ...this.s }; }
  getBalance(): number { return this.s.balance; }
  getEquity():  number { return this.s.equity; }
}
