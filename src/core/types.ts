/** Shared shapes used by every format's stripper. */

export interface StripOptions {
  /** Keep a minimal EXIF block with just the Orientation tag. Default true. */
  keepOrientation?: boolean;
  /** Keep the ICC colour profile. Default true. */
  keepColorProfile?: boolean;
}

export interface RemovedItem {
  /** Machine-readable kind, e.g. 'exif', 'xmp', 'trailer'. */
  kind: string;
  /** Plain-language description for the UI. */
  label: string;
  bytes: number;
}

export interface StripResult {
  output: Uint8Array;
  removed: RemovedItem[];
  /** Orientation value written into the clean file, if any. */
  orientation?: number;
  warnings: string[];
}

/** Collects removed-byte totals per kind, then turns them into RemovedItems. */
export class RemovalTally {
  private totals = new Map<string, number>();
  constructor(private labels: Record<string, string>) {}

  add(kind: string, bytes: number): void {
    if (bytes !== 0) this.totals.set(kind, (this.totals.get(kind) ?? 0) + bytes);
  }

  items(): RemovedItem[] {
    const out: RemovedItem[] = [];
    for (const [kind, bytes] of this.totals) {
      if (bytes > 0) out.push({ kind, label: this.labels[kind] ?? kind, bytes });
    }
    return out;
  }
}
