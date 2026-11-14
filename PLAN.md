# PhotoScrub: plan and roadmap

## Goal
A web tool that removes privacy-revealing metadata from phone photos. All processing happens in the browser, with no uploads and no backend.

## Decisions
- **In-browser only.** Static site, free hosting, works without a server.
- **Lossless.** Edit the file structure instead of re-encoding through a canvas.
- **Formats:** JPEG, PNG, WebP, HEIC. HEIC is converted to JPEG, because most browsers can't display HEIC and many websites reject it.
- **Always removed:** EXIF thumbnail (can show the uncropped original), maker notes, motion-photo or extra-image data appended after the image, C2PA/JUMBF blocks.
- **Kept by default:** Orientation (otherwise photos show up sideways) and the ICC colour profile (otherwise colours shift).
- **No embedded map.** A map widget would send the GPS coordinates to a tile server. We show coordinates plus an "open in maps" link instead.
- **Self-check.** Every clean file is re-read to confirm nothing sensitive is left.
- **Stack:** Vite + TypeScript (no framework), exifr for reading metadata, our own EXIF rewriter for selective removal, libheif WASM for HEIC (lazy-loaded), Vitest.

## Selective-removal categories

| Category | Examples | Default |
|---|---|---|
| Location | GPS coordinates, altitude, direction | remove |
| Device | make, model, serial number, software | remove |
| Author | owner name, copyright, artist | remove |
| Date & time | when taken or edited | remove (can keep) |
| Camera settings | ISO, shutter, aperture, lens | remove (can keep) |
| Thumbnail, maker notes, hidden trailer | n/a | always remove |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0. Setup | Vite + TS, tests, git, docs | ✅ done |
| 1. JPEG MVP | Lossless JPEG strip, pick or drop, download, self-check | ✅ done |
| 2. What's exposed | Metadata inspector grouped by risk, GPS coordinates. **Design review with Manas first.** | next |
| 3. PNG + WebP | Chunk-level stripping | |
| 4. Selective removal | Category toggles, EXIF rewrite with kept fields | |
| 5. HEIC | Decoder loaded on demand, HEIC → clean JPEG | |
| 6. Polish & ship | Filename anonymising, accessibility, CSP (no network), deploy to GitHub Pages | |

Check-ins after Phases 1, 3 and 6.

## Out of scope for v1
Batch/ZIP, offline install (PWA), video files, RAW formats.
