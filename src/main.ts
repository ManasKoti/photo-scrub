import { formatBytes } from './core/bytes';
import { scrub, type ScrubResult } from './core/scrub';

const input = document.querySelector<HTMLInputElement>('#file-input')!;
const dropZone = document.querySelector<HTMLLabelElement>('#drop-zone')!;
const result = document.querySelector<HTMLElement>('#result')!;

let currentUrl: string | null = null;

function cleanName(original: string, extension: string): string {
  const base = original.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}-clean.${extension}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message: string): void {
  result.replaceChildren(el('p', message, 'error'));
  result.hidden = false;
}

function showResult(file: File, r: ScrubResult): void {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  // Copy into a fresh ArrayBuffer-backed array so Blob gets plain bytes.
  currentUrl = URL.createObjectURL(new Blob([new Uint8Array(r.output)], { type: r.mime }));

  const nodes: Node[] = [];
  nodes.push(el('h2', file.name));

  if (r.removed.length === 0) {
    nodes.push(el('p', 'No hidden metadata was found in this photo. You can still download a copy.'));
  } else {
    nodes.push(el('p', 'Removed:'));
    const list = el('ul');
    for (const item of r.removed) list.append(el('li', `${item.label} (${formatBytes(item.bytes)})`));
    nodes.push(list);
  }

  if (r.orientation !== undefined) {
    nodes.push(el('p', 'Kept: rotation info, so the photo still displays the right way up.', 'note'));
  }
  for (const w of r.warnings) nodes.push(el('p', w, 'warning'));

  nodes.push(
    r.remaining.length === 0
      ? el('p', '✔ Checked: the clean copy contains no location, device or time data.', 'ok')
      : el('p', `⚠ Some metadata could not be removed: ${r.remaining.join(', ')}`, 'warning'),
  );

  nodes.push(el('p', `Size: ${formatBytes(file.size)} → ${formatBytes(r.output.length)}`, 'note'));

  const link = el('a', 'Download clean photo', 'button');
  link.href = currentUrl;
  link.download = cleanName(file.name, r.extension);
  nodes.push(link);

  result.replaceChildren(...nodes);
  result.hidden = false;
}

async function handleFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    showResult(file, scrub(bytes));
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Something went wrong reading this file.');
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) void handleFile(file);
  input.value = ''; // allow picking the same file again
});

for (const type of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(type, () => dropZone.classList.remove('dragging'));
}
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) void handleFile(file);
});
