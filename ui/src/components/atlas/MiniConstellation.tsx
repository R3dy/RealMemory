import { memo, useEffect, useRef } from 'react';
import type { GraphEdge, Memory } from '@/lib/data';
import { TYPE_COLORS, EDGE_COLORS } from '@/lib/colors';

/** Deterministic PRNG (mulberry32) seeded from the domain name. */
function seedFrom(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface P3 {
  x: number;
  y: number;
  z: number;
}

const MAX_NODES = 42;
const MAX_EDGES = 90;
const BASE_SPEED = (Math.PI * 2) / 6000; // 6s per revolution

/**
 * MiniConstellation — domains.md §2.
 * Cheap 2D-canvas projection of a slowly rotating 3D point cloud for one domain:
 * type-colored dots + edge lines. Hover: rotation ×3, nodes brighten.
 * Isolated rAF loop + memo so parent re-renders never reset the animation.
 */
export default memo(function MiniConstellation({
  domain,
  nodes,
  edges,
  width = 220,
  height = 180,
}: {
  domain: string;
  nodes: Memory[];
  edges: GraphEdge[];
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef(false);
  const dataRef = useRef({ domain, nodes, edges });
  dataRef.current = { domain, nodes, edges };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // --- pre-compute deterministic 3D layout (fibonacci sphere + jitter) ---
    const rand = seedFrom(dataRef.current.domain);
    const shown = [...dataRef.current.nodes].sort((a, b) => b.weight - a.weight).slice(0, MAX_NODES);
    const pts: P3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    const n = Math.max(1, shown.length);
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / Math.max(1, n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const jitter = 0.55 + rand() * 0.45;
      pts.push({
        x: Math.cos(theta) * r * jitter,
        y: y * jitter * 0.72, // squash for a lobe feel
        z: Math.sin(theta) * r * jitter,
      });
    }
    const idxById = new Map(shown.map((m, i) => [m.id, i]));
    const links = dataRef.current.edges
      .filter((e) => idxById.has(e.source) && idxById.has(e.target))
      .slice(0, MAX_EDGES)
      .map((e) => ({
        a: idxById.get(e.source)!,
        b: idxById.get(e.target)!,
        color: EDGE_COLORS[e.type],
      }));

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // --- render loop ---
    let raf = 0;
    let visible = true;
    let angle = rand() * Math.PI * 2;
    let speed = reduced ? 0 : BASE_SPEED;
    let last = performance.now();
    let t0 = last;

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(canvas);

    const R = Math.min(width, height) * 0.42;
    const cx = width / 2;
    const cy = height / 2;
    const F = 3.2; // perspective focal

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - last);
      last = now;
      if (!visible) return;

      // lerp rotation speed toward hover target
      const target = reduced ? 0 : hoverRef.current ? BASE_SPEED * 3 : BASE_SPEED;
      speed += (target - speed) * 0.08;
      angle += speed * dt;

      // entrance: nodes pop in scale 0→1, staggered ~3ms
      const intro = Math.min(1, (now - t0) / 600);

      ctx.clearRect(0, 0, width, height);

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const tilt = 0.35;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);

      // rotate Y then tilt X; perspective project
      const proj: { x: number; y: number; s: number; z: number }[] = pts.map((p) => {
        const x1 = p.x * cosA + p.z * sinA;
        const z1 = -p.x * sinA + p.z * cosA;
        const y1 = p.y * cosT - z1 * sinT;
        const z2 = p.y * sinT + z1 * cosT;
        const s = F / (F + z2);
        return { x: cx + x1 * R * s, y: cy + y1 * R * s, s, z: z2 };
      });

      const bright = hoverRef.current ? 1.5 : 1;

      // edges first (back → front)
      const sortedLinks = [...links].sort(
        (l1, l2) => proj[l1.a].z + proj[l1.b].z - (proj[l2.a].z + proj[l2.b].z),
      );
      for (const l of sortedLinks) {
        const pa = proj[l.a];
        const pb = proj[l.b];
        const depth = (pa.s + pb.s) / 2;
        ctx.strokeStyle = l.color;
        ctx.globalAlpha = 0.14 * depth * bright;
        ctx.lineWidth = 0.7 * depth;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      // nodes (back → front)
      const order = shown.map((_, i) => i).sort((a, b) => proj[a].z - proj[b].z);
      for (const i of order) {
        const m = shown[i];
        const p = proj[i];
        const pop = Math.min(1, Math.max(0, intro * (shown.length + 6) - i) / 6);
        if (pop <= 0) continue;
        const color = TYPE_COLORS[m.type];
        const r = Math.max(0.8, (1.1 + m.weight * 2.4) * p.s * pop * (hoverRef.current ? 1.15 : 1));
        // halo
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
        grad.addColorStop(0, color + '55');
        grad.addColorStop(1, color + '00');
        ctx.globalAlpha = Math.min(1, 0.5 * bright) * pop;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        // core
        ctx.globalAlpha = Math.min(1, (0.55 + 0.45 * p.s) * bright) * pop;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      onMouseEnter={() => (hoverRef.current = true)}
      onMouseLeave={() => (hoverRef.current = false)}
      style={{ width, height, display: 'block' }}
      aria-label={`${domain} mini constellation`}
    />
  );
});
