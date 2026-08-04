'use client';

// =================================================================
// ParticleTorus v2 — GPU particle torus with voice-reactive morphing
//
// IDLE      : smooth teal ring
// LISTENING : net/lattice pattern emerges  ×  gold gradient
// SPEAKING  : dramatic radial pulse bursts  ×  electric blue
// =================================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Props { voiceStatus?: string; isThinking?: boolean; }

const N = 80_000;

// ── Vertex Shader ──────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uListenBlend; // 0→1 during listening
uniform float uSpeakBlend;  // 0→1 during speaking
uniform float uThinkBlend;  // 0→1 during thinking/AI

attribute float aPhi;
attribute float aTheta;
attribute float aPhase;
attribute float aPtSize;

varying vec3  vColor;
varying float vAlpha;

#define PI 3.14159265359

void main() {
  float t = uTime;

  // ── Base wave layers (idle torus) ──────────────────────────────
  float w1 = 0.18 * sin(6.0  * aPhi  + t * 1.80 + aPhase);
  float w2 = 0.09 * sin(12.0 * aPhi  - t * 2.60 + aPhase * 1.4);
  float w3 = 0.05 * cos(4.0  * aTheta + t * 3.20 + aPhase * 2.1);
  float w4 = 0.03 * sin(20.0 * aPhi  + t * 1.10 + aPhase * 0.8);

  // ── LISTENING — high-freq net/lattice waves ────────────────────
  float wL1 = 0.13 * sin(16.0 * aPhi  + t * 3.0 + aPhase * 0.4);
  float wL2 = 0.09 * sin(11.0 * aTheta - t * 4.2 + aPhase * 0.6);

  // ── SPEAKING — expansive breathing + random burst ──────────────
  float breath  = sin(t * 3.8 + aPhase * 0.25);
  float burst   = 0.22 * breath;
  float wS = burst * uSpeakBlend;

  // ── THINKING — high-freq ring vibration (gold shimmer)──────────
  float thinkVib = uThinkBlend * 0.07 * sin(t * 8.0 + aPhi * 7.0 + aPhase * 1.8);

  float R = 1.10;
  float r = 0.28
    + w1 + w2 + w3 + w4
    + uListenBlend * (wL1 + wL2)
    + wS
    + thinkVib;

  // ── Shape morphing ─────────────────────────────────────────────
  // Speaking: ring stretches vertically (elongate tube in Y)
  float yStretch = 1.0 + uSpeakBlend * 0.4 * abs(breath);

  float x = (R + r * cos(aTheta)) * cos(aPhi);
  float y = r * sin(aTheta) * yStretch;
  float z = (R + r * cos(aTheta)) * sin(aPhi);

  vec3 pos = vec3(x, y, z);

  // ── Wave brightness ────────────────────────────────────────────
  float waveH = (w1 + w2) / 0.27;
  float pulse  = 0.5 + 0.5 * sin(t * 2.5 + aPhase * 8.7);

  // ── LISTENING — net mask: particles near grid lines stay bright ─
  // fract of (angle / 2π × divisions) → near 0 or 1 = on a wire
  float lonNorm = fract(aPhi   / (2.0 * PI) * 9.0);
  float latNorm = fract(aTheta / (2.0 * PI) * 7.0);
  float onLon   = 1.0 - smoothstep(0.0, 0.18, min(lonNorm, 1.0 - lonNorm));
  float onLat   = 1.0 - smoothstep(0.0, 0.18, min(latNorm, 1.0 - latNorm));
  float netMask = max(onLon, onLat);
  // off-grid particles fade → creates lattice/net appearance
  float netAlpha = mix(1.0, netMask * 0.85 + 0.08, uListenBlend);

  // ── SPEAKING — pulse brightness per particle ───────────────────
  float speakPulse = 1.0 + uSpeakBlend * 0.9 * abs(sin(t * 4.5 + aPhase * 2.2))
                       + uThinkBlend * 0.5 * abs(sin(t * 3.0 + aPhase * 3.0));

  // ── Color ──────────────────────────────────────────────────────
  vec3 tealColor    = vec3(0.00, 0.82, 0.76);
  // Cyan-net gradient for listening
  float goldWave    = 0.5 + 0.5 * sin(aPhi * 3.0 - t * 0.8);
  vec3 goldColor    = mix(vec3(0.00, 0.70, 0.90), vec3(0.30, 1.00, 1.00), goldWave);
  // Electric blue-white for speaking
  vec3 speakColor   = vec3(0.00, 1.00, 0.55);
  // Gold shimmer for thinking/AI — shifts phase around the ring
  float goldShift   = 0.5 + 0.5 * sin(aPhi * 5.0 - t * 1.4 + aPhase * 2.0);
  vec3 thinkColor   = mix(vec3(0.85, 0.50, 0.00), vec3(1.00, 0.90, 0.20), goldShift);

  vec3 col = mix(tealColor, goldColor, uListenBlend);
  col      = mix(col, speakColor, uSpeakBlend);
  col      = mix(col, thinkColor, uThinkBlend);

  float bright = clamp(0.45 + 0.80 * waveH, 0.0, 1.6) * speakPulse;
  vColor  = col * bright * (0.75 + 0.25 * pulse);

  // ── Alpha ──────────────────────────────────────────────────────
  vAlpha = aPtSize * (0.40 + 0.60 * pulse) * netAlpha;

  // ── Point size (listening: slightly larger; speaking: pulses) ──
  float sizeBoost = 1.0
    + uListenBlend * 0.35
    + uSpeakBlend  * 0.50 * abs(breath)
    + uThinkBlend  * 0.30 * pulse;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp(aPtSize * 95.0 / max(0.15, -mv.z) * sizeBoost, 0.5, 4.0);
  gl_Position  = projectionMatrix * mv;
}
`;

// ── Fragment Shader ────────────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;

varying vec3  vColor;
varying float vAlpha;

void main() {
  float d    = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float glow = 1.0 - smoothstep(0.0, 1.0, d);
  gl_FragColor = vec4(vColor * (0.80 + 0.20 * glow), glow * vAlpha);
}
`;

// ── Component ──────────────────────────────────────────────────────
export function ParticleTorus({ voiceStatus = 'idle', isThinking = false }: Props) {
  const mountRef     = useRef<HTMLDivElement>(null);
  const voiceRef     = useRef(voiceStatus);
  const thinkRef     = useRef(isThinking);
  voiceRef.current   = voiceStatus;
  thinkRef.current   = isThinking;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: false, alpha: true, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 30);
    camera.position.set(0, 0.15, 3.0);
    camera.lookAt(0, -0.55, 0);

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

    // ── Attributes ───────────────────────────────────────────────
    const aPhi    = new Float32Array(N);
    const aTheta  = new Float32Array(N);
    const aPhase  = new Float32Array(N);
    const aPtSize = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      aPhi[i]    = Math.random() * Math.PI * 2;
      aTheta[i]  = Math.random() * Math.PI * 2;
      aPhase[i]  = Math.random() * Math.PI * 2;
      aPtSize[i] = Math.random() < 0.85
        ? 0.4 + Math.random() * 0.5
        : 0.9 + Math.random() * 0.5;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aPhi',     new THREE.BufferAttribute(aPhi,    1));
    geo.setAttribute('aTheta',   new THREE.BufferAttribute(aTheta,  1));
    geo.setAttribute('aPhase',   new THREE.BufferAttribute(aPhase,  1));
    geo.setAttribute('aPtSize',  new THREE.BufferAttribute(aPtSize, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:        { value: 0 },
      uListenBlend: { value: 0 },
      uSpeakBlend:  { value: 0 },
      uThinkBlend:  { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VS,
      fragmentShader: FS,
      uniforms,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      transparent: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.rotation.x = 0.30;
    scene.add(pts);

    // ── Smooth blend values ────────────────────────────────────────
    let sListen = 0;
    let sSpeak  = 0;
    let sThink  = 0;
    const LF = 0.025;

    const clock = new THREE.Clock();
    let rafId = 0;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const t   = clock.getElapsedTime();
      const vs  = voiceRef.current;
      const thi = thinkRef.current;

      const tListen = vs === 'listening'  ? 1.0 : 0.0;
      const tSpeak  = vs === 'speaking'   ? 1.0 : 0.0;
      const tThink  = (thi && vs === 'idle') ? 1.0 : 0.0;
      sListen += (tListen - sListen) * LF;
      sSpeak  += (tSpeak  - sSpeak)  * LF;
      sThink  += (tThink  - sThink)  * LF;

      uniforms.uTime.value        = t;
      uniforms.uListenBlend.value = sListen;
      uniforms.uSpeakBlend.value  = sSpeak;
      uniforms.uThinkBlend.value  = sThink;

      pts.rotation.y = t * 0.15;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose();
      geo.dispose();
      mat.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 5 }}
    />
  );
}
