import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls, Stars } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import gsap from 'gsap';
import type { GraphEdge, Memory } from '@/lib/data';
import { TYPE_COLORS, EDGE_COLORS, domainColor } from '@/lib/colors';
import { computeBrainLayout } from '@/lib/brain-layout';
import { useUiStore } from '@/lib/ui-store';
import type { ColorMode } from '@/lib/ui-store';
import { getGlowTexture, getBoltTexture } from './textures';
import BrainShell from './BrainShell';
import MemoryLabels from './MemoryLabels';
import { CEREBRUM } from './brain-mesh';

// ---------------------------------------------------------------------------
// Shared scene data
// ---------------------------------------------------------------------------

interface SceneData {
  positions: [number, number, number][];
  baseColors: THREE.Color[];
  recent: boolean[]; // updated < 24h → breathing
  curves: THREE.Curve<THREE.Vector3>[];
  edgeColors: THREE.Color[];
  edgeConnected: Set<number>[]; // per-node connected edge indices
  neighbors: Set<number>[]; // per-node neighbor node indices
  edgeEnds: [number, number][]; // per-edge [sourceIndex, targetIndex]
  weight: number[];
  access: number[];
}

// ---------------------------------------------------------------------------
// Firing FX state — shared between the cascade driver, neuron flashes and
// the bolt renderer. Mutated outside React render; read every frame.
// ---------------------------------------------------------------------------

interface EdgeBurst {
  ei: number;
  start: number; // performance.now() timestamp
  dur: number;
  from: number; // node index the signal originates from
}

interface FxState {
  /** nodeIndex → flash start timestamp (soma flash) */
  flashes: Map<number, number>;
  /** active bolt bursts racing along edges */
  bursts: EdgeBurst[];
}

const MAX_BURSTS = 40;

function pushBurst(fx: FxState, burst: EdgeBurst) {
  fx.bursts.push(burst);
  if (fx.bursts.length > MAX_BURSTS) fx.bursts.splice(0, fx.bursts.length - MAX_BURSTS);
}

function buildSceneData(
  nodes: Memory[],
  edges: GraphEdge[],
  colorMode: ColorMode,
  regionMap: Map<string, number>,
): SceneData {
  const layout = computeBrainLayout(nodes, edges);
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const positions = nodes.map((n) => layout.get(n.id) ?? ([0, 0, 0] as [number, number, number]));
  const baseColors = nodes.map((n) =>
    new THREE.Color(colorMode === 'domain' ? domainColor(n, regionMap) : TYPE_COLORS[n.type]),
  );
  const dayMs = 86_400_000;
  const recent = nodes.map((n) => Date.now() - new Date(n.updatedAt).getTime() < dayMs);

  const v = (p: [number, number, number]) => new THREE.Vector3(p[0], p[1], p[2]);
  const curves = edges.map((e) => {
    const a = v(positions[indexOf.get(e.source)!]);
    const b = v(positions[indexOf.get(e.target)!]);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const len = a.distanceTo(b);
    const outward = mid.lengthSq() > 0.001 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0);
    // arcs bulge gently through the brain interior — clamped so they stay
    // inside the cortical shell instead of poking far outside it
    const lift = e.type === 'derived_from' ? len * 0.2 + 0.4 : len * 0.13 + 0.25;
    const ctrl = mid.clone().add(outward.multiplyScalar(lift));
    ctrl.y = Math.min(ctrl.y, CEREBRUM.cy + CEREBRUM.ry + 0.35);
    if (ctrl.length() > 7.2) ctrl.setLength(7.2);
    if (e.type === 'contradicts') {
      // jagged crackle path
      const quad = new THREE.QuadraticBezierCurve3(a, ctrl, b);
      const pts = quad.getPoints(7).map((p, i) => {
        if (i === 0 || i === 7) return p;
        const j = 0.16;
        return p.clone().add(new THREE.Vector3((Math.sin(i * 12.9) * j), (Math.cos(i * 7.7) * j), (Math.sin(i * 5.3) * j)));
      });
      return new THREE.CatmullRomCurve3(pts);
    }
    return new THREE.QuadraticBezierCurve3(a, ctrl, b);
  });
  const edgeColors = edges.map((e) => new THREE.Color(EDGE_COLORS[e.type]));

  const edgeConnected: Set<number>[] = nodes.map(() => new Set());
  const neighbors: Set<number>[] = nodes.map((_, i) => new Set([i]));
  const edgeEnds: [number, number][] = [];
  edges.forEach((e, ei) => {
    const s = indexOf.get(e.source)!;
    const t = indexOf.get(e.target)!;
    edgeConnected[s].add(ei);
    edgeConnected[t].add(ei);
    neighbors[s].add(t);
    neighbors[t].add(s);
    edgeEnds.push([s, t]);
  });

  return {
    positions,
    baseColors,
    recent,
    curves,
    edgeColors,
    edgeConnected,
    neighbors,
    edgeEnds,
    weight: nodes.map((n) => n.weight),
    access: nodes.map((n) => n.accessCount),
  };
}

// ---------------------------------------------------------------------------
// CascadeDriver — schedules neuron fires: random ambient fires every few
// seconds + a staggered signal-propagation sweep on selection.
// ---------------------------------------------------------------------------

function CascadeDriver({
  nodes,
  data,
  matchIds,
  selectedIndex,
  fireAt,
  fx,
}: {
  nodes: Memory[];
  data: SceneData;
  matchIds: Set<string>;
  selectedIndex: number;
  fireAt: number;
  fx: React.MutableRefObject<FxState>;
}) {
  const { reducedMotion } = useUiStore();
  const lastFireAt = useRef(0);

  // ambient: every ~3.5–6.5s a random visible neuron fires
  useEffect(() => {
    if (reducedMotion) return;
    let timer = 0;
    const fire = () => {
      const visible: number[] = [];
      for (let i = 0; i < nodes.length; i++) if (matchIds.has(nodes[i].id)) visible.push(i);
      if (visible.length > 0) {
        // bias toward frequently-accessed neurons
        const pool = visible.flatMap((i) => {
          const tickets = 1 + Math.min(4, Math.floor((data.access[i] ?? 1) / 8));
          return Array<number>(tickets).fill(i);
        });
        const i = pool[Math.floor(Math.random() * pool.length)];
        const now = performance.now();
        fx.current.flashes.set(i, now);
        data.edgeConnected[i].forEach((ei) =>
          pushBurst(fx.current, { ei, start: now + Math.random() * 90, dur: 650 + Math.random() * 250, from: i }),
        );
      }
      timer = window.setTimeout(fire, 3500 + Math.random() * 3000);
    };
    timer = window.setTimeout(fire, 2200);
    return () => window.clearTimeout(timer);
  }, [nodes, data, matchIds, reducedMotion, fx]);

  // selection: cascade sweeps outward through the 1-hop neighborhood
  useEffect(() => {
    if (!fireAt || fireAt === lastFireAt.current) return;
    lastFireAt.current = fireAt;
    if (selectedIndex < 0 || reducedMotion) return;
    const now = performance.now();
    fx.current.flashes.set(selectedIndex, now);
    const hops = [...data.neighbors[selectedIndex]].filter((j) => j !== selectedIndex);
    hops.forEach((j, k) => fx.current.flashes.set(j, now + 160 + k * 90));
    [...data.edgeConnected[selectedIndex]].forEach((ei, k) =>
      pushBurst(fx.current, { ei, start: now + k * 110, dur: 600 + Math.random() * 200, from: selectedIndex }),
    );
  }, [fireAt, selectedIndex, data, reducedMotion, fx]);

  return null;
}

// ---------------------------------------------------------------------------
// Neurons — instanced icosahedra + additive halo sprites
// ---------------------------------------------------------------------------

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();

function Neurons({
  nodes,
  data,
  matchIds,
  hoverId,
  selectedId,
  booted,
  fx,
  onHover,
  onSelect,
}: {
  nodes: Memory[];
  data: SceneData;
  matchIds: Set<string>;
  hoverId: string | null;
  selectedId: string | null;
  booted: boolean;
  fx: React.MutableRefObject<FxState>;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const haloRef = useRef<THREE.Group>(null);
  const bornAt = useRef<number | null>(null);
  const { reducedMotion } = useUiStore();
  const hoverIndex = hoverId ? nodes.findIndex((n) => n.id === hoverId) : -1;

  // material with per-instance emissive (instanceColor drives emissive via shader patch)
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0a1626'),
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 1.55,
      roughness: 0.35,
      metalness: 0.1,
    });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
#ifdef USE_COLOR
  totalEmissiveRadiance *= vColor;
#endif`,
      );
    };
    return mat;
  }, []);

  // halo sprites (one per node)
  const haloMaterials = useMemo(
    () =>
      nodes.map(
        (_, i) =>
          new THREE.SpriteMaterial({
            map: getGlowTexture(),
            color: data.baseColors[i],
            transparent: true,
            opacity: 0.35,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      ),
    [nodes, data],
  );

  // entrance clock
  useEffect(() => {
    if (booted && bornAt.current === null) bornAt.current = performance.now();
  }, [booted]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    const now = performance.now();
    const born = bornAt.current;
    const hoverSet = hoverIndex >= 0 ? data.neighbors[hoverIndex] : null;

    for (let i = 0; i < nodes.length; i++) {
      const [bx, by, bz] = data.positions[i];
      const w = data.weight[i];

      // idle drift (perlin-ish, amplitude 0.02)
      const dx = reducedMotion ? 0 : Math.sin(t * 0.5 + i * 1.7) * 0.02;
      const dy = reducedMotion ? 0 : Math.cos(t * 0.4 + i * 2.3) * 0.02;
      const dz = reducedMotion ? 0 : Math.sin(t * 0.45 + i * 0.9) * 0.02;

      // entrance bloom: scale 0→1, stagger 4ms radial from brain center
      let entrance = 1;
      if (born === null) entrance = 0;
      else {
        const dist = Math.sqrt(bx * bx + by * by + bz * bz);
        const p = (now - born - dist * 4) / 500;
        entrance = Math.min(1, Math.max(0, p));
      }

      // base radius ∝ weight
      let s = (0.16 + w * 0.42) * entrance;
      // hover spring
      const isHover = i === hoverIndex;
      if (isHover) s *= 1.35;
      // soma flash pop when this neuron fires
      let flash = 0;
      const flashStart = fx.current.flashes.get(i);
      if (flashStart !== undefined) {
        const age = now - flashStart;
        if (age > 900) fx.current.flashes.delete(i);
        else flash = 1 - age / 900;
      }
      if (flash > 0) s *= 1 + flash * 0.55;
      // breathing for recently-accessed nodes
      let breathe = 1;
      if (data.recent[i] && !reducedMotion) breathe = 1 + Math.sin(t * ((2 * Math.PI) / 3) + i) * 0.06;

      tmpObj.position.set(bx + dx, by + dy, bz + dz);
      tmpObj.scale.setScalar(Math.max(0.0001, s * breathe));
      tmpObj.updateMatrix();
      mesh.setMatrixAt(i, tmpObj.matrix);

      // color: type color × match/hover-dim/flash brightness
      let brightness = 1;
      const matched = matchIds.has(nodes[i].id);
      if (!matched) brightness = 0.08;
      else if (hoverSet && !hoverSet.has(i)) brightness = 0.15;
      brightness += flash * 1.8;
      if (data.recent[i] && !reducedMotion) brightness *= 0.85 + 0.15 * Math.sin(t * ((2 * Math.PI) / 3) + i);
      tmpColor.copy(data.baseColors[i]).multiplyScalar(brightness * entrance);
      mesh.setColorAt(i, tmpColor);

      // halo
      const halo = haloRef.current?.children[i] as THREE.Sprite | undefined;
      if (halo) {
        const haloScale = (0.9 + w * 2.4) * entrance * (isHover ? 1.35 : 1) * (1 + flash * 0.7);
        halo.position.set(bx + dx, by + dy, bz + dz);
        halo.scale.setScalar(Math.max(0.0001, haloScale));
        haloMaterials[i].opacity = Math.min(
          1,
          (matched ? (hoverSet && !hoverSet.has(i) ? 0.08 : 0.32) : 0.03) * entrance + flash * 0.55,
        );
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  const handleMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    onHover(i !== undefined && i >= 0 ? nodes[i].id : null);
  };
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i !== undefined && i >= 0) onSelect(nodes[i].id);
  };

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, nodes.length]}
        material={material}
        onPointerMove={handleMove}
        onPointerOut={() => onHover(null)}
        onClick={handleClick}
      >
        <icosahedronGeometry args={[1, 1]} />
      </instancedMesh>
      <group ref={haloRef}>
        {nodes.map((n, i) => (
          <sprite key={n.id} material={haloMaterials[i]} />
        ))}
      </group>
      {selectedId && <SelectionRings nodes={nodes} data={data} selectedId={selectedId} />}
    </group>
  );
}

/** Two counter-rotating dashed torus rings around the selected neuron. */
function SelectionRings({
  nodes,
  data,
  selectedId,
}: {
  nodes: Memory[];
  data: SceneData;
  selectedId: string;
}) {
  const i = nodes.findIndex((n) => n.id === selectedId);
  const g1 = useRef<THREE.Mesh>(null);
  const g2 = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (g1.current) g1.current.rotation.z = (t * (2 * Math.PI)) / 3;
    if (g2.current) g2.current.rotation.z = -(t * (2 * Math.PI)) / 5;
  });
  if (i < 0) return null;
  const [x, y, z] = data.positions[i];
  const r = 0.55 + data.weight[i] * 0.6;
  return (
    <group position={[x, y, z]}>
      <mesh ref={g1} rotation={[Math.PI / 2.6, 0, 0]}>
        <torusGeometry args={[r, 0.012, 8, 64]} />
        <meshBasicMaterial color="#00d4ff" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={g2} rotation={[Math.PI / 1.8, Math.PI / 5, 0]}>
        <torusGeometry args={[r * 1.25, 0.008, 8, 64]} />
        <meshBasicMaterial color="#7de9ff" transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Synapses — bezier line tubes + traveling pulse particles
// ---------------------------------------------------------------------------

function Synapses({
  nodes,
  edges,
  data,
  matchIds,
  hoverId,
  selectedId,
  fireAt,
  booted,
  fx,
}: {
  nodes: Memory[];
  edges: GraphEdge[];
  data: SceneData;
  matchIds: Set<string>;
  hoverId: string | null;
  selectedId: string | null;
  fireAt: number; // timestamp of last "fire" cascade on selection
  booted: boolean;
  fx: React.MutableRefObject<FxState>;
}) {
  const hoverIndex = hoverId ? nodes.findIndex((n) => n.id === hoverId) : -1;
  const selectedIndex = selectedId ? nodes.findIndex((n) => n.id === selectedId) : -1;
  const hoverEdges = hoverIndex >= 0 ? data.edgeConnected[hoverIndex] : null;
  const selectedEdges = selectedIndex >= 0 ? data.edgeConnected[selectedIndex] : null;
  const bornAt = useRef<number | null>(null);
  const matRefs = useRef<(THREE.Material | null)[]>([]);

  useEffect(() => {
    if (booted && bornAt.current === null) bornAt.current = performance.now();
  }, [booted]);

  const edgeVisible = (e: GraphEdge) => matchIds.has(e.source) && matchIds.has(e.target);
  const edgePoints = useMemo(() => data.curves.map((c) => c.getPoints(24)), [data]);

  useFrame(() => {
    const now = performance.now();
    const firing = now - fireAt < 2000;
    edges.forEach((e, ei) => {
      const mat = matRefs.current[ei];
      if (!mat) return;
      let o = 0.55;
      if (!edgeVisible(e)) o = 0.03;
      else if (hoverEdges && !hoverEdges.has(ei)) o = 0.12;
      if (firing && selectedEdges?.has(ei)) o = 1;
      // entrance draw-in
      if (bornAt.current !== null) {
        const p = Math.min(1, Math.max(0, (now - bornAt.current - 300 - ei * 2) / 600));
        o *= p;
      } else o = 0;
      (mat as THREE.LineBasicMaterial).opacity = o;
    });
  });

  return (
    <group>
      {edges.map((e, ei) => {
        const pts = edgePoints[ei];
        const dashed = e.type === 'contradicts' || e.type === 'exception_to';
        return (
          <Line
            key={e.id}
            points={pts}
            color={`#${data.edgeColors[ei].getHexString()}`}
            lineWidth={e.type === 'derived_from' ? 2.6 : 1.1}
            transparent
            opacity={0}
            dashed={dashed}
            dashSize={dashed ? 0.28 : undefined}
            gapSize={dashed ? 0.18 : undefined}
            ref={(r: { material?: THREE.Material } | null) => {
              matRefs.current[ei] = r?.material ?? null;
            }}
          />
        );
      })}
      <Bolts edges={edges} data={data} matchIds={matchIds} fx={fx} booted={booted} />
    </group>
  );
}

/** Electric bolts: instanced additive streak sprites stretched along travel. */
const BOLT_CAP = 150; // hard cap on concurrent bolts (ambient + cascade)
const AMBIENT_BOLT_CAP = 110;

const boltMat4 = new THREE.Matrix4();
const boltTan = new THREE.Vector3();
const boltPerp = new THREE.Vector3();
const boltNorm = new THREE.Vector3();
const boltPos = new THREE.Vector3();
const boltScale = new THREE.Vector3();
const BOLT_UP = new THREE.Vector3(0, 1, 0);
const BOLT_SIDE = new THREE.Vector3(1, 0, 0);
const WHITE = new THREE.Color('#ffffff');

function Bolts({
  edges,
  data,
  matchIds,
  fx,
  booted,
}: {
  edges: GraphEdge[];
  data: SceneData;
  matchIds: Set<string>;
  fx: React.MutableRefObject<FxState>;
  booted: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const { pulseDensity, reducedMotion } = useUiStore();
  const lastSlotCount = useRef(0);

  // ambient bolt plan: [edgeIndex, phaseOffset, speed ∝ source accessCount, jitterSeed]
  const plan = useMemo(() => {
    const p: [number, number, number, number][] = [];
    edges.forEach((_e, ei) => {
      const srcAccess = data.access[data.edgeEnds[ei][0]] ?? 1;
      const perEdge = 2 + Math.min(2, Math.floor(srcAccess / 12)); // 2–4 per edge
      const count = Math.max(0, Math.round(perEdge * pulseDensity));
      for (let k = 0; k < count; k++) {
        p.push([
          ei,
          (k + Math.random() * 0.35) / Math.max(1, count),
          0.1 + Math.min(0.5, srcAccess * 0.012),
          Math.random() * 1000,
        ]);
      }
    });
    return p.slice(0, AMBIENT_BOLT_CAP);
  }, [edges, data, pulseDensity]);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: getBoltTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  // static tint for ambient slots (burst slots are tinted per frame)
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < BOLT_CAP; i++) {
      if (i < plan.length) {
        tmpColor.copy(data.edgeColors[plan[i][0]]).lerp(WHITE, 0.3).multiplyScalar(1.5);
      } else {
        tmpColor.setRGB(0, 0, 0);
      }
      mesh.setColorAt(i, tmpColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [plan, data]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    const now = performance.now();

    // prune expired bursts
    const bursts = fx.current.bursts;
    for (let b = bursts.length - 1; b >= 0; b--) {
      if (now - bursts[b].start > bursts[b].dur + 120) bursts.splice(b, 1);
    }

    let slot = 0;

    const writeBolt = (
      ei: number,
      u: number,
      len: number,
      width: number,
      bright: number,
      seed: number,
      tint: THREE.Color | null,
    ) => {
      if (slot >= BOLT_CAP) return;
      const curve = data.curves[ei];
      curve.getPoint(u, boltPos);
      curve.getTangent(u, boltTan);
      if (boltTan.lengthSq() < 1e-8) boltTan.set(1, 0, 0);
      boltTan.normalize();
      // lightning jitter: small high-frequency perpendicular crackle
      const ref = Math.abs(boltTan.y) > 0.92 ? BOLT_SIDE : BOLT_UP;
      boltPerp.crossVectors(boltTan, ref).normalize();
      boltNorm.crossVectors(boltTan, boltPerp).normalize();
      boltPos.addScaledVector(boltPerp, Math.sin(t * 43 + seed * 7.1) * 0.045);
      boltPos.addScaledVector(boltNorm, Math.cos(t * 37 + seed * 3.7) * 0.045);
      // flicker
      const flicker = bright * (0.72 + 0.28 * Math.sin(t * 61 + seed * 11.3));
      boltMat4.makeBasis(boltTan, boltPerp, boltNorm);
      boltMat4.scale(boltScale.set(len, width * (0.8 + 0.4 * Math.abs(Math.sin(t * 53 + seed))), 1));
      boltMat4.setPosition(boltPos);
      mesh.setMatrixAt(slot, boltMat4);
      if (tint) {
        tmpColor.copy(tint).multiplyScalar(Math.max(0.0001, flicker / 1.5));
        mesh.setColorAt(slot, tmpColor);
      }
      slot++;
    };

    if (!reducedMotion && booted) {
      // ambient bolts
      for (let i = 0; i < plan.length; i++) {
        const [ei, off, speed, seed] = plan[i];
        const e = edges[ei];
        if (!matchIds.has(e.source) || !matchIds.has(e.target)) continue;
        const u = (t * speed + off) % 1;
        writeBolt(ei, u, 0.85 + speed * 0.9, 0.11, 1, seed, null);
      }
      // cascade bursts — longer, hotter, white-cored
      for (const burst of bursts) {
        if (now < burst.start) continue;
        const p = Math.min(1, (now - burst.start) / burst.dur);
        const forward = burst.from === data.edgeEnds[burst.ei][0];
        const u = forward ? p : 1 - p;
        const envelope = Math.sin(p * Math.PI); // ease in/out
        tmpColor.copy(data.edgeColors[burst.ei]).lerp(WHITE, 0.65);
        writeBolt(burst.ei, u, 1.6, 0.17, envelope * 2.2, burst.ei * 3.3, tmpColor);
      }
    }

    // hide unused slots
    for (let i = slot; i < lastSlotCount.current; i++) {
      boltMat4.makeScale(0, 0, 0);
      mesh.setMatrixAt(i, boltMat4);
    }
    lastSlotCount.current = slot;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, BOLT_CAP]} material={material} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Environment — hex floor, lights
// ---------------------------------------------------------------------------

function HexFloor() {
  const texture = useMemo(() => {
    const tex = new THREE.TextureLoader().load('/grid-hex.svg');
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(18, 18);
    return tex;
  }, []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -8, 0]}>
      <planeGeometry args={[70, 70]} />
      <meshBasicMaterial map={texture} transparent opacity={0.5} depthWrite={false} color="#00d4ff" />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Camera rig — OrbitControls + GSAP fly-to + entrance push-in + auto-rotate
// ---------------------------------------------------------------------------

function CameraRig({
  nodes,
  data,
  selectedId,
  focusId,
  booted,
}: {
  nodes: Memory[];
  data: SceneData;
  selectedId: string | null;
  focusId: string | null;
  booted: boolean;
}) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { camera, gl, scene } = useThree();
  const { autoRotate, reducedMotion } = useUiStore();
  const lastInteract = useRef(0);
  const pushed = useRef(false);
  const lastTarget = useRef<string | null>(null);

  // entrance camera push-in: z 26 → off-axis overview (parallax)
  useEffect(() => {
    if (!booted || pushed.current) return;
    pushed.current = true;
    gsap.to(camera.position, {
      x: 1.7,
      y: 2.3,
      z: 15.4,
      duration: reducedMotion ? 0.01 : 1.6,
      ease: 'expo.out',
      onUpdate: () => controlsRef.current?.update(),
    });
  }, [booted, camera, reducedMotion]);

  // ENTER BRAIN cinematic — dolly through the longitudinal fissure into the
  // cortical cavern. Triggered by the HUD button / double-click on empty void.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const dur = (s: number) => (reducedMotion ? 0.01 : s);
    const enterBrain = () => {
      lastInteract.current = performance.now();
      gsap.killTweensOf(camera.position);
      gsap.killTweensOf(controls.target);
      const tl = gsap.timeline();
      // waypoint: pull to the fissure mouth, then slide inside
      tl.to(camera.position, {
        x: 0,
        y: 1.4,
        z: 10.2,
        duration: dur(1.0),
        ease: 'expo.inOut',
        onUpdate: () => controls.update(),
      }, 0);
      tl.to(camera.position, {
        x: 0,
        y: 0.9,
        z: 1.3,
        duration: dur(1.25),
        ease: 'expo.inOut',
        onUpdate: () => controls.update(),
      }, dur(1.0));
      tl.to(controls.target, {
        x: 0,
        y: 0.6,
        z: 0,
        duration: dur(1.0),
        ease: 'expo.inOut',
        onUpdate: () => controls.update(),
      }, 0);
      tl.to(controls.target, {
        x: 0,
        y: 0.4,
        z: -5,
        duration: dur(1.25),
        ease: 'expo.inOut',
        onUpdate: () => controls.update(),
      }, dur(1.0));
    };

    const onCustom = () => enterBrain();
    // double-click empty space (raycast misses every neuron core) → dive in
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const el = gl.domElement;
    const onDblClick = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -(((ev.clientY - r.top) / r.height) * 2 - 1));
      ray.setFromCamera(ndc, camera);
      const hitNeuron = ray
        .intersectObjects(scene.children, true)
        .some((h) => (h.object as THREE.InstancedMesh).isInstancedMesh);
      if (!hitNeuron) enterBrain();
    };
    window.addEventListener('realmemory:enter-brain', onCustom);
    el.addEventListener('dblclick', onDblClick);
    return () => {
      window.removeEventListener('realmemory:enter-brain', onCustom);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [camera, gl, scene, reducedMotion]);

  // fly-to on selection / external focus request; null → ease back to overview
  useEffect(() => {
    const id = selectedId ?? focusId;
    if (id === lastTarget.current) return;
    lastTarget.current = id;
    const controls = controlsRef.current;
    if (!controls) return;
    const dur = reducedMotion ? 0.01 : id ? 1.4 : 1.2;

    let dest = new THREE.Vector3(1.7, 2.3, 15.4);
    let look = new THREE.Vector3(0, 0, 0);
    if (id) {
      const i = nodes.findIndex((n) => n.id === id);
      if (i >= 0) {
        const [x, y, z] = data.positions[i];
        look = new THREE.Vector3(x, y, z);
        const dir = look.lengthSq() > 0.01 ? look.clone().normalize() : new THREE.Vector3(0, 0, 1);
        dest = look.clone().add(dir.multiplyScalar(4.2)).add(new THREE.Vector3(0, 1.1, 0));
      }
    }
    gsap.to(camera.position, {
      x: dest.x,
      y: dest.y,
      z: dest.z,
      duration: dur,
      ease: 'expo.inOut',
      onUpdate: () => controls.update(),
    });
    gsap.to(controls.target, {
      x: look.x,
      y: look.y,
      z: look.z,
      duration: dur,
      ease: 'expo.inOut',
      onUpdate: () => controls.update(),
    });
  }, [selectedId, focusId, nodes, data, camera, reducedMotion]);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const idle = performance.now() - lastInteract.current > 6000;
    controls.autoRotate = autoRotate && !reducedMotion && idle && !selectedId;
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.08}
      minDistance={0.6}
      maxDistance={30}
      autoRotateSpeed={0.4}
      makeDefault
      onStart={() => {
        lastInteract.current = Number.POSITIVE_INFINITY; // interacting now
      }}
      onEnd={() => {
        lastInteract.current = performance.now();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// BrainCanvas — default export. Transparent canvas over the CSS nebula layer.
// ---------------------------------------------------------------------------

function SceneContent({
  nodes,
  edges,
  matchIds,
  hoverId,
  selectedId,
  focusId,
  fireAt,
  booted,
  onHover,
  onSelect,
  data,
  fx,
}: BrainCanvasProps & { data: SceneData; fx: React.MutableRefObject<FxState> }) {
  const selectedIndex = selectedId ? nodes.findIndex((n) => n.id === selectedId) : -1;
  return (
    <>
      {/* exponential fog: depth attenuation so distant neurons fade into the void —
          strong depth cue both outside and inside the cortical cavern */}
      <fogExp2 attach="fog" args={['#02060e', 0.042]} />
      <ambientLight intensity={0.5} />
      <pointLight position={[-10, 7, 9]} intensity={140} color="#00d4ff" />
      <pointLight position={[10, -5, -8]} intensity={90} color="#ffb627" />
      {/* interior lights so neuron cores stay lit when the camera is inside */}
      <pointLight position={[-2.2, 1.2, 1.5]} intensity={36} distance={11} decay={2} color="#00d4ff" />
      <pointLight position={[2.4, -0.6, -1.8]} intensity={26} distance={10} decay={2} color="#ffb627" />
      <Stars radius={90} depth={60} count={2000} factor={4} saturation={0.4} fade speed={0.6} />
      <HexFloor />
      <group rotation={[0.18, 0, 0]}>
        <BrainShell />
        <Neurons
          nodes={nodes}
          data={data}
          matchIds={matchIds}
          hoverId={hoverId}
          selectedId={selectedId}
          booted={booted}
          fx={fx}
          onHover={onHover}
          onSelect={onSelect}
        />
        <Synapses
          nodes={nodes}
          edges={edges}
          data={data}
          matchIds={matchIds}
          hoverId={hoverId}
          selectedId={selectedId}
          fireAt={fireAt}
          booted={booted}
          fx={fx}
        />
        <MemoryLabels
          nodes={nodes}
          positions={data.positions}
          neighbors={data.neighbors}
          weight={data.weight}
          matchIds={matchIds}
          hoverId={hoverId}
          selectedId={selectedId}
          colorMode={colorMode}
          regionMap={regionMap}
        />
      </group>
      <CascadeDriver
        nodes={nodes}
        data={data}
        matchIds={matchIds}
        selectedIndex={selectedIndex}
        fireAt={fireAt}
        fx={fx}
      />
      <CameraRig nodes={nodes} data={data} selectedId={selectedId} focusId={focusId} booted={booted} />
      <EffectComposer multisampling={0}>
        <Bloom luminanceThreshold={0.2} intensity={1.2} mipmapBlur />
        <Vignette eskil={false} offset={0.25} darkness={0.72} />
      </EffectComposer>
    </>
  );
}

export interface BrainCanvasProps {
  nodes: Memory[];
  edges: GraphEdge[];
  matchIds: Set<string>;
  hoverId: string | null;
  selectedId: string | null;
  /** external fly-to request (search / palette / arrow keys) */
  focusId: string | null;
  /** timestamp of the last selection fire-cascade */
  fireAt: number;
  /** entrance animations run once true */
  booted: boolean;
  /** neuron coloring mode */
  colorMode: ColorMode;
  /** domain → region index map (for domain coloring) */
  regionMap: Map<string, number>;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}

export default function BrainCanvas(props: BrainCanvasProps) {
  const data = useMemo(
    () => buildSceneData(props.nodes, props.edges, props.colorMode, props.regionMap),
    [props.nodes, props.edges, props.colorMode, props.regionMap],
  );
  const fx = useRef<FxState>({ flashes: new Map(), bursts: [] });
  // a dataset swap invalidates any in-flight cascades from the old graph
  useEffect(() => {
    fx.current.flashes.clear();
    fx.current.bursts.length = 0;
  }, [data]);
  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ fov: 50, position: [0, 3, 26], near: 0.1, far: 200 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
      onPointerMissed={() => props.onSelect(null)}
    >
      <Suspense fallback={null}>
        <SceneContent {...props} data={data} fx={fx} />
      </Suspense>
    </Canvas>
  );
}
