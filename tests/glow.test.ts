import { describe, it, expect } from 'vitest';
// Pure module — no React/three imports — importable from root vitest (node env).
// Mirrors the tests/domain-regions.test.ts precedent (issue #48).
import { GLOW_BASE, glowScale } from '../ui/src/lib/glow';

describe('GLOW_BASE constants (regression guard — pin to pre-slider hard-coded values)', () => {
  it('bloom matches BrainCanvas <Bloom intensity> (1.2)', () => {
    expect(GLOW_BASE.bloom).toBe(1.2);
  });
  it('emissive matches Neurons material.emissiveIntensity (1.55)', () => {
    expect(GLOW_BASE.emissive).toBe(1.55);
  });
  it('halo matches SpriteMaterial base opacity (0.35)', () => {
    expect(GLOW_BASE.halo).toBe(0.35);
  });
  it('ring matches SelectionRings ring 1 opacity (0.9)', () => {
    expect(GLOW_BASE.ring).toBe(0.9);
  });
  it('ring2 matches SelectionRings ring 2 opacity (0.6)', () => {
    expect(GLOW_BASE.ring2).toBe(0.6);
  });
  it('boltTint matches Bolts useEffect multiplyScalar (1.5)', () => {
    expect(GLOW_BASE.boltTint).toBe(1.5);
  });
  it('fresnelCerebrum matches BrainShell cerebrum uIntensity (1.5, stays at base)', () => {
    expect(GLOW_BASE.fresnelCerebrum).toBe(1.5);
  });
  it('fresnelCerebellum matches BrainShell cerebellum uIntensity (1.1, stays at base)', () => {
    expect(GLOW_BASE.fresnelCerebellum).toBe(1.1);
  });
  it('fresnelStem matches BrainShell stem uIntensity (1.0, stays at base)', () => {
    expect(GLOW_BASE.fresnelStem).toBe(1.0);
  });
  it('wireCerebrum matches BrainShell cerebrum wireframe opacity (0.09)', () => {
    expect(GLOW_BASE.wireCerebrum).toBe(0.09);
  });
  it('wireSub matches BrainShell sub wireframe opacity (0.08)', () => {
    expect(GLOW_BASE.wireSub).toBe(0.08);
  });
});

describe('glowScale', () => {
  it('returns bit-identical to GLOW_BASE at g=1 (no regression at full glow)', () => {
    const s = glowScale(1);
    expect(s.bloom).toBe(GLOW_BASE.bloom);
    expect(s.emissive).toBe(GLOW_BASE.emissive);
    expect(s.halo).toBe(GLOW_BASE.halo);
    expect(s.ring).toBe(GLOW_BASE.ring);
    expect(s.ring2).toBe(GLOW_BASE.ring2);
    expect(s.boltTint).toBe(GLOW_BASE.boltTint);
    // fresnel uIntensity stays at base (uGlow handles scaling in the shader)
    expect(s.fresnelCerebrum).toBe(GLOW_BASE.fresnelCerebrum);
    expect(s.fresnelCerebellum).toBe(GLOW_BASE.fresnelCerebellum);
    expect(s.fresnelStem).toBe(GLOW_BASE.fresnelStem);
    expect(s.wireCerebrum).toBe(GLOW_BASE.wireCerebrum);
    expect(s.wireSub).toBe(GLOW_BASE.wireSub);
  });

  it('returns all zeros at g=0 (true zero glow — every surface black/invisible)', () => {
    const s = glowScale(0);
    expect(s.bloom).toBe(0);
    expect(s.emissive).toBe(0);
    expect(s.halo).toBe(0);
    expect(s.ring).toBe(0);
    expect(s.ring2).toBe(0);
    expect(s.boltTint).toBe(0);
    expect(s.wireCerebrum).toBe(0);
    expect(s.wireSub).toBe(0);
    // fresnel uIntensity stays at base even at g=0 (uGlow=0 in the shader
    // collapses the output to zero — that's the fresnel scaling path)
    expect(s.fresnelCerebrum).toBe(GLOW_BASE.fresnelCerebrum);
    expect(s.fresnelCerebellum).toBe(GLOW_BASE.fresnelCerebellum);
    expect(s.fresnelStem).toBe(GLOW_BASE.fresnelStem);
  });

  it('returns exactly half of each scalable base constant at g=0.5 (linear dimming)', () => {
    const s = glowScale(0.5);
    expect(s.bloom).toBeCloseTo(GLOW_BASE.bloom * 0.5, 10);
    expect(s.emissive).toBeCloseTo(GLOW_BASE.emissive * 0.5, 10);
    expect(s.halo).toBeCloseTo(GLOW_BASE.halo * 0.5, 10);
    expect(s.ring).toBeCloseTo(GLOW_BASE.ring * 0.5, 10);
    expect(s.ring2).toBeCloseTo(GLOW_BASE.ring2 * 0.5, 10);
    expect(s.boltTint).toBeCloseTo(GLOW_BASE.boltTint * 0.5, 10);
    expect(s.wireCerebrum).toBeCloseTo(GLOW_BASE.wireCerebrum * 0.5, 10);
    expect(s.wireSub).toBeCloseTo(GLOW_BASE.wireSub * 0.5, 10);
    // fresnel uIntensity stays at base (not scaled by glowScale — uGlow handles it)
    expect(s.fresnelCerebrum).toBe(GLOW_BASE.fresnelCerebrum);
    expect(s.fresnelCerebellum).toBe(GLOW_BASE.fresnelCerebellum);
    expect(s.fresnelStem).toBe(GLOW_BASE.fresnelStem);
  });

  it('clamps negative values to 0 (no negative glow)', () => {
    const s = glowScale(-0.1);
    expect(s.bloom).toBe(0);
    expect(s.emissive).toBe(0);
    expect(s.halo).toBe(0);
    expect(s.ring).toBe(0);
    expect(s.ring2).toBe(0);
    expect(s.boltTint).toBe(0);
    expect(s.wireCerebrum).toBe(0);
    expect(s.wireSub).toBe(0);
  });

  it('clamps values > 1 to 1 (no super-glow beyond base)', () => {
    const s = glowScale(1.5);
    expect(s.bloom).toBe(GLOW_BASE.bloom);
    expect(s.emissive).toBe(GLOW_BASE.emissive);
    expect(s.halo).toBe(GLOW_BASE.halo);
    expect(s.ring).toBe(GLOW_BASE.ring);
    expect(s.ring2).toBe(GLOW_BASE.ring2);
    expect(s.boltTint).toBe(GLOW_BASE.boltTint);
    expect(s.wireCerebrum).toBe(GLOW_BASE.wireCerebrum);
    expect(s.wireSub).toBe(GLOW_BASE.wireSub);
  });

  it('monotonically increases across the 0..1 range (slider feels right)', () => {
    const at = (g: number) => glowScale(g).bloom;
    expect(at(0)).toBeLessThan(at(0.25));
    expect(at(0.25)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(0.75));
    expect(at(0.75)).toBeLessThan(at(1));
  });
});
