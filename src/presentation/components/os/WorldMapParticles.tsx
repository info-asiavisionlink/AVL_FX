'use client';

// =================================================================
// WorldMapParticles — GPU world coastline particle field
// Fetches Natural Earth 110m topology from CDN,
// samples ~15k points along coastlines, renders with Three.js
// Orthographic camera so lat/lon maps exactly to screen.
// Color: dim neon-green (#00ff88), AI-state reactive brightness.
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { GeoJSON, Feature, Polygon, MultiPolygon, Position } from 'geojson';

// ─────────────────────────────────────────────────────────────────
// Vertex Shader
// ─────────────────────────────────────────────────────────────────
const VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uVoice;

attribute vec2  aPos;
attribute float aPhase;
attribute float aSize;
attribute float aAlpha;

varying float vAlpha;

void main() {
  // Subtle shimmer — latitude breathing (coastlines gently pulse)
  float shimmer = 0.85 + 0.15 * sin(uTime * 0.4 + aPhase * 4.19);

  float energyA = 0.25 + uEnergy * 0.75;
  float voiceA  = 1.00 + uVoice  * 0.80;
  vAlpha = clamp(aAlpha * shimmer * energyA * voiceA, 0.0, 0.95);

  gl_PointSize = clamp(aSize * (1.0 + uEnergy * 0.25 + uVoice * 0.40), 0.5, 4.5);
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(aPos.x, aPos.y, 0.0, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// Fragment Shader — neon-green glow dot
// ─────────────────────────────────────────────────────────────────
const FS = /* glsl */`
precision mediump float;
varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.30, d);
  float halo = 1.0 - smoothstep(0.0, 1.00, d);
  float alpha = (core * 0.80 + halo * 0.20) * vAlpha;

  // Neon green #00ff88
  vec3 col = vec3(0.00, 1.00, 0.53);
  col *= 1.0 + core * 0.60;

  gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────
// AI state → energy
// ─────────────────────────────────────────────────────────────────
const STATE_ENERGY: Record<string, number> = {
  standby:   0.25,
  scanning:  0.55,
  analyzing: 0.90,
  reasoning: 0.75,
  listening: 0.38,
  speaking:  0.62,
};

// ─────────────────────────────────────────────────────────────────
// Coordinate helpers
// ─────────────────────────────────────────────────────────────────
function lonLatToWorld(lon: number, lat: number, hw: number, hh: number): [number, number] {
  return [(lon / 180) * hw, (lat / 90) * hh];
}

function sampleRing(ring: Position[], stepDeg: number, hw: number, hh: number): [number,number][] {
  const pts: [number,number][] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / stepDeg));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      pts.push(lonLatToWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, hw, hh));
    }
  }
  return pts;
}

function extractPoints(geojson: GeoJSON, hw: number, hh: number, targetN: number): [number,number][] {
  const raw: [number,number][] = [];
  const stepDeg = 1.5; // sample every 1.5° along each edge

  const processGeom = (geom: Polygon | MultiPolygon) => {
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) raw.push(...sampleRing(ring, stepDeg, hw, hh));
    } else {
      for (const poly of geom.coordinates)
        for (const ring of poly) raw.push(...sampleRing(ring, stepDeg, hw, hh));
    }
  };

  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) {
      const g = (f as Feature).geometry;
      if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) processGeom(g as Polygon | MultiPolygon);
    }
  }

  if (raw.length <= targetN) return raw;
  const step = raw.length / targetN;
  return Array.from({ length: targetN }, (_, i) => raw[Math.floor(i * step)]);
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
interface Props {
  brainState:  string;
  voiceStatus: string;
}

const TARGET_N = 15000;
const CAM_H    = 1.0;   // orthographic half-height in world units
const MAP_HH   = 0.95;  // map half-height (slightly inset)
const MAP_HW   = 1.75;  // map half-width (for 16:9 ≈ 1.8)

export const WorldMapParticles = memo(function WorldMapParticles({ brainState, voiceStatus }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ brainState, voiceStatus });
  stateRef.current = { brainState, voiceStatus };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
    } catch { return; }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-CAM_H, CAM_H, CAM_H, -CAM_H, 0.01, 10);
    camera.position.z = 2;

    let aspect = 1;
    const resize = () => {
      const w = Math.max(mount.clientWidth, 1);
      const h = Math.max(mount.clientHeight, 1);
      renderer.setSize(w, h);
      aspect = w / h;
      camera.left   = -CAM_H * aspect;
      camera.right  =  CAM_H * aspect;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ── Animation state ─────────────────────────────────────────
    let sEnergy = 0.25, sVoice = 0;
    let rafId   = 0;
    let pts: THREE.Points | null = null;
    const clock = new THREE.Clock();
    const uniforms: Record<string, THREE.IUniform> = {
      uTime:   { value: 0 },
      uEnergy: { value: 0.25 },
      uVoice:  { value: 0 },
    };

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const tEnergy = STATE_ENERGY[bs] ?? 0.25;
      sEnergy += (tEnergy - sEnergy) * 0.025;

      const tVoice =
        vs === 'speaking'  ? 0.35 + Math.sin(elapsed * 7.0) * 0.20
        : vs === 'listening' ? 0.08 + Math.sin(elapsed * 2.0) * 0.05
        : 0;
      sVoice += (tVoice - sVoice) * 0.08;

      uniforms.uTime.value   = elapsed;
      uniforms.uEnergy.value = sEnergy;
      uniforms.uVoice.value  = Math.max(0, sVoice);

      renderer.render(scene, camera);
    };
    tick();

    // ── Fetch & build particle geometry (async) ──────────────────
    const controller = new AbortController();

    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json', {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((topo: Topology) => {
        if (controller.signal.aborted) return;

        const worldGeo = topojson.feature(
          topo,
          topo.objects['countries'] as GeometryCollection,
        ) as unknown as GeoJSON;

        const mapHW = MAP_HW * aspect; // adjust for current aspect
        const points = extractPoints(worldGeo, mapHW, MAP_HH, TARGET_N);
        const N = points.length;

        const aPos   = new Float32Array(N * 2);
        const aPhase = new Float32Array(N);
        const aSize  = new Float32Array(N);
        const aAlpha = new Float32Array(N);

        for (let i = 0; i < N; i++) {
          aPos[i*2]   = points[i][0];
          aPos[i*2+1] = points[i][1];
          aPhase[i]   = Math.random() * Math.PI * 6.28;

          const roll = Math.random();
          aSize[i]   = roll < 0.04 ? 2.8 + Math.random() * 1.6   // bright node (4%)
                     : roll < 0.20 ? 1.4 + Math.random() * 1.0   // medium (16%)
                     :               0.6 + Math.random() * 0.8;   // tiny (80%)

          aAlpha[i] = 0.12 + Math.random() * 0.28;
        }

        const geo = new THREE.BufferGeometry();
        const dummyPos = new Float32Array(N * 3); // zeros; shader uses aPos
        geo.setAttribute('position', new THREE.BufferAttribute(dummyPos, 3));
        geo.setAttribute('aPos',   new THREE.BufferAttribute(aPos,   2));
        geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
        geo.setAttribute('aSize',  new THREE.BufferAttribute(aSize,  1));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

        const mat = new THREE.ShaderMaterial({
          vertexShader: VS, fragmentShader: FS, uniforms,
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
        });

        pts = new THREE.Points(geo, mat);
        pts.frustumCulled = false;
        scene.add(pts);
      })
      .catch(() => { /* fetch aborted or network error — silently ignore */ });

    return () => {
      controller.abort();
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (pts) { scene.remove(pts); (pts.geometry as THREE.BufferGeometry).dispose(); (pts.material as THREE.Material).dispose(); }
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div ref={mountRef} className="absolute inset-0"
      style={{ zIndex: 4, pointerEvents: 'none' }}/>
  );
});
