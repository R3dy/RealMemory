/**
 * Glow scaling for the 3D Brain Graph.
 *
 * Pure module — zero React/three imports — so it is importable from root
 * vitest (environment: node) without jsdom or three.js. Mirrors the
 * `domain-regions.ts` standalone-module precedent (issue #48).
 *
 * The brain's glow is spread across nine additive surfaces (Bloom
 * postprocessing, neuron emissive, halo sprites, ambient bolt tint, cascade
 * burst flicker, two selection rings, three fresnel shells, two wireframe
 * shells). `glowScale(g)` returns the scaled value for each so a single
 * slider dims every surface together — down to true zero at g=0.
 *
 * Constants here are the single source of truth. BrainCanvas + BrainShell
 * read from `glowScale(glowIntensity)` rather than hard-coding, so the
 * regression guard in `tests/glow.test.ts` pins them.
 */

export const GLOW_BASE = {
  bloom: 1.2, // <Bloom intensity>  (BrainCanvas EffectComposer)
  emissive: 1.55, // MeshStandardMaterial.emissiveIntensity  (Neurons)
  halo: 0.35, // halo SpriteMaterial base opacity  (per-frame overwrites; final × glowIntensity)
  ring: 0.9, // selection ring 1 opacity  (SelectionRings)
  ring2: 0.6, // selection ring 2 opacity  (SelectionRings)
  boltTint: 1.5, // ambient bolt static tint multiplyScalar  (Bolts useEffect)
  // Fresnel uIntensity values. NOTE: fresnel is scaled by the `uGlow` shader
  // uniform ONLY (not by uIntensity) to avoid g² double-scaling. These
  // constants are retained as regression-guard documentation and asserted
  // unchanged in tests; they are NOT applied as multipliers at runtime.
  fresnelCerebrum: 1.5, // BrainShell cerebrum uIntensity (stays at base)
  fresnelCerebellum: 1.1, // BrainShell cerebellum uIntensity (stays at base)
  fresnelStem: 1.0, // BrainShell stem uIntensity (stays at base)
  wireCerebrum: 0.09, // BrainShell cerebrum wireframe opacity
  wireSub: 0.08, // BrainShell sub wireframe opacity
} as const;

export interface GlowScale {
  bloom: number;
  emissive: number;
  halo: number;
  ring: number;
  ring2: number;
  boltTint: number;
  fresnelCerebrum: number;
  fresnelCerebellum: number;
  fresnelStem: number;
  wireCerebrum: number;
  wireSub: number;
}

/**
 * Scale all glow surfaces by `g` ∈ [0,1].
 * - `g=0` → zero glow (all surfaces black/invisible; brain lit only by scene lights)
 * - `g=1` → bit-identical to the pre-slider hard-coded constants
 * - `g=0.5` → proportional half-dim across every surface
 * Values outside [0,1] are clamped (no negative glow, no super-glow beyond base).
 */
export function glowScale(g: number): GlowScale {
  const k = Math.max(0, Math.min(1, g));
  return {
    bloom: GLOW_BASE.bloom * k,
    emissive: GLOW_BASE.emissive * k,
    halo: GLOW_BASE.halo * k,
    ring: GLOW_BASE.ring * k,
    ring2: GLOW_BASE.ring2 * k,
    boltTint: GLOW_BASE.boltTint * k,
    // Fresnel uIntensity is NOT scaled here (uGlow handles it in the shader).
    // Returned at base so tests can assert they stay constant.
    fresnelCerebrum: GLOW_BASE.fresnelCerebrum,
    fresnelCerebellum: GLOW_BASE.fresnelCerebellum,
    fresnelStem: GLOW_BASE.fresnelStem,
    wireCerebrum: GLOW_BASE.wireCerebrum * k,
    wireSub: GLOW_BASE.wireSub * k,
  };
}
