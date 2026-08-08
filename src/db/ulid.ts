/**
 * Minimal ULID generator — time-sortable unique identifiers.
 *
 * ULID format: 26 chars, Crockford base32, first 10 = timestamp (ms),
 * remaining 16 = random. Lexicographically sortable by time.
 */

const ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
let lastRand: number[] = [];

export function generateUlid(): string {
  const now = Date.now();
  let rand: number[];

  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = RAND_LEN - 1; i >= 0; i--) {
      if (rand[i] === 31) {
        rand[i] = 0;
      } else {
        rand[i]++;
        break;
      }
    }
  } else {
    rand = new Array(RAND_LEN);
    for (let i = 0; i < RAND_LEN; i++) {
      rand[i] = Math.floor(Math.random() * 32);
    }
  }

  lastTime = now;
  lastRand = rand;

  let id = "";
  let ts = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = ts % 32;
    id = ENCODE[mod] + id;
    ts = Math.floor(ts / 32);
  }
  for (let i = 0; i < RAND_LEN; i++) {
    id += ENCODE[rand[i]];
  }

  return id;
}
