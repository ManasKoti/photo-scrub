# PhotoScrub

Remove hidden metadata from your photos before you share them online. That includes GPS location, phone model and serial number, the time a photo was taken, your name, embedded thumbnails and motion-photo video.

**Everything runs in your browser. Photos are never uploaded anywhere.**

## Why

Phone cameras save a lot of information inside every photo (EXIF, XMP and more). Post an original photo, and anyone who downloads it can see where you were standing, often down to a few metres. PhotoScrub shows you what's inside a photo and removes it, without touching the image itself.

## Features

- **See what a photo reveals**, in plain language: location (with a map link you choose to open), phone, date and time, your name and camera settings, each labelled by risk. Raw tags are available for the curious.
- **Choose what to keep.** Everything is removed by default; switch a category to *Keep* (for example the date) and only that is written back.
- **Lossless.** JPEG, PNG and WebP are not re-compressed: the metadata is cut out of the file and the picture data is copied byte for byte.
- **iPhone HEIC photos** are converted to a high-quality JPEG, since most websites can't open HEIC.
- **Always removed:** hidden thumbnails (which can show the uncropped original), motion-photo video and other data tacked on after the image, maker notes, comments, editing history and content credentials.
- **Kept automatically:** rotation (so photos stay the right way up) and the colour profile (so colours don't shift).
- **Double-checked:** after cleaning, the clean copy is read again to confirm that nothing you removed is left.
- **No network access.** A strict Content Security Policy stops the page from sending data anywhere. Fonts are bundled, and there are no analytics.

## How it works

The commented code in [`src/core/`](src/core/) does all the work:

| File | Job |
|---|---|
| `jpeg.ts`, `png.ts`, `webp.ts` | Walk each format's blocks and copy everything except metadata |
| `heic.ts` | Find EXIF inside iPhone photos and convert them to JPEG |
| `exif.ts` | Read EXIF and write a smaller copy holding only what you keep |
| `categories.ts` | Which tag belongs to which privacy category |
| `inspect.ts` | Turn tags into plain-language findings |
| `scrub.ts` | The single entry point the page calls |

## Run it locally

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run dev      # open the printed http://localhost:5173 link
```

Run `npm install` again whenever `package.json` changes.

## License

MIT. Third-party parts keep their own licenses:

- [exifr](https://github.com/MikeKovarik/exifr) (MIT): reads metadata
- [heic-to](https://github.com/hoppergee/heic-to) (LGPL-3.0), which bundles [libheif](https://github.com/strukturag/libheif) (LGPL-3.0): decodes HEIC. Loaded as a separate file only when a HEIC photo is opened.
- [Fredoka](https://fonts.google.com/specimen/Fredoka) and [Nunito](https://fonts.google.com/specimen/Nunito) fonts via Fontsource (SIL Open Font License 1.1)
