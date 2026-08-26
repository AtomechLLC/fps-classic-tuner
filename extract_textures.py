#!/usr/bin/env python3
"""Extract GoldenEye 007 textures from the ROM's texture segment to PNG.

The texture segment (~0x900000..0xbe6d00) is a byte-packed stream of records:
  image record:   [u8 width][u8 height][1172 block: 0x11 0x72 + raw deflate]
  palette record: [7 raw bytes, ncolors at byte 2][ncolors * 2 bytes RGBA5551]
A palette record follows the CI image(s) it serves.

Pixel format is inferred: bytes-per-pixel = decompressed_size / (w*h):
  2.0 -> RGBA16 (5551); 1.0 -> CI8 (if palette) else I8; 0.5 -> CI4/I4; 4.0 -> RGBA32
"""
import struct, zlib, os, re

ROM = "GoldenEye 007 (USA)/GoldenEye 007 (USA).z64"
OUT = "extracted/textures"
SEG_END = 0xbe6d06   # last record end before 0xFF padding

def write_png(path, w, h, rgba):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = b"".join(b"\x00" + rgba[y*w*4:(y+1)*w*4] for y in range(h))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">2I5B", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 6))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)

def rgba5551(c):
    r = (c >> 11) & 0x1f; g = (c >> 6) & 0x1f; b = (c >> 1) & 0x1f; a = c & 1
    return bytes(((r*255)//31, (g*255)//31, (b*255)//31, 255 if a else 0))

def render(w, h, pix, pal):
    n = w * h
    bpp = len(pix) / n if n else 0
    out = bytearray()
    if bpp == 2:                       # RGBA16
        for i in range(n):
            out += rgba5551(struct.unpack(">H", pix[2*i:2*i+2])[0])
        return bytes(out), "rgba16"
    if bpp == 4:                       # RGBA32
        return bytes(pix[:n*4]), "rgba32"
    if bpp == 1:
        if pal and len(pal) > 32:      # CI8
            for i in range(n):
                c = pix[i]
                out += pal[c] if c < len(pal) else b"\xff\x00\xff\xff"
            return bytes(out), "ci8"
        for i in range(n):             # I8
            v = pix[i]; out += bytes((v, v, v, 255))
        return bytes(out), "i8"
    if bpp == 0.5:
        idxs = []
        for i in range(n // 2):
            b = pix[i]; idxs += [b >> 4, b & 0xf]
        if pal:                        # CI4
            for c in idxs[:n]:
                out += pal[c] if c < len(pal) else b"\xff\x00\xff\xff"
            return bytes(out), "ci4"
        for c in idxs[:n]:             # I4
            v = c * 17; out += bytes((v, v, v, 255))
        return bytes(out), "i4"
    return None, f"bpp{bpp:.2f}"

def main():
    rom = open(ROM, "rb").read()
    os.makedirs(OUT, exist_ok=True)
    # image record starts: 2 bytes before each 1172 block in the segment
    starts = []
    for line in open("extracted/INDEX.txt"):
        m = re.match(r"(0x[0-9a-f]+)\s+comp=\s*(\d+)\s+decomp=\s*(\d+)", line)
        o = int(m.group(1), 16)
        if o >= 0x900000:
            starts.append((o, int(m.group(2)), int(m.group(3))))
    written = skipped = 0
    stats = {}
    index = []
    for i, (o, comp, dc) in enumerate(starts):
        w, h = rom[o-2], rom[o-1]
        if w == 0 or h == 0 or w*h == 0 or dc % (w*h) not in (0,) and (w*h) % dc != 0:
            pass
        d = zlib.decompressobj(wbits=-15)
        try:
            pix = d.decompress(rom[o+2:o+2+0x40000])
        except zlib.error:
            skipped += 1; continue
        # trailing raw bytes between this block and the next record = palette:
        # 5-byte header (ncolors at byte 2) + ncolors * 2 bytes RGBA5551
        def trailing_palette(j):
            end = starts[j][0] + starts[j][1]
            nxt_magic = starts[j+1][0] if j+1 < len(starts) else SEG_END
            gap = nxt_magic - 2 - end        # exclude next record's w,h prefix
            if gap < 7: return None
            nc = rom[end+2]
            if nc == 0 or 5 + nc*2 > gap + 2: return None
            pdata = rom[end+5 : end+5+nc*2]
            return [rgba5551(struct.unpack(">H", pdata[k:k+2])[0]) for k in range(0, len(pdata), 2)]
        # pick the nearest following palette big enough for this image's max index
        n = w * h
        bpp = len(pix) / n if n else 0
        maxidx = 0
        if bpp == 1: maxidx = max(pix) if pix else 0
        elif bpp == 0.5: maxidx = max((max(b >> 4, b & 0xf) for b in pix), default=0)
        pal = None
        if bpp in (1, 0.5):
            for j in range(i, min(i+9, len(starts))):
                p = trailing_palette(j)
                if p is not None and len(p) > maxidx:
                    pal = p; break
        if not (0 < w and 0 < h) or w*h == 0:
            skipped += 1; continue
        rgba, fmt = render(w, h, pix, pal)
        if rgba is None or len(rgba) < w*h*4:
            skipped += 1; stats[fmt] = stats.get(fmt, 0) + 1; continue
        name = f"{o-2:06x}_{w}x{h}_{fmt}.png"
        write_png(os.path.join(OUT, name), w, h, rgba)
        index.append(f"{o-2:#08x} {w:>3}x{h:<3} {fmt:<7} {name}")
        stats[fmt] = stats.get(fmt, 0) + 1
        written += 1
    open(os.path.join(OUT, "TEXTURES.txt"), "w").write("\n".join(index) + "\n")
    print(f"wrote {written} PNGs, skipped {skipped}; formats: {stats}")

if __name__ == "__main__":
    main()
