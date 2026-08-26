#!/usr/bin/env python3
"""Extract GoldenEye 007 sound effects to WAV.

Parses the sfx bank (ALBankFile, uncompressed in ROM at 0x2ebde0; sample data
in sfx.tbl immediately after the ctl) and VADPCM-decodes every sound to
16-bit mono WAV at the bank sample rate (22050 Hz).

Sound indices equal the game's SFX_ID enum (weapon stats' sound_id indexes
this bank directly via sndPlaySfx). Names come from the n64decomp/007
SFX_ID enum. VADPCM decode ported from n64decomp/sm64 tools/aifc_decode.c.
"""
import struct, os, re, json

ROM = "GoldenEye 007 (USA)/GoldenEye 007 (USA).z64"
OUT = "extracted/sounds"
SFX_CTL = 0x2ebde0
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")

rom = open(ROM, "rb").read()
u16 = lambda o: struct.unpack(">H", rom[o:o+2])[0]
s16v = lambda o: struct.unpack(">h", rom[o:o+2])[0]
u32 = lambda o: struct.unpack(">I", rom[o:o+4])[0]
s32v = lambda o: struct.unpack(">i", rom[o:o+4])[0]

def sfx_names():
    bc = open(os.path.join(DECOMP, "src", "bondconstants.h"), encoding="utf-8", errors="replace").read()
    i = bc.find("typedef enum SFX_ID")
    end = bc.find("}", i)
    return [m.group(1) for m in re.finditer(r"^\s*(\w+)\s*,", bc[i:end], re.M)]

def read_book(off):
    """ALADPCMBook at ctl offset: order, npredictors, s16 coefs."""
    order, npred = s32v(off), s32v(off+4)
    coefs = struct.unpack(f">{order*npred*8}h", rom[off+8 : off+8+order*npred*8*2])
    # build coefTable exactly as aifc_decode.c readaifccodebook
    table = []
    p = 0
    for _ in range(npred):
        t = [[0]*(order+8) for _ in range(8)]
        for j in range(order):
            for k in range(8):
                t[k][j] = coefs[p]; p += 1
        for k in range(1, 8):
            t[k][order] = t[k-1][order-1]
        t[0][order] = 1 << 11
        for k in range(1, 8):
            for j in range(k):
                t[j][k+order] = 0
            for j in range(k, 8):
                t[j][k+order] = t[j-k][order]
        table.append(t)
    return order, npred, table

def inner_product(length, v1, v2):
    out = 0
    for i in range(length):
        out += v1[i]*v2[i]
    dout = out >> 11 if out >= 0 else -((-out) >> 11)  # trunc toward 0 = C division
    fiout = dout << 11
    return dout - (1 if out - fiout < 0 else 0)

def decode_vadpcm(data, order, coef_table):
    state = [0]*16
    out = []
    nframes = len(data) // 9
    for f in range(nframes):
        frame = data[f*9:(f+1)*9]
        header = frame[0]
        scale = 1 << (header >> 4)
        optimalp = header & 0xF
        if optimalp >= len(coef_table): optimalp = 0
        ix = []
        for i in range(8):
            c = frame[1+i]
            ix += [c >> 4, c & 0xF]
        ix = [(v-16 if v >= 8 else v)*scale for v in ix]
        ct = coef_table[optimalp]
        for j in range(2):
            in_vec = [0]*16
            src = state[16-order:16] if j == 0 else state[8-order:8]
            for i in range(order):
                in_vec[i] = src[i]
            for i in range(8):
                ind = j*8+i
                in_vec[order+i] = ix[ind]
                state[ind] = inner_product(order+i, ct[i], in_vec) + ix[ind]
        out.extend(max(-32768, min(32767, s)) for s in state)
    return out

def write_wav(path, samples, rate):
    data = struct.pack(f"<{len(samples)}h", *samples)
    hdr = (b"RIFF" + struct.pack("<I", 36+len(data)) + b"WAVEfmt "
           + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate*2, 2, 16)
           + b"data" + struct.pack("<I", len(data)))
    open(path, "wb").write(hdr + data)

def main():
    base = SFX_CTL
    nbank = u16(base+2)
    ba = base + u32(base+4)
    icount, srate = s16v(ba), u32(ba+4)
    ia = base + u32(ba+12)
    scount = s16v(ia+14)
    ctl_end = ba + 12 + 4*icount            # bank struct end == ctl file end
    tbl = (ctl_end + 15) & ~15
    print(f"sfx bank: {scount} sounds @ {srate} Hz; ctl {base:#x}, tbl {tbl:#x}")
    names = sfx_names()
    print(f"SFX_ID names: {len(names)}")
    os.makedirs(OUT, exist_ok=True)
    index = []
    books = {}
    for si in range(scount):
        sa = base + u32(ia+16+4*si)
        env_o, keym_o, wav_o = u32(sa), u32(sa+4), u32(sa+8)
        span, svol = rom[sa+12], rom[sa+13]
        wa = base + wav_o
        wbase, wlen, wtype = u32(wa), u32(wa+4), rom[wa+8]
        loop_o, book_o = u32(wa+12), u32(wa+16)
        name = names[si] if si < len(names) else f"SFX_{si}"
        entry = {"id": si, "name": name, "pan": span, "volume": svol,
                 "type": "adpcm" if wtype == 0 else "raw16", "bytes": wlen}
        eo = base + env_o
        entry["envelope"] = {"attack_us": s32v(eo), "decay_us": s32v(eo+4),
                             "release_us": s32v(eo+8), "attack_vol": rom[eo+12],
                             "decay_vol": rom[eo+13]}
        ko = base + keym_o
        entry["keybase"] = rom[ko+4]
        if loop_o:
            lo = base + loop_o
            entry["loop"] = {"start": u32(lo), "end": u32(lo+4), "count": s32v(lo+8)}
        data = rom[tbl+wbase : tbl+wbase+wlen]
        if wtype == 0:
            if book_o not in books:
                books[book_o] = read_book(base+book_o)
            order, npred, table = books[book_o]
            samples = decode_vadpcm(data, order, table)
        else:
            samples = list(struct.unpack(f">{len(data)//2}h", data[:len(data)//2*2]))
        fn = f"{si:03d}_{name}.wav"
        write_wav(os.path.join(OUT, fn), samples, srate)
        entry["file"] = fn
        entry["seconds"] = round(len(samples)/srate, 3)
        index.append(entry)
    json.dump(index, open(os.path.join(OUT, "SOUNDS.json"), "w"), indent=1)
    print(f"wrote {len(index)} WAVs -> {OUT}/")

if __name__ == "__main__":
    main()
