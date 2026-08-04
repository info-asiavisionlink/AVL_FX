'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────
export type AIState =
  | 'standby'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'signal_detection'
  | 'trade_decision'
  | 'executing_order'
  | 'autonomous';

export type ActiveAgent = null | 'market' | 'analysis' | 'decision' | 'order' | 'voice';

// ── Per-state config ───────────────────────────────────────────────────────
type Cfg = {
  hex: number; hex2: number;
  energy: number; speed: number; rot: number;
  morphType: number; morphTarget: number;
};
const STATE_CFG: Record<AIState, Cfg> = {
  standby:          { hex: 0x0066ff, hex2: 0x002266, energy: 0.72, speed: 0.55, rot: 0.0004, morphType: 0, morphTarget: 0    },
  listening:        { hex: 0x00eeff, hex2: 0x001833, energy: 0.80, speed: 0.90, rot: 0.001,  morphType: 1, morphTarget: 0.88 },
  thinking:         { hex: 0xffd700, hex2: 0xffeeaa, energy: 1.20, speed: 1.60, rot: 0.004,  morphType: 0, morphTarget: 0    },
  speaking:         { hex: 0x00ff88, hex2: 0x00ffcc, energy: 0.95, speed: 1.10, rot: 0.002,  morphType: 2, morphTarget: 0.80 },
  signal_detection: { hex: 0xffdd00, hex2: 0xff8800, energy: 0.90, speed: 1.00, rot: 0.002,  morphType: 0, morphTarget: 0    },
  trade_decision:   { hex: 0xff8800, hex2: 0xff4400, energy: 1.55, speed: 2.20, rot: 0.007,  morphType: 0, morphTarget: 0    },
  executing_order:  { hex: 0xff1100, hex2: 0xff8800, energy: 2.20, speed: 3.80, rot: 0.012,  morphType: 2, morphTarget: 0.60 },
  autonomous:       { hex: 0xffd700, hex2: 0xffffff, energy: 1.70, speed: 2.60, rot: 0.006,  morphType: 0, morphTarget: 0    },
};

const AGENT_HEX: Record<NonNullable<ActiveAgent>, number> = {
  market:   0x00ff44,
  analysis: 0x0088ff,
  decision: 0xffdd00,
  order:    0xff2200,
  voice:    0xaa00ff,
};

export const STATE_LABEL: Record<AIState, string> = {
  standby:          '◇ STANDBY',
  listening:        '◆ LISTENING',
  thinking:         '◆ ANALYZING',
  speaking:         '◆ RESPONDING',
  signal_detection: '◆ SIGNAL DETECTED',
  trade_decision:   '◆ DECIDING',
  executing_order:  '◆ EXECUTING ORDER',
  autonomous:       '◆ AUTONOMOUS MODE',
};

// ── Scene constants ────────────────────────────────────────────────────────
const N_PARTS = 50_000;
const LF      = 0.030;

// ── GLSL Vertex Shader ─────────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpeed;
uniform float uEnergy;
uniform vec3  uColor;
uniform vec3  uColor2;
uniform float uMorph;
uniform float uMorphType;

attribute float aRadius;
attribute float aTheta0;
attribute float aOmega;
attribute vec3  aAxisU;
attribute vec3  aAxisV;
attribute float aNoiseFreqX;
attribute float aNoiseFreqY;
attribute float aNoiseFreqZ;
attribute float aNoiseMag;
attribute float aPhase;
attribute float aPtSize;
attribute float aBaseAlpha;

varying vec3  vColor;
varying float vAlpha;

#define PI 3.14159265358979

void main() {
  float t = uTime * uSpeed;

  float angle   = aTheta0 + t * aOmega;
  vec3 orbitPos = aAxisU * cos(angle) * aRadius * 3.0
                + aAxisV * sin(angle) * aRadius * 3.0;

  float nx = sin(t * aNoiseFreqX + aPhase * 7.1139) * aNoiseMag * 3.0;
  float ny = cos(t * aNoiseFreqY + aPhase * 5.3741) * aNoiseMag * 3.0;
  float nz = sin(t * aNoiseFreqZ + aPhase * 9.5317) * aNoiseMag * 3.0;
  vec3 pos = orbitPos + vec3(nx, ny, nz);

  float breath = 1.0 + 0.08 * sin(t * 0.42 + aPhase * 3.14159);
  pos *= breath;

  float pulse = 0.5 + 0.5 * sin(t * abs(aOmega) * 2.1 + aPhase * 13.77);

  // ── Shape morphing ─────────────────────────────────────────────────────
  vec3 morphTarget = pos;

  if (uMorphType > 0.5 && uMorphType < 1.5) {
    // LISTENING: spherical net/grid morph
    float r      = length(pos);
    float r_safe = max(r, 0.001);
    float phi    = acos(clamp(pos.z / r_safe, -1.0, 1.0));
    float theta  = atan(pos.y, pos.x);

    float gridN    = 9.0;
    float phiStep  = PI / gridN;
    float thetStep = 2.0 * PI / (gridN * 2.0);
    float phi_s    = round(phi   / phiStep)  * phiStep;
    float theta_s  = round(theta / thetStep) * thetStep;
    phi_s = clamp(phi_s, 0.0, PI);

    // Map radius attribute to discrete shells
    float shellStep = 0.35;
    float r_target  = (floor(aRadius / shellStep) + 0.5) * shellStep * 1.2 + 0.3;
    r_target = clamp(r_target, 0.3, 2.0);

    // Subtle breathing pulse on the net nodes
    float netPulse = 0.025 * sin(t * 1.5 + phi_s * 3.0 + theta_s * 2.0);
    r_target *= (1.0 + netPulse);

    morphTarget = r_target * vec3(
      sin(phi_s) * cos(theta_s),
      sin(phi_s) * sin(theta_s),
      cos(phi_s)
    );

  } else if (uMorphType > 1.5) {
    // SPEAKING: concentric ring waves
    float norm_p  = fract(aPhase / 19.74);
    float ringIdx = floor(norm_p * 7.0);
    float inRing  = fract(norm_p * 7.0);

    float ringR   = 0.22 + ringIdx * 0.22;
    float ringAng = aTheta0 + t * aOmega * 0.2;
    float waveAmp = (0.12 + 0.09 * sin(t * 0.6 + ringIdx * 1.2)) * uEnergy;
    float waveZ   = waveAmp * sin(t * 2.8 + ringIdx * 0.9 + inRing * 6.28318);
    float jitter  = 0.03 * sin(t * 5.0 + aPhase);

    morphTarget = vec3(
      cos(ringAng) * (ringR + jitter),
      sin(ringAng) * (ringR + jitter),
      waveZ
    );
  }

  // Organic micro-oscillation on morph to avoid frozen look
  float morphOsc = uMorph * (1.0 + 0.06 * sin(t * 1.1 + aPhase * 2.0));
  pos = mix(pos, morphTarget, clamp(morphOsc, 0.0, 1.0));

  // ── Gradient color ─────────────────────────────────────────────────────
  float gradFactor;

  if (uMorphType > 0.5 && uMorphType < 1.5) {
    // Listening net: polar-angle gradient (top bright → bottom dark)
    float r_f   = max(length(pos), 0.001);
    float phi_f = acos(clamp(pos.z / r_f, -1.0, 1.0));
    gradFactor  = smoothstep(0.0, PI, phi_f);
    // As the net forms, gradient becomes more dramatic
    gradFactor  = mix(gradFactor * 0.5, gradFactor, uMorph);
  } else if (uMorphType > 1.5) {
    // Speaking: radial ring gradient with pulse inversion
    float ringR_f = length(pos.xy);
    gradFactor    = clamp(ringR_f / 1.4, 0.0, 1.0);
    gradFactor    = mix(gradFactor, 1.0 - gradFactor, pulse * 0.35);
  } else {
    // Other states: radial distance + temporal shimmer (gold shimmer for thinking)
    float rd   = clamp(length(pos) / 2.5, 0.0, 1.0);
    gradFactor = mix(rd, pulse, 0.4);
  }

  vColor = mix(uColor, uColor2, gradFactor) * (0.45 + 0.55 * pulse) * uEnergy;

  float alphaPulse = 0.30 + 0.70 * (0.5 + 0.5 * sin(t * 1.7 + aPhase * 11.3));
  vAlpha = aBaseAlpha * alphaPulse * clamp(uEnergy, 0.0, 1.2);

  vec4 mv    = modelViewMatrix * vec4(pos, 1.0);
  float sizeP = 0.60 + 0.60 * pulse;
  gl_PointSize = clamp(aPtSize * (280.0 / max(0.3, -mv.z)) * sizeP, 1.0, 6.0);
  gl_Position  = projectionMatrix * mv;
}
`;

// ── GLSL Fragment Shader ───────────────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;

varying vec3  vColor;
varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core  = 1.0 - smoothstep(0.0, 0.40, d);
  float halo  = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.55 + halo * 0.45) * vAlpha;

  vec3 col = vColor * (1.0 + core * 0.4);

  gl_FragColor = vec4(col, alpha);
}
`;

// ── Random orbital plane (Gram-Schmidt) ───────────────────────────────────
function randomOrbit(): { u: [number,number,number]; v: [number,number,number] } {
  let nx=(Math.random()-.5)*2, ny=(Math.random()-.5)*2, nz=(Math.random()-.5)*2;
  const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1; nx/=nl; ny/=nl; nz/=nl;
  let ux:number, uy:number, uz:number;
  if(Math.abs(nx)<0.9){ux=0;uy=-nz;uz=ny;}else{ux=-nz;uy=0;uz=nx;}
  const ul=Math.sqrt(ux*ux+uy*uy+uz*uz)||1; ux/=ul; uy/=ul; uz/=ul;
  const vx=ny*uz-nz*uy, vy=nz*ux-nx*uz, vz=nx*uy-ny*ux;
  return { u:[ux,uy,uz], v:[vx,vy,vz] };
}

// ── Props ──────────────────────────────────────────────────────────────────
interface Props {
  state?:       AIState;
  activeAgent?: ActiveAgent;
  className?:   string;
}

export function AVLAICore({ state = 'standby', activeAgent = null, className }: Props) {
  const mountRef   = useRef<HTMLDivElement>(null);
  const stateRef   = useRef(state);
  const agentRef   = useRef(activeAgent);
  stateRef.current = state;
  agentRef.current = activeAgent;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── Renderer ──────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 200);
    camera.position.z = 2.0;

    const resize = () => {
      const w = Math.max(mount.clientWidth,  1);
      const h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    const grp = new THREE.Group();
    scene.add(grp);

    // ── GPU Particle System ───────────────────────────────────────────────
    type PGroup = { r0:number; r1:number; s0:number; s1:number;
                    sz0:number; sz1:number; a0:number; a1:number; nm:number };
    const pGroups: PGroup[] = [
      { r0:0.00, r1:0.32, s0:0.1, s1:0.6,  sz0:0.022, sz1:0.042, a0:0.10, a1:0.22, nm:0.03 },
      { r0:0.30, r1:0.68, s0:0.2, s1:1.0,  sz0:0.020, sz1:0.038, a0:0.07, a1:0.16, nm:0.06 },
      { r0:0.62, r1:1.06, s0:0.2, s1:0.9,  sz0:0.019, sz1:0.034, a0:0.05, a1:0.12, nm:0.08 },
      { r0:0.98, r1:1.44, s0:0.1, s1:0.7,  sz0:0.019, sz1:0.034, a0:0.06, a1:0.14, nm:0.10 },
      { r0:1.38, r1:2.60, s0:0.05,s1:0.4,  sz0:0.016, sz1:0.028, a0:0.08, a1:0.18, nm:0.06 },
      { r0:2.50, r1:5.00, s0:0.01,s1:0.2,  sz0:0.011, sz1:0.022, a0:0.12, a1:0.26, nm:0.02 },
    ];
    const weights = [2, 15, 35, 25, 15, 8];
    const gSizes  = weights.map(w => Math.floor(N_PARTS * w / 100));
    gSizes[1]    += N_PARTS - gSizes.reduce((a,b)=>a+b,0);

    const aRadius    = new Float32Array(N_PARTS);
    const aTheta0    = new Float32Array(N_PARTS);
    const aOmega     = new Float32Array(N_PARTS);
    const aAxisU     = new Float32Array(N_PARTS*3);
    const aAxisV     = new Float32Array(N_PARTS*3);
    const aNoiseFreqX= new Float32Array(N_PARTS);
    const aNoiseFreqY= new Float32Array(N_PARTS);
    const aNoiseFreqZ= new Float32Array(N_PARTS);
    const aNoiseMag  = new Float32Array(N_PARTS);
    const aPhase     = new Float32Array(N_PARTS);
    const aPtSize    = new Float32Array(N_PARTS);
    const aBaseAlpha = new Float32Array(N_PARTS);

    let idx = 0;
    for (let g = 0; g < pGroups.length; g++) {
      const gd  = pGroups[g];
      const cnt = gSizes[g];
      for (let i = 0; i < cnt && idx < N_PARTS; i++, idx++) {
        const { u, v } = randomOrbit();
        aAxisU[idx*3]=u[0]; aAxisU[idx*3+1]=u[1]; aAxisU[idx*3+2]=u[2];
        aAxisV[idx*3]=v[0]; aAxisV[idx*3+1]=v[1]; aAxisV[idx*3+2]=v[2];
        aRadius[idx]     = gd.r0 + Math.random()*(gd.r1-gd.r0);
        aOmega[idx]      = (gd.s0 + Math.random()*(gd.s1-gd.s0)) * (Math.random()<0.5?1:-1);
        aTheta0[idx]     = Math.random()*Math.PI*2;
        aNoiseFreqX[idx] = 0.15 + Math.random()*1.8;
        aNoiseFreqY[idx] = 0.15 + Math.random()*1.8;
        aNoiseFreqZ[idx] = 0.15 + Math.random()*1.8;
        aNoiseMag[idx]   = gd.nm*(0.5+Math.random());
        aPhase[idx]      = Math.random()*Math.PI*6.28;
        aPtSize[idx]     = gd.sz0 + Math.random()*(gd.sz1-gd.sz0);
        aBaseAlpha[idx]  = gd.a0 + Math.random()*(gd.a1-gd.a0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.BufferAttribute(new Float32Array(N_PARTS*3), 3));
    geo.setAttribute('aRadius',     new THREE.BufferAttribute(aRadius,     1));
    geo.setAttribute('aTheta0',     new THREE.BufferAttribute(aTheta0,     1));
    geo.setAttribute('aOmega',      new THREE.BufferAttribute(aOmega,      1));
    geo.setAttribute('aAxisU',      new THREE.BufferAttribute(aAxisU,      3));
    geo.setAttribute('aAxisV',      new THREE.BufferAttribute(aAxisV,      3));
    geo.setAttribute('aNoiseFreqX', new THREE.BufferAttribute(aNoiseFreqX, 1));
    geo.setAttribute('aNoiseFreqY', new THREE.BufferAttribute(aNoiseFreqY, 1));
    geo.setAttribute('aNoiseFreqZ', new THREE.BufferAttribute(aNoiseFreqZ, 1));
    geo.setAttribute('aNoiseMag',   new THREE.BufferAttribute(aNoiseMag,   1));
    geo.setAttribute('aPhase',      new THREE.BufferAttribute(aPhase,      1));
    geo.setAttribute('aPtSize',     new THREE.BufferAttribute(aPtSize,     1));
    geo.setAttribute('aBaseAlpha',  new THREE.BufferAttribute(aBaseAlpha,  1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,0,0), 5);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:      { value: 0 },
      uSpeed:     { value: 0.55 },
      uEnergy:    { value: 0.72 },
      uColor:     { value: new THREE.Color(0x0066ff) },
      uColor2:    { value: new THREE.Color(0x002266) },
      uMorph:     { value: 0 },
      uMorphType: { value: 0 },
    };

    const pMat = new THREE.ShaderMaterial({
      vertexShader:   VS,
      fragmentShader: FS,
      uniforms,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      transparent: true,
    });

    const pts = new THREE.Points(geo, pMat);
    pts.frustumCulled = false;
    grp.add(pts);

    // ── Mouse ─────────────────────────────────────────────────────────────
    const mx = { cur: 0, tgt: 0 };
    const my = { cur: 0, tgt: 0 };
    const clock  = new THREE.Clock();
    let lastT    = 0;
    let burstAt  = -99;

    const onMove = (e: MouseEvent) => {
      const rc = mount.getBoundingClientRect();
      mx.tgt = ((e.clientX - rc.left) / rc.width  - 0.5) * 2;
      my.tgt =-((e.clientY - rc.top)  / rc.height - 0.5) * 2;
    };
    const onClickEv = () => { burstAt = clock.getElapsedTime(); };
    mount.addEventListener('mousemove', onMove);
    mount.addEventListener('click', onClickEv);

    // ── Smoothed state values ─────────────────────────────────────────────
    const colC  = new THREE.Color(0x0066ff);
    const colT  = new THREE.Color();
    const colC2 = new THREE.Color(0x002266);
    const colT2 = new THREE.Color();
    let sEnergy     = 0.72;
    let sSpeed      = 0.55;
    let sMorph      = 0;
    let curMorphType = 0;

    // ── Animation loop ────────────────────────────────────────────────────
    let rafId = 0;

    const tick = () => {
      rafId = requestAnimationFrame(tick);

      const t  = clock.getElapsedTime();
      const dt = Math.min(t - lastT, 0.05); lastT = t; void dt;

      const st  = stateRef.current;
      const ag  = agentRef.current;
      const cfg = STATE_CFG[st];

      // Color targets
      colT.setHex(ag ? AGENT_HEX[ag] : cfg.hex);
      colC.lerp(colT, 0.025);

      // Color2 targets (agent → white gradient; state → state hex2)
      colT2.setHex(ag ? 0xffffff : cfg.hex2);
      colC2.lerp(colT2, 0.025);

      // Morph type transition: snap morph to 0 on type change for clean re-entry
      if (cfg.morphType !== curMorphType) {
        curMorphType              = cfg.morphType;
        sMorph                    = 0;
        uniforms.uMorphType.value = cfg.morphType;
      }

      const bAge  = t - burstAt;
      const burst = bAge < 1.8 ? Math.max(0, 1 - bAge * 0.65) : 0;
      const pulse = 0.5 + 0.5 * Math.sin(t * (1.5 + cfg.rot * 400));

      sEnergy += (Math.min(cfg.energy, 1.0) * (0.85 + 0.15 * pulse) * (1 + burst * 0.6) - sEnergy) * LF;
      sSpeed  += (cfg.speed - sSpeed) * LF;
      sMorph  += (cfg.morphTarget - sMorph) * LF;

      uniforms.uTime.value   = t;
      uniforms.uSpeed.value  = sSpeed;
      uniforms.uEnergy.value = sEnergy;
      uniforms.uMorph.value  = sMorph;
      (uniforms.uColor.value  as THREE.Color).copy(colC);
      (uniforms.uColor2.value as THREE.Color).copy(colC2);

      mx.cur += (mx.tgt - mx.cur) * 0.06;
      my.cur += (my.tgt - my.cur) * 0.06;
      grp.rotation.y += cfg.rot;
      grp.rotation.x  = my.cur * 0.28;
      grp.position.y  = Math.sin(t * 0.42) * 0.07;
      grp.position.x  = Math.sin(t * 0.27) * 0.035;

      renderer.render(scene, camera);
    };

    tick();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      mount.removeEventListener('mousemove', onMove);
      mount.removeEventListener('click', onClickEv);
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose();
      geo.dispose();
      pMat.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className={cn('relative overflow-hidden', className)}
      style={{ cursor: 'crosshair' }}
    >
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none z-10 select-none">
        <div className="flex items-center gap-1.5">
          <div
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: state === 'standby' ? '#335588' : '#00ffff' }}
          />
          <span className="text-[9px] font-mono tracking-widest" style={{ color: '#88aacc' }}>
            {STATE_LABEL[state]}
          </span>
        </div>
      </div>

      {activeAgent && (
        <div className="absolute top-2 right-3 pointer-events-none z-10 select-none">
          <span
            className="text-[8px] font-mono tracking-widest px-1.5 py-0.5 border"
            style={{
              color:       AGENT_LABEL_COLOR[activeAgent],
              borderColor: AGENT_LABEL_COLOR[activeAgent] + '55',
              background:  AGENT_LABEL_COLOR[activeAgent] + '11',
            }}
          >
            {AGENT_NAME[activeAgent]}
          </span>
        </div>
      )}
    </div>
  );
}

const AGENT_LABEL_COLOR: Record<NonNullable<ActiveAgent>, string> = {
  market:   '#00ff44',
  analysis: '#0088ff',
  decision: '#ffdd00',
  order:    '#ff2200',
  voice:    '#aa00ff',
};
const AGENT_NAME: Record<NonNullable<ActiveAgent>, string> = {
  market:   '◆ MARKET AGENT',
  analysis: '◆ ANALYSIS AGENT',
  decision: '◆ DECISION AGENT',
  order:    '◆ ORDER AGENT',
  voice:    '◆ VOICE AGENT',
};
