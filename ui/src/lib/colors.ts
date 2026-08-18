import type { EdgeType, MemoryType } from './data';
import type { Memory } from './data';
import { BRAIN_REGIONS, UNASSIGNED_REGION_INDEX, regionIndexFor } from './domain-regions';

/** Color for a memory's domain region (when colorMode === 'domain'). */
export function domainColor(memory: Memory, regionMap: Map<string, number>): string {
  const ri = regionIndexFor(memory, regionMap);
  return BRAIN_REGIONS[ri].color;
}

/** Semantic color maps — design.md §2. MANDATORY RealMemory meaning, neon-tuned for dark UI. */

export const TYPE_COLORS: Record<MemoryType, string> = {
  user_preference: '#4da6ff', // electric blue
  task_pattern: '#22ff88', // synapse green
  codebase_fact: '#ffd319', // datum amber
  lesson_learned: '#ff3355', // scar red
  session_summary: '#b26bff', // engram violet
  contextual_note: '#8a97ab', // static gray
};

export const TYPE_NICKNAMES: Record<MemoryType, string> = {
  user_preference: 'electric blue',
  task_pattern: 'synapse green',
  codebase_fact: 'datum amber',
  lesson_learned: 'scar red',
  session_summary: 'engram violet',
  contextual_note: 'static gray',
};

export const EDGE_COLORS: Record<EdgeType, string> = {
  reinforces: '#22ff88',
  contradicts: '#ff3355',
  extends: '#4da6ff',
  exception_to: '#ffd319',
  derived_from: '#b26bff',
};

export type WeightTier = 'strong' | 'medium' | 'weak' | 'archive';

export const WEIGHT_TIERS: Record<
  Exclude<WeightTier, 'archive'>,
  { min: number; color: string; label: string }
> = {
  strong: { min: 0.5, color: '#22ff88', label: 'STRONG' },
  medium: { min: 0.25, color: '#ffd319', label: 'STABLE' },
  weak: { min: 0, color: '#ff3355', label: 'FADING' },
};

export const ARCHIVE_THRESHOLD = 0.05;
export const ARCHIVE_COLOR = '#ff3355'; // pulsing — AUTO-ARCHIVE ZONE

export function weightTier(weight: number): WeightTier {
  if (weight < ARCHIVE_THRESHOLD) return 'archive';
  if (weight > 0.5) return 'strong';
  if (weight > 0.25) return 'medium';
  return 'weak';
}

export function weightColor(weight: number): string {
  const tier = weightTier(weight);
  if (tier === 'archive') return ARCHIVE_COLOR;
  return WEIGHT_TIERS[tier].color;
}

export function weightLabel(weight: number): string {
  const tier = weightTier(weight);
  if (tier === 'archive') return 'AUTO-ARCHIVE';
  return WEIGHT_TIERS[tier].label;
}

export type InhibitionLevel = 'off' | 'warn' | 'rewrite' | 'block';

export const INHIBITION_COLORS: Record<InhibitionLevel, string> = {
  off: '#8a97ab',
  warn: '#ffd319',
  rewrite: '#ff9f1c',
  block: '#ff3355',
};

export type PredictionErrorLevel = 'low' | 'med' | 'high';

export const PREDICTION_ERROR_COLORS: Record<PredictionErrorLevel, string> = {
  low: '#22ff88',
  med: '#ffd319',
  high: '#ff3355',
};

export const SCOPE_COLORS = {
  project: '#00d4ff',
  global: '#b26bff',
} as const;

/** Core theme tokens (design.md §2) */
export const THEME = {
  void: '#02060e',
  space: '#050b18',
  arc: '#00d4ff',
  arcSoft: '#7de9ff',
  arcDim: '#0e5d75',
  reactor: '#ffb627',
  danger: '#ff3355',
  ok: '#22ff88',
  textHi: '#e8f6ff',
  textMid: '#8fa9c7',
  textDim: '#4b5f7c',
} as const;
