/**
 * RealMemory mock data layer — design.md §9.
 * Deterministic seeded dataset shaped EXACTLY like the real API
 * (http://127.0.0.1:9333) so it can later be swapped for live calls.
 */

// ---------------------------------------------------------------------------
// Types (EXACT RealMemory field names)
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'user_preference'
  | 'task_pattern'
  | 'codebase_fact'
  | 'lesson_learned'
  | 'session_summary'
  | 'contextual_note';

export type Scope = 'project' | 'global';

export type EdgeType = 'reinforces' | 'contradicts' | 'extends' | 'exception_to' | 'derived_from';

export interface Memory {
  id: string; // ULID
  content: string; // ≤ 280 chars
  type: MemoryType;
  scope: Scope;
  domain?: string;
  category?: string; // gotcha|cost|safety|integration|process|tooling|performance|…
  source?: { project?: string; session?: string; ref?: string; refType?: string };
  tags: string[];
  weight: number; // 0..1 composite
  confidence: number; // 0..1
  createdAt: string; // ISO 8601
  updatedAt: string;
  accessCount: number;
  reinforcementCount: number;
  metadata: Record<string, any>; // lesson_learned: {assumed, reality, lesson, reinforced: []}
  //                                 codebase_fact: {location, evidence} · session_summary: {outcomes: []}
  status: 'active' | 'archived';
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  createdAt: string;
}

export interface Stats {
  totalMemories: number;
  byType: Record<MemoryType, number>;
  byScope: { project: number; global: number };
  totalRelationships: number;
}

export interface DomainInfo {
  name: string;
  count: number;
  types: MemoryType[];
  categories: string[];
}

export interface MetricPoint {
  date: string; // ISO date (day)
  value: number;
}

export interface Metric {
  metric_name: string;
  count: number;
  sum: number;
  avg: number;
  latest: number;
  latest_at: string;
  series: MetricPoint[]; // 30-day daily time series
}

export interface GraphFilters {
  limit?: number;
  scope?: Scope | 'all';
  type?: MemoryType[];
  tags?: string[];
  domain?: string;
  category?: string[];
  minWeight?: number;
  createdAfter?: string;
  createdBefore?: string;
  q?: string;
}

export interface Graph {
  nodes: Memory[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + ULID
// ---------------------------------------------------------------------------

const SEED = 0x5eed_c0de;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const rint = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const rfloat = (min: number, max: number) => min + rand() * (max - min);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(time: number, entropy: () => number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out += CROCKFORD[Math.floor(entropy() * 32)];
  return out;
}

// Anchor "now" (rounded to the hour) so the dataset is stable within a session
// but recently-touched memories still breathe on each visit.
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------------------
// Corpus: domain-flavoured content fragments
// ---------------------------------------------------------------------------

export const DOMAINS = [
  'opencode',
  'aws',
  'testing',
  'react',
  'postgres',
  'ci',
  'auth',
  'performance',
] as const;

export const CATEGORIES = [
  'gotcha',
  'cost',
  'safety',
  'integration',
  'process',
  'tooling',
  'performance',
] as const;

const TAGS_BY_DOMAIN: Record<string, string[]> = {
  opencode: ['plugin', 'mcp', 'hooks', 'agent', 'tools', 'config'],
  aws: ['lambda', 's3', 'iam', 'cloudwatch', 'cdk', 'regions'],
  testing: ['vitest', 'playwright', 'fixtures', 'mocks', 'coverage', 'flake'],
  react: ['hooks', 'suspense', 'rsc', 'state', 'render', 'vite'],
  postgres: ['indexes', 'vacuum', 'migration', 'drizzle', 'locks', 'explain'],
  ci: ['github-actions', 'cache', 'deploy', 'pipeline', 'artifacts', 'matrix'],
  auth: ['oauth', 'jwt', 'sessions', 'rbac', 'tokens', 'rotation'],
  performance: ['bundle', 'profiling', 'latency', 'memory', 'caching', 'n+1'],
};

const FACT_TEMPLATES: Record<string, string[]> = {
  opencode: [
    'OpenCode plugin hooks fire in registration order; RealMemory registers recall before compaction so context is injected pre-summarization.',
    'The MCP server exposes tools memory_store, memory_recall and memory_link on http://127.0.0.1:9333 with stdio fallback.',
    'realmemory.config.json lives at the project root; the global layer reads ~/.realmemory/config.json with project values taking precedence.',
  ],
  aws: [
    'Lambda cold starts in vpc-a drop from 3.1s to 900ms when the drizzle client is initialized outside the handler.',
    'S3 lifecycle rule archive-logs transitions to Glacier after 30 days; retrieval cost spikes if dashboards read directly from it.',
    'IAM role realmemory-agent needs ssm:GetParameter on /realmemory/* or the plugin silently degrades to local-only memory.',
  ],
  testing: [
    'Vitest workspace runs unit and e2e in separate projects; e2e requires the MCP stub on port 9334.',
    'Playwright flake rate dropped 60% after pinning the neural-graph canvas test to a fixed deviceScaleFactor of 1.',
    'Coverage thresholds are enforced per-package: lib 85%, plugin 70%, UI is excluded from the gate.',
  ],
  react: [
    'The memory graph canvas must not mount inside React.StrictMode — double-mounted R3F canvases leak WebGL contexts.',
    'useSyncExternalStore backs the memory stream; memoizing the selector cut re-renders per recall event from 40 to 3.',
    'Vite dev proxy forwards /api to 127.0.0.1:9333; production build expects REALMEMORY_URL injected at build time.',
  ],
  postgres: [
    'memories table uses a partial index on (project, weight) WHERE status = active; recall queries stay under 4ms at 200k rows.',
    'Weight decay runs as a single UPDATE with exponential backoff per row — batching it avoided lock contention with live recalls.',
    'pg_stat_statements shows the top query is edge traversal for context assembly; a covering index on edges(source) halved its cost.',
  ],
  ci: [
    'GitHub Actions cache key includes pnpm-lock.yaml hash plus node version; a stale key once shipped a broken esbuild binary.',
    'The deploy job requires pnpm db:migrate to run explicitly — drizzle does not auto-migrate on boot.',
    'Matrix builds run node 20 and 22; node 22 exposed a broken native dep in the sqlite binding.',
  ],
  auth: [
    'OAuth tokens rotate every 12h; the refresh path must persist the new token before invalidating the old one or sessions drop.',
    'JWTs carry scope claims project:read and memory:write; recall endpoints reject tokens missing project:read.',
    'RBAC maps agent roles to memory scopes — read-only agents can never write global-scope memories.',
  ],
  performance: [
    'Recall p95 latency is 38ms; the hot path is embedding lookup, not the SQL round trip.',
    'Bundling the MCP server with esbuild cut startup from 1.4s to 180ms.',
    'An N+1 in relationship hydration caused 900 queries per graph view; fixed with a single join + in-memory grouping.',
  ],
};

const LESSON_TEMPLATES: { assumed: string; reality: string; lesson: string; domain: string }[] = [
  {
    assumed: 'Drizzle ORM migrations run automatically on deploy.',
    reality: 'They require `pnpm db:migrate` as an explicit CI step; the app boots against the old schema otherwise.',
    lesson: 'Always add an explicit migrate step to the deploy pipeline and fail fast on schema mismatch.',
    domain: 'ci',
  },
  {
    assumed: 'Increasing memory weight cap above 1.0 improves recall ranking.',
    reality: 'Weights are normalized 0..1; values above 1 are clamped and distort decay math.',
    lesson: 'Treat weight as a probability-like composite — clamp at 1 and tune decay half-life instead.',
    domain: 'opencode',
  },
  {
    assumed: 'React StrictMode is safe to enable around the 3D memory graph.',
    reality: 'It double-mounts the R3F canvas and leaks WebGL contexts until the tab crashes.',
    lesson: 'Mount WebGL canvases outside StrictMode or guard with a singleton context registry.',
    domain: 'react',
  },
  {
    assumed: 'Lambda would reuse warm containers across deploys.',
    reality: 'Every deploy resets the execution environment; in-process caches are cold on the first request.',
    lesson: 'Warm caches lazily and never assume cross-deploy container reuse.',
    domain: 'aws',
  },
  {
    assumed: 'A flake in the graph e2e test meant a rendering race.',
    reality: 'The test device scale factor differed between CI runners, shifting hit-test coordinates.',
    lesson: 'Pin deviceScaleFactor and viewport in canvas hit tests before suspecting app races.',
    domain: 'testing',
  },
  {
    assumed: 'Recalling memories by tag alone would be selective enough.',
    reality: 'Popular tags match hundreds of rows; recall latency and noise both exploded.',
    lesson: 'Always compound tag filters with scope, domain and minWeight.',
    domain: 'postgres',
  },
  {
    assumed: 'JWT refresh could invalidate the old token immediately.',
    reality: 'In-flight requests signed with the old token failed mid-session for up to 30s.',
    lesson: 'Overlap token validity windows and persist the new token before revoking the old.',
    domain: 'auth',
  },
  {
    assumed: 'More synapse edges per memory always improves context assembly.',
    reality: 'Beyond ~8 edges per node, context windows flooded with low-weight tangents.',
    lesson: 'Cap traversal fan-out and rank edges by relationship type before injecting context.',
    domain: 'performance',
  },
];

const PREFERENCE_TEMPLATES = [
  'User prefers pnpm over npm for all package management in this workspace.',
  'User wants concise commit messages in conventional-commit format, no emoji.',
  'User prefers TypeScript strict mode with explicit return types on exported functions.',
  'User asks for Tailwind utility classes instead of bespoke CSS wherever possible.',
  'User prefers small, reviewable PRs over long-running feature branches.',
  'User wants destructive shell commands confirmed before execution.',
];

const PATTERN_TEMPLATES = [
  'Deploys happen after green CI on main, typically weekday mornings UTC.',
  'The agent stores a lesson_learned memory after every failed command sequence.',
  'Recall is issued at session start with the current project scope before any tool call.',
  'Reflex checks run before shell commands; destructive patterns route through the block list.',
  'Session summaries are written at compaction time and link derived_from the session’s key decisions.',
  'Prediction checks compare planned commands against stored lessons before execution.',
];

const SUMMARY_TEMPLATES = [
  'Session focused on wiring the recall pipeline; fixed weight decay math and added two regression tests.',
  'Debugged a production deploy failure traced to a missing migration step; encoded a lesson and a CI gate.',
  'Reworked the graph view hydration to remove an N+1; p95 render dropped from 900ms to 120ms.',
  'Onboarded the reflex subsystem: blocklist rules loaded from reflexes table with warn/rewrite/block tiers.',
  'Consolidation pass merged 14 duplicate memories about drizzle migrations into two strong engrams.',
];

const NOTE_TEMPLATES = [
  'Staging environment shares a database with preview deploys — expect cross-contamination in recall.',
  'The MCP inspector at 127.0.0.1:6274 is useful for tracing memory_store payloads.',
  'Legacy import script lives in scripts/import-v1.ts; run only with --dry-run first.',
  'Weight chart in the dashboard reads from the metrics table, not live memory rows.',
  'The scrub subsystem archives anything below weight 0.05 during the nightly pass.',
];

const OUTCOME_POOL = [
  'recall pipeline verified end-to-end',
  'regression tests added',
  'deploy unblocked',
  'latency reduced',
  'duplicate memories merged',
  'lesson encoded',
  'CI gate added',
  'docs updated',
];

const LOCATION_POOL = [
  'src/server/recall.ts:42',
  'src/server/decay.ts:17',
  'plugin/hooks/session-start.ts:8',
  'src/db/schema.ts:103',
  'src/graph/hydrate.ts:66',
  'scripts/import-v1.ts:21',
  'plugin/mcp/tools.ts:155',
  'src/reflex/rules.ts:31',
];

const PROJECTS = ['realmemory', 'realmemory', 'realmemory', 'opencode-config', 'neural-ui'];
const REF_TYPES = ['commit', 'issue', 'pr', 'doc', 'url'];

// ---------------------------------------------------------------------------
// Memory generation (~187 memories, weight tiers ~25/45/30, a few < 0.05)
// ---------------------------------------------------------------------------

const TOTAL = 187;
const ARCHIVED_COUNT = 9;

function buildMemories(): Memory[] {
  // Type plan summing to TOTAL
  const typePlan: MemoryType[] = [
    ...Array<MemoryType>(34).fill('codebase_fact'),
    ...Array<MemoryType>(30).fill('task_pattern'),
    ...Array<MemoryType>(28).fill('lesson_learned'),
    ...Array<MemoryType>(26).fill('user_preference'),
    ...Array<MemoryType>(24).fill('session_summary'),
    ...Array<MemoryType>(45).fill('contextual_note'),
  ];
  // Weight plan: ~25% strong (>0.5), 45% medium (0.25–0.5), 30% weak (≤0.25, 6 in archive zone)
  const weightPlan: number[] = [
    ...Array.from({ length: 47 }, () => rfloat(0.52, 0.95)),
    ...Array.from({ length: 84 }, () => rfloat(0.26, 0.5)),
    ...Array.from({ length: 50 }, () => rfloat(0.06, 0.25)),
    ...Array.from({ length: 6 }, () => rfloat(0.01, 0.049)),
  ];
  // Seeded shuffle of both plans
  for (let i = typePlan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [typePlan[i], typePlan[j]] = [typePlan[j], typePlan[i]];
  }
  for (let i = weightPlan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [weightPlan[i], weightPlan[j]] = [weightPlan[j], weightPlan[i]];
  }

  // Scope split: 112 project / 75 global
  const scopePlan: Scope[] = [
    ...Array<Scope>(112).fill('project'),
    ...Array<Scope>(75).fill('global'),
  ];
  for (let i = scopePlan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [scopePlan[i], scopePlan[j]] = [scopePlan[j], scopePlan[i]];
  }

  const memories: Memory[] = [];
  let lessonIdx = 0;

  for (let i = 0; i < TOTAL; i++) {
    const type = typePlan[i];
    const scope = scopePlan[i];
    const weight = Math.round(weightPlan[i] * 1000) / 1000;

    let domain: string | undefined;
    let category: string | undefined;
    let content = '';
    let metadata: Record<string, any> = {};
    let tags: string[] = [];

    if (type === 'codebase_fact') {
      domain = pick(DOMAINS);
      category = pick(CATEGORIES);
      content = pick(FACT_TEMPLATES[domain]);
      metadata = {
        location: pick(LOCATION_POOL),
        evidence: `verified against ${pick(REF_TYPES)} ${ulid(rint(0, 1e9), rand).slice(0, 7).toLowerCase()}`,
      };
      tags = [pick(TAGS_BY_DOMAIN[domain]), pick(TAGS_BY_DOMAIN[domain])];
    } else if (type === 'lesson_learned') {
      const t = LESSON_TEMPLATES[lessonIdx % LESSON_TEMPLATES.length];
      lessonIdx++;
      domain = t.domain;
      category = pick(['gotcha', 'process', 'safety'] as const);
      content = `Assumed ${t.assumed.charAt(0).toLowerCase()}${t.assumed.slice(1)} Reality: ${t.reality} Lesson: ${t.lesson}`;
      const reinforcements = rint(0, 4);
      metadata = {
        assumed: t.assumed,
        reality: t.reality,
        lesson: t.lesson,
        reinforced: Array.from({ length: reinforcements }, (_, k) =>
          iso(NOW - rint(2, 40 - k * 2) * DAY),
        ).sort(),
      };
      tags = [pick(TAGS_BY_DOMAIN[domain]), pick(TAGS_BY_DOMAIN[domain])];
    } else if (type === 'user_preference') {
      content = pick(PREFERENCE_TEMPLATES);
      category = 'process';
      tags = ['preference', pick(['style', 'workflow', 'tooling'])];
    } else if (type === 'task_pattern') {
      domain = pick(DOMAINS);
      category = pick(['process', 'tooling', 'integration'] as const);
      content = pick(PATTERN_TEMPLATES);
      tags = [pick(TAGS_BY_DOMAIN[domain])];
    } else if (type === 'session_summary') {
      domain = pick(DOMAINS);
      content = pick(SUMMARY_TEMPLATES);
      metadata = {
        outcomes: Array.from(new Set(Array.from({ length: rint(2, 4) }, () => pick(OUTCOME_POOL)))),
      };
      tags = ['session', pick(TAGS_BY_DOMAIN[domain])];
    } else {
      // contextual_note
      domain = rand() > 0.3 ? pick(DOMAINS) : undefined;
      category = rand() > 0.5 ? pick(CATEGORIES) : undefined;
      content = pick(NOTE_TEMPLATES);
      tags = domain ? [pick(TAGS_BY_DOMAIN[domain])] : ['note'];
    }

    tags = Array.from(new Set(tags)).slice(0, 3);
    if (rand() > 0.7 && tags.length < 3) tags.push('realmemory');

    const createdAgo = rint(1, 120) * DAY + rint(0, DAY - 1);
    const created = NOW - createdAgo;
    // ~18% touched within the last 24h (breathing neurons)
    const recent = rand() < 0.18;
    const updated = recent ? NOW - rint(0, 23) * 3_600_000 : created + rint(0, Math.max(1, Math.floor(createdAgo / DAY))) * DAY;

    memories.push({
      id: ulid(created, rand),
      content: content.slice(0, 280),
      type,
      scope,
      domain,
      category,
      source: {
        project: scope === 'project' ? pick(PROJECTS) : undefined,
        session: `ses_${ulid(rint(0, 1e9), rand).slice(0, 10).toLowerCase()}`,
        ref: rand() > 0.4 ? `${pick(REF_TYPES)}:${ulid(rint(0, 1e9), rand).slice(0, 7).toLowerCase()}` : undefined,
        refType: rand() > 0.4 ? pick(REF_TYPES) : undefined,
      },
      tags,
      weight,
      confidence: Math.round(rfloat(0.45, 0.99) * 100) / 100,
      createdAt: iso(created),
      updatedAt: iso(Math.min(updated, NOW)),
      accessCount: Math.max(1, Math.round(weight * rint(2, 30))),
      reinforcementCount: type === 'lesson_learned' ? (metadata.reinforced as string[]).length : rint(0, 5),
      metadata,
      status: 'active',
    });
  }

  // Mark the weakest memories as archived
  const byWeight = [...memories].sort((a, b) => a.weight - b.weight);
  for (let i = 0; i < ARCHIVED_COUNT && i < byWeight.length; i++) byWeight[i].status = 'archived';

  return memories;
}

// ---------------------------------------------------------------------------
// Edge generation (~263 relationships, every memory ≥ 1)
// ---------------------------------------------------------------------------

const EDGE_TARGET = 263;

function edgeTypeFor(a: Memory, b: Memory): EdgeType {
  // Cross-scope edges are the corpus callosum: derived_from
  if (a.scope !== b.scope) return 'derived_from';
  return pick([
    'reinforces',
    'reinforces',
    'reinforces',
    'extends',
    'extends',
    'derived_from',
    'exception_to',
    'contradicts',
  ] as const);
}

function buildEdges(memories: Memory[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const connected = new Map<string, Set<string>>();

  const link = (a: Memory, b: Memory) => {
    if (a.id === b.id || seen.has(key(a.id, b.id))) return false;
    seen.add(key(a.id, b.id));
    const t = Math.min(
      new Date(a.createdAt).getTime(),
      new Date(b.createdAt).getTime(),
    );
    edges.push({
      id: ulid(t + rint(0, DAY), rand),
      source: a.id,
      target: b.id,
      type: edgeTypeFor(a, b),
      createdAt: iso(t + rint(0, DAY)),
    });
    degree.set(a.id, (degree.get(a.id) ?? 0) + 1);
    degree.set(b.id, (degree.get(b.id) ?? 0) + 1);
    if (!connected.has(a.id)) connected.set(a.id, new Set());
    if (!connected.has(b.id)) connected.set(b.id, new Set());
    connected.get(a.id)!.add(b.id);
    connected.get(b.id)!.add(a.id);
    return true;
  };

  // Pass 1: guarantee every memory ≥ 1 relationship (prefer same domain + same scope)
  for (const m of memories) {
    if ((degree.get(m.id) ?? 0) > 0) continue;
    const sameDomain = memories.filter(
      (o) =>
        o.id !== m.id &&
        o.domain === m.domain &&
        o.scope === m.scope &&
        !connected.get(m.id)?.has(o.id),
    );
    const sameScope = memories.filter((o) => o.id !== m.id && o.scope === m.scope);
    const partner =
      sameDomain.length > 0 && rand() > 0.2
        ? pick(sameDomain)
        : rand() > 0.12
          ? pick(sameScope)
          : pick(memories.filter((o) => o.id !== m.id));
    link(m, partner);
  }

  // Pass 2: strengthen the corpus callosum — ensure a healthy set of cross-scope bridges
  const projectNodes = memories.filter((m) => m.scope === 'project');
  const globalNodes = memories.filter((m) => m.scope === 'global');
  for (let i = 0; i < 18; i++) link(pick(projectNodes), pick(globalNodes));

  // Pass 3: random densification until target (biased to same scope)
  let guard = 0;
  while (edges.length < EDGE_TARGET && guard++ < EDGE_TARGET * 20) {
    const a = pick(memories);
    const sameScope = rand() < 0.78;
    const pool = memories.filter(
      (o) =>
        o.id !== a.id &&
        (sameScope ? o.scope === a.scope : true) &&
        (rand() > 0.5 ? o.domain === a.domain : true),
    );
    link(a, pick(pool));
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Metrics: 30-day daily time series for every subsystem metric name
// ---------------------------------------------------------------------------

export const METRIC_NAMES = [
  'recall_hit',
  'recall_miss',
  'preference_compliance',
  'duplicate_rate',
  'correction_stored',
  'memory_bloat_ratio',
  'prediction_error:low',
  'prediction_error:med',
  'prediction_error:high',
  'reflex_fire',
  'reflex_block',
  'reflex_rewrite',
  'reflex_override',
  'working_memory:goal',
  'working_memory:plan',
  'working_memory:facts',
  'working_memory:scratch',
  'schema_formation',
  'arousal_modulation',
] as const;

interface MetricShape {
  base: number; // typical daily value
  jitter: number; // relative jitter 0..1
  trend: number; // per-day drift
  ratio?: boolean; // clamp 0..1
}

const METRIC_SHAPES: Record<string, MetricShape> = {
  recall_hit: { base: 42, jitter: 0.3, trend: 0.15 },
  recall_miss: { base: 9, jitter: 0.4, trend: -0.08 },
  preference_compliance: { base: 0.86, jitter: 0.08, trend: 0.001, ratio: true },
  duplicate_rate: { base: 0.07, jitter: 0.35, trend: -0.0008, ratio: true },
  correction_stored: { base: 3, jitter: 0.6, trend: 0.02 },
  memory_bloat_ratio: { base: 0.18, jitter: 0.2, trend: 0.001, ratio: true },
  'prediction_error:low': { base: 21, jitter: 0.3, trend: 0.1 },
  'prediction_error:med': { base: 7, jitter: 0.45, trend: -0.02 },
  'prediction_error:high': { base: 2, jitter: 0.6, trend: -0.03 },
  reflex_fire: { base: 14, jitter: 0.35, trend: 0.05 },
  reflex_block: { base: 3, jitter: 0.5, trend: 0.01 },
  reflex_rewrite: { base: 5, jitter: 0.4, trend: 0.02 },
  reflex_override: { base: 1, jitter: 0.7, trend: 0 },
  'working_memory:goal': { base: 0.72, jitter: 0.15, trend: 0, ratio: true },
  'working_memory:plan': { base: 0.64, jitter: 0.2, trend: 0, ratio: true },
  'working_memory:facts': { base: 0.81, jitter: 0.12, trend: 0, ratio: true },
  'working_memory:scratch': { base: 0.38, jitter: 0.3, trend: 0, ratio: true },
  schema_formation: { base: 1.5, jitter: 0.8, trend: 0.03 },
  arousal_modulation: { base: 0.5, jitter: 0.25, trend: 0, ratio: true },
};

function buildMetrics(): Metric[] {
  const mrand = mulberry32(SEED ^ 0x9e7a1c);
  return METRIC_NAMES.map((name) => {
    const shape = METRIC_SHAPES[name];
    const series: MetricPoint[] = [];
    let sum = 0;
    for (let d = 29; d >= 0; d--) {
      const date = new Date(NOW - d * DAY);
      let v = shape.base + shape.trend * (29 - d);
      v *= 1 + (mrand() - 0.5) * 2 * shape.jitter;
      if (shape.ratio) v = Math.min(1, Math.max(0, v));
      v = Math.max(0, v);
      const value = shape.ratio ? Math.round(v * 1000) / 1000 : Math.round(v * 100) / 100;
      series.push({ date: date.toISOString().slice(0, 10), value });
      sum += value;
    }
    const latest = series[series.length - 1];
    return {
      metric_name: name,
      count: series.length,
      sum: Math.round(sum * 100) / 100,
      avg: Math.round((sum / series.length) * 1000) / 1000,
      latest: latest.value,
      latest_at: latest.date,
      series,
    };
  });
}

// ---------------------------------------------------------------------------
// Dataset singletons + selectors
// ---------------------------------------------------------------------------

// Pristine demo dataset (kept so RESET TO DEMO can restore it exactly).
const DEMO_MEMORIES: Memory[] = buildMemories();
const DEMO_EDGES: GraphEdge[] = buildEdges(DEMO_MEMORIES);
const DEMO_METRICS: Metric[] = buildMetrics();

// Live datasets are mutated IN PLACE (see swapDataset) so every existing
// importer of MEMORIES / EDGES keeps working without signature changes.
export const MEMORIES: Memory[] = [...DEMO_MEMORIES];
export const EDGES: GraphEdge[] = [...DEMO_EDGES];
const METRICS: Metric[] = [...DEMO_METRICS];

let BY_ID = new Map(MEMORIES.map((m) => [m.id, m]));

// Server-provided aggregates (live mode only). When present they win over the
// locally computed values; cleared on any dataset swap.
let statsOverride: Stats | null = null;
let domainsOverride: DomainInfo[] | null = null;

export function getStats(): Stats {
  if (statsOverride) return statsOverride;
  const byType = Object.fromEntries(
    MEMORIES.reduce<Map<MemoryType, number>>((acc, m) => {
      acc.set(m.type, (acc.get(m.type) ?? 0) + 1);
      return acc;
    }, new Map()),
  ) as Record<MemoryType, number>;
  return {
    totalMemories: MEMORIES.length,
    byType,
    byScope: {
      project: MEMORIES.filter((m) => m.scope === 'project').length,
      global: MEMORIES.filter((m) => m.scope === 'global').length,
    },
    totalRelationships: EDGES.length,
  };
}

export function getDomains(): DomainInfo[] {
  if (domainsOverride) return domainsOverride;
  const map = new Map<string, { count: number; types: Set<MemoryType>; categories: Set<string> }>();
  for (const m of MEMORIES) {
    if (!m.domain) continue;
    if (!map.has(m.domain)) map.set(m.domain, { count: 0, types: new Set(), categories: new Set() });
    const d = map.get(m.domain)!;
    d.count++;
    d.types.add(m.type);
    if (m.category) d.categories.add(m.category);
  }
  return [...map.entries()]
    .map(([name, d]) => ({
      name,
      count: d.count,
      types: [...d.types],
      categories: [...d.categories],
    }))
    .sort((a, b) => b.count - a.count);
}

export function getGraph(filters: GraphFilters = {}): Graph {
  const {
    limit,
    scope = 'all',
    type,
    tags,
    domain,
    category,
    minWeight,
    createdAfter,
    createdBefore,
    q,
  } = filters;

  let nodes = MEMORIES.filter((m) => {
    if (scope !== 'all' && m.scope !== scope) return false;
    if (type && type.length > 0 && !type.includes(m.type)) return false;
    if (domain && m.domain !== domain) return false;
    if (category && category.length > 0 && (!m.category || !category.includes(m.category)))
      return false;
    if (minWeight !== undefined && m.weight < minWeight) return false;
    if (tags && tags.length > 0 && !tags.every((t) => m.tags.includes(t))) return false;
    if (createdAfter && m.createdAt < createdAfter) return false;
    if (createdBefore && m.createdAt > createdBefore) return false;
    if (q) {
      const needle = q.toLowerCase();
      const hay = `${m.content} ${m.tags.join(' ')} ${m.id} ${m.domain ?? ''} ${m.category ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (limit !== undefined && limit > 0) {
    nodes = [...nodes].sort((a, b) => b.weight - a.weight).slice(0, limit);
  }

  const ids = new Set(nodes.map((m) => m.id));
  const edges = EDGES.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

export function getMemory(id: string): Memory | undefined {
  return BY_ID.get(id);
}

export function getMetrics(name?: string): Metric[] {
  if (!name) return METRICS;
  return METRICS.filter((m) => m.metric_name === name);
}

/** Relationships of one memory, with the linked memory resolved. */
export interface ResolvedEdge extends GraphEdge {
  direction: 'out' | 'in';
  other: Memory;
}

export function getRelationships(id: string): ResolvedEdge[] {
  const out: ResolvedEdge[] = [];
  for (const e of EDGES) {
    if (e.source === id) {
      const other = BY_ID.get(e.target);
      if (other) out.push({ ...e, direction: 'out', other });
    } else if (e.target === id) {
      const other = BY_ID.get(e.source);
      if (other) out.push({ ...e, direction: 'in', other });
    }
  }
  return out.sort((a, b) => b.other.weight - a.other.weight);
}

/** Neighbourhood (1-hop ids) for hover-dim highlighting. */
export function getNeighborIds(id: string): Set<string> {
  const set = new Set<string>([id]);
  for (const e of EDGES) {
    if (e.source === id) set.add(e.target);
    else if (e.target === id) set.add(e.source);
  }
  return set;
}

/** ISO date N days ago, for createdAfter/createdBefore defaults. */
export function daysAgoISO(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

export const NOW_ISO = iso(NOW);

// ---------------------------------------------------------------------------
// Data-source layer — live RealMemory API / JSON import / demo simulation
// ---------------------------------------------------------------------------

import { uiStore } from './ui-store';

export type DataSourceMode = 'live' | 'import' | 'demo';

export interface DataSourceInfo {
  mode: DataSourceMode;
  baseUrl?: string;
  nodeCount: number;
  edgeCount: number;
  loadedAt: string;
}

// Relative by default — fetches resolve against the page origin. This makes the
// UI work regardless of how it's served: direct http://127.0.0.1:9333, the
// Tailscale HTTPS proxy (https://host:8333 → 127.0.0.1:9333), or any other
// reverse proxy. An absolute http:// default would be blocked as mixed content
// when the page itself is served over HTTPS.
export const DEFAULT_API_BASE = '';
const LS_API_BASE = 'realmemory.apiBase';
const LS_IMPORT = 'realmemory.import';
const FETCH_TIMEOUT_MS = 1500;

let sourceInfo: DataSourceInfo = {
  mode: 'demo',
  nodeCount: MEMORIES.length,
  edgeCount: EDGES.length,
  loadedAt: NOW_ISO,
};

export function getDataSourceInfo(): DataSourceInfo {
  return sourceInfo;
}

// ---- localStorage guards (private mode / quota) ----------------------------

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function lsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---- fetch with timeout -----------------------------------------------------

async function fetchJSON(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

// ---- normalization ----------------------------------------------------------

const MEMORY_TYPES: readonly MemoryType[] = [
  'user_preference',
  'task_pattern',
  'codebase_fact',
  'lesson_learned',
  'session_summary',
  'contextual_note',
];
const EDGE_TYPES: readonly EdgeType[] = [
  'reinforces',
  'contradicts',
  'extends',
  'exception_to',
  'derived_from',
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const num = (v: unknown, dflt: number): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
};
const isoOr = (v: unknown, dflt: string): string => {
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return dflt;
};

let synthId = 0;
const genId = () => `IMP${Date.now().toString(36).toUpperCase()}${(synthId++).toString(36).toUpperCase().padStart(4, '0')}`;

/** Coerce a raw API/import record into a Memory. Embedding is ALWAYS stripped. */
export function normalizeMemory(raw: any): Memory | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.content !== 'string' || !raw.content) return null;
  if (typeof raw.type !== 'string' || !raw.type) return null;
  const nowIso = iso(Date.now());
  const tags: string[] = Array.isArray(raw.tags)
    ? raw.tags.filter((t: unknown): t is string => typeof t === 'string')
    : [];
  return {
    id: raw.id,
    content: String(raw.content).slice(0, 500),
    type: (MEMORY_TYPES as readonly string[]).includes(raw.type) ? (raw.type as MemoryType) : 'contextual_note',
    scope: raw.scope === 'project' ? 'project' : 'global',
    domain: typeof raw.domain === 'string' && raw.domain ? raw.domain : undefined,
    category: typeof raw.category === 'string' && raw.category ? raw.category : undefined,
    source: raw.source && typeof raw.source === 'object' ? raw.source : undefined,
    tags: [...new Set(tags)].slice(0, 8),
    weight: clamp01(num(raw.weight, 0.5)),
    confidence: clamp01(num(raw.confidence, 0.8)),
    createdAt: isoOr(raw.createdAt, nowIso),
    updatedAt: isoOr(raw.updatedAt, nowIso),
    accessCount: Math.max(0, Math.round(num(raw.accessCount, 1))),
    reinforcementCount: Math.max(0, Math.round(num(raw.reinforcementCount, 0))),
    metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {},
    status: raw.status === 'archived' ? 'archived' : 'active',
  };
}

function normalizeEdge(raw: any): GraphEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
    source: raw.source,
    target: raw.target,
    type: (EDGE_TYPES as readonly string[]).includes(raw.type) ? (raw.type as EdgeType) : 'derived_from',
    createdAt: isoOr(raw.createdAt, iso(Date.now())),
  };
}

interface NormalizedGraph {
  nodes: Memory[];
  edges: GraphEdge[];
}

/** Validate + normalize a `{nodes, edges}` payload. Throws Error with clear copy. */
export function normalizeGraphPayload(json: any): NormalizedGraph {
  if (!json || typeof json !== 'object') {
    throw new Error('Not a JSON object — expected { "nodes": [...], "edges": [...] }.');
  }
  if (!Array.isArray(json.nodes) || json.nodes.length === 0) {
    throw new Error('Missing "nodes" array — export via curl http://127.0.0.1:9333/api/graph?limit=2000 > my-memories.json');
  }
  const nodes: Memory[] = [];
  let skipped = 0;
  for (const raw of json.nodes) {
    const m = normalizeMemory(raw);
    if (m) nodes.push(m);
    else skipped++;
  }
  if (nodes.length === 0) {
    throw new Error('No valid memories found — every node needs an id, content and type.');
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  if (json.edges !== undefined) {
    if (!Array.isArray(json.edges)) throw new Error('"edges" must be an array when present.');
    for (const raw of json.edges) {
      const e = normalizeEdge(raw);
      if (e && ids.has(e.source) && ids.has(e.target)) edges.push(e);
    }
  }
  if (skipped > 0) console.warn(`[realmemory] skipped ${skipped} malformed node(s) on ingest`);
  return { nodes, edges };
}

// ---- dataset swap -----------------------------------------------------------

function bumpVersion() {
  uiStore.set({ dataVersion: uiStore.getState().dataVersion + 1 });
}

/** Replace the module-level dataset IN PLACE and notify the UI. */
function swapDataset(nodes: Memory[], edges: GraphEdge[], info: DataSourceInfo) {
  MEMORIES.length = 0;
  MEMORIES.push(...nodes);
  EDGES.length = 0;
  EDGES.push(...edges);
  BY_ID = new Map(nodes.map((m) => [m.id, m]));
  statsOverride = null;
  domainsOverride = null;
  sourceInfo = info;
  bumpVersion();
}

// ---- server aggregates (optional, live mode) --------------------------------

function validStats(raw: any): raw is Stats {
  return (
    raw &&
    typeof raw === 'object' &&
    Number.isFinite(raw.totalMemories) &&
    Number.isFinite(raw.totalRelationships) &&
    raw.byType &&
    typeof raw.byType === 'object' &&
    raw.byScope &&
    Number.isFinite(raw.byScope.project) &&
    Number.isFinite(raw.byScope.global)
  );
}

function validDomains(raw: any): raw is DomainInfo[] {
  return (
    Array.isArray(raw) &&
    raw.every((d) => d && typeof d.name === 'string' && Number.isFinite(d.count) && Array.isArray(d.types) && Array.isArray(d.categories))
  );
}

function validMetrics(raw: any): raw is Metric[] {
  return Array.isArray(raw) && raw.length > 0 && raw.every((m) => m && typeof m.metric_name === 'string' && Array.isArray(m.series));
}

function fetchAggregates(base: string) {
  // fire-and-forget: swap in server aggregates when they arrive
  void (async () => {
    let touched = false;
    try {
      const stats = await fetchJSON(`${base}/api/stats`);
      if (validStats(stats)) {
        statsOverride = stats;
        touched = true;
      }
    } catch { /* keep computed */ }
    try {
      const domains = await fetchJSON(`${base}/api/domains`);
      if (validDomains(domains)) {
        domainsOverride = domains;
        touched = true;
      }
    } catch { /* keep computed */ }
    try {
      const metrics = await fetchJSON(`${base}/api/metrics`);
      if (validMetrics(metrics)) {
        METRICS.length = 0;
        METRICS.push(...metrics);
        touched = true;
      }
    } catch { /* keep demo series */ }
    if (touched) bumpVersion();
  })();
}

// ---- stored import ----------------------------------------------------------

function readStoredImport(): NormalizedGraph | null {
  const raw = lsGet(LS_IMPORT);
  if (!raw) return null;
  try {
    return normalizeGraphPayload(JSON.parse(raw));
  } catch {
    lsRemove(LS_IMPORT);
    return null;
  }
}

// ---- public API --------------------------------------------------------------

function resolveApiBase(override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  try {
    const q = new URLSearchParams(window.location.search).get('api');
    if (q) return q.replace(/\/+$/, '');
  } catch { /* no window */ }
  const stored = lsGet(LS_API_BASE);
  if (stored) {
    // Mixed-content guard: a stale http:// base persisted from a prior
    // localhost visit is blocked when the page is served over HTTPS (e.g. via
    // the Tailscale proxy). Fall back to relative in that case.
    if (stored.startsWith('http://') && window.location.protocol === 'https:') {
      lsRemove(LS_API_BASE);
      return DEFAULT_API_BASE;
    }
    return stored.replace(/\/+$/, '');
  }
  return DEFAULT_API_BASE;
}

/**
 * Boot the data source. Tries the live RealMemory API (1.5s timeout, silent
 * fail), falls back to a persisted import, then to the demo simulation.
 * Safe to call again to re-connect with a new base URL.
 */
export async function initDataSource(baseOverride?: string): Promise<DataSourceInfo> {
  const base = resolveApiBase(baseOverride);
  try {
    const json = await fetchJSON(`${base}/api/graph?limit=2000&scope=all`);
    const { nodes, edges } = normalizeGraphPayload(json);
    swapDataset(nodes, edges, {
      mode: 'live',
      baseUrl: base,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      loadedAt: iso(Date.now()),
    });
    lsSet(LS_API_BASE, base);
    fetchAggregates(base);
    return sourceInfo;
  } catch {
    // silent fail — offline / cloud preview / wrong port
  }
  const stored = readStoredImport();
  if (stored && sourceInfo.mode !== 'live') {
    swapDataset(stored.nodes, stored.edges, {
      mode: 'import',
      nodeCount: stored.nodes.length,
      edgeCount: stored.edges.length,
      loadedAt: iso(Date.now()),
    });
  }
  return sourceInfo;
}

/** Test `${base}/health`, then re-init against that base. */
export async function connectLive(base: string): Promise<{ ok: boolean; error?: string }> {
  const clean = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(clean)) return { ok: false, error: 'Base URL must start with http:// or https://' };
  try {
    await fetchJSON(`${clean}/health`);
  } catch {
    return { ok: false, error: `No RealMemory API at ${clean} — is \`npx realmemory-mcp --ui\` running?` };
  }
  const info = await initDataSource(clean);
  if (info.mode !== 'live') return { ok: false, error: 'Health check passed but /api/graph returned no memories.' };
  return { ok: true };
}

export type ImportResult = { ok: true; nodeCount: number; edgeCount: number; persisted: boolean } | { ok: false; error: string };

/** Import a `{nodes, edges}` JSON export (embeddings stripped, persisted). */
export function importDataset(json: unknown): ImportResult {
  let graph: NormalizedGraph;
  try {
    graph = normalizeGraphPayload(json);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid dataset.' };
  }
  swapDataset(graph.nodes, graph.edges, {
    mode: 'import',
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    loadedAt: iso(Date.now()),
  });
  const persisted = lsSet(LS_IMPORT, JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
  if (!persisted) console.warn('[realmemory] localStorage quota exceeded — import lives for this session only');
  return { ok: true, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, persisted };
}

/** Restore the built-in deterministic demo dataset. */
export function resetToDemo(): void {
  lsRemove(LS_IMPORT);
  METRICS.length = 0;
  METRICS.push(...DEMO_METRICS);
  swapDataset([...DEMO_MEMORIES], [...DEMO_EDGES], {
    mode: 'demo',
    nodeCount: DEMO_MEMORIES.length,
    edgeCount: DEMO_EDGES.length,
    loadedAt: iso(Date.now()),
  });
}
