"use client";

// =================================================================
// AIEABuilder — AI EA Builder ダイアログ
//
// フロー:
//   input → generating → backtesting → result → saving → done
//
// 設計原則:
//   - AI設計 → Preview Backtest → ユーザー承認 → 正式登録
//   - 承認前に strategy_registry に書き込まない
//   - Preview Backtest 結果を正式登録時に昇格（再実行なし）
// =================================================================

import { useState } from "react";
import { toast }    from "sonner";
import {
  conditionToJapanese,
  type StrategySpec,
  type StrategyRecord,
} from "@/lib/strategySchema";
import { StrategyResearchAssistant } from "./StrategyResearchAssistant";

// ── カラー定数 ─────────────────────────────────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";

// ── ステップ型 ─────────────────────────────────────────────────────
type Step =
  | "input"        // 3欄入力
  | "generating"   // AI Spec生成中
  | "backtesting"  // Preview Backtest実行中
  | "result"       // Spec + Backtest結果表示
  | "saving"       // 正式保存中
  | "done";        // 完了

// ── 入力状態 ──────────────────────────────────────────────────────
interface InputState {
  entry:      string;
  takeProfit: string;
  stopLoss:   string;
}

const EMPTY_INPUT: InputState = { entry: "", takeProfit: "", stopLoss: "" };

// ── Backtest結果型（client側定義） ─────────────────────────────────
interface SessionStat {
  tradeCount:   number;
  wins:         number;
  losses:       number;
  winRate:      number;
  totalPips:    number;
  profitFactor: number | null;
}

interface PreviewReport {
  periodLabel:          string;
  dataFrom:             number;
  dataTo:               number;
  dataCoverageDays:     number;
  totalTrades:          number;
  wins:                 number;
  losses:               number;
  winRate:              number;
  totalPips:            number;
  avgPips:              number;
  profitFactor:         number | null;
  maxDrawdown:          number;
  maxDrawdownPct:       number;
  sampleSizeWarning:    boolean;
  minRecommendedTrades: number;
  verdict:              "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:        string;
  sessionStats:         Record<string, SessionStat>;
  bestSession:          string | null;
  worstSession:         string | null;
}

interface TradeForPromotion {
  symbol:       string;
  timeframe:    string;
  direction:    string;
  entryTime:    number;
  entryPrice:   number;
  exitTime:     number;
  exitPrice:    number;
  sl:           number;
  tp:           number;
  lot:          number;
  pips:         number;
  result:       string;
  exitReason:   string;
  durationMin:  number;
  spreadPips:   number;
  slippagePips: number;
  entryBarIdx:  number;
  exitBarIdx:   number;
}

interface DirStat {
  trades:  number;
  wins:    number;
  pips:    number;
  winRate: number;
}

interface BacktestResultState {
  report:             PreviewReport;
  trades:             TradeForPromotion[];
  barCount:           number;
  directionBreakdown: { buy: DirStat; sell: DirStat };
  warnings:           string[];
}

// ── 例文 ─────────────────────────────────────────────────────────
const EXAMPLES: InputState[] = [
  {
    entry:      "EURUSDのM5。H1の価格がEMA21より上で上昇トレンド。M5のRSIが30以下から上向きに反転したらBUY。ロンドン時間はエントリーしない。スプレッド2pips以下。",
    takeProfit: "ATR14の3倍で利確。",
    stopLoss:   "ATR14の2倍で損切り。",
  },
  {
    entry:      "USDJPYのH1。EMA21がEMA200より上でBUY。ADX25以上。NY時間のみ。",
    takeProfit: "リスクリワード1:2",
    stopLoss:   "直近安値",
  },
  {
    entry:      "GOLDのH4。上昇トレンド中にRSI50付近から反発したらBUY。",
    takeProfit: "直近高値",
    stopLoss:   "ATR × 2",
  },
];

// ── Props ─────────────────────────────────────────────────────────
interface Props {
  open:    boolean;
  onClose: () => void;
  onSaved: (strategy: StrategyRecord) => void;
}

// ── ラベルヘルパー ─────────────────────────────────────────────────
function typeLabel(t: string) {
  if (t === "SCALPING")  return "スキャルピング";
  if (t === "DAY_TRADE") return "デイトレード";
  if (t === "SWING")     return "スイング";
  return t;
}

function sessionLabel(s: string) {
  if (s === "TOKYO")    return "東京";
  if (s === "LONDON")   return "ロンドン";
  if (s === "NEW_YORK") return "NY";
  if (s === "SYDNEY")   return "シドニー";
  return s;
}

function slToJapanese(sl: { method: string; period?: number; multiplier?: number; pips?: number; pct?: number }) {
  if (sl.method === "ATR")        return `ATR(${sl.period ?? 14}) × ${sl.multiplier ?? 2}`;
  if (sl.method === "FIXED_PIPS") return `${sl.pips} pips`;
  if (sl.method === "SWING_LOW")  return "直近安値";
  if (sl.method === "SWING_HIGH") return "直近高値";
  if (sl.method === "PERCENTAGE") return `${sl.pct}%`;
  return sl.method;
}

function tpToJapanese(tp: { method: string; period?: number; multiplier?: number; pips?: number; rr_ratio?: number; pct?: number }) {
  if (tp.method === "ATR")        return `ATR(${tp.period ?? 14}) × ${tp.multiplier ?? 3}`;
  if (tp.method === "FIXED_PIPS") return `${tp.pips} pips`;
  if (tp.method === "SWING_LOW")  return "直近安値";
  if (tp.method === "SWING_HIGH") return "直近高値";
  if (tp.method === "RR_RATIO")   return `RR 1:${tp.rr_ratio}`;
  if (tp.method === "PERCENTAGE") return `${tp.pct}%`;
  return tp.method;
}

function verdictColor(v: string) {
  if (v === "PASSED")      return NG;
  if (v === "CONDITIONAL") return AMBER;
  return RED;
}

function verdictLabel(v: string) {
  if (v === "PASSED")      return "合格";
  if (v === "CONDITIONAL") return "条件付";
  return "不合格";
}

function pipsColor(pips: number) { return pips >= 0 ? NG : RED; }

// =================================================================
// メインコンポーネント
// =================================================================

export function AIEABuilder({ open, onClose, onSaved }: Props) {
  const [step,                  setStep]                  = useState<Step>("input");
  const [input,                 setInput]                 = useState<InputState>(EMPTY_INPUT);
  const [spec,                  setSpec]                  = useState<StrategySpec | null>(null);
  const [backtestResult,        setBacktestResult]        = useState<BacktestResultState | null>(null);
  const [hasUnsupported,        setHasUnsupported]        = useState(false);
  const [unsupportedList,       setUnsupportedList]       = useState<string[]>([]);
  const [showFailedWarning,     setShowFailedWarning]     = useState(false);
  const [error,                 setError]                 = useState<string | null>(null);
  const [showResearchAssistant, setShowResearchAssistant] = useState(false);

  if (!open) return null;

  const isReady =
    input.entry.trim().length >= 10 &&
    input.takeProfit.trim().length >= 3 &&
    input.stopLoss.trim().length >= 3;

  // ── メインフロー: AI設計 → Preview Backtest ─────────────────────

  async function handleBuild() {
    if (!isReady) return;
    setError(null);
    setHasUnsupported(false);
    setUnsupportedList([]);
    setBacktestResult(null);
    setShowFailedWarning(false);
    setStep("generating");

    try {
      // STEP 1: AI Spec生成
      const res  = await fetch("/api/ai/strategy/build", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          entry_conditions_text:       input.entry.trim(),
          take_profit_conditions_text: input.takeProfit.trim(),
          stop_loss_conditions_text:   input.stopLoss.trim(),
        }),
      });
      const data = await res.json() as {
        success:  boolean;
        spec?:    StrategySpec;
        error?:   string;
        details?: string[];
      };

      if (!data.success || !data.spec) {
        const msg = data.details?.length
          ? data.details.join(" / ")
          : (data.error ?? "生成に失敗しました");
        setError(msg);
        setStep("input");
        return;
      }

      const generatedSpec = data.spec;
      setSpec(generatedSpec);

      // STEP 2: UNSUPPORTED 条件チェック
      const unsupported = generatedSpec.entry_conditions.conditions
        .filter(c => c.condition?.startsWith("UNSUPPORTED:"))
        .map(c => c.condition!.replace("UNSUPPORTED:", "").trim());

      if (unsupported.length > 0) {
        setHasUnsupported(true);
        setUnsupportedList(unsupported);
        setStep("result");
        return;
      }

      // STEP 3: Preview Backtest 自動実行
      setStep("backtesting");

      const btRes  = await fetch("/api/ai/strategy/preview-backtest", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spec: generatedSpec }),
      });
      const btData = await btRes.json() as {
        success:            boolean;
        report?:            PreviewReport;
        trades?:            TradeForPromotion[];
        barCount?:          number;
        directionBreakdown?: { buy: DirStat; sell: DirStat };
        warnings?:          string[];
        error?:             string;
        unsupported?:       string[];
      };

      if (!btData.success || !btData.report) {
        setError(btData.error ?? "バックテストに失敗しました");
        setStep("input");
        return;
      }

      setBacktestResult({
        report:             btData.report,
        trades:             btData.trades ?? [],
        barCount:           btData.barCount ?? 0,
        directionBreakdown: btData.directionBreakdown ?? { buy: { trades:0, wins:0, pips:0, winRate:0 }, sell: { trades:0, wins:0, pips:0, winRate:0 } },
        warnings:           btData.warnings ?? [],
      });
      setStep("result");

    } catch (e) {
      setError(e instanceof Error ? e.message : "ネットワークエラー");
      setStep("input");
    }
  }

  // ── EAを追加する（FAILED警告ありの場合）───────────────────────────

  async function handleEAAdd() {
    if (!spec || !backtestResult) return;
    if (backtestResult.report.verdict === "FAILED" && !showFailedWarning) {
      setShowFailedWarning(true);
      return;
    }
    await handleFormalSave();
  }

  // ── 正式保存（Backtest結果を昇格）─ パラメータ直接受取り版 ──────

  async function handleFormalSaveWith(
    saveSpec:   StrategySpec,
    saveResult: BacktestResultState,
  ) {
    setStep("saving");
    setShowFailedWarning(false);

    const rawPrompt = `[ENTRY]\n${input.entry}\n\n[TAKE_PROFIT]\n${input.takeProfit}\n\n[STOP_LOSS]\n${input.stopLoss}`;

    try {
      const res  = await fetch("/api/strategies", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          spec:         saveSpec,
          raw_prompt:   rawPrompt,
          previewBacktestData: {
            report:   saveResult.report,
            trades:   saveResult.trades,
            barCount: saveResult.barCount,
          },
        }),
      });
      const data = await res.json() as { strategy?: StrategyRecord; error?: string };

      if (!data.strategy) {
        setError(data.error ?? "保存に失敗しました");
        setStep("result");
        return;
      }

      setStep("done");
      toast.success(`「${saveSpec.name}」をEAに追加しました`);
      onSaved(data.strategy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存エラー");
      setStep("result");
    }
  }

  // ── 正式保存（State から呼び出す版） ────────────────────────────

  async function handleFormalSave() {
    if (!spec || !backtestResult) return;
    await handleFormalSaveWith(spec, backtestResult);
  }

  function handleClose() {
    setStep("input");
    setInput(EMPTY_INPUT);
    setSpec(null);
    setBacktestResult(null);
    setHasUnsupported(false);
    setUnsupportedList([]);
    setShowFailedWarning(false);
    setError(null);
    onClose();
  }

  function handleBack() {
    setStep("input");
    setError(null);
    setShowFailedWarning(false);
  }

  // ── ヘッダーラベル ────────────────────────────────────────────────
  function stepBadge() {
    if (step === "generating")  return "AI設計中...";
    if (step === "backtesting") return "バックテスト実行中...";
    if (step === "result")      return "結果";
    if (step === "saving")      return "保存中...";
    return null;
  }

  // =================================================================
  // レンダリング
  // =================================================================
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(4,6,13,0.92)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="relative w-full max-w-xl max-h-[92vh] flex flex-col overflow-hidden rounded-lg font-mono"
        style={{
          background: "#080e1a",
          border:     `1px solid ${NG_rgba}0.20)`,
          boxShadow:  `0 0 60px ${NG_rgba}0.06), 0 0 120px rgba(0,0,0,0.8)`,
        }}
      >
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${NG_rgba}0.10)` }}
        >
          <div className="flex items-center gap-3">
            <span className="text-[10px] tracking-[0.3em] font-black" style={{ color: NG }}>
              AI EA BUILDER
            </span>
            {stepBadge() && (
              <span
                className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}
              >
                {stepBadge()}
              </span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="text-[16px] leading-none transition-opacity hover:opacity-60"
            style={{ color: "#4b5563" }}
          >
            ×
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* ─── INPUT ─── */}
          {(step === "input" || step === "generating") && (
            <div className="flex flex-col gap-5">

              <InputSection
                label="エントリー条件"
                sublabel="ENTRY CONDITIONS"
                accentColor={NG}
                description="シンボル・時間足・売買条件・フィルターを自然言語で入力"
                placeholder={"例：EURUSDのM5。\nH1の価格がEMA21より上で上昇トレンド。\nM5のRSIが30以下から上向きに反転したらBUY。\nロンドン時間はエントリーしない。スプレッド2pips以下。"}
                value={input.entry}
                onChange={v => setInput(p => ({ ...p, entry: v }))}
                disabled={step === "generating"}
                minLength={10}
                rows={5}
              />

              <InputSection
                label="利確条件"
                sublabel="TAKE PROFIT"
                accentColor={NG}
                description="利益確定する条件を自然言語で入力"
                placeholder={"例：ATR14の3倍で利確。\nまたは直近高値に到達したら利確。"}
                value={input.takeProfit}
                onChange={v => setInput(p => ({ ...p, takeProfit: v }))}
                disabled={step === "generating"}
                minLength={3}
                rows={3}
              />

              <InputSection
                label="損切り条件"
                sublabel="STOP LOSS"
                accentColor={RED}
                description="損切りする条件を自然言語で入力"
                placeholder={"例：ATR14の2倍で損切り。\nまたは直近安値を下抜けたら損切り。"}
                value={input.stopLoss}
                onChange={v => setInput(p => ({ ...p, stopLoss: v }))}
                disabled={step === "generating"}
                minLength={3}
                rows={3}
              />

              {error && (
                <div className="text-[10px] leading-relaxed px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}>
                  ⚠ {error}
                </div>
              )}

              {step === "input" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[9px] tracking-widest" style={{ color: "#334155" }}>
                    例文（クリックで3欄に入力）
                  </p>
                  {EXAMPLES.map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => setInput(ex)}
                      className="text-left text-[9px] leading-relaxed px-3 py-2 rounded transition-all hover:opacity-80"
                      style={{ background: "rgba(0,229,255,0.04)", border: "1px solid rgba(0,229,255,0.10)", color: "#64748b" }}
                    >
                      <span className="text-[7px] tracking-widest" style={{ color: CYAN }}>ENTRY</span>{" "}
                      {ex.entry.length > 55 ? ex.entry.slice(0, 55) + "…" : ex.entry}
                    </button>
                  ))}
                </div>
              )}

              {step === "generating" && <LoadingDots label="AI が Strategy を設計しています..." />}
            </div>
          )}

          {/* ─── BACKTESTING ─── */}
          {step === "backtesting" && (
            <div className="flex flex-col gap-4">
              {/* 完了ステップ */}
              <div
                className="flex items-center gap-3 px-3 py-2.5 rounded"
                style={{ background: `${NG}08`, border: `1px solid ${NG}20` }}
              >
                <span className="text-[14px]" style={{ color: NG }}>✓</span>
                <div>
                  <p className="text-[10px] font-black tracking-widest" style={{ color: NG }}>
                    Strategy Spec 生成完了
                  </p>
                  <p className="text-[9px]" style={{ color: "#64748b" }}>{spec?.name}</p>
                </div>
              </div>

              {/* バックテスト実行中 */}
              <LoadingDots label="過去データでバックテスト実行中..." sub="実際の市場データで性能を検証しています" />
            </div>
          )}

          {/* ─── RESULT ─── */}
          {step === "result" && spec && (
            <div className="flex flex-col gap-5">

              {/* Strategy名 + タイプ */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[13px] font-black tracking-wider" style={{ color: "#f0f9ff" }}>
                    {spec.name}
                  </span>
                  <span
                    className="text-[8px] font-black tracking-widest px-2 py-0.5 rounded"
                    style={{ background: `${CYAN}15`, border: `1px solid ${CYAN}30`, color: CYAN }}
                  >
                    {typeLabel(spec.strategy_type)}
                  </span>
                </div>
                {spec.description && (
                  <p className="text-[9px] leading-relaxed" style={{ color: "#64748b" }}>
                    {spec.description}
                  </p>
                )}
              </div>

              {/* ── ENTRY CONDITIONS ── */}
              <PreviewSection title="ENTRY CONDITIONS" accentColor={NG}>
                <div className="flex gap-6 mb-3">
                  <div>
                    <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>SYMBOL</p>
                    <div className="flex flex-wrap gap-1">
                      {spec.symbols.map(s => <Tag key={s} color={NG}>{s}</Tag>)}
                    </div>
                  </div>
                  <div>
                    <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>TIMEFRAME</p>
                    <div className="flex flex-wrap gap-1">
                      {spec.timeframes.map(t => <Tag key={t} color={CYAN}>{t}</Tag>)}
                    </div>
                  </div>
                </div>

                <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>
                  CONDITIONS — {spec.entry_conditions.logic}
                </p>
                <div className="flex flex-col gap-1 mb-3">
                  {spec.entry_conditions.conditions.map((c, i) => {
                    const isUnsup = c.condition?.startsWith("UNSUPPORTED:");
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-[8px] mt-0.5 shrink-0" style={{ color: isUnsup ? AMBER : NG }}>
                          {isUnsup ? "⚠" : "●"}
                        </span>
                        {isUnsup ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px]" style={{ color: AMBER }}>
                              {c.condition!.replace("UNSUPPORTED:", "").trim()}
                            </span>
                            <span
                              className="text-[7px] tracking-widest px-1.5 py-0.5 rounded shrink-0"
                              style={{ background: `${AMBER}15`, border: `1px solid ${AMBER}30`, color: AMBER }}
                            >
                              REQUIRES EXTENSION
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px]" style={{ color: "#94a3b8" }}>
                            {conditionToJapanese(c)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {spec.filters && (
                  <>
                    <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>FILTERS</p>
                    {spec.filters.max_spread_pips !== undefined && (
                      <FilterRow icon="SPREAD">最大 {spec.filters.max_spread_pips} pips</FilterRow>
                    )}
                    {spec.filters.sessions && spec.filters.sessions.length > 0 && (
                      <FilterRow icon="SESSION">{spec.filters.sessions.map(sessionLabel).join(" / ")}</FilterRow>
                    )}
                    {spec.filters.trend_filter && (
                      <FilterRow icon="TREND">
                        {spec.filters.trend_filter.timeframe}{" "}
                        {spec.filters.trend_filter.indicator}
                        {spec.filters.trend_filter.period ? `(${spec.filters.trend_filter.period})` : ""}{" "}
                        {spec.filters.trend_filter.direction === "BULLISH" ? "↗ 上昇" : "↘ 下降"}
                      </FilterRow>
                    )}
                    {spec.filters.trend_filters?.map((tf, i) => (
                      <FilterRow key={`tf-${i}`} icon="TREND">
                        {tf.timeframe} {tf.indicator}{tf.period ? `(${tf.period})` : ""}{" "}
                        {tf.direction === "BULLISH" ? "↗ 上昇" : "↘ 下降"}
                      </FilterRow>
                    ))}
                    {spec.filters.min_adx !== undefined && (
                      <FilterRow icon="ADX">ADX &gt; {spec.filters.min_adx}</FilterRow>
                    )}
                  </>
                )}
              </PreviewSection>

              {/* ── TAKE PROFIT ── */}
              <PreviewSection title="TAKE PROFIT" accentColor={NG}>
                {spec.exit_conditions?.take_profit ? (
                  <p className="text-[11px]" style={{ color: "#94a3b8" }}>
                    {tpToJapanese(spec.exit_conditions.take_profit)}
                  </p>
                ) : (
                  <p className="text-[10px]" style={{ color: AMBER }}>⚠ 利確条件なし</p>
                )}
              </PreviewSection>

              {/* ── STOP LOSS ── */}
              <PreviewSection title="STOP LOSS" accentColor={RED}>
                {spec.exit_conditions?.stop_loss ? (
                  <p className="text-[11px]" style={{ color: "#94a3b8" }}>
                    {slToJapanese(spec.exit_conditions.stop_loss)}
                  </p>
                ) : (
                  <p className="text-[10px]" style={{ color: RED }}>⚠ 損切り条件なし</p>
                )}
              </PreviewSection>

              {/* ── UNSUPPORTED エラー ── */}
              {hasUnsupported && (
                <div
                  className="px-4 py-3 rounded flex flex-col gap-2"
                  style={{ background: `${AMBER}08`, border: `1px solid ${AMBER}25` }}
                >
                  <p className="text-[10px] font-black tracking-widest" style={{ color: AMBER }}>
                    ⚠ この条件は現在 AVL-FX で検証できません
                  </p>
                  <p className="text-[9px] leading-relaxed" style={{ color: "#64748b" }}>
                    バックテスト未対応の条件が含まれています。エントリー条件を修正してください。
                  </p>
                  {unsupportedList.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                      {unsupportedList.map((u, i) => (
                        <li key={i} className="text-[9px]" style={{ color: AMBER }}>
                          • {u}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* ── BACKTEST RESULT ── */}
              {backtestResult && (
                <div className="flex flex-col gap-3">
                  {/* セクションヘッダー + Verdict */}
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.06)" }} />
                    <span className="text-[8px] tracking-[0.3em] font-black" style={{ color: "#475569" }}>
                      バックテスト結果
                    </span>
                    <span
                      className="text-[8px] font-black tracking-widest px-2 py-0.5 rounded"
                      style={{
                        color:       verdictColor(backtestResult.report.verdict),
                        background:  `${verdictColor(backtestResult.report.verdict)}15`,
                        border:      `1px solid ${verdictColor(backtestResult.report.verdict)}35`,
                      }}
                    >
                      {verdictLabel(backtestResult.report.verdict)}
                    </span>
                    <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.06)" }} />
                  </div>

                  {/* データ期間 */}
                  <p className="text-[9px] text-center" style={{ color: "#334155" }}>
                    {spec.symbols[0]} {spec.timeframes[0]} ·{" "}
                    {Math.round(backtestResult.report.dataCoverageDays)}日間 ·{" "}
                    {backtestResult.barCount.toLocaleString()} bars
                  </p>

                  {/* Total Pips（大きく表示） */}
                  <div
                    className="px-4 py-3 rounded text-center"
                    style={{
                      background: `${pipsColor(backtestResult.report.totalPips)}06`,
                      border:     `1px solid ${pipsColor(backtestResult.report.totalPips)}20`,
                    }}
                  >
                    <p className="text-[8px] tracking-widest mb-1" style={{ color: "#334155" }}>
                      合計 PIPS
                    </p>
                    <p
                      className="text-[28px] font-black leading-none"
                      style={{
                        color:      pipsColor(backtestResult.report.totalPips),
                        textShadow: `0 0 16px ${pipsColor(backtestResult.report.totalPips)}50`,
                      }}
                    >
                      {backtestResult.report.totalPips >= 0 ? "+" : ""}
                      {backtestResult.report.totalPips.toFixed(1)}
                    </p>
                  </div>

                  {/* Stats グリッド */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { label: "取引数",   value: String(backtestResult.report.totalTrades), color: "#94a3b8" },
                      { label: "勝ち",     value: String(backtestResult.report.wins),         color: NG        },
                      { label: "負け",     value: String(backtestResult.report.losses),       color: RED       },
                      {
                        label: "勝率",
                        value: `${backtestResult.report.winRate.toFixed(1)}%`,
                        color: backtestResult.report.winRate >= 55 ? NG : backtestResult.report.winRate >= 50 ? AMBER : RED,
                      },
                      {
                        label: "PF",
                        value: backtestResult.report.profitFactor != null ? backtestResult.report.profitFactor.toFixed(2) : "∞",
                        color: (backtestResult.report.profitFactor ?? 0) >= 1.2 ? NG : (backtestResult.report.profitFactor ?? 0) >= 1 ? AMBER : RED,
                      },
                      {
                        label: "最大DD",
                        value: `${backtestResult.report.maxDrawdownPct.toFixed(1)}%`,
                        color: backtestResult.report.maxDrawdownPct < 10 ? NG : backtestResult.report.maxDrawdownPct < 20 ? AMBER : RED,
                      },
                      {
                        label: "平均PIPS",
                        value: `${backtestResult.report.avgPips >= 0 ? "+" : ""}${backtestResult.report.avgPips.toFixed(1)}`,
                        color: pipsColor(backtestResult.report.avgPips),
                      },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="px-2 py-1.5 rounded"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
                        <p className="text-[6px] font-mono tracking-widest" style={{ color: "#334155" }}>{label}</p>
                        <p className="text-[10px] font-mono font-bold mt-0.5" style={{ color }}>{value}</p>
                      </div>
                    ))}
                  </div>

                  {/* BUY / SELL 方向別 */}
                  {backtestResult.directionBreakdown && (
                    backtestResult.directionBreakdown.buy.trades > 0 || backtestResult.directionBreakdown.sell.trades > 0
                  ) && (
                    <div className="grid grid-cols-2 gap-2">
                      {(["buy", "sell"] as const).map(dir => {
                        const d = backtestResult.directionBreakdown[dir];
                        return (
                          <div key={dir} className="px-2.5 py-2 rounded"
                            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                            <p className="text-[7px] tracking-widest font-black mb-1.5"
                              style={{ color: dir === "buy" ? NG : RED }}>
                              {dir === "buy" ? "BUY / LONG" : "SELL / SHORT"}
                            </p>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[9px]" style={{ color: "#64748b" }}>
                                {d.trades} trades · {d.winRate.toFixed(0)}% WR
                              </span>
                              <span className="text-[10px] font-bold"
                                style={{ color: pipsColor(d.pips) }}>
                                {d.pips >= 0 ? "+" : ""}{d.pips.toFixed(1)} pips
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* セッション別 */}
                  {backtestResult.report.sessionStats &&
                   Object.keys(backtestResult.report.sessionStats).length > 0 && (
                    <div>
                      <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>
                        セッション別
                      </p>
                      <div className="flex flex-col gap-1">
                        {Object.entries(backtestResult.report.sessionStats)
                          .sort((a, b) => b[1].totalPips - a[1].totalPips)
                          .slice(0, 4)
                          .map(([sess, stat]) => (
                            <div key={sess} className="flex items-center gap-2">
                              <span className="text-[8px] w-16 shrink-0" style={{ color: "#475569" }}>
                                {sessionLabel(sess)}
                              </span>
                              <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                                <div className="h-full rounded-full"
                                  style={{ width: `${Math.min(stat.winRate, 100)}%`, background: NG_rgba + "0.5)" }} />
                              </div>
                              <span className="text-[8px] w-8 text-right shrink-0" style={{ color: NG }}>
                                {stat.winRate.toFixed(0)}%
                              </span>
                              <span className="text-[8px] w-14 text-right shrink-0"
                                style={{ color: pipsColor(stat.totalPips) }}>
                                {stat.totalPips >= 0 ? "+" : ""}{stat.totalPips.toFixed(1)}p
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Sample Size Warning */}
                  {backtestResult.report.sampleSizeWarning && (
                    <div className="px-3 py-2 rounded text-[9px] leading-relaxed"
                      style={{ background: `${AMBER}08`, border: `1px solid ${AMBER}20`, color: AMBER }}>
                      ⚠ サンプル数が少なすぎます（{backtestResult.report.totalTrades}件 / 推奨{backtestResult.report.minRecommendedTrades}件以上）。結果の信頼性が低い可能性があります。
                    </div>
                  )}

                  {/* Verdict reason */}
                  {backtestResult.report.verdictReason && (
                    <p className="text-[9px] leading-relaxed px-3 py-2 rounded"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", color: "#475569" }}>
                      {backtestResult.report.verdictReason}
                    </p>
                  )}
                </div>
              )}

              {/* RISK */}
              <div className="flex items-center gap-3">
                <p className="text-[8px] tracking-[0.2em] font-black w-20 shrink-0" style={{ color: "#334155" }}>
                  リスク
                </p>
                <span className="text-[11px]" style={{ color: AMBER }}>
                  {spec.risk.risk_per_trade}% / トレード
                </span>
              </div>

              {error && (
                <div className="text-[10px] px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}>
                  ⚠ {error}
                </div>
              )}
            </div>
          )}

          {/* ─── SAVING ─── */}
          {step === "saving" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <LoadingDots label="EA を登録しています..." sub="バックテスト結果と一緒に保存中" />
            </div>
          )}

          {/* ─── DONE ─── */}
          {step === "done" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div
                className="text-[32px] font-black tracking-widest"
                style={{ color: NG, textShadow: `0 0 20px ${NG}` }}
              >
                ✓
              </div>
              <p className="text-[13px] font-black tracking-[0.2em]" style={{ color: "#f0f9ff" }}>
                EA 追加完了
              </p>
              <p className="text-[10px]" style={{ color: "#64748b" }}>
                EA コマンドセンターに追加されました
              </p>
              <button
                onClick={handleClose}
                className="mt-2 text-[10px] tracking-widest font-bold px-4 py-2 rounded transition-opacity hover:opacity-70"
                style={{ background: `${NG_rgba}0.12)`, border: `1px solid ${NG_rgba}0.30)`, color: NG }}
              >
                閉じる
              </button>
            </div>
          )}
        </div>

        {/* ─── フッター ─── */}
        {step !== "done" && step !== "saving" && (
          <div
            className="shrink-0 px-5 py-3"
            style={{ borderTop: `1px solid ${NG_rgba}0.08)` }}
          >
            {/* INPUT フッター */}
            {step === "input" && (
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleClose}
                  className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                  style={{ color: "#4b5563" }}
                >
                  キャンセル
                </button>
                <button
                  onClick={handleBuild}
                  disabled={!isReady}
                  className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                  style={{
                    background: `${NG_rgba}0.14)`,
                    border:     `1px solid ${NG_rgba}0.35)`,
                    color:      NG,
                    boxShadow:  isReady ? `0 0 12px ${NG_rgba}0.15)` : "none",
                  }}
                >
                  ▶ AI で設計する
                </button>
              </div>
            )}

            {/* GENERATING / BACKTESTING フッター */}
            {(step === "generating" || step === "backtesting") && (
              <div className="flex justify-center">
                <span className="text-[9px] tracking-widest" style={{ color: "#334155" }}>処理中...</span>
              </div>
            )}

            {/* RESULT フッター */}
            {step === "result" && (
              showFailedWarning ? (
                /* FAILED 警告確認 */
                <div className="flex flex-col gap-2">
                  <div
                    className="px-3 py-2 rounded text-[9px] leading-relaxed"
                    style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}
                  >
                    ⚠ バックテスト基準未達のStrategyです。それでも追加しますか？
                  </div>
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowFailedWarning(false)}
                      className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                      style={{ color: "#64748b", border: "1px solid #1e293b" }}
                    >
                      ← 追加しない
                    </button>
                    <button
                      onClick={handleFormalSave}
                      className="text-[10px] font-black tracking-widest px-4 py-1.5 rounded transition-all hover:opacity-80"
                      style={{ background: `${RED}14`, border: `1px solid ${RED}35`, color: RED }}
                    >
                      それでも追加する
                    </button>
                  </div>
                </div>
              ) : hasUnsupported ? (
                /* UNSUPPORTED: 修正するのみ */
                <div className="flex items-center justify-between">
                  <button
                    onClick={handleBack}
                    className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                    style={{ color: "#64748b", border: "1px solid #1e293b" }}
                  >
                    ← 修正する
                  </button>
                  <span className="text-[9px]" style={{ color: "#334155" }}>
                    条件を修正後に再設計してください
                  </span>
                </div>
              ) : (
                /* 通常: キャンセル / AI分析 / EAを追加する */
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={handleClose}
                      className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                      style={{ color: "#4b5563" }}
                    >
                      キャンセル
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleBack}
                        className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60"
                        style={{ color: "#64748b", border: "1px solid #1e293b" }}
                      >
                        ← 修正する
                      </button>
                      <button
                        onClick={handleEAAdd}
                        className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80"
                        style={{
                          background: `${NG_rgba}0.14)`,
                          border:     `1px solid ${NG_rgba}0.35)`,
                          color:      NG,
                          boxShadow:  `0 0 12px ${NG_rgba}0.15)`,
                        }}
                      >
                        EA を追加する
                      </button>
                    </div>
                  </div>
                  {backtestResult && (
                    <div className="flex justify-center">
                      <button
                        onClick={() => setShowResearchAssistant(true)}
                        className="text-[9px] tracking-widest px-4 py-1.5 rounded transition-all hover:opacity-80"
                        style={{
                          background: "rgba(0,229,255,0.06)",
                          border:     "1px solid rgba(0,229,255,0.18)",
                          color:      CYAN,
                        }}
                      >
                        AI戦略アシスタントで分析・改善
                      </button>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1.2); }
        }
      `}</style>

      {/* ── AI戦略アシスタント（フルスクリーンモーダル） ── */}
      {showResearchAssistant && spec && backtestResult && (
        <StrategyResearchAssistant
          spec={spec}
          initialBacktestResult={backtestResult}
          onAddEA={(finalSpec, finalResult) => {
            setShowResearchAssistant(false);
            // 承認されたSpecとBacktestResultを直接パラメータとして正式保存
            void handleFormalSaveWith(finalSpec as StrategySpec, finalResult);
          }}
          onDiscard={() => setShowResearchAssistant(false)}
        />
      )}
    </div>
  );
}

// =================================================================
// 小コンポーネント
// =================================================================

interface InputSectionProps {
  label:       string;
  sublabel:    string;
  accentColor: string;
  description: string;
  placeholder: string;
  value:       string;
  onChange:    (v: string) => void;
  disabled:    boolean;
  minLength:   number;
  rows:        number;
}

function InputSection({
  label, sublabel, accentColor, description,
  placeholder, value, onChange, disabled, minLength, rows,
}: InputSectionProps) {
  const filled   = value.trim().length >= minLength;
  const tooShort = value.trim().length > 0 && !filled;

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] tracking-[0.15em] font-black" style={{ color: accentColor }}>
          {label}
        </span>
        <span className="text-[7px] tracking-widest" style={{ color: "#334155" }}>{sublabel}</span>
        <span className="text-[7px] tracking-widest ml-auto" style={{ color: accentColor, opacity: 0.55 }}>
          必須
        </span>
      </div>
      <p className="text-[9px] mb-1.5 tracking-wide" style={{ color: "#334155" }}>{description}</p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded resize-none text-[11px] leading-relaxed tracking-wide outline-none transition-all"
        style={{
          background:  disabled ? "rgba(0,255,136,0.02)" : "#0a1120",
          border:      disabled ? `1px solid ${accentColor}12` : filled ? `1px solid ${accentColor}30` : "1px solid rgba(71,85,105,0.35)",
          color:       disabled ? "#334155" : "#cbd5e1",
          padding:     "10px 12px",
          caretColor:  accentColor,
        }}
      />
      {tooShort && (
        <p className="text-[8px] mt-1" style={{ color: "#475569" }}>{minLength}文字以上入力してください</p>
      )}
    </div>
  );
}

interface PreviewSectionProps {
  title:       string;
  accentColor: string;
  children:    React.ReactNode;
}

function PreviewSection({ title, accentColor, children }: PreviewSectionProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px flex-1" style={{ background: `${accentColor}18` }} />
        <span className="text-[8px] tracking-[0.3em] font-black px-2" style={{ color: accentColor }}>
          {title}
        </span>
        <div className="h-px flex-1" style={{ background: `${accentColor}18` }} />
      </div>
      <div className="rounded px-3 py-3" style={{ background: `${accentColor}03`, border: `1px solid ${accentColor}10` }}>
        {children}
      </div>
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="text-[9px] font-black tracking-widest px-2 py-0.5 rounded"
      style={{ background: `${color}12`, border: `1px solid ${color}30`, color }}
    >
      {children}
    </span>
  );
}

function FilterRow({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-0.5">
      <span className="text-[7px] tracking-widest w-14 shrink-0" style={{ color: "#334155" }}>{icon}</span>
      <span className="text-[10px]" style={{ color: "#64748b" }}>{children}</span>
    </div>
  );
}

function LoadingDots({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <div className="flex gap-1.5">
        {[0,1,2,3].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full"
            style={{ background: NG, animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`, boxShadow: `0 0 6px ${NG}` }} />
        ))}
      </div>
      <p className="text-[10px] tracking-[0.2em]" style={{ color: NG }}>{label}</p>
      {sub && <p className="text-[9px]" style={{ color: "#334155" }}>{sub}</p>}
    </div>
  );
}
