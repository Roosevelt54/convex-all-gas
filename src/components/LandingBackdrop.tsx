import { useEffect, useRef } from "react";

/**
 * The actual Crewcall mark, extruded into a solid and turned a full 360.
 *
 * The mark is the rounded blue square from the masthead (.wordmark__mark): a squircle badge
 * carrying a large light dot and a smaller one to its right — the "call going out". Here it is a
 * real slab with thickness, so the turn shows its face, then its edge, then its back.
 *
 * Built by hand: the outline is extruded into wall quads, faces and dots are drawn as polygons on
 * the face planes, and everything is painted back-to-front. No 3D library.
 */
type V = { x: number; y: number; z: number };
type Face = { pts: V[]; n: V; color: [number, number, number]; tone: number };

const HALF = 1; // half the badge's width
const CORNER = 0.42; // corner radius, matching the 7px radius on a 26px mark
const DEPTH = 0.52; // the slab's thickness
const BLUE: [number, number, number] = [143, 180, 255]; // --accent-0
const LIGHT: [number, number, number] = [244, 244, 242]; // --text, the dots

/** The badge outline: a rounded square, walked anticlockwise. */
function outline(): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const k = HALF - CORNER;
  const corners: [number, number, number][] = [
    [k, k, 0], // centre x, centre y, start angle quadrant
    [-k, k, Math.PI / 2],
    [-k, -k, Math.PI],
    [k, -k, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * CORNER, y: cy + Math.sin(a) * CORNER });
    }
  }
  return pts;
}

/** A dot on a face plane, as a polygon. */
function disc(cx: number, cy: number, r: number, z: number): V[] {
  const pts: V[] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, z });
  }
  return pts;
}

function buildMark(): Face[] {
  const faces: Face[] = [];
  const ring = outline();
  const zF = -DEPTH / 2;
  const zB = DEPTH / 2;

  // Front and back of the badge.
  faces.push({
    pts: ring.map((p) => ({ x: p.x, y: p.y, z: zF })),
    n: { x: 0, y: 0, z: -1 },
    color: BLUE,
    tone: 1,
  });
  faces.push({
    pts: ring.map((p) => ({ x: p.x, y: p.y, z: zB })).reverse(),
    n: { x: 0, y: 0, z: 1 },
    color: BLUE,
    tone: 0.86,
  });

  // The side wall: one quad per outline segment, each lit by its own outward normal.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    faces.push({
      pts: [
        { x: a.x, y: a.y, z: zF },
        { x: a.x, y: a.y, z: zB },
        { x: b.x, y: b.y, z: zB },
        { x: b.x, y: b.y, z: zF },
      ],
      n: { x: ey / len, y: -ex / len, z: 0 },
      color: BLUE,
      tone: 0.9,
    });
  }

  // The two dots, on both faces, lifted a hair off the surface so they always paint on top.
  const lift = 0.004;
  for (const [z, n, tone] of [
    [zF - lift, { x: 0, y: 0, z: -1 }, 1],
    [zB + lift, { x: 0, y: 0, z: 1 }, 0.86],
  ] as const) {
    const big = disc(-0.12, 0, 0.30, z);
    const small = disc(0.42, 0, 0.19, z);
    faces.push({ pts: n.z < 0 ? big : [...big].reverse(), n, color: LIGHT, tone });
    faces.push({ pts: n.z < 0 ? small : [...small].reverse(), n, color: LIGHT, tone });
  }

  return faces;
}

export default function LandingBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const faces = buildMark();
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
      const spin = reduced.matches ? 0.7 : (t / 11000) * Math.PI * 2;
      const tilt = -0.2; // a slight lean so the top edge catches the light
      const cosA = Math.cos(spin);
      const sinA = Math.sin(spin);
      const cosB = Math.cos(tilt);
      const sinB = Math.sin(tilt);
      const R = Math.min(w, h) * 0.24;
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
        const scale = 3.6 / (3.6 + v.z);
        return { sx: cx + v.x * R * scale, sy: cy + v.y * R * scale };
      };

      const drawable = [];
      for (const f of faces) {
        const n = rotate(f.n);
        if (n.z > 0.02) continue; // pointing away from the camera
        const pts = f.pts.map(rotate);
        let depth = 0;
        for (const p of pts) depth += p.z;
        depth /= pts.length;
        const lam = Math.max(0, -(n.x * light.x + n.y * light.y + n.z * light.z));
        drawable.push({ pts, depth, color: f.color, shade: f.tone * (0.55 + lam * 0.6) });
      }
      drawable.sort((a, b) => b.depth - a.depth);

      for (const f of drawable) {
        const pts = f.pts.map(project);
        const level = Math.min(1, f.shade);
        const [r, g, b] = f.color;
        ctx.fillStyle = `rgb(${Math.round(r * level)},${Math.round(g * level)},${Math.round(b * level)})`;
        ctx.beginPath();
        ctx.moveTo(pts[0].sx, pts[0].sy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.closePath();
        ctx.fill();
        // A hairline of the same colour closes the seams between adjacent quads.
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
