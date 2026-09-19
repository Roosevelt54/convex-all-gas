import { useEffect, useRef } from "react";

/**
 * The Crewcall mark as a genuinely 3D object: a thick extruded "C" that turns a full 360 on its
 * vertical axis, so you see the front face, then the depth of its side wall, then the back.
 *
 * Built by hand — the ring is extruded into quads, each quad is lit by its own normal, and the
 * quads are painted back-to-front. No 3D library, nothing extra to download.
 */
type V = { x: number; y: number; z: number };
type Quad = { v: [V, V, V, V]; n: V; tone: number };

const GAP_START = -0.62; // radians: where the C opens
const GAP_END = 0.62;
const R_OUT = 1;
const R_IN = 0.56;
const DEPTH = 0.46; // the "good thickness" — front face to back face
const SEGMENTS = 64;

/** Build the extruded ring once: front face, back face, outer and inner walls, and the two caps. */
function buildMark(): Quad[] {
  const quads: Quad[] = [];
  const zF = -DEPTH / 2;
  const zB = DEPTH / 2;
  const span = Math.PI * 2 - (GAP_END - GAP_START);
  const at = (i: number) => GAP_END + (i / SEGMENTS) * span;
  const p = (ang: number, r: number, z: number): V => ({ x: Math.cos(ang) * r, y: Math.sin(ang) * r, z });

  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = at(i);
    const a1 = at(i + 1);
    const mid = (a0 + a1) / 2;

    // Front and back faces. Their normals point straight out along z.
    quads.push({
      v: [p(a0, R_IN, zF), p(a0, R_OUT, zF), p(a1, R_OUT, zF), p(a1, R_IN, zF)],
      n: { x: 0, y: 0, z: -1 },
      tone: 1,
    });
    quads.push({
      v: [p(a0, R_IN, zB), p(a1, R_IN, zB), p(a1, R_OUT, zB), p(a0, R_OUT, zB)],
      n: { x: 0, y: 0, z: 1 },
      tone: 0.82,
    });
    // Outer wall — this is the band you see as the mark turns edge-on.
    quads.push({
      v: [p(a0, R_OUT, zF), p(a0, R_OUT, zB), p(a1, R_OUT, zB), p(a1, R_OUT, zF)],
      n: { x: Math.cos(mid), y: Math.sin(mid), z: 0 },
      tone: 0.94,
    });
    // Inner wall, normal pointing back at the hole's centre.
    quads.push({
      v: [p(a0, R_IN, zF), p(a1, R_IN, zF), p(a1, R_IN, zB), p(a0, R_IN, zB)],
      n: { x: -Math.cos(mid), y: -Math.sin(mid), z: 0 },
      tone: 0.66,
    });
  }

  // The two flat ends of the C.
  for (const [ang, sign] of [
    [GAP_END, 1],
    [GAP_START, -1],
  ] as const) {
    const n = { x: -Math.sin(ang) * sign, y: Math.cos(ang) * sign, z: 0 };
    const face: [V, V, V, V] = [p(ang, R_IN, zF), p(ang, R_OUT, zF), p(ang, R_OUT, zB), p(ang, R_IN, zB)];
    quads.push({ v: sign === 1 ? face : ([...face].reverse() as [V, V, V, V]), n, tone: 0.75 });
  }

  return quads;
}

export default function LandingBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const quads = buildMark();
    const light = { x: -0.45, y: -0.62, z: -0.65 };

    let raf = 0;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      w = rect.width;
      h = rect.height;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const frame = (t: number) => {
      // A full turn roughly every 11 seconds: readable, never frantic.
      const spin = reduced.matches ? 0.9 : (t / 11000) * Math.PI * 2;
      const tilt = -0.22; // a slight lean so the top face catches the light
      const cosA = Math.cos(spin);
      const sinA = Math.sin(spin);
      const cosB = Math.cos(tilt);
      const sinB = Math.sin(tilt);
      const R = Math.min(w, h) * 0.22;
      const cx = w / 2;
      const cy = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      const rotate = (v: V): V => {
        const x1 = v.x * cosA - v.z * sinA; // yaw: the 360 spin
        const z1 = v.x * sinA + v.z * cosA;
        const y1 = v.y * cosB - z1 * sinB; // pitch: the fixed lean
        const z2 = v.y * sinB + z1 * cosB;
        return { x: x1, y: y1, z: z2 };
      };
      const project = (v: V) => {
        const scale = 3.4 / (3.4 + v.z);
        return { sx: cx + v.x * R * scale, sy: cy + v.y * R * scale };
      };

      // Transform, drop the faces pointing away, then paint far ones first.
      const drawable = [];
      for (const q of quads) {
        const n = rotate(q.n);
        if (n.z > 0.02) continue; // back-facing
        const v = q.v.map(rotate) as [V, V, V, V];
        const depth = (v[0].z + v[1].z + v[2].z + v[3].z) / 4;
        const lam = Math.max(0, -(n.x * light.x + n.y * light.y + n.z * light.z));
        drawable.push({ v, depth, shade: q.tone * (0.28 + lam * 0.85) });
      }
      drawable.sort((a, b) => b.depth - a.depth);

      for (const f of drawable) {
        const pts = f.v.map(project);
        const level = Math.min(1, f.shade);
        // The mark's own blue, lit: dark in shadow, near-white on the face that faces the light.
        const r = Math.round(30 + level * 130);
        const g = Math.round(52 + level * 140);
        const b = Math.round(96 + level * 150);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.moveTo(pts[0].sx, pts[0].sy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.closePath();
        ctx.fill();
        // Hairline of the same colour closes the seams between adjacent quads.
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    resize();
    start();

    // The first measurement can land before layout settles, which would leave a 0x0 canvas.
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas className="lp__backdrop" ref={ref} aria-hidden="true" />;
}
