/** Small helpers for reading and writing binary data. */

export function readU16BE(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

export function asciiAt(b: Uint8Array, at: number, length: number): string {
  let s = '';
  for (let i = 0; i < length && at + i < b.length; i++) {
    s += String.fromCharCode(b[at + i] ?? 0);
  }
  return s;
}

/** True when `b` contains the ASCII string `text` starting at `at`. */
export function startsWithAscii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
