import * as THREE from 'three';

let glowTexture: THREE.CanvasTexture | null = null;

/** Radial-gradient sprite texture used for neuron halos + synapse pulses. */
export function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

let boltTexture: THREE.CanvasTexture | null = null;

/**
 * Horizontal lightning-streak texture for electric synapse bolts.
 * Bright core, tapered ends, slight vertical crackle asymmetry.
 */
export function getBoltTexture(): THREE.CanvasTexture {
  if (boltTexture) return boltTexture;
  const w = 128;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // soft elongated body
  const body = ctx.createLinearGradient(0, 0, w, 0);
  body.addColorStop(0, 'rgba(255,255,255,0)');
  body.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  body.addColorStop(0.5, 'rgba(255,255,255,1)');
  body.addColorStop(0.82, 'rgba(255,255,255,0.55)');
  body.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = body;
  // vertical profile: tight bright center row, fading halo rows
  for (let y = 0; y < h; y++) {
    const d = Math.abs(y - h / 2) / (h / 2); // 0 center → 1 edge
    const alpha = Math.max(0, 1 - d * d * 3.2);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, y, w, 1);
  }

  // crackle filaments above/below the core
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  for (const offset of [-5, 4]) {
    ctx.beginPath();
    let y = h / 2 + offset;
    ctx.moveTo(6, y);
    for (let x = 6; x < w - 6; x += 8) {
      y += (Math.sin(x * 1.7 + offset) + Math.sin(x * 0.6)) * 1.4;
      y = Math.max(2, Math.min(h - 2, y));
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  boltTexture = new THREE.CanvasTexture(canvas);
  return boltTexture;
}
