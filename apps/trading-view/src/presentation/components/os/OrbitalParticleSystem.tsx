'use client';

// =================================================================
// ScatteredParticleField v3 — Full-screen uniform star nebula
// Orthographic camera → guarantees edge-to-edge coverage.
// 8000 cyan particles, two-layer density (dense inner + wide outer).
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';

const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uVoice;
uniform float uSpeed;

attribute vec2  aPos;     // base 2D position (ortho units)
attribute float aZ;       // shallow z for layering
attribute vec2  aFreq;    // drift frequencies x/y
attribute float aPhase;
attribute float aDrift;
attribute float aSize;
attribute float aAlpha;

varying float vAlpha;

void main() {
  float t = uTime * uSpeed;

  float amp = aDrift * (1.0 + uEnergy * 0.50 + uVoice * 0.80);
  float dx = sin(t * aFreq.x + aPhase * 3.91) * amp;
  float dy = cos(t * aFreq.y + aPhase * 5.37) * amp;

  vec3 pos = vec3(aPos.x + dx, aPos.y + dy, aZ);

  float energyA = 0.35 + uEnergy * 0.65;
  float voiceA  = 1.00 + uVoice  * 0.70;
  vAlpha = clamp(aAlpha * energyA * voiceA, 0.0, 0.95);

  gl_PointSize = clamp(aSize * (1.0 + uVoice * 0.50 + uEnergy * 0.30), 0.5, 12.0);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const FS = /* glsl */`
precision mediump float;

varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.28, d);
  float halo = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.80 + halo * 0.20) * vAlpha;

  // Cyan: #00e5ff  rgb(0, 0.898, 1.0)
  vec3 col = vec3(0.10 + core * 0.55, 0.92 + core * 0.08, 1.00);
  col *= 1.0 + core * 0.55;   // brighten core

  gl_FragColor = vec4(col, alpha);
}
`;

const STATE_CFG: Record<string, [number, number]> = {
  standby:   [0.10, 0.32],
  scanning:  [0.42, 0.62],
  analyzing: [0.95, 0.95],
  reasoning: [0.68, 0.80],
  listening: [0.18, 0.42],
  speaking:  [0.48, 0.68],
};

interface Props {
  brainState:  string;
  voiceStatus: string;
  isActive:    boolean;
  isThinking:  boolean;
}

const N = 8000;

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

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    // Orthographic camera — 1 unit = half the viewport height
    // Aspect ratio handled in resize
    let aspect = 1;
    const CAM_H = 1.0;  // half-height in world units
    const camera = new THREE.OrthographicCamera(
      -CAM_H * aspect, CAM_H * aspect,
       CAM_H, -CAM_H, 0.01, 10,
    );
    camera.position.z = 2;

    const resize = () => {
      const w = Math.max(mount.clientWidth, 1);
      const h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      aspect = w / h;
      camera.left   = -CAM_H * aspect;
      camera.right  =  CAM_H * aspect;
      camera.top    =  CAM_H;
      camera.bottom = -CAM_H;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ── Build particle data ────────────────────────────────────────
    const aPos   = new Float32Array(N * 2);
    const aZ     = new Float32Array(N);
    const aFreq  = new Float32Array(N * 2);
    const aPhase = new Float32Array(N);
    const aDrift = new Float32Array(N);
    const aSize  = new Float32Array(N);
    const aAlpha = new Float32Array(N);

    // World units: camera half-height = 1.0, aspect ~= 1.8
    // So visible range is ±1.0 vertically, ±1.8 horizontally
    // We'll scatter up to ±1.15 vertical, ±2.1 horizontal (slight bleed)
    const HH = 1.15;   // half-height (just beyond viewport edge)
    const HW = 2.10;   // half-width  (for ~1.82 aspect, with bleed)

    for (let i = 0; i < N; i++) {
      const zone = Math.random();

      let x: number, y: number;
      if (zone < 0.30) {
        // Inner cluster — denser around center
        const r     = 0.05 + Math.pow(Math.random(), 0.5) * 0.65;
        const theta = Math.random() * Math.PI * 2;
        x = r * Math.cos(theta) * 1.3;
        y = r * Math.sin(theta);
      } else {
        // Full-screen uniform scatter
        x = (Math.random() * 2 - 1) * HW;
        y = (Math.random() * 2 - 1) * HH;
      }

      aPos[i*2]   = x;
      aPos[i*2+1] = y;
      aZ[i]       = (Math.random() - 0.5) * 0.4;

      aFreq[i*2]   = 0.03 + Math.random() * 0.12;
      aFreq[i*2+1] = 0.04 + Math.random() * 0.10;
      aPhase[i]    = Math.random() * Math.PI * 6.28;

      // Drift: tiny, star-like shimmer
      aDrift[i] = 0.003 + Math.random() * 0.018;

      // Size: heavily weighted toward small
      const roll = Math.random();
      aSize[i]   = roll < 0.025 ? 5.0 + Math.random() * 4.0   // bright sparks (2.5%)
                 : roll < 0.12  ? 2.5 + Math.random() * 2.0   // medium (10%)
                 : roll < 0.40  ? 1.4 + Math.random() * 1.2   // small-med (28%)
                 :                0.7 + Math.random() * 0.8;   // tiny (60%)

      // Alpha — inner area brighter, outer slightly sparser
      const dist  = Math.sqrt(x*x + y*y) / Math.sqrt(HW*HW + HH*HH);
      const fade  = 0.55 + (1.0 - dist) * 0.45;
      aAlpha[i]   = (0.20 + Math.random() * 0.60) * fade;
    }

    // geometry — position attr is dummy (we drive from aPos in shader)
    const geo = new THREE.BufferGeometry();
    const dummyPos = new Float32Array(N * 3); // kept at origin; shader uses aPos
    geo.setAttribute('position', new THREE.BufferAttribute(dummyPos, 3));
    geo.setAttribute('aPos',   new THREE.BufferAttribute(aPos,   2));
    geo.setAttribute('aZ',     new THREE.BufferAttribute(aZ,     1));
    geo.setAttribute('aFreq',  new THREE.BufferAttribute(aFreq,  2));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(aDrift, 1));
    geo.setAttribute('aSize',  new THREE.BufferAttribute(aSize,  1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:   { value: 0 },
      uSpeed:  { value: 0.10 },
      uEnergy: { value: 0.32 },
      uVoice:  { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    // ── Animation loop ──────────────────────────────────────────────
    let sSpeed = 0.10, sEnergy = 0.32, sVoice = 0;
    let rafId = 0;
    const clock = new THREE.Clock();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const [tSpeed, tEnergy] = STATE_CFG[bs] ?? STATE_CFG.standby;
      const lf = 0.022;
      sSpeed  += (tSpeed  - sSpeed)  * lf;
      sEnergy += (tEnergy - sEnergy) * lf;

      const tVoice =
        vs === 'speaking'  ? 0.40 + Math.sin(elapsed * 7.5) * 0.25 + Math.sin(elapsed * 13) * 0.15
        : vs === 'listening' ? 0.10 + Math.sin(elapsed * 2.3) * 0.07
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
