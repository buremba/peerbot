#!/usr/bin/env python3
"""Append (or replace) a Sparkle appcast item.

Reads an existing appcast.xml, removes any <item> with the same
sparkle:shortVersionString, inserts a fresh one, and writes the file back.
Items stay sorted by pubDate descending so the newest release is first.

Usage:
    update-appcast.py appcast.xml \
        --version 0.2.0 \
        --build 7 \
        --dmg-url https://github.com/lobu-ai/lobu/releases/download/lobu-v0.2.0/Lobu.dmg \
        --signature 'BASE64_FROM_SIGN_UPDATE' \
        --length 12345678 \
        --release-notes https://github.com/lobu-ai/lobu/releases/tag/lobu-v0.2.0 \
        --min-system-version 14.0
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from email.utils import format_datetime
from xml.etree import ElementTree as ET

SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE_NS)
ET.register_namespace("dc", "http://purl.org/dc/elements/1.1/")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--dmg-url", required=True)
    parser.add_argument("--signature", required=True)
    parser.add_argument("--length", required=True)
    parser.add_argument("--release-notes")
    parser.add_argument("--min-system-version", default="14.0")
    args = parser.parse_args()

    tree = ET.parse(args.path)
    channel = tree.find("channel")
    if channel is None:
        print("appcast.xml missing <channel>", file=sys.stderr)
        return 1

    # Remove any pre-existing <item> with the same short version string. Lets
    # re-runs of the same release overwrite cleanly instead of duplicating.
    for item in list(channel.findall("item")):
        existing = item.find(f"{{{SPARKLE_NS}}}shortVersionString")
        if existing is not None and existing.text == args.version:
            channel.remove(item)

    item = ET.SubElement(channel, "item")
    ET.SubElement(item, "title").text = f"Version {args.version}"
    ET.SubElement(item, "pubDate").text = format_datetime(
        datetime.now(timezone.utc), usegmt=True
    )
    ET.SubElement(item, f"{{{SPARKLE_NS}}}version").text = args.build
    ET.SubElement(item, f"{{{SPARKLE_NS}}}shortVersionString").text = args.version
    ET.SubElement(item, f"{{{SPARKLE_NS}}}minimumSystemVersion").text = (
        args.min_system_version
    )
    if args.release_notes:
        ET.SubElement(item, f"{{{SPARKLE_NS}}}releaseNotesLink").text = (
            args.release_notes
        )
    ET.SubElement(
        item,
        "enclosure",
        attrib={
            "url": args.dmg_url,
            f"{{{SPARKLE_NS}}}edSignature": args.signature,
            "length": str(args.length),
            "type": "application/octet-stream",
        },
    )

    # Sort items newest first.
    items = sorted(
        channel.findall("item"),
        key=lambda el: el.findtext("pubDate") or "",
        reverse=True,
    )
    for el in channel.findall("item"):
        channel.remove(el)
    for el in items:
        channel.append(el)

    # Pretty-print with 4-space indentation (Python 3.9+).
    ET.indent(tree, space="    ")
    tree.write(args.path, encoding="utf-8", xml_declaration=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
