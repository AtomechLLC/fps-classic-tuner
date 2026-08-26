#!/usr/bin/env python3
"""Render GoldenEye 007 music tracks to WAV from the ROM.

Pipeline: seq table @0x419790 (RareALSeqBankFile, 63 tracks, 1172-compressed
compressed-MIDI) -> cMIDI parser (per libultra cseq.c: 16 track offsets +
division header, varint deltas, running status, note-on carries a duration
varint, FF 2E/2D loop metas, FE byte-level backup blocks) -> sample synth
using the instruments bank (ALBankFile @0x3b4450, VADPCM samples, keymaps,
envelopes, loop points).

Usage: python render_music.py [track_id] [out.wav]   (default: 2 = M_INTRO)
"""
import struct, zlib, sys, os, math

ROM = "GoldenEye 007 (USA)/GoldenEye 007 (USA).z64"
SEQ_TABLE = 0x419790
INST_CTL = 0x3b4450
OUT_RATE = 22050

rom = open(ROM, "rb").read()
u8 = lambda o: rom[o]
u16 = lambda o: struct.unpack(">H", rom[o:o+2])[0]
s16v = lambda o: struct.unpack(">h", rom[o:o+2])[0]
u32 = lambda o: struct.unpack(">I", rom[o:o+4])[0]
s32v = lambda o: struct.unpack(">i", rom[o:o+4])[0]

# ---------------- VADPCM ----------------
def read_book(off):
    order, npred = s32v(off), s32v(off+4)
    coefs = struct.unpack(f">{order*npred*8}h", rom[off+8: off+8+order*npred*8*2])
    table, p = [], 0
    for _ in range(npred):
        t = [[0]*(order+8) for _ in range(8)]
        for j in range(order):
            for k in range(8):
                t[k][j] = coefs[p]; p += 1
        for k in range(1, 8):
            t[k][order] = t[k-1][order-1]
        t[0][order] = 1 << 11
        for k in range(1, 8):
            for j in range(k): t[j][k+order] = 0
            for j in range(k, 8): t[j][k+order] = t[j-k][order]
        table.append(t)
    return order, table

def decode_vadpcm(data, order, table):
    state = [0]*16
    out = []
    for f in range(len(data)//9):
        fr = data[f*9:(f+1)*9]
        scale = 1 << (fr[0] >> 4)
        pred = fr[0] & 0xF
        if pred >= len(table): pred = 0
        ix = []
        for i in range(8):
            c = fr[1+i]; ix += [c >> 4, c & 0xF]
        ix = [(v-16 if v >= 8 else v)*scale for v in ix]
        ct = table[pred]
        for j in range(2):
            iv = [0]*16
            src = state[16-order:16] if j == 0 else state[8-order:8]
            for i in range(order): iv[i] = src[i]
            for i in range(8):
                ind = j*8+i
                iv[order+i] = ix[ind]
                acc = 0
                row = ct[i]
                for k in range(order+i): acc += row[k]*iv[k]
                d = acc >> 11 if acc >= 0 else -((-acc) >> 11)
                if acc - (d << 11) < 0: d -= 1
                state[ind] = d + ix[ind]
        out.extend(max(-32768, min(32767, s)) for s in state)
    return out

# ---------------- instrument bank ----------------
class Bank:
    def __init__(self, ctl):
        self.base = ctl
        ba = ctl + u32(ctl+4)
        icount = s16v(ba)
        self.rate = u32(ba+4)
        ctl_end = ba + 12 + 4*icount
        self.tbl = (ctl_end + 15) & ~15
        self.insts = [ctl + u32(ba+12+4*i) for i in range(icount)]
        self.sample_cache = {}

    def inst_sounds(self, prog):
        """list of dicts for instrument's sounds"""
        if prog >= len(self.insts): prog = 0
        ia = self.insts[prog]
        scount = s16v(ia+14)
        out = []
        for si in range(scount):
            sa = self.base + u32(ia+16+4*si)
            env_o, key_o, wav_o = u32(sa), u32(sa+4), u32(sa+8)
            eo, ko, wa = self.base+env_o, self.base+key_o, self.base+wav_o
            out.append({
                "pan": rom[sa+12], "vol": rom[sa+13],
                "attack_us": s32v(eo), "decay_us": s32v(eo+4), "release_us": s32v(eo+8),
                "attack_vol": rom[eo+12], "decay_vol": rom[eo+13],
                "keymin": rom[ko+2], "keymax": rom[ko+3],
                "keybase": rom[ko+4], "detune": struct.unpack('b', rom[ko+5:ko+6])[0],
                "wav": wa,
            })
        return out

    def sample(self, wa):
        """decoded PCM + loop info for a wavetable"""
        if wa in self.sample_cache: return self.sample_cache[wa]
        wbase, wlen, wtype = u32(wa), u32(wa+4), rom[wa+8]
        loop_o, book_o = u32(wa+12), u32(wa+16)
        data = rom[self.tbl+wbase: self.tbl+wbase+wlen]
        if wtype == 0:
            order, table = read_book(self.base+book_o)
            pcm = decode_vadpcm(data, order, table)
        else:
            pcm = list(struct.unpack(f">{len(data)//2}h", data[:len(data)//2*2]))
        loop = None
        if loop_o:
            lo = self.base + loop_o
            start, end, count = u32(lo), u32(lo+4), s32v(lo+8)
            if count != 0 and 0 <= start < end <= len(pcm):
                loop = (start, end)
        r = (pcm, loop)
        self.sample_cache[wa] = r
        return r

# ---------------- cMIDI parser ----------------
class TrackReader:
    """byte reader with FE backup blocks, mirroring __getTrackByte"""
    def __init__(self, data, pos):
        self.d = data; self.pos = pos
        self.bu_pos = 0; self.bu_len = 0
    def byte(self):
        if self.bu_len:
            b = self.d[self.bu_pos]; self.bu_pos += 1; self.bu_len -= 1
            return b
        b = self.d[self.pos]; self.pos += 1
        if b == 0xFE:
            nxt = self.d[self.pos]; self.pos += 1
            if nxt != 0xFE:
                hi, lo = nxt, self.d[self.pos]; self.pos += 1
                ln = self.d[self.pos]; self.pos += 1
                back = (hi << 8) + lo
                self.bu_pos = self.pos - (back + 4)
                self.bu_len = ln
                b = self.d[self.bu_pos]; self.bu_pos += 1; self.bu_len -= 1
        return b
    def varint(self):
        v = self.byte()
        if v & 0x80:
            v &= 0x7F
            while True:
                c = self.byte()
                v = (v << 7) + (c & 0x7F)
                if not (c & 0x80): break
        return v

def parse_seq(data, max_loop_unroll=2):
    offsets = struct.unpack(">16I", data[:64])
    division = struct.unpack(">I", data[64:68])[0] or 96
    events = []   # (tick, kind, ...)
    for tr, off in enumerate(offsets):
        if off == 0: continue
        r = TrackReader(data, off)
        tick = 0
        last_status = 0
        loop_counts = {}
        guard = 0
        while guard < 200000:
            guard += 1
            tick += r.varint()
            status = r.byte()
            if status == 0xFF:
                t = r.byte()
                if t == 0x51:            # tempo
                    tempo = (r.byte() << 16) | (r.byte() << 8) | r.byte()
                    events.append((tick, "tempo", tempo))
                    last_status = 0
                elif t == 0x2F:          # end of track
                    break
                elif t == 0x2E:          # loop start
                    r.byte(); r.byte()
                    last_status = 0
                elif t == 0x2D:          # loop end
                    # curLoc points at: loopCt, curLpCt, offset u32
                    key = r.pos
                    loop_ct = r.d[r.pos]
                    n = loop_counts.get(key, 0)
                    max_n = max_loop_unroll if loop_ct == 0xFF or loop_ct == 0 else min(loop_ct, max_loop_unroll)
                    if n < max_n:
                        loop_counts[key] = n + 1
                        off_b = struct.unpack(">I", r.d[r.pos+2:r.pos+6])[0]
                        end_of_evt = r.pos + 6
                        r.pos = end_of_evt - off_b
                        r.bu_len = 0
                    else:
                        r.pos += 6
                    last_status = 0
                else:
                    break
                continue
            if status & 0x80:
                b1 = r.byte()
                last_status = status
            else:
                b1 = status
                status = last_status
                if status == 0: break
            hi = status & 0xF0
            ch = status & 0x0F
            if hi in (0xC0, 0xD0):
                if hi == 0xC0: events.append((tick, "prog", ch, b1))
            else:
                b2 = r.byte()
                if hi == 0x90:
                    dur = r.varint()
                    if b1 < 128 and b2 > 0:
                        events.append((tick, "note", ch, b1, b2, dur))
                elif hi == 0xB0:
                    events.append((tick, "cc", ch, b1, b2))
                elif hi == 0xE0:
                    events.append((tick, "bend", ch, ((b2 << 7) | b1) - 8192))
    events.sort(key=lambda e: e[0])
    return division, events

# ---------------- synth ----------------
def render(track_id, out_path):
    n = u16(SEQ_TABLE)
    off, ulen, clen = struct.unpack(">IHH", rom[SEQ_TABLE+4+8*track_id: SEQ_TABLE+12+8*track_id])
    raw = rom[SEQ_TABLE+off:]
    assert raw[:2] == b"\x11\x72"
    data = zlib.decompressobj(wbits=-15).decompress(raw[2:], ulen)
    print(f"track {track_id}: {len(data)} bytes decompressed")
    division, events = parse_seq(data)
    notes = [e for e in events if e[1] == "note"]
    print(f"division {division}, events {len(events)}, notes {len(notes)}")
    if not notes: return False

    bank = Bank(INST_CTL)
    # channel state over time: walk events, keep tempo map + per-channel prog/vol/pan
    tempo = 500000
    # build tick->seconds map incrementally
    sec_at = {}
    cur_t, cur_s = 0, 0.0
    tick_events = sorted(set([e[0] for e in events]))
    tempo_changes = [(e[0], e[2]) for e in events if e[1] == "tempo"]
    def tick_to_sec(t):
        s, lt, tp = 0.0, 0, 500000
        for tt, tv in tempo_changes:
            if tt >= t: break
            s += (tt - lt) * tp / division / 1e6
            lt, tp = tt, tv
        return s + (t - lt) * tp / division / 1e6

    chans = [{"prog": 0, "vol": 1.0, "pan": 0.5} for _ in range(16)]
    voices = []
    for e in events:
        if e[1] == "prog": chans[e[2]]["prog"] = e[3]
        elif e[1] == "cc":
            if e[3] == 7: chans[e[2]]["vol"] = (e[4]/127)**2
            elif e[3] == 10: chans[e[2]]["pan"] = e[4]/127
        elif e[1] == "note":
            t, _, ch, note, vel, dur = e
            c = chans[ch]
            voices.append({
                "start": tick_to_sec(t), "dur": tick_to_sec(t+dur) - tick_to_sec(t),
                "prog": c["prog"], "note": note, "vel": vel/127,
                "cvol": c["vol"], "cpan": c["pan"],
            })
    total = max(v["start"] + v["dur"] for v in voices) + 1.5
    total = min(total, 240.0)
    print(f"length {total:.1f}s, voices {len(voices)}")
    NL = int(total * OUT_RATE) + OUT_RATE
    L = [0.0] * NL
    R = [0.0] * NL

    inst_cache = {}
    for vi, v in enumerate(voices):
        if v["start"] > 238: continue
        prog = v["prog"]
        if prog not in inst_cache: inst_cache[prog] = bank.inst_sounds(prog)
        sounds = inst_cache[prog]
        if not sounds: continue
        snd = next((s for s in sounds if s["keymin"] <= v["note"] <= s["keymax"]), None)
        if snd is None:
            snd = min(sounds, key=lambda s: min(abs(v["note"]-s["keymin"]), abs(v["note"]-s["keymax"])))
        pcm, loop = bank.sample(snd["wav"])
        if not pcm: continue
        rate = 2 ** ((v["note"] - snd["keybase"] + snd["detune"]/100) / 12)
        # envelope times (sec)
        atk = max(snd["attack_us"], 0) / 1e6
        dec = snd["decay_us"] / 1e6 if snd["decay_us"] > 0 else -1
        rel = max(snd["release_us"], 1000) / 1e6
        av, dv = snd["attack_vol"]/127, snd["decay_vol"]/127
        amp = v["vel"] * v["cvol"] * (snd["vol"]/127)
        pan = v["cpan"]
        gl = amp * math.cos(pan * math.pi/2)
        gr = amp * math.sin(pan * math.pi/2)
        dur = v["dur"]
        nsmp = int((dur + rel) * OUT_RATE)
        if nsmp <= 0: continue
        start_i = int(v["start"] * OUT_RATE)
        pos = 0.0
        plen = len(pcm)
        for i in range(nsmp):
            ip = int(pos)
            if loop:
                if ip >= loop[1]:
                    pos -= (loop[1] - loop[0])
                    ip = int(pos)
                    if ip < 0: break
            if ip >= plen - 1:
                break
            frac = pos - ip
            s = pcm[ip] * (1-frac) + pcm[ip+1] * frac
            t = i / OUT_RATE
            if t < atk and atk > 0:
                env = av * t / atk
            elif dec > 0 and t < atk + dec:
                env = av + (dv - av) * (t - atk) / dec
            else:
                env = dv if dec > 0 else av
            if t > dur:
                env *= max(0.0, 1 - (t - dur) / rel)
            o = start_i + i
            if o >= NL: break
            val = s / 32768 * env
            L[o] += val * gl
            R[o] += val * gr
            pos += rate
    # normalize
    peak = max(max(map(abs, L)), max(map(abs, R)), 1e-9)
    g = 0.89 / peak
    out = bytearray()
    for i in range(NL):
        out += struct.pack("<hh", int(max(-1, min(1, L[i]*g)) * 32767),
                                  int(max(-1, min(1, R[i]*g)) * 32767))
    hdr = (b"RIFF" + struct.pack("<I", 36+len(out)) + b"WAVEfmt "
           + struct.pack("<IHHIIHH", 16, 1, 2, OUT_RATE, OUT_RATE*4, 4, 16)
           + b"data" + struct.pack("<I", len(out)))
    open(out_path, "wb").write(hdr + bytes(out))
    print(f"wrote {out_path} ({len(out)/OUT_RATE/4:.1f}s)")
    return True

if __name__ == "__main__":
    tid = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    out = sys.argv[2] if len(sys.argv) > 2 else f"extracted/music/track{tid:02d}.wav"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    render(tid, out)
