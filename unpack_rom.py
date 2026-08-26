#!/usr/bin/env python3
"""Unpack GoldenEye 007 (USA) .z64 ROM.

The ROM stores assets as "1172" blocks: a 2-byte magic 0x11 0x72 followed by a
raw DEFLATE stream. This script:
  1. Parses/report the ROM header.
  2. Scans the whole ROM for 1172 blocks and inflates each into extracted/.
  3. Dumps the ROM's embedded filename strings for cross-reference.
"""
import sys
import zlib
from pathlib import Path

ROM = Path("GoldenEye 007 (USA)/GoldenEye 007 (USA).z64")
OUT = Path("extracted")
MIN_DECOMP = 16          # ignore inflate "successes" smaller than this (false positives)

data = ROM.read_bytes()
print(f"ROM: {ROM.name}  ({len(data):#x} / {len(data)//1024//1024} MB)")

# --- header ---
magic = data[:4].hex()
title = data[0x20:0x34].decode("ascii", "replace").strip()
game_id = data[0x3B:0x3F].decode("ascii", "replace")
crc1, crc2 = data[0x10:0x14].hex(), data[0x14:0x18].hex()
print(f"header: magic={magic} title={title!r} id={game_id} crc={crc1}/{crc2}")
assert magic == "80371240", "not a native big-endian .z64"

# --- scan for 1172 blocks ---
OUT.mkdir(exist_ok=True)
blocks = []
pos = 0
while True:
    pos = data.find(b"\x11\x72", pos)
    if pos == -1:
        break
    d = zlib.decompressobj(wbits=-15)
    try:
        out = d.decompress(data[pos + 2 : pos + 2 + 0x200000])
        if d.eof and len(out) >= MIN_DECOMP:
            comp_len = (len(data[pos + 2 : pos + 2 + 0x200000]) - len(d.unused_data)) + 2
            blocks.append((pos, comp_len, out))
            pos += comp_len
            continue
    except zlib.error:
        pass
    pos += 1

print(f"found {len(blocks)} 1172-compressed blocks")
total = 0
index_lines = []
for off, clen, out in blocks:
    name = f"{off:08x}.bin"
    (OUT / name).write_bytes(out)
    total += len(out)
    index_lines.append(f"{off:#010x}  comp={clen:>7}  decomp={len(out):>8}  {name}")
(OUT / "INDEX.txt").write_text("\n".join(index_lines) + "\n")
print(f"wrote {total} bytes decompressed -> {OUT}/  (see INDEX.txt)")

# --- embedded filename strings (Rare's internal asset names) ---
names = []
i = 0
n = len(data)
while i < n:
    if 0x20 < data[i] < 0x7F:
        j = i
        while j < n and 0x20 <= data[j] < 0x7F:
            j += 1
        s = data[i:j]
        if j < n and data[j] == 0 and len(s) >= 4:
            t = s.decode("ascii")
            # Rare's names look like "ob/ob_xxx.seg", "Ttracktop", "ProlSetupZ" etc.
            if ("/" in t and "." in t) or t.endswith(("Z", ".seg", ".bin")):
                names.append((i, t))
        i = j
    i += 1
with (OUT / "FILENAMES.txt").open("w") as f:
    for off, t in names:
        f.write(f"{off:#010x}  {t}\n")
print(f"dumped {len(names)} embedded name strings -> {OUT}/FILENAMES.txt")
