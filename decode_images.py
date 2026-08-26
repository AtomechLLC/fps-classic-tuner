#!/usr/bin/env python3
"""Decode ALL GoldenEye 007 textures (2698 images) to PNG, by image id.

The image segment (base 0x8f7df0) is indexed by g_Textures in the code
segment (2698 entries; 24-bit compressed sizes -> offsets by prefix sum).
Each image: [header byte: bit7=explicitlods, bit6=iszlib, bits0-5=lodcount]
then either:
  zlib:    fmt(8) ncolours-1(8) palette(n*16) then per-LOD [w(8) h(8) 1172-deflate]
  nonzlib: bitstream per-LOD [fmt(4) w(8) h(8) method(4) <compressed channels>]
Ported from n64decomp/007 src/game/image.c (texInflateZlib/NonZlib and helpers).

Outputs extracted/images/<id>_<name>.png (LOD 0) and IMAGES.json with
hit-material metadata (per-surface impact sounds) from g_Textures/images.def.
"""
import struct, zlib, os, re, json, math

ROM = "GoldenEye 007 (USA)/GoldenEye 007 (USA).z64"
OUT = "extracted/images"
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")
SEG_BASE = 0x8f7df0
G_TEXTURES_RAM, CODE_BASE = 0x80049300, 0x80020d90
N_IMAGES = 2698

FMT_RGBA32, FMT_RGBA16, FMT_RGB24, FMT_RGB15 = 0, 1, 2, 3
FMT_IA16, FMT_IA8, FMT_IA4, FMT_I8, FMT_I4 = 4, 5, 6, 7, 8
FMT_RGBA16_CI8, FMT_RGBA16_CI4, FMT_IA16_CI8, FMT_IA16_CI4 = 9, 10, 11, 12
NUM_CHANNELS = [4, 3, 3, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1]
HAS_1BIT_ALPHA = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]
CHANNEL_SIZES = [0x100, 0x20, 0x100, 0x20, 0x100, 0x10, 8, 0x100, 0x10, 0x100, 0x10, 0x100, 0x10]
BITS_PER_PIXEL = [0x20, 0x10, 0x18, 0xF, 0x10, 8, 4, 8, 4, 0x10, 0x10, 0x10, 0x10]

class Bits:
    def __init__(self, data, pos=0):
        self.d = data; self.pos = pos; self.bit = 0
    def read(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.pos] >> (7 - self.bit)) & 1)
            self.bit += 1
            if self.bit == 8: self.bit = 0; self.pos += 1
        return v
    def align_next_image(self):
        # C: if (img_bitcount == 0) img_curpos++; else img_bitcount = 0;
        if self.bit == 0: self.pos += 1
        else: self.bit = 0

def rgba5551(c):
    return ((c >> 11 & 31)*255//31, (c >> 6 & 31)*255//31, (c >> 1 & 31)*255//31, 255 if c & 1 else 0)
def ia88(c):
    i, a = c >> 8, c & 0xFF
    return (i, i, i, a)

def cdiv(a, b): return -(-a // b) if (a < 0) != (b < 0) and a % b else a // b
def cmod(a, b): return a - int(a / b) * b if b else 0

def inflate_huffman(bs, count, chansize):
    freq = [bs.read(8) for _ in range(chansize)] + [0]*(2048-chansize)
    nodes = [[-1, -1] for _ in range(2048)]
    def two_smallest():
        f1 = f2 = 9999; i1 = i2 = 0
        for i in range(chansize):
            if freq[i] < f1:
                if f1 > f2: f1 = freq[i]; i1 = i
                else: f2 = freq[i]; i2 = i
            elif freq[i] < f2: f2 = freq[i]; i2 = i
        return f1, i1, f2, i2
    f1, i1, f2, i2 = two_smallest()
    root = 0
    while True:
        s = freq[i1] + freq[i2] or 1
        freq[i1] = 9999; freq[i2] = 9999
        if nodes[i1][0] < 0 and nodes[i1][1] < 0:
            nodes[i1][0] = i1 + 10000; root = i1; freq[i1] = s
            nodes[i1][1] = i2 + 10000 if (nodes[i2][0] < 0 and nodes[i2][1] < 0) else i2
        elif nodes[i2][0] < 0 and nodes[i2][1] < 0:
            nodes[i2][0] = i2 + 10000; root = i2; freq[i2] = s
            nodes[i2][1] = i1 + 10000 if (nodes[i1][0] < 0 and nodes[i1][1] < 0) else i1
        else:
            r = 0
            while nodes[r][0] >= 0 or nodes[r][1] >= 0 or freq[r] < 9999: r += 1
            root = r; freq[r] = s; nodes[r][0] = i1; nodes[r][1] = i2
        f1, i1, f2, i2 = two_smallest()
        if f1 == 9999 or f2 == 9999: break
    out = []
    for _ in range(count):
        v = root
        while v < 10000:
            v = nodes[v][bs.read(1)]
        out.append(v - 10000)
    return out

def inflate_rle(bs, total):
    bt = bs.read(3); rl = bs.read(3); blocksize = bs.read(4)
    cost = bt + rl + blocksize + 1
    fudge = 0
    while cost > 0:
        cost -= blocksize + 1; fudge += 1
    out = []
    while len(out) < total:
        if bs.read(1) == 0:
            out.append(bs.read(blocksize))
        else:
            start = len(out) - bs.read(bt) - 1
            run = bs.read(rl) + fudge
            for i in range(start, start + run):
                out.append(out[i])
            out.append(bs.read(blocksize))
    return out[:total]

def build_lookup(bs, bpp):
    n = bs.read(11)
    if bpp <= 24:
        return [bs.read(bpp) for _ in range(n)]
    return [(bs.read(24) << 8) | bs.read(bpp - 24) for _ in range(n)]

def bitsize(n):
    n -= 1; c = 0
    while n > 0: n >>= 1; c += 1
    return c

def blur(px, width, height, method, chansize):
    for y in range(height):
        for x in range(width):
            cur = px[y*width+x] + chansize*2
            left = px[y*width+x-1] if x > 0 else 0
            above = px[(y-1)*width+x] if y > 0 else 0
            al = px[(y-1)*width+x-1] if x > 0 and y > 0 else 0
            if   method == 0: v = cur + left
            elif method == 1: v = cur + above
            elif method == 2: v = cur + al
            elif method == 3: v = cur + (left + above - al)
            elif method == 4: v = cur + (int((above - al)/2) + left)
            elif method == 5: v = cur + (int((left - al)/2) + above)
            else:             v = cur + int((left + above)/2)
            px[y*width+x] = cmod(v, chansize)
    return px

def channels_to_rgba(ch, alpha_bits, w, h, fmt):
    """planar channel samples -> flat RGBA tuples"""
    n = w*h
    out = []
    if fmt == FMT_RGBA32:
        for i in range(n): out.append((ch[i], ch[i+n], ch[i+2*n], ch[i+3*n]))
    elif fmt == FMT_RGB24:
        for i in range(n): out.append((ch[i], ch[i+n], ch[i+2*n], 255))
    elif fmt in (FMT_RGBA16, FMT_RGB15):
        for i in range(n):
            a = 255 if (fmt == FMT_RGB15 or (alpha_bits and alpha_bits[i])) else 0
            if fmt == FMT_RGB15: a = 255
            out.append((ch[i]*255//31, ch[i+n]*255//31, ch[i+2*n]*255//31, a))
    elif fmt == FMT_IA16:
        for i in range(n): out.append((ch[i], ch[i], ch[i], ch[i+n]))
    elif fmt == FMT_IA8:
        for i in range(n):
            v = ch[i]*17; out.append((v, v, v, ch[i+n]*17))
    elif fmt == FMT_IA4:
        for i in range(n):
            v = ch[i]*255//7; out.append((v, v, v, 255 if (alpha_bits and alpha_bits[i]) else 0))
    elif fmt == FMT_I8:
        for i in range(n): out.append((ch[i], ch[i], ch[i], 255))
    elif fmt == FMT_I4:
        for i in range(n):
            v = ch[i]*17; out.append((v, v, v, 255))
    else:
        return None
    return out

def colour_to_rgba(c, fmt):
    if fmt == FMT_RGBA32: return (c >> 24 & 255, c >> 16 & 255, c >> 8 & 255, c & 255)
    if fmt == FMT_RGB24:  return (c >> 16 & 255, c >> 8 & 255, c & 255, 255)
    if fmt == FMT_RGBA16: return rgba5551(c)
    if fmt == FMT_RGB15:  return rgba5551(c << 1 | 1)
    if fmt == FMT_IA16:   return ia88(c)
    if fmt in (FMT_IA8, FMT_I8): v = c & 0xFF; return (v, v, v, 255)
    return (c, c, c, 255)

def decode_nonzlib_image(bs):
    fmt = bs.read(4); w = bs.read(8); h = bs.read(8); method = bs.read(4)
    if w == 0 or h == 0 or w*h > 0x2000 or fmt > 12:
        return None
    nch, chsz = NUM_CHANNELS[fmt], CHANNEL_SIZES[fmt]
    has_a = HAS_1BIT_ALPHA[fmt]
    n = w*h
    ch = alpha = None
    if method in (0, 1):     # uncompressed: direct per-pixel bits
        px = []
        bpp = BITS_PER_PIXEL[fmt]
        for i in range(n):
            if fmt == FMT_RGBA32: c = (bs.read(16) << 16) | bs.read(16)
            else: c = bs.read(bpp)
            px.append(colour_to_rgba(c if fmt != FMT_RGB15 else c, fmt))
        return (w, h, px)
    elif method == 2:        # huffman
        ch = inflate_huffman(bs, nch*n, chsz)
        if has_a: alpha = [bs.read(1) for _ in range(n)]
    elif method == 3:        # huffman per channel
        ch = []
        for _ in range(nch): ch += inflate_huffman(bs, n, chsz)
        if has_a: alpha = [bs.read(1) for _ in range(n)]
    elif method == 4:        # rle
        ch = inflate_rle(bs, nch*n)
        if has_a: alpha = [bs.read(1) for _ in range(n)]
    elif method == 5:        # lookup
        lut = build_lookup(bs, BITS_PER_PIXEL[fmt])
        b = bitsize(len(lut))
        px = [colour_to_rgba(lut[bs.read(b)] if lut else 0, fmt) for _ in range(n)]
        return (w, h, px)
    elif method == 6:        # huffman + lookup
        lut = build_lookup(bs, BITS_PER_PIXEL[fmt])
        idx = inflate_huffman(bs, n, len(lut))
        px = [colour_to_rgba(lut[i] if i < len(lut) else 0, fmt) for i in idx]
        return (w, h, px)
    elif method == 7:        # rle + lookup
        lut = build_lookup(bs, BITS_PER_PIXEL[fmt])
        idx = inflate_rle(bs, n)
        px = [colour_to_rgba(lut[i] if i < len(lut) else 0, fmt) for i in idx]
        return (w, h, px)
    elif method == 8:        # huffman + blur
        stack = bs.read(3)
        ch = inflate_huffman(bs, nch*n, chsz)
        ch = blur(ch, w, nch*h, stack, chsz)
        if has_a: alpha = [bs.read(1) for _ in range(n)]
    elif method == 9:        # rle + blur
        stack = bs.read(3)
        ch = inflate_rle(bs, nch*n)
        ch = blur(ch, w, nch*h, stack, chsz)
        if has_a: alpha = [bs.read(1) for _ in range(n)]
    else:
        return None
    px = channels_to_rgba(ch, alpha, w, h, fmt)
    return (w, h, px) if px else None

def decode_zlib_image(rom, pos, numimages):
    fmt = rom[pos]; ncol = rom[pos+1] + 1
    pal = struct.unpack(f">{ncol}H", rom[pos+2:pos+2+ncol*2])
    to_rgba = ia88 if fmt in (FMT_IA16_CI8, FMT_IA16_CI4) else rgba5551
    colours = [to_rgba(c) for c in pal]
    p = pos + 2 + ncol*2
    lods = []
    for _ in range(max(numimages, 1)):
        if p + 4 > len(rom): break
        w, h = rom[p], rom[p+1]
        if rom[p+2:p+4] != b"\x11\x72": break
        d = zlib.decompressobj(wbits=-15)
        try:
            data = d.decompress(rom[p+4:p+4+0x20000])
        except zlib.error:
            break
        consumed = (0x20000 if p+4+0x20000 <= len(rom) else len(rom)-p-4) - len(d.unused_data)
        p += 4 + consumed
        n = w*h
        if fmt in (FMT_RGBA16_CI4, FMT_IA16_CI4):
            idx = []
            for b in data: idx += [b >> 4, b & 0xF]
        else:
            idx = list(data)
        px = [colours[i] if i < len(colours) else (255, 0, 255, 255) for i in idx[:n]]
        if len(px) < n: break
        lods.append((w, h, px))
    return lods

def write_png(path, w, h, px):
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in px[y*w:(y+1)*w]) for y in range(h))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">2I5B", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))

def main():
    rom = open(ROM, "rb").read()
    code = open("extracted/00021990.bin", "rb").read()
    bc = open(os.path.join(DECOMP, "src", "bondconstants.h"), encoding="utf-8", errors="replace").read()
    i = bc.find("typedef enum HIT_TYPE")
    hit_names = {n: m.group(1) for n, m in
                 enumerate(re.finditer(r"^\s*(HIT_\w+)\s*[,=]", bc[i:bc.find('}', i)], re.M))}
    names = [m.group(1) for line in open(os.path.join(DECOMP, "assets", "images.def"))
             if (m := re.match(r"IMAGE\((\w+),", line))]
    entries = []
    off = G_TEXTURES_RAM - CODE_BASE
    for _ in range(N_IMAGES):
        w0, _ = struct.unpack(">2I", code[off:off+8])
        entries.append((w0 >> 28, (w0 >> 24) & 0xF, w0 & 0xFFFFFF))
        off += 8
    os.makedirs(OUT, exist_ok=True)
    table = []
    o = SEG_BASE
    ok = fail = 0
    for idx, (hs, ht, size) in enumerate(entries):
        hdr = rom[o]
        explicit, iszlib, lodcount = hdr >> 7, (hdr >> 6) & 1, hdr & 0x3F
        numimages = lodcount if explicit and lodcount else 1
        name = names[idx] if idx < len(names) else str(idx)
        entry = {"id": idx, "name": name, "rom": f"{o:#x}", "size": size,
                 "hit_sound": hit_names.get(hs, hs), "hit_texture": hit_names.get(ht, ht),
                 "zlib": bool(iszlib), "lods": numimages, "png": None}
        try:
            if iszlib:
                lods = decode_zlib_image(rom, o+1, numimages)
            else:
                bs = Bits(rom, o+1)
                lods = []
                for _ in range(numimages):
                    r = decode_nonzlib_image(bs)
                    if r is None: break
                    lods.append(r)
                    bs.align_next_image()
        except (IndexError, zlib.error):
            lods = []
        if lods:
            w, h, px = lods[0]
            fn = f"{idx:04d}_{name}.png"
            write_png(os.path.join(OUT, fn), w, h, px)
            entry["png"] = fn; entry["w"], entry["h"] = w, h
            ok += 1
        else:
            fail += 1
        table.append(entry)
        o += size
    json.dump(table, open(os.path.join(OUT, "IMAGES.json"), "w"), indent=1)
    print(f"decoded {ok}/{N_IMAGES} images -> {OUT}/ ({fail} failed)")

if __name__ == "__main__":
    main()
