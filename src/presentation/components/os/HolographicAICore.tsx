'use client';

// =================================================================
// HolographicAICore v8 — State-Reactive GPU Particle System
// Listening  → sphere net/grid morph + cyan gradient
// Thinking   → gold shimmer gradient
// Speaking   → concentric ring wave morph + green gradient
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { AIMode }     from '@/application/stores/aiOSStore';

// ── GLSL Vertex Shader ────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpeed;
uniform float uEnergy;
uniform vec3  uColor;
uniform vec3  uColor2;
uniform float uMorph;
uniform float uMorphType;

attribute vec4  aOrbit;       // [radius, theta0, omega, phase]
attribute vec3  aAxisU;
attribute vec3  aAxisV;
attribute vec4  aNoiseParams; // [freqX, freqY, freqZ, magnitude]
attribute vec2  aAppear;      // [ptSize, baseAlpha]
attribute vec3  aColor;       // per-particle neon color

varying vec3  vColor;
varying float vAlpha;

#define PI 3.14159265358979

void main() {
  float t = uTime * uSpeed;

  float aRadius     = aOrbit.x;
  float aTheta0     = aOrbit.y;
  float aOmega      = aOrbit.z;
  float aPhase      = aOrbit.w;
  float aNoiseFreqX = aNoiseParams.x;
  float aNoiseFreqY = aNoiseParams.y;
  float aNoiseFreqZ = aNoiseParams.z;
  float aNoiseMag   = aNoiseParams.w;
  float aPtSize     = aAppear.x;
  float aBaseAlpha  = aAppear.y;

  // Organic cloud position
  float angle   = aTheta0 + t * aOmega;
  vec3 orbitPos = aAxisU * cos(angle) * aRadius * 3.0
                + aAxisV * sin(angle) * aRadius * 3.0;

  float nx = sin(t * aNoiseFreqX + aPhase * 7.1139) * aNoiseMag * 3.0;
  float ny = cos(t * aNoiseFreqY + aPhase * 5.3741) * aNoiseMag * 3.0;
  float nz = sin(t * aNoiseFreqZ + aPhase * 9.5317) * aNoiseMag * 3.0;
  vec3 cloudPos = orbitPos + vec3(nx, ny, nz);

  float breath = 1.0 + 0.07 * sin(t * 0.45 + aPhase * PI);
  cloudPos *= breath;

  float pulse = 0.5 + 0.5 * sin(t * abs(aOmega) * 2.1 + aPhase * 13.77);

  // ── Shape morphing ──────────────────────────────────────────────
  vec3 morphTarget = cloudPos;

  if (uMorphType > 0.5 && uMorphType < 1.5) {
    // LISTENING: spherical net / grid
    float r      = length(cloudPos);
    float r_safe = max(r, 0.001);
    float phi    = acos(clamp(cloudPos.z / r_safe, -1.0, 1.0));
    float theta  = atan(cloudPos.y, cloudPos.x);

    float gridN    = 9.0;
    float phiStep  = PI / gridN;
    float thetStep = 2.0 * PI / (gridN * 2.0);
    float phi_s    = round(phi   / phiStep)  * phiStep;
    float theta_s  = round(theta / thetStep) * thetStep;
    phi_s = clamp(phi_s, 0.0, PI);

    float r_target = clamp(round(aRadius / 0.35) * 0.35 * 1.2 + 0.3, 0.3, 2.0);
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

  // Smooth organic oscillation on morph
  float morphOsc = uMorph * (1.0 + 0.06 * sin(t * 1.1 + aPhase * 2.0));
  vec3 pos = mix(cloudPos, morphTarget, clamp(morphOsc, 0.0, 1.0));

  // ── Gradient color ──────────────────────────────────────────────
  float gradFactor;

  if (uMorphType > 0.5 && uMorphType < 1.5) {
    // Listening: polar-angle gradient (top bright → bottom dark)
    float r_f   = max(length(pos), 0.001);
    float phi_f = acos(clamp(pos.z / r_f, -1.0, 1.0));
    gradFactor  = smoothstep(0.0, PI, phi_f);
    gradFactor  = mix(gradFactor * 0.5, gradFactor, uMorph);
  } else if (uMorphType > 1.5) {
    // Speaking: radial ring gradient with pulse inversion
    float ringR_f = length(pos.xy);
    gradFactor    = clamp(ringR_f / 1.4, 0.0, 1.0);
    gradFactor    = mix(gradFactor, 1.0 - gradFactor, pulse * 0.35);
  } else {
    // Standby / thinking: radial + pulse shimmer
    float rd   = clamp(length(pos) / 2.5, 0.0, 1.0);
    gradFactor = mix(rd, pulse, 0.4);
  }

  // Blend state color with per-particle color
  vec3 stateCol = mix(uColor, uColor2, gradFactor) * (0.45 + 0.55 * pulse) * uEnergy;
  float blend   = 0.70 + 0.30 * uMorph; // state color dominates more during morph
  vColor = mix(aColor * (0.8 + 0.5 * pulse) * uEnergy, stateCol, blend);

  float alphaPulse = 0.4 + 0.6 * (0.5 + 0.5 * sin(t * 1.7 + aPhase * 11.3));
  vAlpha = aBaseAlpha * alphaPulse * clamp(uEnergy, 0.0, 1.2);

  vec4 mv    = modelViewMatrix * vec4(pos, 1.0);
  float sizeP = 0.7 + 0.5 * pulse;
  gl_PointSize = clamp(aPtSize * (300.0 / max(0.3, -mv.z)) * sizeP, 1.0, 6.0);
  gl_Position  = projectionMatrix * mv;
}
`;

// ── GLSL Fragment Shader ──────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;

varying vec3  vColor;
varying float vAlpha;

void main() {
  float d    = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core  = 1.0 - smoothstep(0.0, 0.40, d);
  float halo  = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.55 + halo * 0.45) * vAlpha;

  vec3 col = vColor * (1.0 + core * 0.4);
  gl_FragColor = vec4(col, alpha);
}
`;

// ── Neon palette — Pure Red scheme ────────────────────────────────
type RGB = [number,number,number];
const P: Record<string,RGB> = {
  white:  [1.00, 0.92, 0.92],   // warm white (tiny red tint)
  wsoft:  [1.00, 0.80, 0.80],   // soft pinkish white
  red:    [1.00, 0.08, 0.08],   // neon red (primary)
  redmid: [0.90, 0.05, 0.05],   // mid red
  reddark:[0.55, 0.02, 0.02],   // dark red
  redwarm:[1.00, 0.22, 0.08],   // warm red-orange
  wdim:   [0.80, 0.15, 0.15],   // dim red (replaces gray)
  wgray:  [0.65, 0.08, 0.08],   // dark red (replaces gray)
  orange: [1.00, 0.30, 0.05],
  pink:   [1.00, 0.12, 0.25],
};
const PAL = Object.values(P);

// ── Mode & voice state config — White + Red theme ─────────────────
type Cfg = { bloom: number; energy: number; speed: number; hex: number; hex2: number; morphType: number; morphTarget: number };
const MODE_CFG: Record<AIMode, Cfg> = {
  analysis:   { bloom:0.55, energy:0.78, speed:0.90, hex:0xff1515, hex2:0x550000, morphType:0, morphTarget:0 },
  monitor:    { bloom:0.45, energy:0.72, speed:0.55, hex:0xffffff, hex2:0x661111, morphType:0, morphTarget:0 },
  assisted:   { bloom:0.70, energy:0.88, speed:1.40, hex:0xff2020, hex2:0xffffff, morphType:0, morphTarget:0 },
  autonomous: { bloom:0.92, energy:1.00, speed:2.80, hex:0xffffff, hex2:0xff0808, morphType:0, morphTarget:0 },
};

type VoiceCfg = { bloom: number; energy: number; speed: number; hex: number; hex2: number; morphType: number; morphTarget: number };
const VOICE_CFG: Record<string, VoiceCfg> = {
  listening:  { bloom:0.55, energy:0.72, speed:1.0,  hex:0xff1515, hex2:0x550000, morphType:0, morphTarget:0 },
  speaking:   { bloom:0.65, energy:0.92, speed:2.2,  hex:0xff1c1c, hex2:0xffffff, morphType:0, morphTarget:0 },
  connecting: { bloom:0.48, energy:0.68, speed:0.9,  hex:0xff1515, hex2:0x440000, morphType:0, morphTarget:0 },
};

const THINKING_CFG: VoiceCfg = {
  bloom:0.75, energy:0.95, speed:3.5, hex:0xffffff, hex2:0xff1010, morphType:0, morphTarget:0,
};

const N_TOTAL = 60_000;
const LF      = 0.028;

// ── Mostly face-on orbits with some tilt for scatter feel ──
function randomOrbit(): { u: [number,number,number], v: [number,number,number] } {
  const tilt = Math.pow(Math.random(), 1.8) * 1.0; // 0〜1.0 rad — some scatter
  const az   = Math.random() * Math.PI * 2;
  let nx = Math.sin(tilt) * Math.cos(az);
  let ny = Math.sin(tilt) * Math.sin(az);
  let nz = Math.cos(tilt);
  const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1; nx/=nl; ny/=nl; nz/=nl;
  let ux: number, uy: number, uz: number;
  if(Math.abs(nx)<0.9){ux=0;uy=-nz;uz=ny;}else{ux=-nz;uy=0;uz=nx;}
  const ul=Math.sqrt(ux*ux+uy*uy+uz*uz)||1; ux/=ul; uy/=ul; uz/=ul;
  const vx=ny*uz-nz*uy, vy=nz*ux-nx*uz, vz=nx*uy-ny*ux;
  return { u:[ux,uy,uz], v:[vx,vy,vz] };
}

// ── Props ─────────────────────────────────────────────────────────
interface Props { mode: AIMode; isActive: boolean; isThinking: boolean; voiceStatus: string; }

export const HolographicAICore = memo(function HolographicAICore({ mode, isThinking, voiceStatus }: Props) {
  const mountRef  = useRef<HTMLDivElement>(null);
  const modeRef   = useRef(mode);
  const thinkRef  = useRef(isThinking);
  const voiceRef  = useRef(voiceStatus);
  modeRef.current  = mode;
  thinkRef.current = isThinking;
  voiceRef.current = voiceStatus;

  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;

    // ── Renderer ─────────────────────────────────────────────────
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias:false, alpha:true, powerPreference:'high-performance' });
    } catch { return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 200);
    camera.position.set(0, 0, 2.5);
    camera.lookAt(0, -0.2, 0);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.45, 0.35, 0.14);
    composer.addPass(bloom);

    const resize = () => {
      const w=Math.max(mount.clientWidth,1), h=Math.max(mount.clientHeight,1);
      renderer.setSize(w,h); composer.setSize(w,h);
      camera.aspect=w/h; camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(mount); resize();

    // ── Particle attribute buffers (7 slots — within WebGL minimum 8) ──
    const aOrbit       = new Float32Array(N_TOTAL*4);
    const aAxisU       = new Float32Array(N_TOTAL*3);
    const aAxisV       = new Float32Array(N_TOTAL*3);
    const aNoiseParams = new Float32Array(N_TOTAL*4);
    const aAppear      = new Float32Array(N_TOTAL*2);
    const aColorBuf    = new Float32Array(N_TOTAL*3);

    type Group = { r0:number; r1:number; s0:number; s1:number; sz0:number; sz1:number; a0:number; a1:number; nm:number; cols:RGB[] };
    const groups: Group[] = [
      // inner core — bright red + warm white tint
      { r0:0.00, r1:0.32, s0:0.1, s1:0.6,  sz0:0.026, sz1:0.050, a0:0.08, a1:0.18, nm:0.03, cols:[P.white, P.red, P.redwarm] },
      // ring zone — dense red cloud at ring radius
      { r0:0.28, r1:0.75, s0:0.2, s1:1.0,  sz0:0.022, sz1:0.044, a0:0.06, a1:0.14, nm:0.06, cols:[P.red, P.redmid, P.redwarm, P.red] },
      // just outside ring — medium density
      { r0:0.68, r1:1.20, s0:0.2, s1:0.9,  sz0:0.018, sz1:0.038, a0:0.05, a1:0.12, nm:0.08, cols:[P.red, P.reddark, P.redwarm, P.orange] },
      // outer scatter — sparse crimson sparks
      { r0:1.10, r1:2.00, s0:0.1, s1:0.5,  sz0:0.013, sz1:0.026, a0:0.06, a1:0.14, nm:0.05, cols:[P.reddark, P.redmid, P.orange] },
      // far outer — very sparse dim sparks
      { r0:1.80, r1:3.20, s0:0.02,s1:0.15, sz0:0.009, sz1:0.018, a0:0.07, a1:0.16, nm:0.02, cols:[P.reddark, P.wgray, P.wdim] },
    ];
    const groupWeights = [5, 30, 35, 20, 10];
    const groupSizes   = groupWeights.map(w => Math.floor(N_TOTAL*w/100));
    groupSizes[1] += N_TOTAL - groupSizes.reduce((a,b)=>a+b,0);

    let idx=0;
    for(let g=0;g<groups.length;g++){
      const grp=groups[g], cnt=groupSizes[g];
      for(let i=0;i<cnt&&idx<N_TOTAL;i++,idx++){
        const {u,v}=randomOrbit();
        aAxisU[idx*3]=u[0]; aAxisU[idx*3+1]=u[1]; aAxisU[idx*3+2]=u[2];
        aAxisV[idx*3]=v[0]; aAxisV[idx*3+1]=v[1]; aAxisV[idx*3+2]=v[2];
        const r=grp.r0+Math.random()*(grp.r1-grp.r0);
        const omega=(grp.s0+Math.random()*(grp.s1-grp.s0))*(Math.random()<0.5?1:-1);
        aOrbit[idx*4]=r; aOrbit[idx*4+1]=Math.random()*Math.PI*2;
        aOrbit[idx*4+2]=omega; aOrbit[idx*4+3]=Math.random()*Math.PI*6.28;
        aNoiseParams[idx*4]=0.2+Math.random()*1.5; aNoiseParams[idx*4+1]=0.2+Math.random()*1.5;
        aNoiseParams[idx*4+2]=0.2+Math.random()*1.5; aNoiseParams[idx*4+3]=grp.nm*(0.5+Math.random());
        aAppear[idx*2]=grp.sz0+Math.random()*(grp.sz1-grp.sz0);
        aAppear[idx*2+1]=grp.a0+Math.random()*(grp.a1-grp.a0);
        const c=grp.cols[Math.floor(Math.random()*grp.cols.length)];
        aColorBuf[idx*3]=c[0]; aColorBuf[idx*3+1]=c[1]; aColorBuf[idx*3+2]=c[2];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.BufferAttribute(new Float32Array(N_TOTAL*3), 3));
    geo.setAttribute('aOrbit',      new THREE.BufferAttribute(aOrbit,       4));
    geo.setAttribute('aAxisU',      new THREE.BufferAttribute(aAxisU,       3));
    geo.setAttribute('aAxisV',      new THREE.BufferAttribute(aAxisV,       3));
    geo.setAttribute('aNoiseParams',new THREE.BufferAttribute(aNoiseParams, 4));
    geo.setAttribute('aAppear',     new THREE.BufferAttribute(aAppear,      2));
    geo.setAttribute('aColor',      new THREE.BufferAttribute(aColorBuf,    3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,0,0), 22);

    const uniforms: Record<string,THREE.IUniform> = {
      uTime:      { value: 0 },
      uSpeed:     { value: 0.9 },
      uEnergy:    { value: 0.8 },
      uColor:     { value: new THREE.Color(0x0066ff) },
      uColor2:    { value: new THREE.Color(0x002266) },
      uMorph:     { value: 0 },
      uMorphType: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    // ── Mouse ─────────────────────────────────────────────────────
    const mx={c:0,t:0}, my={c:0,t:0};
    let burstAt=-99;
    const clock = new THREE.Clock();
    const onMove=(e:MouseEvent)=>{const rc=mount.getBoundingClientRect();mx.t=((e.clientX-rc.left)/rc.width-.5)*2;my.t=-((e.clientY-rc.top)/rc.height-.5)*2;};
    const onClick=()=>{burstAt=clock.getElapsedTime();};
    mount.addEventListener('mousemove',onMove,{passive:true});
    mount.addEventListener('click',onClick);

    // ── Smooth state — initialize colors to current mode (skip blue lerp startup) ──
    const _initCfg = MODE_CFG[modeRef.current] ?? MODE_CFG.analysis;
    let sBloom=_initCfg.bloom, sEnergy=_initCfg.energy, sSpeed=_initCfg.speed;
    let sMorph=0, curMorphType=0;
    const colC  = new THREE.Color(_initCfg.hex);
    const colT  = new THREE.Color(_initCfg.hex);
    const colC2 = new THREE.Color(_initCfg.hex2);
    const colT2 = new THREE.Color(_initCfg.hex2);
    // Sync uniforms immediately
    uniforms.uColor.value  = new THREE.Color(_initCfg.hex);
    uniforms.uColor2.value = new THREE.Color(_initCfg.hex2);
    uniforms.uSpeed.value  = _initCfg.speed;
    uniforms.uEnergy.value = _initCfg.energy;

    let rafId=0;
    const tick=()=>{
      rafId=requestAnimationFrame(tick);
      const t=clock.getElapsedTime();

      const md  = modeRef.current;
      const vs  = voiceRef.current;
      const thi = thinkRef.current;

      // Pick active config: voice > thinking > mode
      let cfg: VoiceCfg;
      if (vs === 'listening' || vs === 'speaking' || vs === 'connecting') {
        cfg = VOICE_CFG[vs] ?? VOICE_CFG.listening;
      } else if (thi) {
        cfg = THINKING_CFG;
      } else {
        cfg = MODE_CFG[md];
      }

      // Morph type transition: snap morph to 0 on type change
      if (cfg.morphType !== curMorphType) {
        curMorphType              = cfg.morphType;
        sMorph                    = 0;
        uniforms.uMorphType.value = cfg.morphType;
      }

      // Burst effect
      const bAge=t-burstAt, burst=bAge<2.2?Math.max(0,1-bAge*0.55):0;

      sBloom  += (Math.min(cfg.bloom,  1.0) - sBloom)  * LF;
      sEnergy += (Math.min(cfg.energy, 1.0) - sEnergy) * LF;
      sSpeed  += (cfg.speed - sSpeed) * LF;
      sMorph  += (cfg.morphTarget - sMorph) * LF;

      colT.setHex(cfg.hex);  colC.lerp(colT,  0.025);
      colT2.setHex(cfg.hex2); colC2.lerp(colT2, 0.025);

      // Mouse camera drift
      mx.c+=(mx.t-mx.c)*0.05; my.c+=(my.t-my.c)*0.05;
      const ct=t*0.06;
      camera.position.x=Math.sin(ct)*0.15+mx.c*0.25;
      camera.position.y=Math.sin(ct*1.27)*0.06+my.c*0.15;
      camera.position.z=2.5+Math.sin(ct*0.8)*0.12;
      camera.lookAt(0,-0.2,0);

      uniforms.uTime.value   = t;
      uniforms.uSpeed.value  = sSpeed;
      uniforms.uEnergy.value = sEnergy*(1+burst*0.9);
      uniforms.uMorph.value  = sMorph;
      (uniforms.uColor.value  as THREE.Color).copy(colC);
      (uniforms.uColor2.value as THREE.Color).copy(colC2);

      bloom.strength  = Math.min(1.0, sBloom*(1+burst*0.35));
      bloom.threshold = 0.14;
      bloom.radius    = 0.40;

      composer.render();
    };
    tick();

    return ()=>{
      cancelAnimationFrame(rafId); ro.disconnect();
      mount.removeEventListener('mousemove',onMove);
      mount.removeEventListener('click',onClick);
      if(mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose(); geo.dispose(); mat.dispose();
    };
  },[]);

  return <div ref={mountRef} className="w-full h-full" style={{cursor:'crosshair'}}/>;
});
