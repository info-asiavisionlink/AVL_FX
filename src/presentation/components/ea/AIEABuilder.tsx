"use client";

// =================================================================
// AIEABuilder — AI EA Builder ダイアログ
//
// フロー: INPUT → GENERATING → PREVIEW → SAVING → DONE
// 入力: ENTRY / TAKE PROFIT / STOP LOSS を3欄に分離
// デザイン: Neon GREEN / BLACK / GLASS UI
// =================================================================

import { useState } from "react";
import { toast }    from "sonner";
import {
  conditionToJapanese,
  type StrategySpec,
  type StrategyRecord,
} from "@/lib/strategySchema";

// ── カラー定数 ─────────────────────────────────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";

// ── 型定義 ────────────────────────────────────────────────────────
type Step = "input" | "generating" | "preview" | "saving" | "done";

interface InputState {
  entry:      string;
  takeProfit: string;
  stopLoss:   string;
}

const EMPTY_INPUT: InputState = { entry: "", takeProfit: "", stopLoss: "" };

// ── 例文 — 3欄フォーマット ─────────────────────────────────────────
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

// =================================================================
// メインコンポーネント
// =================================================================

export function AIEABuilder({ open, onClose, onSaved }: Props) {
  const [step,  setStep]  = useState<Step>("input");
  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const [spec,  setSpec]  = useState<StrategySpec | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const isReady =
    input.entry.trim().length >= 10 &&
    input.takeProfit.trim().length >= 3 &&
    input.stopLoss.trim().length >= 3;

  // ── ハンドラ ────────────────────────────────────────────────────

  async function handleBuild() {
    if (!isReady) return;
    setError(null);
    setStep("generating");

    try {
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

      setSpec(data.spec);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ネットワークエラー");
      setStep("input");
    }
  }

  async function handleSave() {
    if (!spec) return;
    setStep("saving");

    // raw_prompt に3入力内容を [ENTRY] / [TAKE_PROFIT] / [STOP_LOSS] 形式で保存
    const rawPrompt = `[ENTRY]\n${input.entry}\n\n[TAKE_PROFIT]\n${input.takeProfit}\n\n[STOP_LOSS]\n${input.stopLoss}`;

    try {
      const res  = await fetch("/api/strategies", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spec, raw_prompt: rawPrompt }),
      });
      const data = await res.json() as { strategy?: StrategyRecord; error?: string };

      if (!data.strategy) {
        setError(data.error ?? "保存に失敗しました");
        setStep("preview");
        return;
      }

      setStep("done");
      toast.success(`「${spec.name}」を登録しました`);
      onSaved(data.strategy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存エラー");
      setStep("preview");
    }
  }

  function handleClose() {
    setStep("input");
    setInput(EMPTY_INPUT);
    setSpec(null);
    setError(null);
    onClose();
  }

  function handleBack() {
    setStep("input");
    setError(null);
    // input は保持したまま
  }

  // ── レンダリング ────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(4,6,13,0.92)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* モーダル本体 */}
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
            {step !== "input" && step !== "done" && (
              <span
                className="text-[8px] tracking-widest px-2 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}
              >
                {step === "generating" ? "生成中..." : step === "preview" ? "PREVIEW" : "保存中..."}
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

          {/* ─── INPUT / GENERATING ─── */}
          {(step === "input" || step === "generating") && (
            <div className="flex flex-col gap-5">

              {/* ENTRY CONDITIONS */}
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

              {/* TAKE PROFIT */}
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

              {/* STOP LOSS */}
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

              {/* エラー表示 */}
              {error && (
                <div
                  className="text-[10px] leading-relaxed px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}
                >
                  ⚠ {error}
                </div>
              )}

              {/* 例文ボタン */}
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
                      style={{
                        background: "rgba(0,229,255,0.04)",
                        border:     "1px solid rgba(0,229,255,0.10)",
                        color:      "#64748b",
                      }}
                    >
                      <span className="text-[7px] tracking-widest" style={{ color: CYAN }}>ENTRY</span>{" "}
                      {ex.entry.length > 55 ? ex.entry.slice(0, 55) + "…" : ex.entry}
                    </button>
                  ))}
                </div>
              )}

              {/* 生成中アニメーション */}
              {step === "generating" && (
                <div className="flex flex-col items-center gap-3 py-4">
                  <div className="flex gap-1.5">
                    {[0,1,2,3].map(i => (
                      <div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          background: NG,
                          animation:  `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                          boxShadow:  `0 0 6px ${NG}`,
                        }}
                      />
                    ))}
                  </div>
                  <p className="text-[10px] tracking-[0.2em]" style={{ color: NG }}>
                    AI が Strategy を設計しています...
                  </p>
                  <p className="text-[9px]" style={{ color: "#334155" }}>
                    通常 5〜15 秒かかります
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ─── PREVIEW / SAVING ─── */}
          {(step === "preview" || step === "saving") && spec && (
            <div className="flex flex-col gap-5">

              {/* 名前 + タイプ */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[14px] font-black tracking-wider" style={{ color: "#f0f9ff" }}>
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
                  <p className="text-[10px] leading-relaxed" style={{ color: "#64748b" }}>
                    {spec.description}
                  </p>
                )}
              </div>

              {/* ── ENTRY CONDITIONS ── */}
              <PreviewSection title="ENTRY CONDITIONS" accentColor={NG}>

                {/* Symbol / Timeframe */}
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

                {/* エントリー条件 */}
                <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>
                  CONDITIONS — {spec.entry_conditions.logic}
                </p>
                <div className="flex flex-col gap-1 mb-3">
                  {spec.entry_conditions.conditions.map((c, i) => {
                    const isUnsupported = c.condition?.startsWith("UNSUPPORTED:");
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-[8px] mt-0.5 shrink-0" style={{ color: isUnsupported ? AMBER : NG }}>
                          {isUnsupported ? "⚠" : "●"}
                        </span>
                        {isUnsupported ? (
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

                {/* フィルター */}
                {spec.filters && (
                  <>
                    <p className="text-[7px] tracking-widest mb-1.5" style={{ color: "#334155" }}>FILTERS</p>
                    {spec.filters.max_spread_pips !== undefined && (
                      <FilterRow icon="SPREAD">最大 {spec.filters.max_spread_pips} pips</FilterRow>
                    )}
                    {spec.filters.sessions && spec.filters.sessions.length > 0 && (
                      <FilterRow icon="SESSION">
                        {spec.filters.sessions.map(sessionLabel).join(" / ")}
                      </FilterRow>
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
                        {tf.timeframe} {tf.indicator}
                        {tf.period ? `(${tf.period})` : ""}{" "}
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
                  <p className="text-[10px]" style={{ color: AMBER }}>
                    ⚠ 利確条件が生成されませんでした — 修正してください
                  </p>
                )}
              </PreviewSection>

              {/* ── STOP LOSS ── */}
              <PreviewSection title="STOP LOSS" accentColor={RED}>
                {spec.exit_conditions?.stop_loss ? (
                  <p className="text-[11px]" style={{ color: "#94a3b8" }}>
                    {slToJapanese(spec.exit_conditions.stop_loss)}
                  </p>
                ) : (
                  <p className="text-[10px]" style={{ color: RED }}>
                    ⚠ 損切り条件が生成されませんでした — 修正してください
                  </p>
                )}
              </PreviewSection>

              {/* リスク */}
              <div className="flex items-center gap-3">
                <p className="text-[8px] tracking-[0.2em] font-black w-20 shrink-0" style={{ color: "#334155" }}>
                  RISK
                </p>
                <span className="text-[11px]" style={{ color: AMBER }}>
                  {spec.risk.risk_per_trade}% / トレード
                </span>
              </div>

              {/* DRAFT ステータス */}
              <div
                className="flex items-center gap-3 px-3 py-2 rounded"
                style={{ background: `${AMBER}08`, border: `1px solid ${AMBER}20` }}
              >
                <span className="text-[9px] tracking-widest font-black" style={{ color: AMBER }}>
                  DRAFT
                </span>
                <span className="text-[9px]" style={{ color: "#64748b" }}>
                  バックテスト未実施 — 保存後に実行できます
                </span>
              </div>

              {error && (
                <div
                  className="text-[10px] px-3 py-2 rounded"
                  style={{ background: `${RED}10`, border: `1px solid ${RED}30`, color: RED }}
                >
                  ⚠ {error}
                </div>
              )}
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
                登録完了
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

        {/* フッター: アクションボタン */}
        {step !== "done" && (
          <div
            className="flex items-center justify-between px-5 py-3 gap-3 shrink-0"
            style={{ borderTop: `1px solid ${NG_rgba}0.08)` }}
          >
            {step === "input" && (
              <>
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
              </>
            )}

            {step === "generating" && (
              <div className="flex-1 flex justify-center">
                <span className="text-[9px] tracking-widest" style={{ color: "#334155" }}>
                  処理中...
                </span>
              </div>
            )}

            {(step === "preview" || step === "saving") && (
              <>
                <button
                  onClick={handleBack}
                  disabled={step === "saving"}
                  className="text-[10px] tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-60 disabled:opacity-30"
                  style={{ color: "#64748b", border: "1px solid #1e293b" }}
                >
                  ← 修正する
                </button>
                <button
                  onClick={handleSave}
                  disabled={step === "saving"}
                  className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                  style={{
                    background: `${NG_rgba}0.14)`,
                    border:     `1px solid ${NG_rgba}0.35)`,
                    color:      NG,
                    boxShadow:  `0 0 12px ${NG_rgba}0.15)`,
                  }}
                >
                  {step === "saving" ? "保存中..." : "保存して登録"}
                </button>
              </>
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
        <span className="text-[7px] tracking-widest" style={{ color: "#334155" }}>
          {sublabel}
        </span>
        <span className="text-[7px] tracking-widest ml-auto" style={{ color: accentColor, opacity: 0.55 }}>
          必須
        </span>
      </div>
      <p className="text-[9px] mb-1.5 tracking-wide" style={{ color: "#334155" }}>
        {description}
      </p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded resize-none text-[11px] leading-relaxed tracking-wide outline-none transition-all"
        style={{
          background:  disabled ? "rgba(0,255,136,0.02)" : "#0a1120",
          border:      disabled
            ? `1px solid ${accentColor}12`
            : filled
            ? `1px solid ${accentColor}30`
            : "1px solid rgba(71,85,105,0.35)",
          color:       disabled ? "#334155" : "#cbd5e1",
          padding:     "10px 12px",
          caretColor:  accentColor,
        }}
      />
      {tooShort && (
        <p className="text-[8px] mt-1" style={{ color: "#475569" }}>
          {minLength}文字以上入力してください
        </p>
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
      <div
        className="rounded px-3 py-3"
        style={{ background: `${accentColor}03`, border: `1px solid ${accentColor}10` }}
      >
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
      <span className="text-[7px] tracking-widest w-14 shrink-0" style={{ color: "#334155" }}>
        {icon}
      </span>
      <span className="text-[10px]" style={{ color: "#64748b" }}>{children}</span>
    </div>
  );
}
