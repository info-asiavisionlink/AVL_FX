'use client';

// =================================================================
// ScatteredParticleField — 3D GPU Scattered Particle Cloud
// ~3000 particles distributed randomly in 3D space around AI CORE
// No orbital rings. Organic float/drift via noise.
// White+Red · AI State + Voice reactive
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────
// Vertex Shader — pure noise-driven scatter, no orbital paths
// ─────────────────────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uVoice;
uniform float uSpeed;
uniform float uConverge;

attribute vec3  aBase;    // initial random 3D position
attribute vec3  aFreq;    // per-axis drift frequency
attribute float aPhase;   // phase offset
attribute float aDrift;   // drift amplitude scalar
attribute float aSize;
attribute float aAlpha;

varying float vAlpha;
varying float vDepth;

void main() {
  float t = uTime * uSpeed;

  // Organic drift — no orbital constraint
  float dAmp = aDrift * (1.0 + uEnergy * 0.55 + uVoice * 0.85);
  vec3 drift = vec3(
    sin(t * aFreq.x + aPhase * 6.93) * dAmp,
    cos(t * aFreq.y + aPhase * 4.17) * dAmp,
    sin(t * aFreq.z + aPhase * 8.51) * dAmp * 0.65
  );

  vec3 pos = aBase + drift;

  // Convergence: pull toward origin (DECISION / ANALYZING transition)
  pos = mix(pos, vec3(0.0), clamp(uConverge * 0.82, 0.0, 0.82));

  // Depth for size/alpha variation
  float baseR = length(aBase);
  vDepth = clamp(pos.z / max(baseR * 1.2, 0.1), -1.0, 1.0);

  // Alpha — back particles dimmer, energy brightens all
  float depthA  = 0.28 + 0.72 * (vDepth * 0.5 + 0.5);
  float energyA = 0.20 + uEnergy * 0.80;
  float voiceA  = 1.0  + uVoice  * 0.80;
  vAlpha = clamp(aAlpha * depthA * energyA * voiceA, 0.0, 0.90);

  // Size — front bigger, voice enlarges
  float depthSz = 0.45 + 0.90 * (vDepth * 0.5 + 0.5);
  gl_PointSize  = clamp(aSize * depthSz * (1.0 + uVoice * 0.55), 0.5, 12.0);

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

  float core = 1.0 - smoothstep(0.0, 0.35, d);
  float halo = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.70 + halo * 0.30) * vAlpha;

  // Depth color: back=dark red, front=white
  float t = vDepth * 0.5 + 0.5;
  vec3 col = mix(
    vec3(0.80, 0.05, 0.05),  // back: dark red
    vec3(1.00, 1.00, 1.00),  // front: white
    smoothstep(0.12, 0.88, t)
  );
  col *= 1.0 + core * 0.60;

  gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────
// State config → [speedMult, energy]
// ─────────────────────────────────────────────────────────────────
const STATE_CFG: Record<string, [number, number]> = {
  standby:   [0.20, 0.26],
  scanning:  [0.75, 0.58],
  analyzing: [1.70, 0.92],
  reasoning: [1.25, 0.78],
  listening: [0.40, 0.40],
  speaking:  [0.85, 0.68],
};

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
interface Props {
  brainState:  string;
  voiceStatus: string;
  isActive:    boolean;
  isThinking:  boolean;
}

const N = 3000; // total scattered particles

export const OrbitalParticleSystem = memo(function OrbitalParticleSystem({
  brainState, voiceStatus,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ brainState, voiceStatus });
  stateRef.current = { brainState, voiceStatus };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true, antialias: false, powerPreference: 'high-performance',
      });
    } catch { return; }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
    camera.position.set(0, 0, 2.5);
    camera.lookAt(0, -0.2, 0);

    const resize = () => {
      const w = Math.max(mount.clientWidth, 1), h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ── Build random scatter particle positions ────────────────
    const aBase  = new Float32Array(N * 3);
    const aFreq  = new Float32Array(N * 3);
    const aPhase = new Float32Array(N);
    const aDrift = new Float32Array(N);
    const aSize  = new Float32Array(N);
    const aAlpha = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      // Random position in a 3D sphere (non-uniform density — denser near center)
      // Use power distribution for density gradient
      const r     = 0.25 + Math.pow(Math.random(), 0.6) * 2.2;
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);

      aBase[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      aBase[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      aBase[i*3+2] = r * Math.cos(phi);

      // Per-axis drift frequencies (slow organic motion)
      aFreq[i*3]   = 0.08 + Math.random() * 0.25;
      aFreq[i*3+1] = 0.06 + Math.random() * 0.20;
      aFreq[i*3+2] = 0.10 + Math.random() * 0.22;

      aPhase[i] = Math.random() * Math.PI * 6.28;

      // Drift amplitude: smaller near core, larger far out
      aDrift[i] = 0.04 + (r / 2.2) * 0.18 + Math.random() * 0.10;

      // Size: mostly tiny with a few bright ones
      const roll = Math.random();
      aSize[i] = roll < 0.05 ? 3.5 + Math.random() * 2.5   // bright sparks (5%)
               : roll < 0.25 ? 1.8 + Math.random() * 1.5   // medium (20%)
               :               0.8 + Math.random() * 1.0;   // tiny (75%)

      // Alpha: inner particles brighter
      const distFactor = 1.0 - Math.min(r / 2.5, 1.0) * 0.5;
      aAlpha[i] = (0.25 + Math.random() * 0.45) * distFactor;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aBase',  new THREE.BufferAttribute(aBase,  3));
    geo.setAttribute('aFreq',  new THREE.BufferAttribute(aFreq,  3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(aDrift, 1));
    geo.setAttribute('aSize',  new THREE.BufferAttribute(aSize,  1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:     { value: 0 },
      uSpeed:    { value: 0.20 },
      uEnergy:   { value: 0.26 },
      uVoice:    { value: 0 },
      uConverge: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    // ── Animation loop ─────────────────────────────────────────
    let sSpeed = 0.20, sEnergy = 0.26, sVoice = 0;
    let convergeTimer = 0, prevState = brainState;
    let rafId = 0;
    const clock = new THREE.Clock();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const [tSpeed, tEnergy] = STATE_CFG[bs] ?? STATE_CFG.standby;
      const lf = 0.030;
      sSpeed  += (tSpeed  - sSpeed)  * lf;
      sEnergy += (tEnergy - sEnergy) * lf;

      // Voice amplitude
      const tVoice =
        vs === 'speaking'  ? 0.40 + Math.sin(elapsed * 7.5) * 0.25 + Math.sin(elapsed * 14) * 0.15
        : vs === 'listening' ? 0.10 + Math.sin(elapsed * 2.2) * 0.08
        : 0;
      sVoice += (tVoice - sVoice) * 0.10;

      // Convergence on state transition to analyzing
      if (bs !== prevState) {
        if (bs === 'analyzing') convergeTimer = elapsed;
        prevState = bs;
      }
      let converge = 0;
      if (convergeTimer > 0) {
        const dt = elapsed - convergeTimer;
        if      (dt < 0.7) converge = dt / 0.7;
        else if (dt < 1.3) converge = 1.0 - (dt - 0.7) / 0.6;
        else               { convergeTimer = 0; converge = 0; }
      }

      uniforms.uTime.value     = elapsed;
      uniforms.uSpeed.value    = sSpeed;
      uniforms.uEnergy.value   = sEnergy;
      uniforms.uVoice.value    = Math.max(0, sVoice);
      uniforms.uConverge.value = converge;

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      scene.remove(pts);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div ref={mountRef} className="absolute inset-0"
      style={{ zIndex: 8, pointerEvents: 'none' }}/>
  );
});
