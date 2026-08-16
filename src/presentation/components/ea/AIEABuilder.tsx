"use client";

// =================================================================
// AIEABuilder — AI EA Builder ダイアログ
//
// フロー: INPUT → GENERATING → PREVIEW → SAVING → DONE
// デザイン: 既存 NEON GREEN / BLACK / GLASS UI に統一
// =================================================================

import { useState, useRef }  from "react";
import { toast }              from "sonner";
import {
  conditionToJapanese,
  type StrategySpec,
  type StrategyRecord,
} from "@/lib/strategySchema";

// ── カラー定数（EACommandCenter と統一）──────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";
const DARK    = "#04060d";

// ── ステップ型 ─────────────────────────────────────────────────────
type Step = "input" | "generating" | "preview" | "saving" | "done";

// ── プロンプト例 ────────────────────────────────────────────────────
const EXAMPLES = [
  "EURUSDのM5でRSIスキャルピング。RSI30以下から反転したらBUY。H1がEMA21より上の時だけ。スプレッド2pips以下。",
  "USDJPYのH1でEMAトレンドフォロー。EMA21がEMA200を上抜けたらBUY。ADXが25以上の時のみ。ロンドン・NY時間限定。",
  "GOLDのH4でスイングトレード。市場構造が上昇トレンドで、RSIが50付近から反発したらBUY。ATRでSLを設定。",
];

// ── Props ─────────────────────────────────────────────────────────
interface Props {
  open:    boolean;
  onClose: () => void;
  onSaved: (strategy: StrategyRecord) => void;
}

// ── Strategy Type ラベル ──────────────────────────────────────────
function typeLabel(t: string) {
  if (t === "SCALPING")  return "スキャルピング";
  if (t === "DAY_TRADE") return "デイトレード";
  if (t === "SWING")     return "スイング";
  return t;
}

// ── Session ラベル ────────────────────────────────────────────────
function sessionLabel(s: string) {
  if (s === "TOKYO")    return "東京";
  if (s === "LONDON")   return "ロンドン";
  if (s === "NEW_YORK") return "NY";
  if (s === "SYDNEY")   return "シドニー";
  return s;
}

// =================================================================
// メインコンポーネント
// =================================================================

export function AIEABuilder({ open, onClose, onSaved }: Props) {
  const [step,   setStep]   = useState<Step>("input");
  const [prompt, setPrompt] = useState("");
  const [spec,   setSpec]   = useState<StrategySpec | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  if (!open) return null;

  // ── ハンドラ ────────────────────────────────────────────────────

  async function handleBuild() {
    if (prompt.trim().length < 10) {
      toast.error("10文字以上入力してください");
      return;
    }
    setError(null);
    setStep("generating");

    try {
      const res  = await fetch("/api/ai/strategy/build", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json() as {
        success: boolean;
        spec?: StrategySpec;
        error?: string;
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

    try {
      const res  = await fetch("/api/strategies", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spec, raw_prompt: prompt }),
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
    setPrompt("");
    setSpec(null);
    setError(null);
    onClose();
  }

  // ── レンダリング ────────────────────────────────────────────────
  return (
    // オーバーレイ
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(4,6,13,0.92)", backdropFilter: "blur(6px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* モーダル本体 */}
      <div
        className="relative w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden rounded-lg font-mono"
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

          {/* ─── INPUT ─── */}
          {(step === "input" || step === "generating") && (
            <div className="flex flex-col gap-4">

              <div>
                <p className="text-[11px] tracking-[0.15em] mb-1" style={{ color: "#94a3b8" }}>
                  どんな EA を作りますか？
                </p>
                <p className="text-[9px] tracking-[0.1em]" style={{ color: "#334155" }}>
                  自然言語でトレード条件を説明してください
                </p>
              </div>

              <textarea
                ref={textRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                disabled={step === "generating"}
                rows={7}
                placeholder={"例：EURUSDのM5でRSIスキャルピング。\nRSI30以下から反転したらBUY。\nH1がEMA21より上の時だけエントリー。\nATRでSL、直近高値でTP。\nロンドン・NY時間のみ。スプレッド2pips以下。"}
                className="w-full rounded resize-none text-[11px] leading-relaxed tracking-wide outline-none transition-all"
                style={{
                  background: step === "generating" ? "rgba(0,255,136,0.02)" : "#0a1120",
                  border:     step === "generating"
                    ? `1px solid ${NG_rgba}0.20)`
                    : `1px solid rgba(71,85,105,0.4)`,
                  color:      step === "generating" ? "#334155" : "#cbd5e1",
                  padding:    "12px",
                  caretColor: NG,
                }}
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

              {/* プロンプト例 */}
              {step === "input" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[9px] tracking-widest" style={{ color: "#334155" }}>
                    例文（クリックで入力）
                  </p>
                  {EXAMPLES.map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => { setPrompt(ex); textRef.current?.focus(); }}
                      className="text-left text-[9px] leading-relaxed px-3 py-2 rounded transition-all hover:opacity-80"
                      style={{
                        background: "rgba(0,229,255,0.04)",
                        border:     "1px solid rgba(0,229,255,0.10)",
                        color:      "#64748b",
                      }}
                    >
                      {ex}
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

          {/* ─── PREVIEW ─── */}
          {(step === "preview" || step === "saving") && spec && (
            <div className="flex flex-col gap-4">

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

              {/* シンボル / 時間足 */}
              <Row label="SYMBOL">
                <div className="flex flex-wrap gap-1">
                  {spec.symbols.map(s => (
                    <Tag key={s} color={NG}>{s}</Tag>
                  ))}
                </div>
              </Row>

              <Row label="TIMEFRAME">
                <div className="flex flex-wrap gap-1">
                  {spec.timeframes.map(t => (
                    <Tag key={t} color={CYAN}>{t}</Tag>
                  ))}
                </div>
              </Row>

              {/* エントリー条件 */}
              <div>
                <Label>ENTRY CONDITIONS</Label>
                <div
                  className="rounded px-3 py-2 flex flex-col gap-1.5 mt-1"
                  style={{ background: "rgba(0,255,136,0.03)", border: `1px solid ${NG_rgba}0.10)` }}
                >
                  <p className="text-[8px] tracking-widest mb-1" style={{ color: "#334155" }}>
                    LOGIC: {spec.entry_conditions.logic}
                  </p>
                  {spec.entry_conditions.conditions.map((c, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span style={{ color: NG }} className="text-[8px] mt-0.5">●</span>
                      <span className="text-[10px]" style={{ color: "#94a3b8" }}>
                        {conditionToJapanese(c)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* フィルター */}
              {spec.filters && (
                <div>
                  <Label>FILTERS</Label>
                  <div className="flex flex-col gap-1 mt-1">
                    {spec.filters.max_spread_pips !== undefined && (
                      <FilterRow icon="SPREAD">
                        最大 {spec.filters.max_spread_pips} pips
                      </FilterRow>
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
                    {spec.filters.min_adx !== undefined && (
                      <FilterRow icon="ADX">
                        ADX &gt; {spec.filters.min_adx}
                      </FilterRow>
                    )}
                  </div>
                </div>
              )}

              {/* EXIT */}
              {spec.exit_conditions && (
                <div>
                  <Label>EXIT CONDITIONS</Label>
                  <div className="flex gap-4 mt-1">
                    {spec.exit_conditions.stop_loss && (
                      <div>
                        <p className="text-[8px] tracking-widest mb-0.5" style={{ color: RED }}>
                          STOP LOSS
                        </p>
                        <p className="text-[10px]" style={{ color: "#94a3b8" }}>
                          {spec.exit_conditions.stop_loss.method}
                          {spec.exit_conditions.stop_loss.multiplier
                            ? ` × ${spec.exit_conditions.stop_loss.multiplier}`
                            : ""}
                          {spec.exit_conditions.stop_loss.pips
                            ? ` ${spec.exit_conditions.stop_loss.pips} pips`
                            : ""}
                        </p>
                      </div>
                    )}
                    {spec.exit_conditions.take_profit && (
                      <div>
                        <p className="text-[8px] tracking-widest mb-0.5" style={{ color: NG }}>
                          TAKE PROFIT
                        </p>
                        <p className="text-[10px]" style={{ color: "#94a3b8" }}>
                          {spec.exit_conditions.take_profit.method}
                          {spec.exit_conditions.take_profit.rr_ratio
                            ? ` RR ${spec.exit_conditions.take_profit.rr_ratio}`
                            : ""}
                          {spec.exit_conditions.take_profit.pips
                            ? ` ${spec.exit_conditions.take_profit.pips} pips`
                            : ""}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* リスク */}
              <Row label="RISK">
                <span style={{ color: AMBER }}>
                  {spec.risk.risk_per_trade}% / トレード
                </span>
              </Row>

              {/* ステータス */}
              <div
                className="flex items-center gap-3 px-3 py-2 rounded"
                style={{ background: `${AMBER}08`, border: `1px solid ${AMBER}20` }}
              >
                <span className="text-[9px] tracking-widest font-black" style={{ color: AMBER }}>
                  DRAFT
                </span>
                <span className="text-[9px]" style={{ color: "#64748b" }}>
                  バックテスト: 未実施 — Phase 2 で実装予定
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
                  disabled={prompt.trim().length < 10}
                  className="text-[10px] font-black tracking-widest px-5 py-2 rounded transition-all hover:opacity-80 disabled:opacity-30"
                  style={{
                    background: `${NG_rgba}0.14)`,
                    border:     `1px solid ${NG_rgba}0.35)`,
                    color:      NG,
                    boxShadow:  prompt.trim().length >= 10 ? `0 0 12px ${NG_rgba}0.15)` : "none",
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
                  onClick={() => { setStep("input"); setError(null); }}
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

// ── 小コンポーネント ──────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[8px] tracking-[0.25em] font-black mb-0" style={{ color: "#334155" }}>
      {children}
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <p className="text-[8px] tracking-[0.2em] font-black w-20 shrink-0 mt-0.5" style={{ color: "#334155" }}>
        {label}
      </p>
      <div className="text-[11px]" style={{ color: "#94a3b8" }}>{children}</div>
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
    <div className="flex items-center gap-2">
      <span className="text-[7px] tracking-widest w-14 shrink-0" style={{ color: "#334155" }}>
        {icon}
      </span>
      <span className="text-[10px]" style={{ color: "#64748b" }}>{children}</span>
    </div>
  );
}
