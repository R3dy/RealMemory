import { describe, it, expect } from 'vitest';
import {
  BRAIN_REGIONS,
  UNASSIGNED_REGION_INDEX,
  computeDomainRegionMap,
  regionIndexFor,
} from '../ui/src/lib/domain-regions';

describe('BRAIN_REGIONS', () => {
  it('has exactly 10 regions', () => {
    expect(BRAIN_REGIONS).toHaveLength(10);
  });

  it('every region has name, anchor, radius, color', () => {
    for (const r of BRAIN_REGIONS) {
      expect(typeof r.name).toBe('string');
      expect(r.anchor).toHaveLength(3);
      expect(typeof r.radius).toBe('number');
      expect(r.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('all colors are distinct', () => {
    const colors = BRAIN_REGIONS.map((r) => r.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('computeDomainRegionMap', () => {
  it('assigns the top-count domain to region 0', () => {
    const nodes = [
      { id: '1', domain: 'react' },
      { id: '2', domain: 'react' },
      { id: '3', domain: 'react' },
      { id: '4', domain: 'aws' },
      { id: '5', domain: 'aws' },
      { id: '6', domain: 'opencode' },
    ];
    const map = computeDomainRegionMap(nodes);
    expect(map.get('react')).toBe(0); // 3 count → region 0 (Left Frontal)
    expect(map.get('aws')).toBe(1);     // 2 count → region 1
    expect(map.get('opencode')).toBe(2); // 1 count → region 2
  });

  it('assigns up to 9 domains to distinct regions (0-8)', () => {
    const domains = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const nodes = domains.map((d, i) => ({ id: String(i), domain: d }));
    const map = computeDomainRegionMap(nodes);
    expect(map.size).toBe(9);
    const regions = [...map.values()];
    expect(new Set(regions).size).toBe(9); // all distinct
    expect(Math.min(...regions)).toBe(0);
    expect(Math.max(...regions)).toBe(8);
  });

  it('overflow domains (10+) cycle into brain stem (region 9)', () => {
    const domains = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    const nodes = domains.map((d, i) => ({ id: String(i), domain: d }));
    const map = computeDomainRegionMap(nodes);
    // 11 domains: 0-8 get regions 0-8, domains 9+ (j, k) → region 9 (brain stem)
    expect(map.get('j')).toBe(9);
    expect(map.get('k')).toBe(9);
  });

  it('excludes undefined-domain memories from the map', () => {
    const nodes = [
      { id: '1', domain: 'react' },
      { id: '2', domain: undefined },
      { id: '3' }, // no domain field
    ];
    const map = computeDomainRegionMap(nodes);
    expect(map.size).toBe(1);
    expect(map.has('react')).toBe(true);
  });

  it('is deterministic (same input → same output)', () => {
    const nodes = [
      { id: '1', domain: 'react' },
      { id: '2', domain: 'aws' },
      { id: '3', domain: 'react' },
    ];
    const a = computeDomainRegionMap(nodes);
    const b = computeDomainRegionMap([...nodes].reverse());
    // react (count 2) → region 0 in both; aws (count 1) → region 1 in both
    expect(a.get('react')).toBe(b.get('react'));
    expect(a.get('aws')).toBe(b.get('aws'));
  });
});

describe('regionIndexFor', () => {
  it('returns the mapped region for a memory with a domain', () => {
    const map = new Map([['react', 0]]);
    expect(regionIndexFor({ id: '1', domain: 'react' }, map)).toBe(0);
  });

  it('returns UNASSIGNED_REGION_INDEX for undefined-domain memories', () => {
    const map = new Map([['react', 0]]);
    expect(regionIndexFor({ id: '1', domain: undefined }, map)).toBe(UNASSIGNED_REGION_INDEX);
    expect(regionIndexFor({ id: '1' }, map)).toBe(UNASSIGNED_REGION_INDEX);
  });

  it('returns UNASSIGNED_REGION_INDEX for a domain not in the map', () => {
    const map = new Map([['react', 0]]);
    expect(regionIndexFor({ id: '1', domain: 'unknown' }, map)).toBe(UNASSIGNED_REGION_INDEX);
  });

  it('UNASSIGNED_REGION_INDEX is 9 (Brain Stem)', () => {
    expect(UNASSIGNED_REGION_INDEX).toBe(9);
    expect(BRAIN_REGIONS[UNASSIGNED_REGION_INDEX].name).toBe('Brain Stem');
  });
});
