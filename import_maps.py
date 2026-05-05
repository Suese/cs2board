#!/usr/bin/env python3
"""
import_maps.py — populate ./radar/ with CS2 mini-map (radar) PNGs so the
board runs fully offline after the first run.

CS2 stores radar overlays as Source 2 compiled textures (.vtex_c) inside
pak01_dir.vpk, which can't be decoded with the pure-Python `vpk` library
alone. The simplest reliable path is to download the PNGs from
github.com/MurkyYT/cs2-map-icons, which scrapes the official depot daily.

Run with no args:

    python3 import_maps.py

Override the source if needed:

    python3 import_maps.py --url-template "https://example.com/{map}.png"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

MAPS = [
    "de_ancient", "de_anubis", "de_dust2",  "de_inferno",
    "de_mirage",  "de_nuke",   "de_overpass", "de_train",
]

DEFAULT_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons"
    "/main/images/radars/{map}_radar_psd.png"
)

OUT_DIR = Path(__file__).parent / "radar"


def download(url_template: str) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    count = 0
    for m in MAPS:
        url = url_template.format(map=m)
        dst = OUT_DIR / f"{m}.png"
        try:
            req = Request(url, headers={"User-Agent": "cs2board-import/1.0"})
            with urlopen(req, timeout=15) as resp:
                if resp.status != 200:
                    raise HTTPError(url, resp.status, "non-200", resp.headers, None)
                data = resp.read()
            with open(dst, "wb") as f:
                f.write(data)
            print(f"  ✓ {m:12s} {len(data) // 1024} KB")
            count += 1
        except (URLError, HTTPError, TimeoutError) as e:
            print(f"  ✗ {m:12s} {url}\n      {e}", file=sys.stderr)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(description="Download CS2 radar PNGs into ./radar/")
    ap.add_argument("--url-template", default=DEFAULT_URL_TEMPLATE,
                    help=f"URL pattern with '{{map}}' placeholder.")
    args = ap.parse_args()

    print(f"→ Output directory: {OUT_DIR.resolve()}")
    print(f"→ Source:           {args.url_template}")
    wrote = download(args.url_template)
    print(f"→ Done. {wrote}/{len(MAPS)} maps written.")
    return 0 if wrote == len(MAPS) else 1


if __name__ == "__main__":
    sys.exit(main())
