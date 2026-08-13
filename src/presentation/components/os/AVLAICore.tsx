"use client";

// =================================================================
// AVL AI CORE v3.0 — Neon White + Red Multi-Ring HUD
// Visual Ref: Military-grade AI OS / JARVIS-style interface
// Tech: SVG rings + GSAP 3 + CSS bloom filters
// =================================================================

import { useEffect, useRef, useCallback } from "react";
import gsap from "gsap";

interface Props {
  brainState: string;
  voiceStatus: string;
  isActive: boolean;
  isThinking: boolean;
  neonHex: string;
  onVoiceToggle?: () => void;
  isVoiceConnecting?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Color constants
// ─────────────────────────────────────────────────────────────────
const NW  = "#ffffff";   // neon white
const NR  = "#ff1c1c";   // neon red
const DR  = "#880808";   // dark red
const DW  = "#777777";   // dim white
const MR  = "#cc1111";   // mid red

// ─────────────────────────────────────────────────────────────────
// Ring definitions
// Each ring: { r, isWhite, strokeWidth, dashArray, baseRpm, cw }
// dashArray: "TICKS" = generate individual tick lines
// ─────────────────────────────────────────────────────────────────
interface RingDef {
  r: number; white: boolean; sw: number;
  da: string; rpm: number; cw: boolean;
  opacity: number;
}

const RINGS: RingDef[] = [
  // outer → inner
  { r:292, white:true,  sw:1.8, da:"266 40 266 40 266 40 266 40 266 38 266 38", rpm:0.7,  cw:true,  opacity:0.85 }, // 0 white 6-arc outer
  { r:272, white:false, sw:1.0, da:"13 8",                 rpm:1.6,  cw:false, opacity:0.70 }, // 1 red ~81-seg
  { r:252, white:true,  sw:3.0, da:"346 50 346 46 346 50 346 46", rpm:2.0,  cw:true,  opacity:0.92 }, // 2 white 4-arc MAJOR
  { r:234, white:false, sw:0.0, da:"TICKS",                rpm:2.8,  cw:false, opacity:0.75 }, // 3 tick ring (144本)
  { r:215, white:true,  sw:1.2, da:"22 17",                rpm:2.2,  cw:true,  opacity:0.80 }, // 4 white HUD-seg ~34-seg
  { r:196, white:false, sw:1.0, da:"14 8",                 rpm:3.5,  cw:false, opacity:0.68 }, // 5 red ~56-seg
  { r:176, white:true,  sw:2.4, da:"110 24 110 24 110 24 110 24 110 24 110 24 110 24 110 24", rpm:4.2, cw:true, opacity:0.88 }, // 6 white 8-arc
  { r:156, white:false, sw:0.8, da:"8 6",                  rpm:5.2,  cw:false, opacity:0.65 }, // 7 red ~70-seg
  { r:132, white:true,  sw:2.8, da:"169 38 169 38 169 38 169 38", rpm:3.8,  cw:true,  opacity:0.90 }, // 8 white 4-arc MAJOR inner
  { r:110, white:false, sw:0.0, da:"TICKS48",              rpm:6.5,  cw:false, opacity:0.72 }, // 9 inner tick ring (96本)
  { r: 90, white:true,  sw:1.6, da:"244 38 244 38",        rpm:5.0,  cw:true,  opacity:0.85 }, // 10 white 2-arc energy
  { r: 70, white:false, sw:1.2, da:"11 7",                 rpm:4.0,  cw:false, opacity:0.72 }, // 11 red ~24-seg inner core
];

// ─────────────────────────────────────────────────────────────────
// Speed multipliers per state (uniform for all rings)
// ─────────────────────────────────────────────────────────────────
const STATE_MULT: Record<string, number> = {
  standby:   0.18,
  scanning:  1.00,
  analyzing: 2.80,
  reasoning: 1.90,
  listening: 0.55,
  speaking:  0.90,
};

const STATE_ENERGY: Record<string, number> = {
  standby:   0.25,
  scanning:  0.58,
  analyzing: 0.95,
  reasoning: 0.82,
  listening: 0.45,
  speaking:  0.72,
};

// ─────────────────────────────────────────────────────────────────
// Tick ring generator (JSX)
// ─────────────────────────────────────────────────────────────────
function TickMarks({ r, count, majorEvery = 6 }: { r: number; count: number; majorEvery?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const isMajor = i % majorEvery === 0;
        const angle = ((i / count) * 360 - 90) * (Math.PI / 180);
        const rOuter = r;
        const rInner = isMajor ? r - 14 : r - 7;
        return (
          <line key={i}
            x1={rOuter * Math.cos(angle)} y1={rOuter * Math.sin(angle)}
            x2={rInner * Math.cos(angle)} y2={rInner * Math.sin(angle)}
            stroke={isMajor ? NW : MR}
            strokeWidth={isMajor ? 1.5 : 0.6}
            opacity={isMajor ? 0.95 : 0.45}
          />
        );
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// Segment burst ring (analyzing/reasoning state)
// ─────────────────────────────────────────────────────────────────
function SegmentBurst({ r1, r2, count }: { r1: number; r2: number; count: number }) {
  const segs = Array.from({ length: count }, (_, i) => {
    const span = 360 / count;
    const a0 = (i * span - 90) * (Math.PI / 180);
    const a1 = ((i * span + span * 0.7) - 90) * (Math.PI / 180);
    const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    const isWhiteSeg = i % 3 === 0;
    return (
      <path key={i}
        d={`M ${r1*cos0} ${r1*sin0} L ${r2*cos0} ${r2*sin0} A ${r2} ${r2} 0 0 1 ${r2*cos1} ${r2*sin1} L ${r1*cos1} ${r1*sin1} A ${r1} ${r1} 0 0 0 ${r1*cos0} ${r1*sin0} Z`}
        fill={isWhiteSeg ? NW : NR}
        opacity="0"
        data-seg-idx={i}
      />
    );
  });
  return <>{segs}</>;
}

// ─────────────────────────────────────────────────────────────────
// HUD data panels (4 cardinal positions)
// ─────────────────────────────────────────────────────────────────
function HUDPanel({ x, y, deg, bright }: { x: number; y: number; deg: number; bright: boolean }) {
  return (
    <g transform={`translate(${x}, ${y}) rotate(${deg})`} opacity={bright ? 0.75 : 0.45}>
      <rect x="-16" y="-5" width="32" height="10" fill="none" stroke={NR} strokeWidth="0.8"/>
      <rect x="-12" y="-3" width="8"  height="6" fill={DR}  opacity="0.8"/>
      <rect x="-2"  y="-3" width="3"  height="6" fill={NW}  opacity="0.3"/>
      <rect x="3"   y="-3" width="6"  height="6" fill={DR}  opacity="0.6"/>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────
export function AVLAICore({ brainState, voiceStatus, isActive, isThinking, onVoiceToggle, isVoiceConnecting }: Props) {
  const svgRef    = useRef<SVGSVGElement>(null);
  const ringRefs  = useRef<(SVGGElement | null)[]>([]);
  const coreRef   = useRef<SVGGElement>(null);
  const scanRef   = useRef<SVGCircleElement>(null);
  const segsRef   = useRef<SVGGElement>(null);
  const textRef   = useRef<HTMLDivElement>(null);
  const labelRef  = useRef<SVGTextElement>(null);

  // Track angle per ring
  const angles    = useRef<number[]>(RINGS.map(() => 0));
  const rotTweens = useRef<(gsap.core.Tween | null)[]>(RINGS.map(() => null));
  const stateTl   = useRef<gsap.core.Timeline | null>(null);
  const segTweens = useRef<gsap.core.Tween[]>([]);

  // ── Single ring rotation ─────────────────────────────────────
  const spinRing = useCallback((idx: number, mult: number) => {
    rotTweens.current[idx]?.kill();
    const def  = RINGS[idx];
    const rpm  = def.rpm * mult * (def.cw ? 1 : -1);
    if (Math.abs(rpm) < 0.001) return;

    const dps  = rpm * 6;
    const big  = dps > 0 ? 360000 : -360000;
    const obj  = { a: angles.current[idx] };

    rotTweens.current[idx] = gsap.to(obj, {
      a: obj.a + big,
      duration: Math.abs(big / dps),
      ease: "none",
      repeat: -1,
      onUpdate: () => {
        angles.current[idx] = obj.a;
        const el = ringRefs.current[idx];
        if (el) el.setAttribute("transform", `rotate(${obj.a % 360})`);
      },
    });
  }, []);

  // ── Kill all segment flash tweens ────────────────────────────
  const killSegTweens = useCallback(() => {
    segTweens.current.forEach(t => t.kill());
    segTweens.current = [];
  }, []);

  // ── Apply AI state ───────────────────────────────────────────
  const applyState = useCallback((state: string) => {
    const mult   = STATE_MULT[state] ?? STATE_MULT.standby;
    const energy = STATE_ENERGY[state] ?? STATE_ENERGY.standby;

    RINGS.forEach((_, i) => spinRing(i, mult));

    stateTl.current?.kill();
    stateTl.current = gsap.timeline();
    killSegTweens();

    // Ring opacity driven by energy
    RINGS.forEach((_, i) => {
      const el = ringRefs.current[i];
      if (!el) return;
      const base = RINGS[i].opacity;
      stateTl.current!.to(el, {
        opacity: base * (0.4 + energy * 0.65),
        duration: 1.0,
        ease: "power2.out",
      }, 0);
    });

    // Scan wave
    if (scanRef.current) {
      if (state === "scanning") {
        stateTl.current.fromTo(scanRef.current,
          { attr: { r: 290 }, opacity: 0.85 },
          { attr: { r: 48 }, opacity: 0, duration: 2.2, ease: "power1.in", repeat: -1 },
          0
        );
      } else {
        gsap.to(scanRef.current, { opacity: 0, duration: 0.4 });
      }
    }

    // Segment burst (analyzing / reasoning)
    if (segsRef.current) {
      const kids = Array.from(segsRef.current.children) as SVGElement[];
      if (state === "analyzing" || state === "reasoning") {
        kids.forEach((el, i) => {
          const t = gsap.to(el, {
            opacity: 0.55 + Math.random() * 0.4,
            duration: 0.1 + Math.random() * 0.2,
            repeat: -1,
            yoyo: true,
            delay: i * 0.055,
            ease: "steps(1)",
          });
          segTweens.current.push(t);
        });
      } else {
        kids.forEach(el => {
          gsap.to(el, { opacity: 0, duration: 0.5 });
        });
      }
    }

    // State label update
    if (labelRef.current) {
      const labels: Record<string, string> = {
        standby:   "STANDBY",
        scanning:  "SCANNING",
        analyzing: "ANALYZING",
        reasoning: "REASONING",
        listening: "LISTENING",
        speaking:  "SPEAKING",
      };
      labelRef.current.textContent = labels[state] ?? "STANDBY";
    }
  }, [spinRing, killSegTweens]);

  // ── Core pulse removed — opacity animation caused red ring to appear
  //    to scale up/down due to bloom filter blur expanding with opacity

  // ── Voice → text glow ────────────────────────────────────────
  useEffect(() => {
    if (!textRef.current) return;
    if (voiceStatus === "speaking") {
      gsap.to(textRef.current, {
        opacity: 0.6,
        duration: 0.3,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
    } else {
      gsap.killTweensOf(textRef.current);
      gsap.to(textRef.current, { opacity: 1, duration: 0.5 });
    }
  }, [voiceStatus]);

  // ── State change ─────────────────────────────────────────────
  useEffect(() => {
    applyState(brainState);
  }, [brainState, applyState]);

  // ── Mount: boot animation + cleanup ─────────────────────────
  useEffect(() => {
    if (!svgRef.current) return;
    gsap.fromTo(svgRef.current,
      { opacity: 0, scale: 0.82 },
      { opacity: 1, scale: 1, duration: 2.2, ease: "power2.out" }
    );
    applyState("standby");

    return () => {
      rotTweens.current.forEach(t => t?.kill());
      stateTl.current?.kill();
      killSegTweens();
      [svgRef, textRef, coreRef, scanRef].forEach(r => {
        if (r.current) gsap.killTweensOf(r.current);
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cardinal HUD positions ───────────────────────────────────
  const hudPanels = [0, 90, 180, 270].map((deg, i) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    const r   = 215;
    return { x: r * Math.cos(rad), y: r * Math.sin(rad), deg, bright: i < 2 };
  });

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  const isVoiceActive = voiceStatus !== "idle" && voiceStatus !== "connecting";

  return (
    <div
      className="absolute inset-0 select-none flex items-center justify-center"
      style={{ zIndex: 12, pointerEvents: "none" }}
    >
      <svg
        ref={svgRef}
        viewBox="-320 -320 640 640"
        style={{
          position: "absolute",
          width:  "min(84vh, 98vw)",
          height: "min(84vh, 98vw)",
          overflow: "visible",
          willChange: "transform, opacity",
        }}
        aria-hidden
      >
        <defs>
          {/* White bloom glow — strong */}
          <filter id="avl-wglow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4"  result="b1"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="b2"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="22" result="b3"/>
            <feMerge>
              <feMergeNode in="b3"/>
              <feMergeNode in="b2"/>
              <feMergeNode in="b1"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Red glow — strong */}
          <filter id="avl-rglow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4"  result="b1"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="b2"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="20" result="b3"/>
            <feMerge>
              <feMergeNode in="b3"/>
              <feMergeNode in="b2"/>
              <feMergeNode in="b1"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Core bloom — very strong */}
          <filter id="avl-coreglow" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6"  result="b1"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="b2"/>
            <feGaussianBlur in="SourceGraphic" stdDeviation="28" result="b3"/>
            <feMerge>
              <feMergeNode in="b3"/>
              <feMergeNode in="b2"/>
              <feMergeNode in="b1"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Ambient radial gradient — strong red */}
          <radialGradient id="avl-ambient" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={NR} stopOpacity="0.30"/>
            <stop offset="40%"  stopColor={NR} stopOpacity="0.12"/>
            <stop offset="100%" stopColor="#000" stopOpacity="0"/>
          </radialGradient>

          {/* Center void — black tunnel */}
          <radialGradient id="avl-void" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#000" stopOpacity="0.95"/>
            <stop offset="60%"  stopColor="#1a0000" stopOpacity="0.60"/>
            <stop offset="100%" stopColor="#000" stopOpacity="0"/>
          </radialGradient>
        </defs>

        {/* Ambient glow background */}
        <circle r="310" fill="url(#avl-ambient)"/>

        {/* Center black void — tunnel depth */}
        <circle r="68" fill="url(#avl-void)"/>

        {/* ── ROTATING RINGS ─────────────────────────────────── */}
        {RINGS.map((ring, i) => (
          <g
            key={i}
            ref={el => { ringRefs.current[i] = el; }}
            opacity={ring.opacity * 0.92}
            filter={ring.white ? "url(#avl-wglow)" : "url(#avl-rglow)"}
          >
            {ring.da === "TICKS" ? (
              <TickMarks r={ring.r} count={144} majorEvery={12}/>
            ) : ring.da === "TICKS48" ? (
              <TickMarks r={ring.r} count={96} majorEvery={8}/>
            ) : (
              <circle
                r={ring.r}
                fill="none"
                stroke={ring.white ? NW : NR}
                strokeWidth={ring.sw}
                strokeDasharray={ring.da}
                strokeLinecap="round"
              />
            )}
          </g>
        ))}

        {/* ── HUD DATA PANELS ─────────────────────────────────── */}
        {hudPanels.map((p, i) => (
          <HUDPanel key={i} {...p} />
        ))}

        {/* ── SECONDARY HUD: small cross-markers on outer ring ── */}
        {[45, 135, 225, 315].map((deg, i) => {
          const a = ((deg - 90) * Math.PI) / 180;
          const r = 292;
          const x = r * Math.cos(a), y = r * Math.sin(a);
          return (
            <g key={i} transform={`translate(${x},${y})`} opacity="0.35" stroke={DW} strokeWidth="0.8">
              <line x1="-6" y1="0" x2="6" y2="0"/>
              <line x1="0" y1="-6" x2="0" y2="6"/>
            </g>
          );
        })}

        {/* scan wave: removed */}

        {/* ── SEGMENT BURST (analyzing/reasoning) ─────────────── */}
        <g ref={segsRef}>
          <SegmentBurst r1={198} r2={216} count={16}/>
        </g>

        {/* ── CORE GROUP ─────────────────────────────────────── */}
        <g ref={coreRef} opacity="0.92">
          {/* Core rings */}
          <circle r="54" fill="none" stroke={NW} strokeWidth="2.2"
            filter="url(#avl-wglow)" opacity="0.95"/>
          <circle r="44" fill="none" stroke={NR} strokeWidth="1.4"
            strokeDasharray="18 9"
            filter="url(#avl-rglow)" opacity="0.90"/>
          <circle r="36" fill="none" stroke={NW} strokeWidth="0.9"
            opacity="0.75"/>
          <circle r="28" fill="none" stroke={DR} strokeWidth="0.7"
            strokeDasharray="6 10" opacity="0.60"/>

          {/* Core fill */}
          <circle r="24" fill={NR} fillOpacity="0.05"/>
          <circle r="16" fill={NW} fillOpacity="0.03"/>

          {/* Center dot cluster */}
          <circle r="4.5" fill={NR} filter="url(#avl-rglow)" opacity="0.9"/>
          <circle r="2.5" fill={NW} filter="url(#avl-wglow)" opacity="1.0"/>
          <circle r="1.2" fill={NW} opacity="1.0"/>
        </g>

        {/* ── CORNER BRACKETS ────────────────────────────────── */}
        {([ [-1,-1],[1,-1],[1,1],[-1,1] ] as const).map(([sx,sy], i) => {
          const bx = sx * 310, by = sy * 310;
          const L = 18;
          return (
            <g key={i} stroke={NR} strokeWidth="1.1" opacity="0.45"
              filter="url(#avl-rglow)">
              <line x1={bx} y1={by} x2={bx - sx*L} y2={by}/>
              <line x1={bx} y1={by} x2={bx} y2={by - sy*L}/>
            </g>
          );
        })}

        {/* ── STATE LABEL (top arc position) ──────────────────── */}
        <text
          ref={labelRef}
          x="0" y="-310"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="7.5"
          fontFamily="monospace"
          letterSpacing="3"
          fill={NR}
          opacity="0.7"
          filter="url(#avl-rglow)"
        >
          STANDBY
        </text>

        {/* ── BOTTOM ARC LABEL ─────────────────────────────────── */}
        <text
          x="0" y="312"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="6"
          fontFamily="monospace"
          letterSpacing="2"
          fill={DW}
          opacity="0.35"
        >
          AVL AI SYSTEM
        </text>
      </svg>

      {/* ── AVL AI Text ──────────────────────────────────────── */}
      <div
        ref={textRef}
        style={{
          position: "absolute",
          textAlign: "center",
          pointerEvents: "none",
          userSelect: "none",
          willChange: "opacity",
        }}
      >
        <p style={{
          fontSize: "clamp(18px, 2.2vw, 30px)",
          fontFamily: "monospace",
          fontWeight: 900,
          letterSpacing: "0.56em",
          paddingLeft: "0.56em",
          color: NW,
          textShadow:
            `0 0 5px ${NW}bb, 0 0 14px ${NW}66, 0 0 32px ${NW}33`,
          transition: "text-shadow 0.8s ease",
        }}>
          AVL AI
        </p>
      </div>

      {/* ── 中心クリックエリア（マイク起動）──────────────────── */}
      {onVoiceToggle && (
        <button
          type="button"
          disabled={isVoiceConnecting}
          onClick={onVoiceToggle}
          aria-label={isVoiceActive ? "マイク停止" : "マイク起動"}
          style={{
            position: "absolute",
            width:  "min(18vh, 21vw)",
            height: "min(18vh, 21vw)",
            borderRadius: "50%",
            background: "transparent",
            border: "none",
            cursor: isVoiceConnecting ? "wait" : "pointer",
            pointerEvents: "auto",
            zIndex: 20,
            // アクティブ時に微妙な光輪
            boxShadow: isVoiceActive
              ? `0 0 40px rgba(255,255,255,0.08), 0 0 80px rgba(255,28,28,0.06)`
              : undefined,
            transition: "box-shadow 0.5s ease",
          }}
        />
      )}
    </div>
  );
}
