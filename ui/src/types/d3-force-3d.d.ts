declare module 'd3-force-3d' {
  export interface SimulationNode {
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
    index?: number;
  }
  export interface SimulationLink<N extends SimulationNode> {
    source: string | number | N;
    target: string | number | N;
    index?: number;
  }
  export interface ForceSimulation<N extends SimulationNode> {
    force(name: string, force?: unknown): ForceSimulation<N>;
    nodes(nodes?: N[]): N[] | ForceSimulation<N>;
    alpha(a?: number): number | ForceSimulation<N>;
    alphaDecay(d?: number): number | ForceSimulation<N>;
    tick(iterations?: number): ForceSimulation<N>;
    stop(): ForceSimulation<N>;
    restart(): ForceSimulation<N>;
  }
  export function forceSimulation<N extends SimulationNode>(nodes?: N[]): ForceSimulation<N>;
  export function forceLink<N extends SimulationNode, L extends SimulationLink<N>>(
    links?: L[],
  ): {
    id(fn: (n: N) => string): unknown;
    distance(d: number | ((l: L) => number)): unknown;
    strength(s: number | ((l: L) => number)): unknown;
  };
  export function forceManyBody(): { strength(s: number | (() => number)): unknown };
  export function forceX(x?: number | ((n: SimulationNode) => number)): {
    strength(s: number): unknown;
    x(v: number | ((n: SimulationNode) => number)): unknown;
  };
  export function forceY(y?: number | ((n: SimulationNode) => number)): {
    strength(s: number): unknown;
    y(v: number | ((n: SimulationNode) => number)): unknown;
  };
  export function forceZ(z?: number | ((n: SimulationNode) => number)): {
    strength(s: number): unknown;
    z(v: number | ((n: SimulationNode) => number)): unknown;
  };
  export function forceCenter(x?: number, y?: number, z?: number): unknown;
  export function forceRadial(
    radius?: number | ((n: SimulationNode) => number),
    x?: number,
    y?: number,
    z?: number,
  ): { strength(s: number): unknown };
}
