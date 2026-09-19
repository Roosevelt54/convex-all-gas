import { useEffect, useRef } from "react";

/**
 * The dark globe behind the hero.
 *
 * A black sphere with a dotted surface, a latitude/longitude wireframe and a lit rim, drawn with a
 * real perspective projection on a 2D canvas — no 3D library, nothing to download. It spins slowly
 * on its own and leans toward the pointer, easing into the new angle rather than snapping.
 *
 * Only the front hemisphere is drawn (points whose rotated z faces the camera), which is what makes
 * it read as a solid body instead of a cloud of dots.
 */
type P = { x: number; y: number; z: number };

/** Evenly spread surface points — Fibonacci, so nothing clusters at the poles. */
function surface(count: number): P[] {
  const pts: P[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

/** Meridians and parallels, as point paths so they can be depth-culled per point. */
function wireframe(): P[][] {
  const lines: P[][] = [];
  const STEPS = 90;
  for (let m = 0; m < 12; m++) {
    const lon = (m / 12) * Math.PI * 2;
    const line: P[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const lat = -Math.PI / 2 + (i / STEPS) * Math.PI;
      line.push({ x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon) });
    }
    lines.push(line);
  }
  for (let p = 1; p < 7; p++) {
    const lat = -Math.PI / 2 + (p / 7) * Math.PI;
    const line: P[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const lon = (i / STEPS) * Math.PI * 2;
      line.push({ x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon) });
    }
    lines.push(line);
  }
  return lines;
}

export default function LandingBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const points = surface(1300);
    const lines = wireframe();
    // Bright "spots being claimed" that ride the surface.
    const sparks = Array.from({ length: 6 }, (_, i) => ({
      lon: (i / 6) * Math.PI * 2,
      lat: -0.7 + (i % 4) * 0.42,
      speed: 0.16 + (i % 3) * 0.06,
    }));

    let raf = 0;
    let w = 0;
    let h = 0;
    // Where the pointer wants the globe, and where it currently is. The gap is eased every frame.
    let targetYaw = 0;
    let targetPitch = -0.12;
    let yaw = 0;
    let pitch = -0.12;
    let last = 0;

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

    const onPointer = (e: PointerEvent) => {
      // -1..1 across the viewport, then a gentle lean: never a full spin, so it stays calm.
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      targetYaw = nx * 0.75;
      targetPitch = -0.12 + ny * 0.45;
    };

    const frame = (t: number) => {
      const dt = last === 0 ? 16 : Math.min(64, t - last);
      last = t;

      // Constant slow spin, plus the pointer's lean eased in at ~4%/frame.
      const spin = reduced.matches ? 0.6 : t / 14000;
      yaw += (targetYaw - yaw) * (1 - Math.pow(0.94, dt / 16));
      pitch += (targetPitch - pitch) * (1 - Math.pow(0.94, dt / 16));

      const a = spin + yaw;
      const b = pitch;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const cosB = Math.cos(b);
      const sinB = Math.sin(b);
      const R = Math.min(w, h) * 0.34;
      const cx = w / 2;
      const cy = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      const project = (p: P) => {
        const x1 = p.x * cosA - p.z * sinA;
        const z1 = p.x * sinA + p.z * cosA;
        const y1 = p.y * cosB - z1 * sinB;
        const z2 = p.y * sinB + z1 * cosB;
        const scale = 2.8 / (2.8 + z2);
        return { sx: cx + x1 * R * scale, sy: cy + y1 * R * scale, z: z2, scale };
      };

      // The body: a black sphere, lit from the upper left so it reads as a ball, not a disc.
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.02);
      body.addColorStop(0, "#1d1f24");
      body.addColorStop(0.55, "#101114");
      body.addColorStop(1, "#050506");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // Atmosphere: a soft lit rim just outside the edge.
      const rim = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.22);
      rim.addColorStop(0, "rgba(150,180,255,0.20)");
      rim.addColorStop(0.5, "rgba(130,165,255,0.07)");
      rim.addColorStop(1, "rgba(130,165,255,0)");
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.22, 0, Math.PI * 2);
      ctx.fill();

      // Surface stipple. Front hemisphere only; alpha falls off toward the limb.
      ctx.fillStyle = "#cfd8ea";
      for (const p of points) {
        const { sx, sy, z, scale } = project(p);
        if (z > 0.02) continue;
        const facing = Math.min(1, -z);
        ctx.globalAlpha = 0.06 + facing * 0.5;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.35, scale * 1.15), 0, Math.PI * 2);
        ctx.fill();
      }

      // Wireframe, drawn as short segments so it can be culled point by point.
      ctx.lineWidth = 1;
      for (const line of lines) {
        let drawing = false;
        ctx.beginPath();
        for (const p of line) {
          const { sx, sy, z } = project(p);
          if (z > 0) {
            drawing = false;
            continue;
          }
          if (!drawing) {
            ctx.moveTo(sx, sy);
            drawing = true;
          } else {
            ctx.lineTo(sx, sy);
          }
        }
        ctx.globalAlpha = 0.16;
        ctx.strokeStyle = "#9fb6e8";
        ctx.stroke();
      }

      // The bright ones.
      for (const s of sparks) {
        const lon = reduced.matches ? s.lon : s.lon + (t / 1000) * s.speed;
        const p = {
          x: Math.cos(s.lat) * Math.cos(lon),
          y: Math.sin(s.lat),
          z: Math.cos(s.lat) * Math.sin(lon),
        };
        const { sx, sy, z, scale } = project(p);
        if (z > 0) continue;
        const facing = Math.min(1, -z);
        ctx.globalAlpha = 0.3 + facing * 0.7;
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22 * scale);
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.3, "rgba(160,195,255,0.4)");
        glow.addColorStop(1, "rgba(160,195,255,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy, 22 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    resize();
    start();

    // The first measurement can land before layout settles, which would leave a 0x0 canvas.
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas className="lp__backdrop" ref={ref} aria-hidden="true" />;
}
