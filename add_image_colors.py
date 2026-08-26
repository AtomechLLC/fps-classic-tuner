#!/usr/bin/env python3
"""Augment extracted/images/IMAGES.json with each texture's average RGBA.

Guns use 1x1 textures as flat colours for texture-gen (env-mapped) metal, so
the renderer needs the actual colour rather than a guessed tint. Averages are
also handy for picking materials and for sanity-checking decodes.
"""
import struct, zlib, json, os

IMG_DIR = "extracted/images"
INDEX = os.path.join(IMG_DIR, "IMAGES.json")

def png_avg(path):
    d = open(path, "rb").read()
    pos, w, h, idat = 8, None, None, b""
    while pos < len(d):
        ln, tag = struct.unpack(">I4s", d[pos:pos+8])
        data = d[pos+8:pos+8+ln]
        if tag == b"IHDR": w, h = struct.unpack(">2I", data[:8])
        elif tag == b"IDAT": idat += data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w*4 + 1
    r = g = b = a = n = 0
    ra = rw = rg = rb = 0          # alpha-weighted (ignores transparent padding)
    for y in range(h):
        row = raw[y*stride+1:(y+1)*stride]
        for x in range(w):
            p = row[x*4:x*4+4]
            r += p[0]; g += p[1]; b += p[2]; a += p[3]; n += 1
            if p[3] > 8:
                rw += p[0]; rg += p[1]; rb += p[2]; ra += 1
    avg = [r//n, g//n, b//n, a//n]
    opaque = [rw//ra, rg//ra, rb//ra] if ra else avg[:3]
    return avg, opaque

def main():
    table = json.load(open(INDEX))
    done = 0
    for e in table:
        if not e.get("png"): continue
        path = os.path.join(IMG_DIR, e["png"])
        if not os.path.exists(path): continue
        try:
            avg, opaque = png_avg(path)
        except Exception:
            continue
        e["avg"] = avg
        e["opaque"] = opaque
        done += 1
    json.dump(table, open(INDEX, "w"), indent=1)
    print(f"annotated {done} images with average colours -> {INDEX}")

if __name__ == "__main__":
    main()
