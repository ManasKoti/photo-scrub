"""
Generate test photos with fake but realistic metadata.

Run:  python scripts/make-fixtures.py   (needs: pip install pillow)

No real personal data is used: the GPS point is the Eiffel Tower and the
"phone" is made up. Real photos from your own phone go in test-photos/,
which git ignores.
"""
from pathlib import Path

from PIL import Image, ImageDraw
from PIL.ExifTags import Base, GPS, IFD

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def picture(w=320, h=240):
    img = Image.new("RGB", (w, h), (30, 90, 160))
    d = ImageDraw.Draw(img)
    for i in range(0, w, 20):
        d.line([(i, 0), (w - i, h)], fill=(240, 200, 40), width=3)
    d.ellipse([w // 3, h // 3, 2 * w // 3, 2 * h // 3], fill=(200, 40, 60))
    return img


def exif_block(orientation=6):
    exif = Image.Exif()
    exif[Base.Make] = "FakePhone"
    exif[Base.Model] = "FakePhone 15 Pro"
    exif[Base.Software] = "FakeOS 18.1"
    exif[Base.DateTime] = "2026:11:14 23:01:00"
    exif[Base.Orientation] = orientation
    exif[Base.Artist] = "Jane Doe"
    sub = exif.get_ifd(IFD.Exif)
    sub[Base.DateTimeOriginal] = "2026:11:14 23:01:00"
    sub[Base.BodySerialNumber] = "SN-0123456789"
    sub[Base.ISOSpeedRatings] = 100
    gps = exif.get_ifd(IFD.GPSInfo)
    gps[GPS.GPSLatitudeRef] = "N"
    gps[GPS.GPSLatitude] = (48.0, 51.0, 29.6)
    gps[GPS.GPSLongitudeRef] = "E"
    gps[GPS.GPSLongitude] = (2.0, 17.0, 40.2)
    return exif


XMP = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.493N" exif:GPSLongitude="2,17.67E"/>
</rdf:RDF></x:xmpmeta>"""

# 1. Typical phone photo: EXIF with GPS, rotated (orientation 6), XMP, comment.
picture().save(OUT / "phone-gps.jpg", quality=90, exif=exif_block(6), xmp=XMP, comment=b"shot at home")

# 2. Same, progressive JPEG, plus fake "motion photo" video appended after the image.
p = OUT / "progressive-motion.jpg"
picture().save(p, quality=85, progressive=True, exif=exif_block(1))
with open(p, "ab") as f:
    f.write(b"\x00\x00\x00\x18ftypmp42" + b"FAKE-MOTION-VIDEO" * 200)

# 3. Already clean photo (no metadata at all).
picture().save(OUT / "clean.jpg", quality=90)

# 4. Restart markers (exercise the scan parser).
picture().save(OUT / "restart-markers.jpg", quality=90, exif=exif_block(3), restart_marker_blocks=1)

print("wrote fixtures to", OUT)

# ---- PNG and WebP (Phase 3) -------------------------------------------------
from PIL.PngImagePlugin import PngInfo
import struct
import datetime

# 5. Screenshot-style PNG with EXIF (eXIf), text chunks, XMP (iTXt) and a timestamp (tIME).
info = PngInfo()
info.add_text("Software", "FakeOS Screenshot 18.1")
info.add_text("Author", "Jane Doe")
info.add_text("Creation Time", "2026-11-14 23:01:00")
info.add_itxt("XML:com.adobe.xmp", XMP.decode())
info.add_text("Comment", "a compressed secret comment " * 4, zip=True)
info.add(b"tIME", struct.pack(">HBBBBB", 2026, 11, 14, 17, 31, 0))
p = OUT / "screenshot.png"
picture().save(p, pnginfo=info, exif=exif_block(6))
with open(p, "ab") as f:
    f.write(b"TRAILING-SECRET" * 20)

# 6. Transparent PNG with no metadata (must come out unchanged).
Image.new("RGBA", (64, 64), (255, 0, 0, 128)).save(OUT / "clean.png")

# 7. WebP with EXIF, XMP and an ICC profile.
from PIL import ImageCms
srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
picture().save(OUT / "phone.webp", quality=85, exif=exif_block(6), xmp=XMP, icc_profile=srgb)

# 8. Lossless WebP with alpha and only XMP.
Image.new("RGBA", (64, 64), (0, 128, 255, 200)).save(OUT / "alpha-xmp.webp", lossless=True, xmp=XMP)

# 9. Simple (VP8 only) WebP, no metadata.
picture().save(OUT / "clean.webp", quality=80)

print("wrote PNG/WebP fixtures")

# ---- HEIC (Phase 5) -----------------------------------------------------------
# Needs: pip install pillow-heif
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    picture().save(OUT / "iphone.heic", quality=80, exif=exif_block(1).tobytes())
    print("wrote HEIC fixture")
except ImportError:
    print("skipped HEIC fixture (pip install pillow-heif)")
