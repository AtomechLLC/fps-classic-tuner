#!/usr/bin/env python3
"""Decode GoldenEye's skeletal animations so characters can be posed.

Character bodies have no rest pose: model.c builds every joint matrix as
`parent * translate(Origin) * rotate(anim)` (`modelBuildGroupMatrices` ->
`matrix_4x4_set_rotation_around_xyz`, which is Rz*Ry*Rx), and the rotation only
ever comes from the animation. Without it the limbs stay on their local +x axis
and the figure splays.

Layout, from the decomp:
  - ge007.ld puts `animation_data` immediately after `animation_entries`, so the
    data blob's start is the entries segment's end.
  - The data blob is an array of ModelAnimation headers; assets/animationtable_data.h
    gives each animation's name and its byte offset within the blob.
  - ModelAnimation: address (entries-segment offset of frame 0), unk04 frames,
    unk06 bit width, unk0E bits per frame. `loadAnimationFrame` reads frame N at
    `address + N * (unk0E >> 3)`.
  - A frame is a packed array of `unk06`-bit values. Joint J of a skeleton reads
    three of them (x, y, z) starting at value index `Joints[J].mtxA`
    (`sub_GAME_7F06DEC0`), each scaled to 16 bits and read as a full turn.

Everything above is structure; every byte decoded here comes from the ROM.
"""
import struct, os, re, json, glob, sys

ROM = glob.glob("GoldenEye 007 (USA)/*.z64")
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")
OUT = "extracted/animations"

# What the range needs: a standing guard, a flinch, and a few ways to fall.
WANTED = [
    "idle", "idle_unarmed",
    "fire_standing", "fire_standing_fast", "fire_hip",
    "fire_standing_one_handed_weapon",
    "walking", "walking_unarmed", "walking_female",
    "hit_left_shoulder", "hit_right_shoulder", "hit_left_arm", "hit_right_arm",
    "death_forward_face_down", "death_backward_fall_face_up1",
    "death_backward_spin_face_down_right", "death_fetal_position_left",
    "death_head", "death_neck",
]

def anim_offsets():
    """name -> byte offset into the animation data blob (assets/animationtable_data.h)."""
    path = os.path.join(DECOMP, "assets", "animationtable_data.h")
    out = {}
    for m in re.finditer(r"#define\s+PTR_ANIM_(\w+)\s+(0x[0-9a-fA-F]+)", open(path).read()):
        out[m.group(1)] = int(m.group(2), 16)
    return out

def header(rom, off):
    address, = struct.unpack(">I", rom[off:off+4])
    frames, width, flags = struct.unpack(">HBB", rom[off+4:off+8])
    descoff, = struct.unpack(">I", rom[off+8:off+12])
    rootbits, framebits = struct.unpack(">2H", rom[off+12:off+16])
    streamoff, = struct.unpack(">I", rom[off+16:off+20])
    return {"address": address, "frames": frames, "width": width, "flags": flags,
            "framebits": framebits, "framebytes": framebits >> 3,
            "descoff": descoff, "rootbits": rootbits, "streamoff": streamoff}

def plausible(h):
    if not (0 < h["frames"] < 20000): return False
    if not (4 <= h["width"] <= 16): return False
    if h["framebits"] == 0 or h["framebits"] % 8: return False
    n = h["framebits"] / h["width"]
    return 3 <= n <= 400

def find_blob(rom, offsets):
    """The blob base is wherever every animation's header reads as a valid one."""
    probes = sorted(offsets.values())[:24]
    span = max(probes)
    step = 4
    for base in range(0, len(rom) - span - 32, step):
        h = header(rom, base + probes[1])
        if not plausible(h): continue
        if all(plausible(header(rom, base + p)) for p in probes):
            return base
    return None

def read_bits(buf, width, bitoff):
    """model.c modelAnimReadBitsAsU16Angle: big-endian bit packing, left-justified."""
    value, remaining = 0, width
    p, bitoff = bitoff // 8 + 0, bitoff % 8
    p += 0
    nb = 8 - bitoff
    while remaining >= nb:
        remaining -= nb
        value |= (buf[p] & ((1 << nb) - 1)) << remaining
        value &= 0xFFFF
        p += 1
        nb = 8
    if remaining > 0:
        value |= (buf[p] >> (nb - remaining)) & ((1 << remaining) - 1)
        value &= 0xFFFF
    return (value << (16 - width)) & 0xFFFF

def root_motion(rom, blob, h):
    """Per-frame root position and yaw (sub_GAME_7F06D2E4).

    The header's unk08/unk10 are blob-relative offsets to a table of
    ModelAnimBitField {bitOffset u16, bitCount u8, pad, valueOffset u16} and a
    second bit stream; unk0C is that stream's bits-per-frame. The root joint
    reads four fields -- x, y, z, then a 16th-turn yaw -- each sign-extended
    from bitCount bits and added to valueOffset. Idle-style animations point
    at the shared all-zero descriptor block and so have no root motion.
    """
    descs = []
    for i in range(4):
        o = blob + h["descoff"] + 6 * i
        bo, bc, _, vo = struct.unpack(">HBBH", rom[o:o+6])
        descs.append((bo, bc, vo))
    if not any(d[1] for d in descs):
        return None
    stream = blob + h["streamoff"]
    frames = []
    for f in range(h["frames"]):
        base = h["rootbits"] * f
        vals = []
        for bo, bc, vo in descs:
            if bc == 0:
                vals.append(vo if vo < 0x8000 else vo - 0x10000)
                continue
            raw = 0
            pos = base + bo
            for _ in range(bc):
                raw = (raw << 1) | ((rom[stream + (pos >> 3)] >> (7 - (pos & 7))) & 1)
                pos += 1
            if raw & (1 << (bc - 1)):               # sign-extend
                raw |= ((1 << (16 - bc)) - 1) << bc
            v = (vo + raw) & 0xFFFF
            vals.append(v if v < 0x8000 else v - 0x10000)
        frames.append(vals)
    return frames

def main():
    if not ROM: sys.exit("ROM not found")
    rom = open(ROM[0], "rb").read()
    offsets = anim_offsets()
    blob = find_blob(rom, offsets)
    if blob is None: sys.exit("could not locate the animation data blob")
    heads = {n: header(rom, blob + o) for n, o in offsets.items()}
    # ge007.ld: animation_data starts at _animation_entriesSegmentRomEnd, so the
    # entries segment ends where the blob begins. Its length is the furthest
    # frame any animation reads, which gives the segment's start without needing
    # a symbol table.
    span = max(h["address"] + h["frames"] * h["framebytes"] for h in heads.values())
    entries = blob - ((span + 15) // 16) * 16
    print(f"animation data blob at {blob:#x}; entries segment {entries:#x}..{blob:#x} "
          f"({span} bytes used by {len(heads)} animations)")

    os.makedirs(OUT, exist_ok=True)
    index = {"blob": blob, "entries": entries, "animations": {}}
    for name in WANTED:
        h = heads.get(name)
        if h is None:
            print("  no such animation:", name); continue
        nvals = h["framebits"] // h["width"]
        base = entries + h["address"]
        frames = []
        for f in range(h["frames"]):
            o = base + f * h["framebytes"]
            buf = rom[o:o + h["framebytes"] + 4]
            frames.append([read_bits(buf, h["width"], i * h["width"]) for i in range(nvals)])
        root = root_motion(rom, blob, h)
        json.dump({"name": name, "frames": h["frames"], "width": h["width"],
                   "values": nvals, "loop": bool(h["flags"] & 1), "data": frames,
                   "root": root},
                  open(os.path.join(OUT, name + ".json"), "w"), separators=(",", ":"))
        index["animations"][name] = {"frames": h["frames"], "values": nvals,
                                     "loop": bool(h["flags"] & 1),
                                     "file": name + ".json"}
        rinfo = "no root motion"
        if root:
            import math
            dist = sum(math.dist(root[i][:3:2], root[i+1][:3:2]) for i in range(len(root)-1))
            rinfo = f"root motion {dist:6.0f} units over {h['frames']/60:.2f} s"
        print(f"  {name:38s} {h['frames']:4d} frames x {nvals} values @ {h['width']} bits  {rinfo}")
    json.dump(index, open(os.path.join(OUT, "ANIMATIONS.json"), "w"), indent=1)
    print(f"-> {OUT}/")

if __name__ == "__main__":
    main()
