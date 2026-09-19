import { useEffect, useRef } from "react";

/**
 * The Crewcall mark as a solid, turning a full 360.
 *
 * The mark is the masthead badge (.wordmark__mark): a rounded blue square carrying a large light
 * dot with a small one to its right. Proportions are taken straight from that CSS — a 26px badge,
 * 7px corner radius, a 10px dot and a 4px companion 8px to its right — so the 3D version is the
 * same logo, given thickness.
 *
 * Rendering: because the badge is convex, its silhouette at any angle is the convex hull of the
 * front and back outlines. Drawing back face → hull → front face → dots keeps the edges clean at
 * every angle, which per-quad painting could not.
 */
type V = { x: number; y: number; z: number };
type P2 = { sx: number; sy: number };

const HALF = 1; // half the badge's width (13px in the real mark)
const CORNER = 7 / 13; // 7px radius on a 26px badge
const DEPTH = 0.62; // slab thickness, front face to back face
const DOT_R = 5 / 13; // the 10px dot
const DOT_X = -1 / 13; // sits just left of centre, as the box-shadow pair does
const PIP_R = 2 / 13; // the 4px companion (10px dot, -3px spread)
const PIP_X = DOT_X + 8 / 13; // 8px to the right of it

/** The badge outline, as a closed loop of points. */
function outline(): V[] {
  const pts: V[] = [];
  const k = HALF - CORNER;
  const corners: [number, number, number][] = [
    [k, k, 0],
    [-k, k, Math.PI / 2],
    [-k, -k, Math.PI],
    [k, -k, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (i / 10) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * CORNER, y: cy + Math.sin(a) * CORNER, z: 0 });
    }
  }
  return pts;
}

function disc(cx: number, cy: number, r: number): V[] {
  const pts: V[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, z: 0 });
  }
  return pts;
}

/** Convex hull (monotone chain) — the silhouette of a convex slab at any angle. */
function hull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a.sx - b.sx || a.sy - b.sy);
  const cross = (o: P2, a: P2, b: P2) =>
    (a.sx - o.sx) * (b.sy - o.sy) - (a.sy - o.sy) * (b.sx - o.sx);
  const build = (src: P2[]) => {
    const out: P2[] = [];
    for (const pt of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop();
      out.push(pt);
    }
    out.pop();
    return out;
  };
  return [...build(p), ...build([...p].reverse())];
}

export default function LandingBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ring = outline();
    const dot = disc(DOT_X, 0, DOT_R);
    const pip = disc(PIP_X, 0, PIP_R);

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
      const spin = reduced.matches ? 0.6 : (t / 11000) * Math.PI * 2;
      const tilt = -0.18;
      const cosA = Math.cos(spin);
      const sinA = Math.sin(spin);
      const cosB = Math.cos(tilt);
      const sinB = Math.sin(tilt);
      const R = Math.min(w, h) * 0.26;
      const cx = w / 2;
      const cy = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      const at = (v: V, z: number): P2 => {
        const x1 = v.x * cosA - z * sinA; // yaw: the 360 spin
        const z1 = v.x * sinA + z * cosA;
        const y1 = v.y * cosB - z1 * sinB; // pitch: a fixed lean
        const z2 = v.y * sinB + z1 * cosB;
        const scale = 3.6 / (3.6 + z2);
        return { sx: cx + x1 * R * scale, sy: cy + y1 * R * scale };
      };
      const fill = (pts: P2[], color: string) => {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pts[0].sx, pts[0].sy);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      };

      const zF = -DEPTH / 2;
      const zB = DEPTH / 2;
      // Which face is toward the camera: the sign of the rotated z of the face normal.
      const frontTowardsCamera = -cosA * cosB < 0 ? 1 : -1;
      const near = frontTowardsCamera === 1 ? zF : zB;
      const far = frontTowardsCamera === 1 ? zB : zF;

      const nearRing = ring.map((v) => at(v, near));
      const farRing = ring.map((v) => at(v, far));

      // Far face, then the side wall as one clean silhouette, then the near face on top.
      fill(farRing, "rgb(38,55,92)");
      fill(hull([...nearRing, ...farRing]), "rgb(62,88,140)");
      // How square-on the near face is — its brightness, so the turn reads as a turn.
      const facing = Math.abs(cosA * cosB);
      const lit = 0.55 + facing * 0.45;
      fill(nearRing, `rgb(${Math.round(143 * lit)},${Math.round(180 * lit)},${Math.round(255 * lit)})`);

      // The dots ride the near face. They vanish naturally as it turns edge-on.
      if (facing > 0.06) {
        const dotColor = `rgb(${Math.round(244 * lit)},${Math.round(246 * lit)},${Math.round(250 * lit)})`;
        fill(dot.map((v) => at(v, near - 0.004)), dotColor);
        fill(pip.map((v) => at(v, near - 0.004)), dotColor);
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
