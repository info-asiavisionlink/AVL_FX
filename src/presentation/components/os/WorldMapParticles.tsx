'use client';

// =================================================================
// WorldMapParticles v3 — Neon-blue holographic world map
// • Uniform small dots along coastlines (sharp outline)
// • Major FX city hotspots with pulse ring
// • Slow globe rotation (horizontal scroll, seamless wrap)
// • Holoram-level transparency
// =================================================================

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { GeoJSON, Feature, Polygon, MultiPolygon, Position } from 'geojson';

// ─────────────────────────────────────────────────────────────────
// Map particle VS — uniform small dots + horizontal globe rotation
// ─────────────────────────────────────────────────────────────────
const MAP_VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uVoice;
uniform float uRotOffset;  // world-unit horizontal scroll
uniform float uMapHW;      // half-width of map (for wrap)

attribute vec2  aPos;
attribute float aPhase;
attribute float aAlpha;

varying float vAlpha;

void main() {
  // Seamless horizontal wrap for globe-scroll
  float x = mod(aPos.x + uRotOffset + uMapHW, 2.0 * uMapHW) - uMapHW;

  float shimmer = 0.90 + 0.10 * sin(uTime * 0.6 + aPhase * 3.71);
  float voiceA  = 1.0 + uVoice * 0.60;
  vAlpha = clamp(aAlpha * shimmer * voiceA, 0.0, 1.0);

  gl_PointSize = 2.8;  // uniform: slightly larger for visibility
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(x, aPos.y, 0.0, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// Map particle FS — neon blue
// ─────────────────────────────────────────────────────────────────
const MAP_FS = /* glsl */`
precision mediump float;
varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.5, d);
  float halo = 1.0 - smoothstep(0.0, 1.0, d);
  float a = (core * 0.8 + halo * 0.2) * vAlpha;
  // Neon blue bright
  vec3 col = vec3(0.1, 0.65, 1.0) * (1.0 + core * 0.5);
  gl_FragColor = vec4(col, a);
}
`;

// ─────────────────────────────────────────────────────────────────
// City VS — pulsing hotspot with glow ring
// ─────────────────────────────────────────────────────────────────
const CITY_VS = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uRotOffset;
uniform float uMapHW;

attribute vec2  aPos;
attribute float aPhase;
attribute float aLayerSize; // 0=core, 1=ring1, 2=ring2

varying float vAlpha;
varying float vLayer;

void main() {
  float x = mod(aPos.x + uRotOffset + uMapHW, 2.0 * uMapHW) - uMapHW;

  float pulse = 0.5 + 0.5 * sin(uTime * 2.2 + aPhase);
  vLayer = aLayerSize;

  // Core: always bright; rings: pulse
  float a = aLayerSize < 0.5
    ? 0.90 + 0.10 * pulse
    : aLayerSize < 1.5
      ? pulse * 0.70
      : pulse * 0.35;
  vAlpha = clamp(a, 0.0, 1.0);

  float sz = aLayerSize < 0.5 ? 5.0
           : aLayerSize < 1.5 ? 10.0 + pulse * 6.0
           :                    18.0 + pulse * 8.0;
  gl_PointSize = sz;
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(x, aPos.y, 0.0, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────
// City FS — bright neon blue core + ring halo
// ─────────────────────────────────────────────────────────────────
const CITY_FS = /* glsl */`
precision mediump float;
varying float vAlpha;
varying float vLayer;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  vec3 col;
  float a;
  if (vLayer < 0.5) {
    // Core: white-blue bright dot
    float c = 1.0 - smoothstep(0.0, 0.5, d);
    col = vec3(0.6, 0.85, 1.0);
    a   = c * vAlpha;
  } else {
    // Ring: thin edge
    float ring = smoothstep(0.60, 0.75, d) * (1.0 - smoothstep(0.85, 1.0, d));
    col = vec3(0.0, 0.60, 1.0);
    a   = ring * vAlpha;
  }
  gl_FragColor = vec4(col, a);
}
`;

// ─────────────────────────────────────────────────────────────────
// AI state → energy
// ─────────────────────────────────────────────────────────────────
const STATE_ENERGY: Record<string, number> = {
  standby:   0.75, scanning: 0.90, analyzing: 1.00,
  reasoning: 0.95, listening: 0.80, speaking: 0.90,
};

// ─────────────────────────────────────────────────────────────────
// Major FX market cities [lon, lat, name]
// ─────────────────────────────────────────────────────────────────
const CITIES: [number, number, string][] = [
  [ 139.69,  35.69, 'Tokyo'     ],
  [ -74.01,  40.71, 'New York'  ],
  [  -0.13,  51.51, 'London'    ],
  [ 103.82,   1.35, 'Singapore' ],
  [ 114.17,  22.32, 'Hong Kong' ],
  [ 151.21, -33.87, 'Sydney'    ],
  [   8.68,  50.11, 'Frankfurt' ],
  [  55.27,  25.20, 'Dubai'     ],
];

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function lonLatToWorld(lon: number, lat: number, hw: number, hh: number): [number,number] {
  return [(lon / 180) * hw, (lat / 90) * hh];
}

function sampleRing(ring: Position[], stepDeg: number, hw: number, hh: number): [number,number][] {
  const pts: [number,number][] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const len = Math.hypot(x1-x0, y1-y0);
    const n   = Math.max(1, Math.round(len / stepDeg));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      pts.push(lonLatToWorld(x0+(x1-x0)*t, y0+(y1-y0)*t, hw, hh));
    }
  }
  return pts;
}

function extractPoints(geo: GeoJSON, hw: number, hh: number, targetN: number): [number,number][] {
  const raw: [number,number][] = [];
  const step = 0.8; // denser sampling for sharper outline
  const process = (g: Polygon | MultiPolygon) => {
    if (g.type === 'Polygon') {
      for (const r of g.coordinates) raw.push(...sampleRing(r, step, hw, hh));
    } else {
      for (const poly of g.coordinates) for (const r of poly) raw.push(...sampleRing(r, step, hw, hh));
    }
  };
  if (geo.type === 'FeatureCollection') {
    for (const f of geo.features) {
      const g = (f as Feature).geometry;
      if (g?.type === 'Polygon' || g?.type === 'MultiPolygon') process(g as Polygon|MultiPolygon);
    }
  }
  if (raw.length <= targetN) return raw;
  const skip = raw.length / targetN;
  return Array.from({ length: targetN }, (_, i) => raw[Math.floor(i * skip)]);
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
interface Props { brainState: string; voiceStatus: string; }

const TARGET_N      = 25000;
const CAM_H         = 1.0;
const ROT_SPEED     = 0.006; // world-units per second (~3 min per full rotation)

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
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mount.appendChild(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-CAM_H, CAM_H, CAM_H, -CAM_H, 0.01, 10);
    camera.position.z = 2;

    let aspect = 1;
    const resize = () => {
      const w = Math.max(mount.clientWidth,1), h = Math.max(mount.clientHeight,1);
      renderer.setSize(w, h);
      aspect = w / h;
      camera.left = -CAM_H*aspect; camera.right = CAM_H*aspect;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount); resize();

    // ── Shared uniforms ─────────────────────────────────────────
    const mapUniforms: Record<string, THREE.IUniform> = {
      uTime:      { value: 0 },
      uEnergy:    { value: 0.75 },
      uVoice:     { value: 0 },
      uRotOffset: { value: 0 },
      uMapHW:     { value: CAM_H * aspect },
    };
    const cityUniforms: Record<string, THREE.IUniform> = {
      uTime:      { value: 0 },
      uEnergy:    { value: 0.75 },
      uRotOffset: { value: 0 },
      uMapHW:     { value: CAM_H * aspect },
    };

    // ── Animation ───────────────────────────────────────────────
    let sEnergy = 0.75, sVoice = 0;
    let rafId   = 0;
    let mapPts:  THREE.Points | null = null;
    let cityPts: THREE.Points | null = null;
    const clock = new THREE.Clock();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const elapsed = clock.getElapsedTime();
      const { brainState: bs, voiceStatus: vs } = stateRef.current;

      const tEnergy = STATE_ENERGY[bs] ?? 0.75;
      sEnergy += (tEnergy - sEnergy) * 0.025;

      const tVoice = vs === 'speaking'  ? 0.30 + Math.sin(elapsed*7)*0.20
                   : vs === 'listening' ? 0.08
                   : 0;
      sVoice += (tVoice - sVoice) * 0.08;

      const rotOffset = elapsed * ROT_SPEED;
      const mapHW     = CAM_H * aspect;

      mapUniforms.uTime.value      = elapsed;
      mapUniforms.uEnergy.value    = sEnergy;
      mapUniforms.uVoice.value     = Math.max(0, sVoice);
      mapUniforms.uRotOffset.value = rotOffset;
      mapUniforms.uMapHW.value     = mapHW;

      cityUniforms.uTime.value      = elapsed;
      cityUniforms.uEnergy.value    = sEnergy;
      cityUniforms.uRotOffset.value = rotOffset;
      cityUniforms.uMapHW.value     = mapHW;

      renderer.render(scene, camera);
    };
    tick();

    // ── Build city geometry (immediate — no fetch needed) ────────
    const buildCities = (mapHW: number, mapHH: number) => {
      // 3 layers per city: core(0), ring1(1), ring2(2)
      const LAYERS = 3;
      const NC = CITIES.length * LAYERS;
      const aPos       = new Float32Array(NC * 2);
      const aPhase     = new Float32Array(NC);
      const aLayerSize = new Float32Array(NC);
      const dummyPos   = new Float32Array(NC * 3);

      CITIES.forEach(([lon, lat, ], ci) => {
        const [wx, wy] = lonLatToWorld(lon, lat, mapHW, mapHH);
        for (let l = 0; l < LAYERS; l++) {
          const idx = ci * LAYERS + l;
          aPos[idx*2] = wx; aPos[idx*2+1] = wy;
          aPhase[idx]     = ci * 1.37 + l * 0.93;
          aLayerSize[idx] = l;
        }
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',   new THREE.BufferAttribute(dummyPos,   3));
      geo.setAttribute('aPos',       new THREE.BufferAttribute(aPos,       2));
      geo.setAttribute('aPhase',     new THREE.BufferAttribute(aPhase,     1));
      geo.setAttribute('aLayerSize', new THREE.BufferAttribute(aLayerSize, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

      const mat = new THREE.ShaderMaterial({
        vertexShader: CITY_VS, fragmentShader: CITY_FS, uniforms: cityUniforms,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      });
      cityPts = new THREE.Points(geo, mat);
      cityPts.frustumCulled = false;
      scene.add(cityPts);
    };

    // ── Fetch world topology ─────────────────────────────────────
    const ctrl = new AbortController();

    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json', { signal: ctrl.signal })
      .then(r => r.json())
      .then((topo: Topology) => {
        if (ctrl.signal.aborted) return;

        const mapHW  = CAM_H * aspect;
        const mapHH  = CAM_H * 0.98;

        const geo2d = topojson.feature(
          topo, topo.objects['countries'] as GeometryCollection,
        ) as unknown as GeoJSON;

        const pts = extractPoints(geo2d, mapHW, mapHH, TARGET_N);
        const N   = pts.length;

        const aPos   = new Float32Array(N * 2);
        const aPhase = new Float32Array(N);
        const aAlpha = new Float32Array(N);
        const dummy  = new Float32Array(N * 3);

        for (let i = 0; i < N; i++) {
          aPos[i*2] = pts[i][0]; aPos[i*2+1] = pts[i][1];
          aPhase[i] = Math.random() * Math.PI * 6.28;
          aAlpha[i] = 0.70 + Math.random() * 0.30; // 0.70〜1.0
        }

        mapUniforms.uMapHW.value = mapHW;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(dummy, 3));
        geo.setAttribute('aPos',     new THREE.BufferAttribute(aPos,  2));
        geo.setAttribute('aPhase',   new THREE.BufferAttribute(aPhase,1));
        geo.setAttribute('aAlpha',   new THREE.BufferAttribute(aAlpha,1));
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

        const mat = new THREE.ShaderMaterial({
          vertexShader: MAP_VS, fragmentShader: MAP_FS, uniforms: mapUniforms,
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
        });
        mapPts = new THREE.Points(geo, mat);
        mapPts.frustumCulled = false;
        scene.add(mapPts);

        buildCities(mapHW, mapHH);
      })
      .catch(() => {});

    return () => {
      ctrl.abort();
      cancelAnimationFrame(rafId);
      ro.disconnect();
      [mapPts, cityPts].forEach(p => {
        if (!p) return;
        scene.remove(p);
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
      });
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="absolute inset-0" style={{ zIndex: 4, pointerEvents: 'none' }}/>;
});
