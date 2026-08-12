'use client';

// =================================================================
// OrbitalParticleSystem — 3D GPU Orbital Particle Field
// ~2700 particles in 5 tilted elliptical orbits, GPU shader-driven
// White+Red color scheme · AI State + Voice reactive
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────
// Vertex Shader — all motion computed on GPU
// ─────────────────────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpeed;
uniform float uEnergy;
uniform float uVoice;
uniform float uConverge;  // 0→1 convergence, then handled externally

attribute float aAngle0;    // initial orbit angle (radians)
attribute float aOmega;     // angular velocity (rad/s · sign = dir)
attribute float aRadius;    // orbit radius
attribute float aAspect;    // ellipse Y squish (0.4–1.0)
attribute vec3  aAxisU;     // orbital plane U basis
attribute vec3  aAxisV;     // orbital plane V basis
attribute float aPhase;     // per-particle noise phase
attribute float aNoiseAmp;  // floating noise amplitude
attribute float aSize;      // base point size (px)
attribute float aAlpha;     // base alpha

varying float vAlpha;
varying float vDepth;  // -1 back → +1 front

void main() {
  float t = uTime * uSpeed;

  // ── Elliptical orbital position ─────────────────────────────
  float angle = aAngle0 + t * aOmega;
  float r = aRadius * (1.0 + uEnergy * 0.18);   // expands with energy

  vec3 orbitPos = aAxisU * (r * cos(angle))
                + aAxisV * (r * aAspect * sin(angle));

  // ── Floating micro-perturbation (3D noise) ──────────────────
  float nt = uTime * 0.22;
  float nAmp = aNoiseAmp * (1.0 + uEnergy * 0.55 + uVoice * 0.9);

  vec3 noise = vec3(
    sin(nt * 1.41 + aPhase * 7.13) * cos(nt * 0.63 + aPhase * 3.07),
    cos(nt * 0.87 + aPhase * 5.31) * sin(nt * 1.23 + aPhase * 8.59),
    sin(nt * 1.67 + aPhase * 4.27) * cos(nt * 0.91 + aPhase * 2.71)
  ) * nAmp;

  vec3 pos = orbitPos + noise;

  // ── DECISION convergence: pull toward origin ─────────────────
  pos = mix(pos, vec3(0.0), clamp(uConverge * 0.88, 0.0, 0.88));

  // ── Depth proxy (z in world space) ──────────────────────────
  vDepth = clamp(pos.z / max(aRadius * 1.6, 0.01), -1.0, 1.0);

  // ── Alpha ────────────────────────────────────────────────────
  float depthA  = 0.30 + 0.70 * (vDepth * 0.5 + 0.5);
  float energyA = 0.22 + uEnergy * 0.78;
  float voiceA  = 1.0  + uVoice  * 0.75;
  vAlpha = clamp(aAlpha * depthA * energyA * voiceA, 0.0, 0.88);

  // ── Point size ────────────────────────────────────────────────
  float depthSz = 0.50 + 0.95 * (vDepth * 0.5 + 0.5);
  float voiceSz = 1.0  + uVoice  * 0.60;
  float eSz     = 1.0  + uEnergy * 0.28;
  gl_PointSize  = clamp(aSize * depthSz * voiceSz * eSz, 0.6, 14.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// Fragment Shader
// ─────────────────────────────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;

varying float vAlpha;
varying float vDepth;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.36, d);
  float halo = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.68 + halo * 0.32) * vAlpha;

  // Depth-driven color: back=dark red, front=white
  float t = vDepth * 0.5 + 0.5;  // 0=back, 1=front
  vec3 colBack  = vec3(0.85, 0.06, 0.06);  // dark red
  vec3 colFront = vec3(1.00, 1.00, 1.00);  // white
  vec3 col = mix(colBack, colFront, smoothstep(0.15, 0.85, t));
  col *= 1.0 + core * 0.55;  // core brightening

  gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────
// Orbit group definitions (5 tilted ellipses)
// ─────────────────────────────────────────────────────────────────
interface OGroup {
  r:       number;
  aspect:  number;
  euler:   [number, number, number];
  sign:    1 | -1;
  rpm:     number;
  n:       number;
  noise:   number;
  szMin:   number;
  szMax:   number;
  aMin:    number;
  aMax:    number;
}

const GROUPS: OGroup[] = [
  // inner fast CW — tightly around CORE
  { r:0.40, aspect:0.55, euler:[26,  10,   0], sign: 1, rpm:1.8, n:500, noise:0.07, szMin:1.5, szMax:5.0, aMin:0.30, aMax:0.78 },
  // mid CCW — wider, different tilt
  { r:0.72, aspect:0.65, euler:[-18,  48,  22], sign:-1, rpm:1.1, n:660, noise:0.12, szMin:1.2, szMax:4.2, aMin:0.20, aMax:0.68 },
  // outer CW — deep tilt, elliptical
  { r:1.05, aspect:0.70, euler:[ 62, -22,  38], sign: 1, rpm:0.75,n:580, noise:0.17, szMin:1.0, szMax:3.8, aMin:0.14, aMax:0.58 },
  // cross-orbit CCW — nearly perpendicular
  { r:0.86, aspect:0.80, euler:[-50,  32, -18], sign:-1, rpm:1.3, n:480, noise:0.10, szMin:1.4, szMax:4.8, aMin:0.18, aMax:0.65 },
  // far scattered CW — random outer field
  { r:1.45, aspect:0.48, euler:[ 78,  18,  55], sign: 1, rpm:0.45,n:360, noise:0.25, szMin:0.8, szMax:3.2, aMin:0.08, aMax:0.42 },
];

const N_TOTAL = GROUPS.reduce((s, g) => s + g.n, 0); // 2580

// ─────────────────────────────────────────────────────────────────
// State → [speedMultiplier, energy]
// ─────────────────────────────────────────────────────────────────
const STATE_CFG: Record<string, [number, number]> = {
  standby:   [0.18, 0.26],
  scanning:  [0.80, 0.60],
  analyzing: [1.85, 0.93],
  reasoning: [1.35, 0.80],
  listening: [0.42, 0.40],
  speaking:  [0.88, 0.70],
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function computeBasis(rx: number, ry: number, rz: number) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180)
  );
  return {
    u: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    v: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
  };
}

// Non-uniform angle: clustered in 3-5 zones (avoids perfect ring)
function clusteredAngle(): number {
  const nC = 3 + Math.floor(Math.random() * 3);
  if (Math.random() < 0.55) {
    const ci = Math.floor(Math.random() * nC);
    const spread = (Math.PI * 2 / nC) * 0.38;
    return (ci / nC) * Math.PI * 2 + (Math.random() - 0.5) * spread;
  }
  return Math.random() * Math.PI * 2;
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
interface Props {
  brainState:  string;
  voiceStatus: string;
  isActive:    boolean;
  isThinking:  boolean;
}

export const OrbitalParticleSystem = memo(function OrbitalParticleSystem({
  brainState, voiceStatus, isActive, isThinking,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ brainState, voiceStatus, isActive, isThinking });
  stateRef.current = { brainState, voiceStatus, isActive, isThinking };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── Renderer (alpha=true: transparent bg) ─────────────────
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true, antialias: false,
        powerPreference: 'high-performance',
      });
    } catch {
      return; // WebGL not available (SSR or headless)
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
    camera.position.set(0, 0, 2.5);
    camera.lookAt(0, -0.2, 0); // match HolographicAICore camera

    const resize = () => {
      const w = Math.max(mount.clientWidth, 1);
      const h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ── Build GPU attribute buffers ────────────────────────────
    const aAngle0    = new Float32Array(N_TOTAL);
    const aOmega     = new Float32Array(N_TOTAL);
    const aRadius    = new Float32Array(N_TOTAL);
    const aAspect    = new Float32Array(N_TOTAL);
    const aAxisUBuf  = new Float32Array(N_TOTAL * 3);
    const aAxisVBuf  = new Float32Array(N_TOTAL * 3);
    const aPhase     = new Float32Array(N_TOTAL);
    const aNoiseAmp  = new Float32Array(N_TOTAL);
    const aSizeBuf   = new Float32Array(N_TOTAL);
    const aAlphaBuf  = new Float32Array(N_TOTAL);

    let idx = 0;
    for (const grp of GROUPS) {
      const { u, v } = computeBasis(...grp.euler);
      const baseOmega = (grp.rpm / 60) * Math.PI * 2 * grp.sign;

      for (let i = 0; i < grp.n && idx < N_TOTAL; i++, idx++) {
        aAngle0[idx] = clusteredAngle();
        // Per-particle speed variation ±30%
        aOmega[idx]  = baseOmega * (0.70 + Math.random() * 0.60);
        // Per-particle radius jitter ±15%
        aRadius[idx] = grp.r * (0.85 + Math.random() * 0.30);
        // Per-particle aspect jitter ±10%
        aAspect[idx] = grp.aspect * (0.90 + Math.random() * 0.20);

        aAxisUBuf[idx*3]   = u.x; aAxisUBuf[idx*3+1] = u.y; aAxisUBuf[idx*3+2] = u.z;
        aAxisVBuf[idx*3]   = v.x; aAxisVBuf[idx*3+1] = v.y; aAxisVBuf[idx*3+2] = v.z;

        aPhase[idx]    = Math.random() * Math.PI * 6.28;
        aNoiseAmp[idx] = grp.noise * (0.5 + Math.random() * 1.0);
        aSizeBuf[idx]  = grp.szMin + Math.random() * (grp.szMax - grp.szMin);
        aAlphaBuf[idx] = grp.aMin  + Math.random() * (grp.aMax  - grp.aMin);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_TOTAL * 3), 3));
    geo.setAttribute('aAngle0',  new THREE.BufferAttribute(aAngle0,   1));
    geo.setAttribute('aOmega',   new THREE.BufferAttribute(aOmega,    1));
    geo.setAttribute('aRadius',  new THREE.BufferAttribute(aRadius,   1));
    geo.setAttribute('aAspect',  new THREE.BufferAttribute(aAspect,   1));
    geo.setAttribute('aAxisU',   new THREE.BufferAttribute(aAxisUBuf, 3));
    geo.setAttribute('aAxisV',   new THREE.BufferAttribute(aAxisVBuf, 3));
    geo.setAttribute('aPhase',   new THREE.BufferAttribute(aPhase,    1));
    geo.setAttribute('aNoiseAmp',new THREE.BufferAttribute(aNoiseAmp, 1));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(aSizeBuf,  1));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(aAlphaBuf, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:     { value: 0 },
      uSpeed:    { value: 0.18 },
      uEnergy:   { value: 0.26 },
      uVoice:    { value: 0 },
      uConverge: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms,
      blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    // ── Animation loop ─────────────────────────────────────────
    let sSpeed = 0.18, sEnergy = 0.26, sVoice = 0;
    let prevState = 'standby';
    let convergeTimer = 0;
    let rafId = 0;
    const clock = new THREE.Clock();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const [tSpeedMult, tEnergy] = STATE_CFG[bs] ?? STATE_CFG.standby;

      // Smooth interpolation
      const lf = 0.028;
      sSpeed  += (tSpeedMult - sSpeed)  * lf;
      sEnergy += (tEnergy    - sEnergy) * lf;

      // Voice amplitude simulation
      const tVoice =
        vs === 'speaking'  ? 0.45 + Math.sin(elapsed * 7.3) * 0.28 + Math.sin(elapsed * 13.7) * 0.18
        : vs === 'listening' ? 0.12 + Math.sin(elapsed * 2.3) * 0.08
        : 0;
      sVoice += (tVoice - sVoice) * 0.10;

      // DECISION convergence trigger
      if (bs !== prevState) {
        if (bs === 'analyzing' && prevState !== 'analyzing') {
          convergeTimer = elapsed; // start convergence
        }
        prevState = bs;
      }
      let converge = 0;
      if (convergeTimer > 0) {
        const dt = elapsed - convergeTimer;
        if (dt < 0.8) {
          converge = dt / 0.8;  // 0→1 in 0.8s
        } else if (dt < 1.4) {
          converge = 1.0 - (dt - 0.8) / 0.6; // 1→0 in 0.6s (burst back)
        } else {
          convergeTimer = 0;
          converge = 0;
        }
      }

      uniforms.uTime.value     = elapsed;
      uniforms.uSpeed.value    = sSpeed;
      uniforms.uEnergy.value   = sEnergy;
      uniforms.uVoice.value    = Math.max(0, sVoice);
      uniforms.uConverge.value = converge;

      renderer.render(scene, camera);
    };
    tick();

    // ── Cleanup ────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      scene.remove(pts);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []); // mount once

  return (
    <div
      ref={mountRef}
      className="absolute inset-0"
      style={{ zIndex: 8, pointerEvents: 'none' }}
    />
  );
});
