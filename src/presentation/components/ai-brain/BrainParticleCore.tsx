'use client';

// =================================================================
// BrainParticleCore — AVL AI Command Center Particle System
// GPU-computed shader particles: 25,000 points, 4 populations
//
// POPULATIONS
//   CORE    (0-4999)  : dense nucleus, breathing
//   ORBITAL (5000-14999): multi-ring orbits
//   STREAM  (15000-21999): radial jets / escape trails
//   AMBIENT (22000-24999): background cosmic drift
//
// STATES (uState uniform)
//   0 standby   – slow drift, cool cyan
//   1 scanning  – sweeping wave + speed burst
//   2 collecting– particles converge to core
//   3 analyzing – max speed, multi-layer orbits
//   4 thinking  – gold shimmer + density pulse
//   5 buy       – cyan/green energy burst
//   6 sell      – red/magenta energy burst
//   7 wait      – cool down, blue contraction
//   8 listening – outer particles react to mic
//   9 speaking  – rhythmic pulse synced to TTS
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── GLSL Vertex Shader ─────────────────────────────────────────────
const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uState;        // 0-9 state index (float for smooth lerp)
uniform float uEnergy;       // 0-1 overall energy level
uniform float uVoice;        // 0-1 voice amplitude
uniform vec3  uColorA;       // primary color
uniform vec3  uColorB;       // secondary color
uniform vec3  uColorC;       // decision color

attribute float aGroup;      // 0=core 1=orbital 2=stream 3=ambient
attribute vec4  aOrbit;      // [radius, theta0, omega, inclination]
attribute vec3  aAxis1;
attribute vec3  aAxis2;
attribute float aPhase;
attribute float aSize;
attribute float aSeed;       // random 0-1

varying vec3  vColor;
varying float vAlpha;
varying float vGlow;

#define PI  3.14159265358979
#define TAU 6.28318530717959

// smooth step helper
float smoothstep2(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  float t   = uTime;
  float grp = aGroup;
  float ph  = aPhase;
  float sd  = aSeed;

  // ── State transitions ─────────────────────────────────────────
  float isStandby   = smoothstep2(0.5, 0.0, abs(uState - 0.0));
  float isScanning  = smoothstep2(0.5, 0.0, abs(uState - 1.0));
  float isCollect   = smoothstep2(0.5, 0.0, abs(uState - 2.0));
  float isAnalyzing = smoothstep2(0.5, 0.0, abs(uState - 3.0));
  float isThinking  = smoothstep2(0.5, 0.0, abs(uState - 4.0));
  float isBuy       = smoothstep2(0.5, 0.0, abs(uState - 5.0));
  float isSell      = smoothstep2(0.5, 0.0, abs(uState - 6.0));
  float isWait      = smoothstep2(0.5, 0.0, abs(uState - 7.0));
  float isListening = smoothstep2(0.5, 0.0, abs(uState - 8.0));
  float isSpeaking  = smoothstep2(0.5, 0.0, abs(uState - 9.0));

  float speed = 1.0
    + isScanning  * 2.5
    + isCollect   * 1.5
    + isAnalyzing * 4.0
    + isThinking  * 2.0
    + isBuy       * 3.0
    + isSell      * 3.0
    + isSpeaking  * (1.0 + uVoice * 2.0);

  // ── CORE particles (grp ≈ 0) ──────────────────────────────────
  vec3 pos = vec3(0.0);

  if (grp < 0.5) {
    // Dense cloud near origin — breathe and pulse
    float r      = aOrbit.x;
    float theta  = aOrbit.y + t * aOrbit.z * speed;
    float phi    = aOrbit.w + t * 0.3 * speed;
    float breath = 1.0 + 0.25 * sin(t * 1.8 + ph * 4.2) * uEnergy;
    float surge  = isCollect * -0.5;  // contract during collect
    pos = r * breath * (1.0 + surge) * (
      aAxis1 * cos(theta) * cos(phi) +
      aAxis2 * sin(theta) * cos(phi) +
      vec3(0,sin(phi),0) * 0.6
    );

    // pulse outward on BUY/SELL decision
    float burst = (isBuy + isSell) * 0.4 * sin(t * 8.0 + ph * 12.0) * uEnergy;
    pos *= 1.0 + burst;

  } else if (grp < 1.5) {
    // ── ORBITAL particles ─────────────────────────────────────────
    float r     = aOrbit.x * (1.0 + 0.15 * sin(t * 0.4 + ph));
    float omega = aOrbit.z * speed;
    float angle = aOrbit.y + t * omega;
    float incl  = aOrbit.w;

    // multi-layer ring morphing
    float ring1 = cos(incl) * r;
    float ring2 = sin(incl) * r;
    vec3 ringPos = aAxis1 * cos(angle) * ring1
                 + aAxis2 * sin(angle) * ring1
                 + vec3(0.0, ring2, 0.0) * 0.6;

    // Scanning wave: add sinusoidal displacement
    float scanWave = isScanning * 0.3 * sin(t * 6.0 + aOrbit.y * 3.0) * uEnergy;
    ringPos += aAxis1 * scanWave;

    // Collect: spiral inward
    float collectFactor = 1.0 - isCollect * 0.6 * (1.0 - sd);
    ringPos *= collectFactor;

    // Analyzing: add second orbital ring at different angle
    vec3 ring2pos = aAxis1 * cos(angle * 1.3 + ph) * r * 0.7
                  + vec3(0,1,0) * sin(angle * 0.7 + ph) * r * 0.5;
    ringPos = mix(ringPos, ringPos + ring2pos * 0.3, isAnalyzing);

    pos = ringPos;

  } else if (grp < 2.5) {
    // ── STREAM / ESCAPE particles ──────────────────────────────────
    float spd   = speed * 0.8;
    float life  = fract(t * 0.15 * spd + sd);  // 0→1 loop
    float r     = life * 2.8;
    float theta = aOrbit.y + life * TAU * 3.0;
    float phi   = aOrbit.w;

    pos = aAxis1 * r * cos(theta) * cos(phi)
        + aAxis2 * r * sin(theta) * cos(phi)
        + vec3(0,1,0) * r * sin(phi) * 0.4;

    // Fade in scanning / analyzing mode
    pos *= (isScanning + isAnalyzing * 0.6 + isBuy * 0.8 + isSell * 0.8);

  } else {
    // ── AMBIENT drift ──────────────────────────────────────────────
    float dx = sin(t * 0.07 * speed + sd * 17.3) * 3.5;
    float dy = cos(t * 0.09 * speed + sd * 23.1) * 1.8;
    float dz = sin(t * 0.11 * speed + sd * 11.7) * 3.5;
    pos = aAxis1 * dx + vec3(0,dy,0) + aAxis2 * dz;
  }

  // ── Voice reactivity (outer particles oscillate) ──────────────
  float outerMask = smoothstep2(0.5, 2.0, length(pos));
  pos += aAxis1 * outerMask * uVoice * 0.3 * sin(t * 12.0 + ph * 6.0) * (isListening + isSpeaking);

  // ── Color blending ────────────────────────────────────────────
  // Base: uColorA (cyan), decision overrides
  vec3 col = uColorA;
  col = mix(col, vec3(1.0, 0.85, 0.0), isThinking * 0.8);  // gold for thinking
  col = mix(col, uColorB, isBuy  * 0.9);     // green for BUY
  col = mix(col, uColorC, isSell * 0.9);     // red for SELL
  col = mix(col, vec3(0.4, 0.6, 1.0), isWait * 0.6);       // cool blue for WAIT
  col = mix(col, vec3(0.7, 0.9, 1.0), isListening * 0.5);  // light cyan for listening
  // per-particle color variation
  col += vec3(aSeed * 0.15, aSeed * 0.05, -aSeed * 0.1);
  col = clamp(col, 0.0, 1.0);

  // ── Alpha / size ──────────────────────────────────────────────
  float dist = length(pos);
  float alpha = aSize * uEnergy;
  alpha *= (1.0 - smoothstep2(2.0, 3.8, dist));

  // Stream: fade on lifecycle
  if (grp >= 1.5 && grp < 2.5) {
    float life = fract(uTime * 0.15 * speed + aSeed);
    alpha *= (1.0 - smoothstep2(0.6, 1.0, life));
    alpha *= smoothstep2(0.0, 0.15, life);
  }

  // Ambient: dimmer
  if (grp >= 2.5) alpha *= 0.35;

  // Speaking: amplitude pulse
  alpha *= 1.0 + isSpeaking * uVoice * 0.8 * sin(uTime * 18.0 + aPhase * 8.0);

  vColor = col;
  vAlpha = clamp(alpha, 0.0, 1.0);
  vGlow  = (isBuy + isSell + isThinking) * uEnergy;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  // サイズ制限を 4px に → 粒子間に黒い空間を確保、白塊防止
  float ptSz = aSize * 260.0 / -mvPos.z;
  gl_PointSize = clamp(ptSz, 0.5, 4.0);
  gl_Position  = projectionMatrix * mvPos;
}
`;

// ── GLSL Fragment Shader ───────────────────────────────────────────
const FRAG = /* glsl */`
precision highp float;

varying vec3  vColor;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // soft disc — 中心だけ明るく、外側はすぐ透明になる
  float core = exp(-d * d * 22.0);
  float halo = exp(-d * d * 7.0) * 0.3;
  float alpha = vAlpha * (core + halo);
  // 粒子1個のmax alpha を抑えて密集箇所の白塊を防止
  alpha = min(alpha, 0.78);

  gl_FragColor = vec4(vColor + vGlow * core * 0.35, alpha);
}
`;

// ── State → uniforms mapping ───────────────────────────────────────
const STATE_MAP: Record<string, { stateIdx: number; energy: number }> = {
  idle:          { stateIdx: 0, energy: 0.30 },
  standby:       { stateIdx: 0, energy: 0.30 },
  scanning:      { stateIdx: 1, energy: 0.70 },
  collecting:    { stateIdx: 2, energy: 0.60 },
  snapshot:      { stateIdx: 2, energy: 0.60 },
  analyzing:     { stateIdx: 3, energy: 0.82 },
  decision:      { stateIdx: 3, energy: 0.82 },
  reasoning:     { stateIdx: 4, energy: 0.78 },
  risk:          { stateIdx: 4, energy: 0.78 },
  risk_check:    { stateIdx: 4, energy: 0.78 },
  dryrun:        { stateIdx: 5, energy: 0.72 },
  complete_buy:  { stateIdx: 5, energy: 0.88 },
  complete_sell: { stateIdx: 6, energy: 0.88 },
  complete_wait: { stateIdx: 7, energy: 0.45 },
  complete:      { stateIdx: 7, energy: 0.42 },
  error:         { stateIdx: 6, energy: 0.38 },
  listening:     { stateIdx: 8, energy: 0.65 },
  speaking:      { stateIdx: 9, energy: 0.75 },
};

// ── Component ──────────────────────────────────────────────────────
interface Props {
  brainState: string;   // matches BrainStep or voice state
  decision?:  "BUY" | "SELL" | "WAIT" | null;
  voiceAmp?:  number;   // 0-1
  className?: string;
}

// 白塊防止のため CORE を減らし、ORBITAL を維持してシルエット感を出す
const N_CORE    = 3_000;
const N_ORBITAL = 10_000;
const N_STREAM  = 6_000;
const N_AMBIENT = 2_500;
const N_TOTAL   = N_CORE + N_ORBITAL + N_STREAM + N_AMBIENT;

function rand(a = 0, b = 1) { return a + Math.random() * (b - a); }
function randNorm() { return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random()); }
function randOnSphere(): [number, number, number] {
  const u = rand(-1, 1), phi = rand(0, Math.PI * 2);
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(phi), u, s * Math.sin(phi)];
}

export const BrainParticleCore = memo(function BrainParticleCore({ brainState, decision, voiceAmp = 0, className }: Props) {
  const canvasRef  = useRef<HTMLDivElement>(null);
  const stateRef   = useRef({ state: brainState, decision, voiceAmp });
  const cleanupRef = useRef<(() => void) | undefined>(undefined);

  stateRef.current = { state: brainState, decision, voiceAmp };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    // ── Scene setup — use getBoundingClientRect for accurate initial size ──
    const rect = el.getBoundingClientRect();
    const W = Math.max(rect.width,  el.clientWidth,  300);
    const H = Math.max(rect.height, el.clientHeight, 240);
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    // FOV 55° / z=6.5 → 粒子がコンテナ内に収まり密集しすぎない
    const camera = new THREE.PerspectiveCamera(55, W / H, 0.01, 100);
    camera.position.set(0, 0, 6.5);

    // ── Bloom post-processing ───────────────────────────────────
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // strength低め・threshold高め → 白塊防止、粒子が個別認識できる明るさに
    const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.7, 0.22);
    composer.addPass(bloom);

    // ── Build geometry ──────────────────────────────────────────
    const geo = new THREE.BufferGeometry();

    const aGroup  = new Float32Array(N_TOTAL);
    const aOrbit  = new Float32Array(N_TOTAL * 4);
    const aAxis1  = new Float32Array(N_TOTAL * 3);
    const aAxis2  = new Float32Array(N_TOTAL * 3);
    const aPhase  = new Float32Array(N_TOTAL);
    const aSize   = new Float32Array(N_TOTAL);
    const aSeed   = new Float32Array(N_TOTAL);

    let idx = 0;

    // Core
    for (let i = 0; i < N_CORE; i++, idx++) {
      aGroup[idx] = 0;
      const [ax, ay, az] = randOnSphere();
      const [bx, by, bz] = randOnSphere();
      aOrbit.set([rand(0.05, 0.6), rand(0, Math.PI*2), rand(0.2, 1.2) * (Math.random()<0.5?1:-1), rand(0,Math.PI*2)], idx*4);
      aAxis1.set([ax,ay,az], idx*3); aAxis2.set([bx,by,bz], idx*3);
      aPhase[idx] = rand(0, Math.PI*2);
      aSize[idx]  = rand(0.3, 1.0);
      aSeed[idx]  = Math.random();
    }
    // Orbital
    for (let i = 0; i < N_ORBITAL; i++, idx++) {
      aGroup[idx] = 1;
      const ring = Math.floor(i / (N_ORBITAL/5));
      const baseR = 0.8 + ring * 0.32;
      const [ax, ay, az] = randOnSphere();
      const [bx, by, bz] = randOnSphere();
      const omega = rand(0.15, 0.55) * (Math.random()<0.5?1:-1);
      aOrbit.set([rand(baseR-0.1, baseR+0.1), rand(0,Math.PI*2), omega, rand(-Math.PI/3, Math.PI/3)], idx*4);
      aAxis1.set([ax,ay,az], idx*3); aAxis2.set([bx,by,bz], idx*3);
      aPhase[idx] = rand(0, Math.PI*2);
      aSize[idx]  = rand(0.2, 0.8);
      aSeed[idx]  = Math.random();
    }
    // Stream
    for (let i = 0; i < N_STREAM; i++, idx++) {
      aGroup[idx] = 2;
      const [ax,ay,az] = randOnSphere();
      const [bx,by,bz] = randOnSphere();
      aOrbit.set([1, rand(0,Math.PI*2), rand(0.5,1.5), rand(-Math.PI/4, Math.PI/4)], idx*4);
      aAxis1.set([ax,ay,az], idx*3); aAxis2.set([bx,by,bz], idx*3);
      aPhase[idx] = rand(0, Math.PI*2);
      aSize[idx]  = rand(0.1, 0.5);
      aSeed[idx]  = Math.random();
    }
    // Ambient
    for (let i = 0; i < N_AMBIENT; i++, idx++) {
      aGroup[idx] = 3;
      const [ax,ay,az] = randOnSphere();
      const [bx,by,bz] = randOnSphere();
      aOrbit.set([rand(1.5,3.5), rand(0,Math.PI*2), rand(0.05,0.2), rand(0,Math.PI)], idx*4);
      aAxis1.set([ax,ay,az], idx*3); aAxis2.set([bx,by,bz], idx*3);
      aPhase[idx] = rand(0, Math.PI*2);
      aSize[idx]  = rand(0.05, 0.3);
      aSeed[idx]  = Math.random();
    }

    geo.setAttribute('aGroup', new THREE.BufferAttribute(aGroup, 1));
    geo.setAttribute('aOrbit', new THREE.BufferAttribute(aOrbit, 4));
    geo.setAttribute('aAxis1', new THREE.BufferAttribute(aAxis1, 3));
    geo.setAttribute('aAxis2', new THREE.BufferAttribute(aAxis2, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    geo.setAttribute('aSize',  new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aSeed',  new THREE.BufferAttribute(aSeed, 1));

    // ── Material with shared uniforms ────────────────────────────
    const uniforms = {
      uTime:    { value: 0 },
      uState:   { value: 0 },
      uEnergy:  { value: 0.35 },
      uVoice:   { value: 0 },
      uColorA:  { value: new THREE.Color(0x00e5ff) },  // cyan
      uColorB:  { value: new THREE.Color(0x00ff88) },  // green
      uColorC:  { value: new THREE.Color(0xff1a4e) },  // red
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    scene.add(points);

    // ── Animation loop ───────────────────────────────────────────
    let raf = 0;
    let tgt_state  = 0;
    let tgt_energy = 0.35;
    const clock    = new THREE.Clock();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (document.hidden) return;

      const { state, decision: dec, voiceAmp: va } = stateRef.current;

      // Resolve state key
      let key = state;
      if (state === 'complete' && dec === 'BUY')  key = 'complete_buy';
      if (state === 'complete' && dec === 'SELL') key = 'complete_sell';
      if (state === 'complete' && dec === 'WAIT') key = 'complete_wait';

      const map = STATE_MAP[key] ?? STATE_MAP['idle'];
      tgt_state  += (map.stateIdx - tgt_state)  * 0.04;
      tgt_energy += (map.energy   - tgt_energy) * 0.05;

      uniforms.uTime.value   = clock.getElapsedTime();
      uniforms.uState.value  = tgt_state;
      uniforms.uEnergy.value = tgt_energy;
      uniforms.uVoice.value  = va ?? 0;

      // Gentle auto-rotation
      points.rotation.y += 0.0008;
      points.rotation.x  = Math.sin(clock.getElapsedTime() * 0.12) * 0.12;

      composer.render();
    };

    animate();

    // ── Resize handler via ResizeObserver (catches flex/layout changes) ───
    const applyResize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        applyResize(width, height);
      }
    });
    ro.observe(el);
    // Also fire once on next frame to catch any initial layout resolution
    requestAnimationFrame(() => applyResize(el.clientWidth, el.clientHeight));

    cleanupRef.current = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      composer.dispose();
      renderer.dispose();
      geo.dispose();
      mat.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };

    return () => cleanupRef.current?.();
  }, []); // mount once

  return <div ref={canvasRef} className={className} style={{ background: 'transparent' }} />;
});
