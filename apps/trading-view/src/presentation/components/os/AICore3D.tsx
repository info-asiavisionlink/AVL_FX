"use client";

// =================================================================
// AICore3D — Canvas-based JARVIS-style 3D neural sphere
// No external deps. Uses requestAnimationFrame + Canvas2D API.
// =================================================================

import { useEffect, useRef } from "react";
import type { AIMode }       from "@/application/stores/aiOSStore";

interface Props {
  mode:        AIMode;
  isActive:    boolean;
  isThinking:  boolean;
  voiceStatus: string;
  width?:      number;
  height?:     number;
}

const NEON: Record<AIMode, [number,number,number]> = {
  analysis:   [0,   229, 255],
  monitor:    [255, 215, 0  ],
  assisted:   [0,   255, 136],
  autonomous: [255, 26,  78 ],
};

interface Node3D { x:number; y:number; z:number; ph:number; sp:number; tier:number; }

export function AICore3D({ mode, isActive, isThinking, voiceStatus, width=540, height=540 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const animRef   = useRef({ rotY:0, rotX:0, targetRotX:0, t:0 });
  const nodesRef  = useRef<Node3D[]>([]);
  const SPHERE_R  = Math.min(width, height) * 0.295;

  useEffect(() => {
    const N = 110;
    const φ = Math.PI * (3 - Math.sqrt(5));
    nodesRef.current = Array.from({ length: N }, (_, i) => {
      const y = 1 - (i / (N-1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y*y));
      const θ = φ * i;
      return {
        x:    r * Math.cos(θ) * SPHERE_R,
        y:    y * SPHERE_R,
        z:    r * Math.sin(θ) * SPHERE_R,
        ph:   Math.random() * Math.PI * 2,
        sp:   0.3 + Math.random() * 0.9,
        tier: i % 11 === 0 ? 2 : i % 7 === 0 ? 1 : 0, // 0=primary 1=red 2=orange
      };
    });
  }, [SPHERE_R]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
    canvas.style.width  = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const CX = width  / 2;
    const CY = height / 2 - 20;
    const [pr, pg, pb] = NEON[mode];

    const rgba  = (a: number) => `rgba(${pr},${pg},${pb},${a})`;
    const rdRed = (a: number) => `rgba(255,80,80,${a})`;
    const rdOrn = (a: number) => `rgba(255,160,40,${a})`;

    // Project 3D → 2D with perspective
    const proj = (x:number, y:number, z:number, rx:number, ry:number) => {
      const cy2 = Math.cos(ry), sy2 = Math.sin(ry);
      const x2  = x*cy2 + z*sy2;
      const z2  = -x*sy2 + z*cy2;
      const cx3 = Math.cos(rx), sx3 = Math.sin(rx);
      const y3  = y*cx3 - z2*sx3;
      const z3  = y*sx3 + z2*cx3;
      const FOV = 520;
      const sc  = FOV / (FOV + z3 + 60);
      return { px: x2*sc, py: y3*sc, dz: z3, sc };
    };

    // Rotated point on ring in local space
    const ringPt = (θ:number, incX:number, incZ:number, animT:number, speed:number) => {
      const lx = SPHERE_R * Math.cos(θ);
      const lz = SPHERE_R * Math.sin(θ);
      const sX = Math.sin(incX), cX = Math.cos(incX);
      const sZ = Math.sin(incZ), cZ = Math.cos(incZ);
      const rx_w = lx*cZ - lz*sZ*sX;
      const ry_w = lx*sZ + lz*cZ;
      const rz_w = -lx*sX*cZ + lz*cX;
      const aAng = animT * speed;
      const ca = Math.cos(aAng), sa = Math.sin(aAng);
      return { wx: rx_w*ca + rz_w*sa, wy: ry_w, wz: -rx_w*sa + rz_w*ca };
    };

    const orbDefs = [
      { incX: 0.85,  incZ: 0,    speed: 0.4,  colFn: rgba,  ptCol: rgba,  ptN: 3 },
      { incX: -0.5,  incZ: 1.3,  speed: -0.3, colFn: rdRed, ptCol: rdRed, ptN: 4 },
      { incX: 1.2,   incZ: 0.7,  speed: 0.2,  colFn: rdOrn, ptCol: rdOrn, ptN: 3 },
    ];

    const render = () => {
      const a = animRef.current;
      const speed = isThinking ? 0.014 : isActive ? 0.009 : 0.005;
      a.t     += speed;
      a.rotY  += isActive ? 0.007 : 0.004;
      a.rotX  += (a.targetRotX - a.rotX) * 0.04;
      const { rotY, rotX, t } = a;

      ctx.clearRect(0, 0, width, height);

      // ── Background sphere glow ──
      const bg = ctx.createRadialGradient(CX, CY, 0, CX, CY, SPHERE_R*1.9);
      bg.addColorStop(0,   rgba(isActive ? 0.20 : 0.12));
      bg.addColorStop(0.3, rgba(0.07));
      bg.addColorStop(0.7, rgba(0.02));
      bg.addColorStop(1,   rgba(0));
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Outer boundary circle
      ctx.beginPath();
      ctx.arc(CX, CY, SPHERE_R+14, 0, Math.PI*2);
      ctx.strokeStyle = rgba(0.10);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Second outer ring
      ctx.beginPath();
      ctx.arc(CX, CY, SPHERE_R+28, 0, Math.PI*2);
      ctx.strokeStyle = rgba(0.04);
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // ── Orbital rings ──
      orbDefs.forEach((orb, oi) => {
        const steps = 72;
        let prevP: {px:number;py:number;dz:number} | null = null;

        for (let s = 0; s <= steps; s++) {
          const θ = (s / steps) * Math.PI * 2;
          const { wx, wy, wz } = ringPt(θ, orb.incX, orb.incZ, t, orb.speed);
          const p = proj(wx, wy, wz, rotX, rotY);
          const depth = (p.dz + SPHERE_R) / (2 * SPHERE_R);
          if (prevP) {
            ctx.beginPath();
            ctx.moveTo(CX+prevP.px, CY+prevP.py);
            ctx.lineTo(CX+p.px, CY+p.py);
            ctx.strokeStyle = orb.colFn(Math.max(0, depth * 0.38));
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          prevP = p;
        }

        // Orbital particles
        for (let pi = 0; pi < orb.ptN; pi++) {
          const offset = (pi / orb.ptN) * Math.PI * 2;
          const θ = (t * (orb.speed > 0 ? 0.9 : -0.9) + offset) % (Math.PI*2);
          const { wx, wy, wz } = ringPt(θ, orb.incX, orb.incZ, t, orb.speed);
          const p = proj(wx, wy, wz, rotX, rotY);
          const depth = (p.dz + SPHERE_R) / (2*SPHERE_R);
          if (depth < 0.05) continue;
          const alpha = depth * 0.95;
          const sz = (3.5 + oi*0.5) * p.sc;

          // Glow
          const grd = ctx.createRadialGradient(CX+p.px, CY+p.py, 0, CX+p.px, CY+p.py, sz*5);
          grd.addColorStop(0, orb.ptCol(alpha*0.7));
          grd.addColorStop(1, orb.ptCol(0));
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(CX+p.px, CY+p.py, sz*5, 0, Math.PI*2);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(CX+p.px, CY+p.py, sz, 0, Math.PI*2);
          ctx.fillStyle = orb.ptCol(Math.min(1, alpha));
          ctx.fill();
        }
      });

      // ── Sphere nodes & connections ──
      const projs = nodesRef.current.map(n => {
        const p     = proj(n.x, n.y, n.z, rotX, rotY);
        const pulse = 0.65 + 0.35 * Math.sin(t * n.sp + n.ph);
        const depth = (p.dz + SPHERE_R) / (2*SPHERE_R);
        return { ...p, pulse, depth, ox:n.x, oy:n.y, oz:n.z, tier:n.tier };
      }).sort((a,b) => a.dz - b.dz);

      // Connections (only front-facing, limited by distance)
      for (let i = 0; i < projs.length; i++) {
        const A = projs[i];
        if (A.depth < 0.08) continue;
        for (let j = i+1; j < projs.length; j++) {
          const B = projs[j];
          if (B.depth < 0.08) continue;
          const dx = A.ox-B.ox, dy = A.oy-B.oy, dz = A.oz-B.oz;
          const d3 = Math.sqrt(dx*dx+dy*dy+dz*dz);
          if (d3 > SPHERE_R * 0.58) continue;
          const fade  = 1 - d3/(SPHERE_R*0.58);
          const alpha = fade * Math.min(A.depth, B.depth) * 0.18;
          if (alpha < 0.01) continue;
          ctx.beginPath();
          ctx.moveTo(CX+A.px, CY+A.py);
          ctx.lineTo(CX+B.px, CY+B.py);
          ctx.strokeStyle = rgba(alpha);
          ctx.lineWidth   = 0.5;
          ctx.stroke();
        }
      }

      // Nodes
      projs.forEach(p => {
        if (p.depth < 0.04) return;
        const sz    = Math.max(0.5, 2.8 * p.sc * p.pulse);
        const alpha = Math.min(1, p.depth * p.pulse * 1.1);
        const cFn   = p.tier === 1 ? rdRed : p.tier === 2 ? rdOrn : rgba;

        const grd = ctx.createRadialGradient(CX+p.px, CY+p.py, 0, CX+p.px, CY+p.py, sz*5);
        grd.addColorStop(0, cFn(alpha*0.55));
        grd.addColorStop(1, cFn(0));
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(CX+p.px, CY+p.py, sz*5, 0, Math.PI*2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(CX+p.px, CY+p.py, sz, 0, Math.PI*2);
        ctx.fillStyle = cFn(alpha);
        ctx.fill();
      });

      // ── Center Core ──
      const corePulse = isThinking
        ? 0.8 + 0.2 * Math.sin(t * 5)
        : 0.88 + 0.12 * Math.sin(t * 2);
      const coreR = (isActive ? 50 : 36) * corePulse;

      const coreG = ctx.createRadialGradient(CX, CY, 0, CX, CY, coreR*3);
      coreG.addColorStop(0,    `rgba(255,255,255,${isActive ? 1 : 0.85})`);
      coreG.addColorStop(0.08, rgba(0.95));
      coreG.addColorStop(0.25, rgba(0.5));
      coreG.addColorStop(0.55, rgba(0.15));
      coreG.addColorStop(1,    rgba(0));
      ctx.fillStyle = coreG;
      ctx.beginPath();
      ctx.arc(CX, CY, coreR*3, 0, Math.PI*2);
      ctx.fill();

      // Expanding pulse rings
      if (isActive) {
        [0, 0.33, 0.66].forEach(ph => {
          const prog = ((t*0.5 + ph) % 1);
          const rr   = coreR + prog * SPHERE_R * 0.95;
          const aa   = (1 - prog) * 0.42;
          ctx.beginPath();
          ctx.arc(CX, CY, rr, 0, Math.PI*2);
          ctx.strokeStyle = rgba(aa);
          ctx.lineWidth   = 1.5;
          ctx.stroke();
        });
      }

      // ── Platform rings (base) ──
      const platY = CY + SPHERE_R + 10;
      [1.1, 0.78, 0.52].forEach((sc, i) => {
        const ph2 = ((t*0.22 + i*0.38) % 1);
        const aa  = 0.18 + (1-ph2) * 0.15;
        ctx.beginPath();
        ctx.ellipse(CX, platY + i*14, SPHERE_R*sc, 17*sc, 0, 0, Math.PI*2);
        ctx.strokeStyle = rgba(aa - ph2*0.1);
        ctx.lineWidth   = 0.9 + (1-ph2)*0.6;
        ctx.stroke();
      });

      // Ground light beam
      const beamG = ctx.createLinearGradient(CX-SPHERE_R*0.6, platY, CX+SPHERE_R*0.6, platY);
      beamG.addColorStop(0, rgba(0));
      beamG.addColorStop(0.35, rgba(0.4));
      beamG.addColorStop(0.65, rgba(0.4));
      beamG.addColorStop(1, rgba(0));
      ctx.fillStyle = beamG;
      ctx.fillRect(CX-SPHERE_R*0.6, platY-0.5, SPHERE_R*1.2, 1.5);

      rafRef.current = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isActive, isThinking, voiceStatus, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const y    = (e.clientY - rect.top - rect.height/2) / rect.height;
      animRef.current.targetRotX = y * 0.32;
    };
    canvas.addEventListener("mousemove", onMove);
    return () => canvas.removeEventListener("mousemove", onMove);
  }, []);

  return <canvas ref={canvasRef} className="cursor-move select-none block" />;
}
