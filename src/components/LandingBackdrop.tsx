import { useEffect, useRef } from "react";

/**
 * The slow 3D field behind the hero: a rotating sphere of points with a few bright "shifts"
 * travelling along its arcs, drawn with a real perspective projection on a 2D canvas.
 *
 * Deliberately cheap: ~420 points, one canvas, no libraries. It stops entirely when the tab is
 * hidden or the visitor asks for reduced motion, so it never burns a phone battery.
 */
type P = { x: number; y: number; z: number };

function sphere(count: number, radius: number): P[] {
  const pts: P[] = [];
  // Fibonacci sphere: evenly spread without clustering at the poles.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius });
  }
  return pts;
}

export default function LandingBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const points = sphere(420, 1);
    const sparks = Array.from({ length: 7 }, (_, i) => ({
      phase: (i / 7) * Math.PI * 2,
      tilt: (i / 7) * Math.PI - Math.PI / 2,
      speed: 0.22 + (i % 3) * 0.07,
    }));

    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      if (w === 0 || h === 0) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number) => {
      const a = reduced.matches ? 0.6 : t / 9000; // yaw
      const b = Math.sin(a * 0.6) * 0.32; // gentle pitch wobble
      const radius = Math.min(w, h) * 0.42;
      const cx = w / 2;
      const cy = h * 0.52;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const cosB = Math.cos(b);
      const sinB = Math.sin(b);

      ctx.clearRect(0, 0, w, h);

      const project = (p: P) => {
        const x1 = p.x * cosA - p.z * sinA;
        const z1 = p.x * sinA + p.z * cosA;
        const y1 = p.y * cosB - z1 * sinB;
        const z2 = p.y * sinB + z1 * cosB;
        // Perspective: nearer points sit further out and draw larger.
        const scale = 2.6 / (2.6 + z2);
        return { sx: cx + x1 * radius * scale, sy: cy + y1 * radius * scale, depth: z2, scale };
      };

      for (const p of points) {
        const { sx, sy, depth, scale } = project(p);
        const front = (1 - (depth + 1) / 2) * 0.85 + 0.15;
        ctx.globalAlpha = 0.1 + front * 0.5;
        ctx.fillStyle = "#dfe6f2";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.4, scale * 1.5), 0, Math.PI * 2);
        ctx.fill();
      }

      // The bright ones: a spot being claimed, travelling its arc.
      for (const s of sparks) {
        const u = reduced.matches ? s.phase : s.phase + (t / 1000) * s.speed;
        const p = {
          x: Math.cos(u) * Math.cos(s.tilt),
          y: Math.sin(s.tilt),
          z: Math.sin(u) * Math.cos(s.tilt),
        };
        const { sx, sy, depth, scale } = project(p);
        const front = 1 - (depth + 1) / 2;
        ctx.globalAlpha = 0.25 + front * 0.75;
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 26 * scale);
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.35, "rgba(160,190,255,0.35)");
        glow.addColorStop(1, "rgba(160,190,255,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy, 26 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (raf) return;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    resize();
    if (reduced.matches) draw(0);
    else start();

    // The first measurement can land before layout settles, which would leave a 0x0 canvas.
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced.matches) draw(0);
    });
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
