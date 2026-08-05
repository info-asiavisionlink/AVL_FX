"use client";

// =================================================================
// AVL AI OS — Settings Page (Full)
// AI 設定 / リスク管理 / 外部データ / 通知 / UI
// =================================================================

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore, type AVLSettings } from "@/application/stores/settingsStore";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { STORAGE_KEY_MT5_CONFIG } from "@/infrastructure/connection/types";
import {
  Brain, Shield, Wifi, Bell, Monitor, Trash2, Save, Eye, EyeOff, RefreshCw, MessageSquare,
} from "lucide-react";

// -----------------------------------------------------------------
// セクション共通ヘッダー
// -----------------------------------------------------------------
function SectionHeader({ icon: Icon, title, desc }: { icon: typeof Brain; title: string; desc?: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="w-7 h-7 border border-cyan-700/40 bg-cyan-900/20 flex items-center justify-center shrink-0 mt-0.5">
        <Icon size={13} className="text-cyan-400" />
      </div>
      <div>
        <h3 className="text-[10px] text-white font-mono font-semibold tracking-wider">{title}</h3>
        {desc && <p className="text-[8px] text-gray-600 font-mono mt-0.5">{desc}</p>}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// 入力フィールド
// -----------------------------------------------------------------
function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-[#0d1520] last:border-0">
      <div className="min-w-0">
        <p className="text-[9px] text-gray-300 font-mono">{label}</p>
        {desc && <p className="text-[7px] text-gray-700 font-mono mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder, password }: {
  value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex items-center">
      <input
        type={password && !show ? "password" : "text"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-48 bg-[#060a12] border border-[#0d1520] text-gray-300 text-[9px] font-mono px-2 py-1 focus:outline-none focus:border-cyan-700/50"
      />
      {password && (
        <button type="button" onClick={() => setShow(s => !s)} className="absolute right-1.5 text-gray-600 hover:text-gray-400">
          {show ? <EyeOff size={10} /> : <Eye size={10} />}
        </button>
      )}
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <input
      type="number" value={value} min={min} max={max} step={step ?? 0.01}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      className="w-24 bg-[#060a12] border border-[#0d1520] text-gray-300 text-[9px] font-mono px-2 py-1 text-right focus:outline-none focus:border-cyan-700/50"
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={cn("w-9 h-5 rounded-full relative transition-all shrink-0",
        value ? "bg-cyan-600/70" : "bg-[#1a2535]"
      )}
    >
      <div className={cn("absolute top-0.5 w-4 h-4 rounded-full transition-all",
        value ? "left-[18px] bg-cyan-300" : "left-0.5 bg-gray-600"
      )} />
    </button>
  );
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value} onChange={e => onChange(e.target.value)}
      className="w-48 bg-[#060a12] border border-[#0d1520] text-gray-300 text-[9px] font-mono px-2 py-1 focus:outline-none focus:border-cyan-700/50"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// -----------------------------------------------------------------
// メインコンポーネント
// -----------------------------------------------------------------
export function SettingsPage() {
  const { settings, set, reset } = useSettingsStore();
  const { disconnect }           = useConnectionStore();
  const [saved, setSaved]        = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const s = (patch: Partial<AVLSettings>) => { set(patch); setSaved(false); };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    if (!confirmReset) { setConfirmReset(true); return; }
    disconnect();
    localStorage.removeItem(STORAGE_KEY_MT5_CONFIG);
    reset();
    setConfirmReset(false);
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#0d1520] shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">AVL AI OS — SETTINGS</span>
        </div>
        <button onClick={handleSave}
          className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[8px] font-mono border transition-all",
            saved ? "border-green-600/50 text-green-300 bg-green-900/20" : "border-cyan-700/40 text-cyan-400 hover:bg-cyan-900/20"
          )}>
          <Save size={10} />
          {saved ? "保存済み ✓" : "保存"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* === システムプロンプト === */}
          <div className="border border-cyan-700/30 bg-[#060a12] p-4">
            <SectionHeader icon={MessageSquare} title="AI PERSONA" desc="AIの人格・話し方・あなたの呼び名を設定" />

            <Field label="あなたの呼び名" desc="AIがあなたを何と呼ぶか（例: ボス、さん付け、名前）">
              <input
                type="text"
                value={settings.operatorName}
                onChange={e => s({ operatorName: e.target.value || "ボス" })}
                placeholder="ボス"
                maxLength={20}
                className="w-full bg-[#04060d] border border-[#0d1520] px-3 py-1.5 text-[9px] font-mono text-cyan-300 outline-none focus:border-cyan-700/60 transition-colors"
              />
            </Field>

            <Field label="話し方スタイル" desc="AIの応答スタイルを選択">
              <SelectInput value={settings.aiPersonality} onChange={v => s({ aiPersonality: v as AVLSettings["aiPersonality"] })}
                options={[
                  { value: "professional", label: "プロフェッショナル — 冷静・断定的・簡潔（デフォルト）" },
                  { value: "friendly",     label: "フレンドリー — 親しみやすく、励ましも入れる" },
                  { value: "concise",      label: "超簡潔 — 数字と方向だけ、説明なし" },
                  { value: "custom",       label: "カスタム — 下のプロンプトで自由に設定" },
                ]}
              />
            </Field>

            <Field label="応答言語" desc="AIが話す言語">
              <SelectInput value={settings.responseLanguage} onChange={v => s({ responseLanguage: v as AVLSettings["responseLanguage"] })}
                options={[
                  { value: "ja",    label: "日本語" },
                  { value: "en",    label: "English" },
                  { value: "ja_en", label: "日本語 + English（バイリンガル）" },
                ]}
              />
            </Field>

            <Field label="追加システムプロンプト" desc="AIへの追加指示。スタイルが「カスタム」の場合はここで全て定義">
              <textarea
                value={settings.customSystemPrompt}
                onChange={e => s({ customSystemPrompt: e.target.value })}
                placeholder={"例：\n・返答は必ず箇条書きにする\n・エントリー提案時は必ずリスクを先に伝える\n・毎回最後に「ご確認ください」と付け加える"}
                rows={5}
                className="w-full bg-[#04060d] border border-[#0d1520] px-3 py-2 text-[9px] font-mono text-cyan-300 outline-none focus:border-cyan-700/60 transition-colors resize-none placeholder-gray-700 leading-relaxed"
              />
            </Field>

            {/* Preview */}
            <div className="mt-3 p-3 border border-cyan-900/20 bg-[#02040a]">
              <p className="text-[7px] text-gray-700 font-mono mb-1.5 tracking-wider">— プレビュー —</p>
              <p className="text-[8.5px] font-mono text-cyan-300/80 leading-relaxed">
                {settings.aiPersonality === "professional" &&
                  `「分析完了です、${settings.operatorName}。EURUSDのバイ、エントリー1.15300、損切り1.14800、勝率82%。H4上昇トレンド継続。」`}
                {settings.aiPersonality === "friendly" &&
                  `「${settings.operatorName}、いいチャンス見つけましたよ！EURUSDのバイです。エントリー1.15300、損切り1.14800で、勝率82%があります！」`}
                {settings.aiPersonality === "concise" &&
                  `「EURUSD BUY 1.15300 / SL 1.14800 / TP 1.15800 / 82%」`}
                {settings.aiPersonality === "custom" &&
                  (settings.customSystemPrompt
                    ? `カスタムプロンプト設定済み (${settings.customSystemPrompt.length}文字)`
                    : "カスタムプロンプトを入力してください")}
              </p>
            </div>
          </div>

          {/* === AI 設定 === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={Brain} title="AI ENGINE" desc="AVL AI が使用するモデル設定" />
            <Field label="Chat モデル" desc="市場分析・テキスト応答に使用">
              <SelectInput value={settings.aiModel} onChange={v => s({ aiModel: v })}
                options={[
                  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra — バランス (推奨)" },
                  { value: "gpt-5.6-sol",   label: "GPT-5.6 Sol — 最高性能" },
                  { value: "gpt-5.6-luna",  label: "GPT-5.6 Luna — 高速・低コスト" },
                  { value: "gpt-4.1",       label: "GPT-4.1 — 旧モデル" },
                ]}
              />
            </Field>
            <Field label="Voice モデル" desc="音声会話に使用">
              <SelectInput value={settings.realtimeModel} onChange={v => s({ realtimeModel: v })}
                options={[
                  { value: "gpt-realtime-2.1-mini", label: "gpt-realtime-2.1-mini — 推奨 (高速)" },
                  { value: "gpt-realtime-2.1",      label: "gpt-realtime-2.1 — 高性能 (低速)" },
                  { value: "gpt-4o-realtime-preview", label: "gpt-4o-realtime-preview — 旧モデル" },
                ]}
              />
            </Field>
            <Field label="Temperature" desc="0.1 (厳密) ～ 1.0 (創造的)">
              <div className="flex items-center gap-2">
                <input type="range" min={0.1} max={1.0} step={0.1} value={settings.aiTemperature}
                  onChange={e => s({ aiTemperature: parseFloat(e.target.value) })}
                  className="w-32 accent-cyan-500" />
                <span className="text-[9px] text-cyan-400 font-mono w-8">{settings.aiTemperature.toFixed(1)}</span>
              </div>
            </Field>
          </div>

          {/* === リスク管理 === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={Shield} title="RISK MANAGEMENT" desc="取引リスクの上限設定" />
            <Field label="デフォルトロット数" desc="AI が注文する際のデフォルト量">
              <NumberInput value={settings.defaultLotSize} onChange={v => s({ defaultLotSize: v })} min={0.01} max={10} step={0.01} />
            </Field>
            <Field label="最大日次損失 (%)" desc="この割合を超えたら自動停止">
              <NumberInput value={settings.maxDailyLossPct} onChange={v => s({ maxDailyLossPct: v })} min={0.1} max={20} step={0.1} />
            </Field>
            <Field label="最大同時ポジション数">
              <NumberInput value={settings.maxPositions} onChange={v => s({ maxPositions: Math.round(v) })} min={1} max={20} step={1} />
            </Field>
            <Field label="損失上限で自動停止" desc="日次損失上限に達したらAIを停止">
              <Toggle value={settings.stopOnLoss} onChange={v => s({ stopOnLoss: v })} />
            </Field>
          </div>

          {/* === 外部データ (Twelve Data) === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={Wifi} title="EXTERNAL MARKET DATA" desc="Twelve Data API — 外部市場データ（DXY, VIX, US30 等）" />
            <Field label="Twelve Data API Key" desc="twelvedata.com で取得">
              <TextInput
                value={settings.twelveDataKey}
                onChange={v => s({ twelveDataKey: v })}
                placeholder="your_api_key"
                password
              />
            </Field>
            <div className="mt-2 text-[7px] text-gray-700 font-mono">
              API キーなしでもデモデータで動作します。本番データには無料プランで月500リクエスト利用可能です。
            </div>
          </div>

          {/* === 通知 === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={Bell} title="NOTIFICATIONS" />
            <Field label="シグナル通知" desc="EMAクロス・トレンドアラインを通知">
              <Toggle value={settings.notifySignals} onChange={v => s({ notifySignals: v })} />
            </Field>
            <Field label="注文通知" desc="AI が注文提案・実行時に通知">
              <Toggle value={settings.notifyOrders} onChange={v => s({ notifyOrders: v })} />
            </Field>
            <Field label="Spread 警告" desc="スプレッドが閾値を超えたら通知">
              <Toggle value={settings.notifyWarnSpread} onChange={v => s({ notifyWarnSpread: v })} />
            </Field>
            <Field label="Spread 警告閾値 (pips)">
              <NumberInput value={settings.spreadWarnPips} onChange={v => s({ spreadWarnPips: v })} min={1} max={50} step={0.5} />
            </Field>
          </div>

          {/* === UI === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={Monitor} title="UI / DISPLAY" />
            <Field label="レーダーサイズ">
              <SelectInput value={settings.radarSize} onChange={v => s({ radarSize: v as AVLSettings["radarSize"] })}
                options={[
                  { value: "sm", label: "Small" },
                  { value: "md", label: "Medium (推奨)" },
                  { value: "lg", label: "Large" },
                ]}
              />
            </Field>
            <Field label="資産スパークライン" desc="アカウントパネルに資産推移グラフを表示">
              <Toggle value={settings.showSparkline} onChange={v => s({ showSparkline: v })} />
            </Field>
          </div>

          {/* === アプリ情報 === */}
          <div className="border border-[#0d1520] bg-[#060a12] p-4">
            <SectionHeader icon={RefreshCw} title="SYSTEM" />
            <div className="space-y-1 mb-4">
              {[
                ["App",     "AVL AI Trading Operating System"],
                ["Version", "v3.0 — Phase 3"],
                ["Engine",  "Next.js 16 + @openai/agents 0.14"],
                ["EA",      "AVL_FX_Bridge v3.10"],
                ["Gateway", "AVL Market Server v3.0"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-[8px] font-mono">
                  <span className="text-gray-700">{k}</span>
                  <span className="text-gray-400">{v}</span>
                </div>
              ))}
            </div>
            <button onClick={handleReset}
              className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[8px] font-mono border transition-all",
                confirmReset
                  ? "border-red-700/50 text-red-300 bg-red-900/20 hover:bg-red-900/40"
                  : "border-[#0d1520] text-gray-600 hover:text-gray-400 hover:border-gray-700"
              )}>
              <Trash2 size={10} />
              {confirmReset ? "本当にリセットしますか？（もう一度クリック）" : "全設定をリセット"}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
