import { useSyncExternalStore } from 'react';
import type { Scope } from './data';

export type ScopeFilter = Scope | 'all';

export interface UiState {
  /** Global scope quick-toggle (top HUD bar) — mirrors the graph scope filter. */
  scope: ScopeFilter;
  autoRotate: boolean;
  /** 0..1 — scales synapse pulse particle counts. */
  pulseDensity: number;
  reducedMotion: boolean;
  /** Floating memory labels on the 3D graph. */
  labels: boolean;
  /** Bumped by the data layer whenever the dataset is swapped (live/import/demo). */
  dataVersion: number;
}

const MEDIA_REDUCED =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let state: UiState = {
  scope: 'all',
  autoRotate: true,
  pulseDensity: 0.8,
  reducedMotion: MEDIA_REDUCED,
  labels: true,
  dataVersion: 0,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const uiStore = {
  getState: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useUiStore(): UiState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getState, uiStore.getState);
}

/** Ask the open page to show the ⌘K command palette. */
export function requestCommandPalette() {
  window.dispatchEvent(new CustomEvent('realmemory:palette'));
}
