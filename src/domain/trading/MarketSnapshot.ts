// =================================================================
// MarketSnapshot — AVL AI Brain の統合データ構造
//
// 全データに鮮度タグを付与し、陳腐化したデータを明示する。
// AI はこの構造体のみを入力として受け取る。
// =================================================================

export type DataSource = "MT5_LIVE" | "MT5_STALE" | "EXTERNAL" | "UNAVAILABLE";
export type TradingSession = "Tokyo" | "London" | "New York" | "Sydney" | "Off-hours";

// -----------------------------------------------------------------
// 鮮度メタデータ
// -----------------------------------------------------------------
export interface DataFreshness {
  ts:       number;   // 取得時刻 (ms)
  ageMs:    number;   // 経過時間 (ms)
  stale:    boolean;  // true = 陳腐化（閾値超過）
  source:   DataSource;
}

// -----------------------------------------------------------------
// 時間足インジケーター（MT5から受信した値をそのまま使用）
// -----------------------------------------------------------------
export interface TFIndicatorSnapshot {
  ema21:      number;
  ema200:     number;
  sma50:      number;
  atr:        number;
  rsi:        number;
  macd:       number;
  macdSignal: number;
  macdHist:   number;
  adx:        number;
  diPlus:     number;
  diMinus:    number;
  bbUpper:    number;
  bbMid:      number;
  bbLower:    number;
  bbWidth:    number;
  stochastic: number;  // Calculated from bars
  trend:      "UP" | "DOWN" | "FLAT";
  freshness:  DataFreshness;
}

// -----------------------------------------------------------------
// Swing Point（ダウ理論スイング）
// -----------------------------------------------------------------
export interface SwingPoint {
  time:  number;
  price: number;
  type:  "high" | "low";
  label: "HH" | "HL" | "LH" | "LL" | "H" | "L";
}

// -----------------------------------------------------------------
// S/R レベル
// -----------------------------------------------------------------
export interface SRLevel {
  price:    number;
  strength: number;
  type:     "support" | "resistance" | "pivot";
  source:   string;
}

// -----------------------------------------------------------------
// ローソク足パターン
// -----------------------------------------------------------------
export interface CandlePatternSnapshot {
  name:      string;
  direction: "bullish" | "bearish" | "neutral";
  strength:  number;
  tf:        string;
}

// -----------------------------------------------------------------
// チャートパターン
// -----------------------------------------------------------------
export interface ChartPatternSnapshot {
  name:       string;
  direction:  "bullish" | "bearish" | "neutral";
  confidence: number;
}

// -----------------------------------------------------------------
// 相関市場
// -----------------------------------------------------------------
export interface CorrelatedMarket {
  symbol:       string;
  bid:          number;
  relationship: "positive" | "negative";
  confirms:     boolean;
  weight:       number;
}

// -----------------------------------------------------------------
// 経済指標イベント
// -----------------------------------------------------------------
export interface EconomicEventSnapshot {
  time:     string;   // ISO
  currency: string;
  title:    string;
  impact:   "HIGH" | "MEDIUM" | "LOW";
  forecast: string | null;
  previous: string | null;
  actual:   string | null;
  hoursUntil: number;  // 負値 = 過去
}

// -----------------------------------------------------------------
// ニュース
// -----------------------------------------------------------------
export interface NewsSnapshot {
  title:       string;
  source:      string;
  publishedAt: string;
  sentiment:   "bullish" | "bearish" | "neutral";
  freshness:   DataFreshness;
}

// -----------------------------------------------------------------
// 口座状態
// -----------------------------------------------------------------
export interface AccountSnapshot {
  login:       number;
  broker:      string;
  currency:    string;
  balance:     number;
  equity:      number;
  margin:      number;
  freeMargin:  number;
  marginLevel: number;
  leverage:    number;
  drawdownPct: number;  // (balance - equity) / balance * 100
  freshness:   DataFreshness;
}

// -----------------------------------------------------------------
// ポジション
// -----------------------------------------------------------------
export interface PositionSnapshot {
  ticket:       number;
  symbol:       string;
  type:         "BUY" | "SELL";
  volume:       number;
  openPrice:    number;
  currentPrice: number;
  sl:           number;
  tp:           number;
  profit:       number;
  openTime:     number;
}

// -----------------------------------------------------------------
// ダウ理論
// -----------------------------------------------------------------
export interface DowTheorySnapshot {
  trend:       "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION";
  score:       number;
  swingPoints: SwingPoint[];
  lastHH:      number | null;
  lastHL:      number | null;
  lastLH:      number | null;
  lastLL:      number | null;
  summary:     string;
}

// -----------------------------------------------------------------
// マルチタイムフレームアライメント
// -----------------------------------------------------------------
export interface MultiTFAlignment {
  direction: "BUY" | "SELL" | "NEUTRAL";
  score:     number;
  // 各TFの方向と信頼度
  timeframes: Record<string, { direction: "BUY" | "SELL" | "NEUTRAL"; score: number; signals: string[] }>;
  alignedCount:   number;  // 同方向TF数
  totalCount:     number;
}

// -----------------------------------------------------------------
// MarketSnapshot — メイン構造体
// -----------------------------------------------------------------
export interface MarketSnapshot {
  // Identity
  snapshotId: string;
  symbol:     string;
  timestamp:  number;

  // Tick
  bid:    number;
  ask:    number;
  spread: number;   // pips
  digits: number;

  // Session
  session: TradingSession[];

  // Technical — MT5インジケーター（TF別）
  indicators: Partial<Record<"H4" | "H1" | "M15" | "M5" | "M1", TFIndicatorSnapshot>>;

  // Dow Theory + ZigZag
  dowTheory: DowTheorySnapshot;

  // Multi-TF alignment
  multiTF: MultiTFAlignment;

  // Support / Resistance
  srLevels:          SRLevel[];
  nearestSupport:    number;
  nearestResistance: number;

  // Patterns
  candlePatterns: CandlePatternSnapshot[];
  chartPatterns:  ChartPatternSnapshot[];

  // Correlated markets
  correlatedMarkets: CorrelatedMarket[];

  // Fundamental
  economicEvents: EconomicEventSnapshot[];
  news:           NewsSnapshot[];
  newsRisk:       "HIGH" | "MEDIUM" | "LOW";

  // Account
  account:   AccountSnapshot | null;
  positions: PositionSnapshot[];
  openPositionsCount: number;
  symbolPositionsCount: number;

  // Overall data quality
  overallSource: DataSource;
  indicatorFreshnessSec: number;  // 最新インジケーターの経過秒数
}

// -----------------------------------------------------------------
// TradeProposal — AI Decision Engine の出力（構造化JSON必須）
// -----------------------------------------------------------------
export interface TradeReasoning {
  market_structure: string;
  technical:        string;
  oscillator:       string;
  fundamental:      string;
  news:             string;
  correlation:      string;
  invalidation:     string;
}

export interface TradeProposal {
  decision:       "BUY" | "SELL" | "WAIT";
  symbol:         string;
  confidence:     number;      // 0-100
  entry:          number;
  stop_loss:      number;
  take_profit:    number;
  risk_reward:    number;      // 計算値（固定ではない）
  sl_pips:        number;
  tp_pips:        number;
  win_probability:number;      // AI推定 0-100
  expected_value: number;      // EV = (prob * reward) - ((1-prob) * risk)
  setup_type:     string;      // e.g. "Dow Pullback", "Structure Break"
  time_horizon:   string;      // e.g. "M5 scalp", "H1 swing"
  reasoning:      TradeReasoning;
  snapshot_id:    string;      // 参照スナップショットID
  timestamp:      string;      // ISO
  model:          string;      // 使用AIモデル
}

// -----------------------------------------------------------------
// RiskDecision — Risk Engine の出力
// -----------------------------------------------------------------
export interface RiskChecks {
  spreadOk:          boolean;
  marginOk:          boolean;
  dailyLossOk:       boolean;
  positionLimitOk:   boolean;
  symbolLimitOk:     boolean;
  newsBlackoutOk:    boolean;
  slValid:           boolean;
  tpValid:           boolean;
  rrMinOk:           boolean;
  expectedValueOk:   boolean;
  lotValid:          boolean;
  duplicateSignalOk: boolean;
  cooldownOk:        boolean;
}

export interface RiskDecision {
  status:           "APPROVED" | "REJECTED" | "MODIFIED";
  proposal:         TradeProposal;   // 修正後
  lot:              number;          // 動的計算済みロット
  riskAmount:       number;          // 損失リスク額
  riskPct:          number;          // 口座比率 %
  checks:           RiskChecks;
  rejectionReason:  string | null;
  modifications:    string[];
  timestamp:        string;
}

// -----------------------------------------------------------------
// TradeAuditRecord — 全決定の監査ログ
// -----------------------------------------------------------------
export interface TradeAuditRecord {
  id:              string;
  ts:              number;
  symbol:          string;
  snapshot_id:     string;
  ai_model:        string;
  decision:        "BUY" | "SELL" | "WAIT";
  confidence:      number;
  entry:           number | null;
  sl:              number | null;
  tp:              number | null;
  rr:              number | null;
  expected_value:  number | null;
  lot:             number | null;
  risk_pct:        number | null;
  risk_status:     "APPROVED" | "REJECTED" | "MODIFIED" | "SKIPPED";
  rejection_reason: string | null;
  order_ticket:    number | null;
  execution_price: number | null;
  slippage_pips:   number | null;
  result_pnl:      number | null;
  live_trading:    boolean;
}
