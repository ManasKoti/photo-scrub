/**
 * The tool page: Start → Report ("what this photo reveals") → Done.
 * All the photo work happens in ./core; this file only updates the page.
 */

import './fonts';
import './style.css';
import { formatBytes } from './core/bytes';
import type { CategoryId } from './core/categories';
import { inspect, type Finding } from './core/inspect';
import { detectFormat } from './core/detect';
import { analyze, scrub, UnsupportedFormatError, verify, type Analysis } from './core/scrub';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const stages = {
  start: $('#stage-start'),
  busy: $('#stage-busy'),
  report: $('#stage-report'),
  done: $('#stage-done'),
};
type Stage = keyof typeof stages;

const fileInput = $<HTMLInputElement>('#file-input');
const dropZone = $('#drop-zone');
const startError = $('#start-error');
const renameBox = $<HTMLInputElement>('#rename');
const downloadLink = $<HTMLAnchorElement>('#download');
const rawToggle = $<HTMLButtonElement>('#raw-toggle');
const rawPanel = $('#raw-panel');

interface Current {
  file: File;
  bytes: Uint8Array;
  analysis: Analysis;
  /** Categories the user switched to "Keep". */
  keep: Set<CategoryId>;
  url: string;
}
let current: Current | null = null;

// ---- small DOM helpers -------------------------------------------------------

function icon(name: string, size = 22): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(stage: Stage): void {
  for (const [name, node] of Object.entries(stages)) node.hidden = name !== stage;
}

// ---- what to show -------------------------------------------------------------

interface Item {
  icon: string;
  text: string;
  short: string;
}

/** Things removed no matter what, beyond the main findings. */
function alwaysRemoved(a: Analysis): Item[] {
  const kinds = new Set(a.result.removed.map((r) => r.kind));
  const items: Item[] = [];
  if (a.before.hasThumbnail || kinds.has('thumbnail') || kinds.has('jfxx')) {
    items.push({ icon: 'image', text: 'Hidden thumbnail. It can still show the uncropped original.', short: 'Hidden thumbnail' });
  }
  const trailer = a.result.removed.find((r) => r.kind === 'trailer');
  if (trailer) {
    items.push({
      icon: 'film',
      text: `Hidden data tacked on after the image (${formatBytes(trailer.bytes)}). On phones this is often a motion-photo video.`,
      short: 'Hidden extra data or motion video',
    });
  }
  if (kinds.has('comment') || a.before.raw.some((t) => t.group === 'PNG text' && t.category === 'other')) {
    items.push({ icon: 'text', text: 'Hidden text notes and comments', short: 'Text notes' });
  }
  if (['app-other', 'c2pa', 'other', 'xmp-extended'].some((k) => kinds.has(k))) {
    items.push({ icon: 'layers', text: 'Other app data, like editing history or content credentials', short: 'Other app data' });
  }
  return items;
}

function keptItems(a: Analysis): Item[] {
  const items: Item[] = [];
  if (a.result.orientation !== undefined) {
    items.push({ icon: 'check', text: 'Rotation, so the photo stays the right way up', short: 'Rotation info' });
  }
  if (a.result.keptColorProfile) {
    items.push({ icon: 'check', text: 'Colour profile, so colours don’t shift', short: 'Colour profile' });
  }
  return items;
}

function fillList(list: HTMLElement, items: Item[]): void {
  list.replaceChildren(
    ...items.map((it) => {
      const li = el('li');
      li.append(icon(it.icon), el('span', undefined, it.text));
      return li;
    }),
  );
}

const ICONS: Record<Finding['id'], string> = {
  location: 'location', device: 'device', time: 'time', author: 'author', camera: 'camera',
};
const RISK_LABEL = { high: 'HIGH RISK', medium: 'MEDIUM', low: 'LOW' } as const;

function findingCard(f: Finding): HTMLElement {
  const tpl = $<HTMLTemplateElement>('#finding-template');
  const card = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  card.classList.add(`risk-${f.risk}`);
  card.dataset.category = f.id;
  const sw = card.querySelector<HTMLInputElement>('.sw')!;
  sw.setAttribute('aria-label', `Remove ${f.title.toLowerCase()}`);
  sw.addEventListener('change', () => setKeep(f.id, !sw.checked, card));
  card.querySelector('.finding-icon use')!.setAttribute('href', `#i-${ICONS[f.id]}`);
  card.querySelector('.finding-title')!.textContent = f.title;
  card.querySelector('.risk')!.textContent = RISK_LABEL[f.risk];
  card.querySelector('.finding-headline')!.textContent = f.headline;
  const detail = card.querySelector('.finding-detail')!;
  detail.textContent = f.detail + ' ';
  if (f.mapUrl) {
    const a = el('a', undefined, 'See it on a map');
    a.href = f.mapUrl;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    detail.append(a);
  }
  return card;
}

// ---- Remove / Keep switches -------------------------------------------------

/** Re-clean the photo with the current choices. Fast: no re-reading needed. */
function setKeep(id: CategoryId, keep: boolean, card: HTMLElement): void {
  if (!current) return;
  if (keep) current.keep.add(id);
  else current.keep.delete(id);
  card.classList.toggle('is-kept', keep);
  card.querySelector('.switch-text')!.textContent = keep ? 'Keep' : 'Remove';

  const result = scrub(current.bytes, { keep: current.keep, heicDecoded: current.analysis.heicDecoded });
  current.analysis = { ...current.analysis, result };
  URL.revokeObjectURL(current.url);
  current.url = URL.createObjectURL(new Blob([new Uint8Array(result.output)], { type: result.mime }));
  updateSummary();
  updateDownload();
}

function updateSummary(): void {
  if (!current) return;
  const { findings } = current.analysis.before;
  const n = findings.length;
  const kept = findings.filter((f) => current!.keep.has(f.id)).map((f) => f.title);
  const always = alwaysRemoved(current.analysis);
  let text: string;
  if (n === 0) {
    text = always.length > 0
      ? 'There’s still some hidden data, listed below, and it will be removed.'
      : 'This photo is already clean. You can still download a copy.';
  } else if (kept.length === 0) {
    text = n === 1 ? 'It will be removed when you download. Switch it off to keep it.' : `Removing all ${n}. Switch off anything you want to keep.`;
  } else {
    text = `Removing ${n - kept.length} of ${n}. Keeping ${joinWords(kept)}.`;
  }
  $('#report-sub').textContent = text;
}

function joinWords(words: string[]): string {
  const lower = words.map((w) => w.toLowerCase());
  return lower.length <= 1 ? (lower[0] ?? '') : `${lower.slice(0, -1).join(', ')} and ${lower.at(-1)}`;
}

// ---- file names -------------------------------------------------------------

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'photo';
}

function downloadName(): string {
  if (!current) return 'photo';
  const ext = current.analysis.result.extension;
  return renameBox.checked ? `photo.${ext}` : `${baseName(current.file.name)}-clean.${ext}`;
}

function updateDownload(): void {
  if (!current) return;
  const name = downloadName();
  downloadLink.href = current.url;
  downloadLink.download = name;
  $('#download-label').textContent = `Download ${name}`;
}

// ---- stages -------------------------------------------------------------------

function renderReport(file: File, a: Analysis): void {
  const { findings } = a.before;
  const always = alwaysRemoved(a);
  const kept = keptItems(a);

  ($('#preview') as HTMLImageElement).src = current!.url;
  $('#file-name').textContent = file.name;
  $('#file-info').textContent = `${a.result.format.toUpperCase()} · ${formatBytes(file.size)}`;

  const n = findings.length;
  $('#step1').textContent = n === 0
    ? 'Good news: nothing personal found'
    : `This photo gives away ${n} ${n === 1 ? 'thing' : 'things'} about you`;
  updateSummary();

  $('#findings').replaceChildren(...findings.map(findingCard));
  const isHeic = a.result.format === 'heic';
  $('#heic-note').hidden = !isHeic;
  $('#quality-note').textContent = isHeic
    ? 'Saved as a high-quality JPEG that opens everywhere.'
    : 'Same quality as the original: only the hidden data is cut out.';
  $('#warnings').replaceChildren(
    ...a.result.warnings.map((w) => {
      const p = el('p', 'alert');
      p.append(icon('alert'), el('span', undefined, w));
      return p;
    }),
  );

  $('#always-box').hidden = always.length === 0;
  fillList($('#always-list'), always);
  $('#kept-box').hidden = kept.length === 0;
  fillList($('#kept-list'), kept);

  const raw = a.before.raw;
  $('#raw-wrap').hidden = raw.length === 0;
  $('#raw-label').textContent = `Show all ${raw.length} raw tags (for the curious)`;
  rawToggle.setAttribute('aria-expanded', 'false');
  rawPanel.hidden = true;
  $('#raw-body').replaceChildren(
    ...raw.map((t) => {
      const tr = el('tr');
      tr.append(el('td', undefined, t.group), el('td', undefined, t.tag), el('td', undefined, t.value));
      return tr;
    }),
  );

  const base = baseName(file.name);
  $('#rename-hint').textContent = /\d{8}|\d{4}[-_]\d{2}[-_]\d{2}/.test(base)
    ? `Names like “${base}” give away when you took the photo.`
    : 'Original file names can give away when or where a photo was taken.';
  updateDownload();

  show('report');
  $('#step1').focus();
}

async function renderDone(): Promise<void> {
  if (!current) return;
  const keep = current.keep;
  const a = current.analysis;
  $('#done-name').textContent = downloadName();

  // Re-read the exact file that was downloaded and check it.
  const after = await inspect(a.result.output);
  const leaks = verify(after, a.result, keep);
  const verified = leaks.length === 0;
  $('#done-verified').hidden = !verified;
  const unverified = $('#done-unverified');
  unverified.hidden = verified;
  unverified.textContent = verified
    ? ''
    : `Some data could not be removed (${leaks.join(', ')}). Please don’t share this copy, and report the problem on GitHub.`;

  const rows: { label: string; removed: boolean }[] = [
    ...a.before.findings.map((f) => ({ label: f.title, removed: !keep.has(f.id) })),
    ...alwaysRemoved(a).map((i) => ({ label: i.short, removed: true })),
    ...keptItems(a).map((i) => ({ label: i.short, removed: false })),
  ];
  $('#done-list').replaceChildren(
    ...rows.map((r) => {
      const li = el('li');
      const dot = el('span', `done-dot ${r.removed ? 'removed' : 'kept'}`);
      dot.setAttribute('aria-hidden', 'true');
      dot.append(icon(r.removed ? 'check' : 'minus', 16));
      li.append(dot, el('span', 'done-label', r.label), el('span', 'done-status', r.removed ? 'Removed' : 'Kept'));
      return li;
    }),
  );

  show('done');
  $('#done-title').focus();
}

function reset(): void {
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  startError.hidden = true;
  show('start');
  window.scrollTo({ top: 0 });
}

function showError(message: string): void {
  show('start');
  startError.replaceChildren(icon('alert'), el('span', undefined, message));
  startError.hidden = false;
}

async function handleFile(file: File): Promise<void> {
  startError.hidden = true;
  $('#busy-text').textContent = 'Reading your photo…';
  show('busy');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (detectFormat(bytes) === 'heic') $('#busy-text').textContent = 'Converting your iPhone photo… (the first one takes a few seconds)';
    let analysis: Analysis;
    try {
      analysis = await analyze(bytes);
    } catch (err) {
      if (detectFormat(bytes) === 'heic' && !(err instanceof UnsupportedFormatError)) {
        throw new Error('Couldn’t open this HEIC photo. Try exporting it from your Photos app as a JPEG instead.');
      }
      throw err;
    }
    if (current) URL.revokeObjectURL(current.url);
    const blob = new Blob([new Uint8Array(analysis.result.output)], { type: analysis.result.mime });
    current = { file, bytes, analysis, keep: new Set(), url: URL.createObjectURL(blob) };
    renderReport(file, analysis);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Something went wrong reading this file.');
  }
}

// ---- events -------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
  fileInput.value = ''; // allow choosing the same file again
});

// Accept drops anywhere on the page while on the start screen, and stop the
// browser from opening a dropped file itself.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!stages.start.hidden) dropZone.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropZone.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (file && !stages.start.hidden) void handleFile(file);
});

$('#sample-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('./sample.jpg');
    const blob = await res.blob();
    void handleFile(new File([blob], 'IMG_20261114_230100.jpg', { type: 'image/jpeg' }));
  } catch {
    showError('Couldn’t load the sample photo.');
  }
});

rawToggle.addEventListener('click', () => {
  const open = rawToggle.getAttribute('aria-expanded') !== 'true';
  rawToggle.setAttribute('aria-expanded', String(open));
  rawPanel.hidden = !open;
  $('#raw-label').textContent = open
    ? 'Hide the raw tags'
    : `Show all ${current?.analysis.before.raw.length ?? 0} raw tags (for the curious)`;
});

renameBox.addEventListener('change', updateDownload);
downloadLink.addEventListener('click', () => {
  // The browser starts the download from the link; then show the done screen.
  setTimeout(() => void renderDone(), 150);
});
for (const b of document.querySelectorAll('.js-reset')) b.addEventListener('click', reset);
