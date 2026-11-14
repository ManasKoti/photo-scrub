import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));
