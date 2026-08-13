'use client';

// =================================================================
// ScatteredParticleField v2 — Full-screen cyan star scatter
// 5000 particles spread across the entire viewport like a nebula.
// Cyan (#00e5ff) color, soft drift, AI-state reactive brightness.
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────
// Vertex Shader
// ─────────────────────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uVoice;
uniform float uSpeed;

attribute vec3  aBase;
attribute vec3  aFreq;
attribute float aPhase;
attribute float aDrift;
attribute float aSize;
attribute float aAlpha;

varying float vAlpha;
varying float vDist;   // normalized distance from center 0..1

void main() {
  float t = uTime * uSpeed;

  // Very slow organic drift — like stars slowly shifting
  float amp = aDrift * (1.0 + uEnergy * 0.40 + uVoice * 0.60);
  vec3 drift = vec3(
    sin(t * aFreq.x + aPhase * 3.71) * amp,
    cos(t * aFreq.y + aPhase * 5.23) * amp,
    sin(t * aFreq.z + aPhase * 2.17) * amp * 0.30
  );

  vec3 pos = aBase + drift;

  vDist  = clamp(length(aBase.xy) / 3.5, 0.0, 1.0);

  // Alpha — energy brightens, voice pulses, outer stars slightly dimmer
  float outerFade = 0.60 + 0.40 * (1.0 - vDist * 0.5);
  float energyA   = 0.30 + uEnergy * 0.70;
  float voiceA    = 1.0  + uVoice  * 0.50;
  vAlpha = clamp(aAlpha * outerFade * energyA * voiceA, 0.0, 0.92);

  // Size — voice makes them twinkle bigger
  gl_PointSize = clamp(aSize * (1.0 + uVoice * 0.45 + uEnergy * 0.25), 0.4, 10.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// Fragment Shader — soft glow dot, cyan tinted
// ─────────────────────────────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;

varying float vAlpha;
varying float vDist;

// Cyan base; outer particles slightly cooler
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.30, d);
  float halo = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.75 + halo * 0.25) * vAlpha;

  // Cyan (#00e5ff) with tiny warm/cool variation per depth
  vec3 colInner = vec3(0.55, 1.00, 1.00);   // bright cyan-white
  vec3 colOuter = vec3(0.00, 0.80, 0.90);   // deeper teal
  vec3 col = mix(colInner, colOuter, vDist);
  col *= 1.0 + core * 0.45;

  gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────
// State config — [speedMult, energy]
// ─────────────────────────────────────────────────────────────────
const STATE_CFG: Record<string, [number, number]> = {
  standby:   [0.12, 0.28],
  scanning:  [0.40, 0.55],
  analyzing: [0.90, 0.90],
  reasoning: [0.65, 0.75],
  listening: [0.20, 0.38],
  speaking:  [0.45, 0.62],
};

interface Props {
  brainState:  string;
  voiceStatus: string;
  isActive:    boolean;
  isThinking:  boolean;
}

// 5000 particles spread across a wide flat disc (+depth)
const N = 5000;

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
    // Wide FOV + pulled back camera → particles cover entire viewport
    const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 80);
    camera.position.set(0, 0, 3.2);
    camera.lookAt(0, 0, 0);

    const resize = () => {
      const w = Math.max(mount.clientWidth, 1), h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ── Particle attribute arrays ─────────────────────────────────
    const aBase  = new Float32Array(N * 3);
    const aFreq  = new Float32Array(N * 3);
    const aPhase = new Float32Array(N);
    const aDrift = new Float32Array(N);
    const aSize  = new Float32Array(N);
    const aAlpha = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      // Wide, roughly flat scatter — fill the full screen edge-to-edge.
      // X/Y from -4 to +4 (more than viewport), Z shallow ±0.8
      // Use two zones: dense inner cloud + sparse outer field
      const zone = Math.random();
      let x: number, y: number, z: number;

      if (zone < 0.45) {
        // Inner cloud around center (radius 0.3 – 2.2), denser
        const r     = 0.3 + Math.pow(Math.random(), 0.55) * 1.9;
        const theta = Math.random() * Math.PI * 2;
        x = r * Math.cos(theta);
        y = r * Math.sin(theta);
        z = (Math.random() - 0.5) * 1.2;
      } else {
        // Outer scatter — fills corners and edges
        x = (Math.random() * 2 - 1) * 4.2;
        y = (Math.random() * 2 - 1) * 4.2;
        z = (Math.random() - 0.5) * 0.8;
      }

      aBase[i*3]   = x;
      aBase[i*3+1] = y;
      aBase[i*3+2] = z;

      // Very slow drift frequencies
      aFreq[i*3]   = 0.04 + Math.random() * 0.14;
      aFreq[i*3+1] = 0.03 + Math.random() * 0.12;
      aFreq[i*3+2] = 0.05 + Math.random() * 0.10;

      aPhase[i] = Math.random() * Math.PI * 6.28;

      // Drift amplitude — tiny, just gentle shimmer
      const r2    = Math.sqrt(x*x + y*y);
      aDrift[i]   = 0.02 + (r2 / 4.0) * 0.06 + Math.random() * 0.04;

      // Size distribution: mostly tiny stars, few bright
      const roll  = Math.random();
      aSize[i]    = roll < 0.03 ? 4.0 + Math.random() * 3.0   // bright sparks (3%)
                  : roll < 0.18 ? 1.8 + Math.random() * 1.6   // medium (15%)
                  :               0.6 + Math.random() * 1.0;   // tiny (82%)

      // Alpha — inner brighter, outer sparser
      const distR = Math.sqrt(x*x + y*y);
      const fade  = Math.max(0, 1.0 - distR / 5.0);
      aAlpha[i]   = (0.15 + Math.random() * 0.55) * (0.4 + fade * 0.6);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aBase',  new THREE.BufferAttribute(aBase,  3));
    geo.setAttribute('aFreq',  new THREE.BufferAttribute(aFreq,  3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(aDrift, 1));
    geo.setAttribute('aSize',  new THREE.BufferAttribute(aSize,  1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:   { value: 0 },
      uSpeed:  { value: 0.12 },
      uEnergy: { value: 0.28 },
      uVoice:  { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    // ── Animation loop ─────────────────────────────────────────────
    let sSpeed = 0.12, sEnergy = 0.28, sVoice = 0;
    let rafId = 0;
    const clock = new THREE.Clock();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const [tSpeed, tEnergy] = STATE_CFG[bs] ?? STATE_CFG.standby;
      const lf = 0.025;
      sSpeed  += (tSpeed  - sSpeed)  * lf;
      sEnergy += (tEnergy - sEnergy) * lf;

      const tVoice =
        vs === 'speaking'  ? 0.35 + Math.sin(elapsed * 8.0) * 0.22 + Math.sin(elapsed * 13) * 0.12
        : vs === 'listening' ? 0.08 + Math.sin(elapsed * 2.5) * 0.06
        : 0;
      sVoice += (tVoice - sVoice) * 0.09;

      uniforms.uTime.value   = elapsed;
      uniforms.uSpeed.value  = sSpeed;
      uniforms.uEnergy.value = sEnergy;
      uniforms.uVoice.value  = Math.max(0, sVoice);

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
