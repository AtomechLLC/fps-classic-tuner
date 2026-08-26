#!/usr/bin/env python3
"""Decode GoldenEye 007 stage setup files (Usetup*Z) into JSON + summary.

Formats are taken from the n64decomp/007 decompilation:
  - stagesetup header: 10 file-offset words
    [pathtbl, pathlink, intro, props, paths, ailists, pads, pad3ds, padnames, pad3dnames]
  - pad: 44 bytes {pos f3, up f3, look f3, name_off u32, unk u32}
  - pad3d: 64 bytes {pos f3, up f3, look f3, bbox f6, name_off u32}
  - prop records: common 4-byte header {u16 extrascale, u8 state, u8 type},
    sizes per sizepropdef() in src/game/loadobjectmodel.c (words)
  - intro records: sizes per bondview2.c walker
  - text ids: bank = id >> 10 (language bank enum), index = id & 0x3ff;
    L bank file starts with a u32 offset table (offsets from file base)
"""
import struct, glob, json, os, re, sys

FILES = "extracted/files"
OUT = "extracted/setups"
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")

# ---- record sizes in words, from sizepropdef() ----
PROP_SIZES = {1:64, 2:2, 3:32, 4:33, 5:32, 6:59, 7:33, 8:34, 9:7, 10:64, 11:149,
              12:32, 13:54, 14:3, 15:1, 16:1, 17:32, 18:3, 19:4, 20:45, 21:34,
              22:4, 23:4, 24:1, 25:2, 26:2, 27:2, 28:2, 29:2, 30:4, 31:1, 32:4,
              33:5, 34:1, 35:4, 36:32, 37:10, 38:4, 39:44, 40:45, 41:1, 42:32,
              43:32, 44:5, 45:56, 46:7, 47:37}
PROPDEF_END = 48
TYPE_NAMES = {1:"door",2:"door_scale",3:"prop",4:"key",5:"alarm",6:"cctv",
    7:"magazine",8:"collectable",9:"guard",10:"monitor",11:"multi_monitor",
    12:"rack",13:"autogun",14:"link",15:"debris",16:"unk16",17:"hat",
    18:"guard_attribute",19:"switch",20:"ammo",21:"armour",22:"tag",
    23:"objective_start",24:"objective_end",25:"obj_destroy_object",
    26:"obj_complete_condition",27:"obj_fail_condition",28:"obj_collect_object",
    29:"obj_deposit_object",30:"obj_photograph",31:"obj_null",
    32:"obj_enter_room",33:"obj_deposit_in_room",34:"obj_copy_item",
    35:"watch_objective_text",36:"gas_releasing",37:"rename",38:"lock_door",
    39:"vehicle",40:"aircraft",41:"unk41",42:"glass",43:"safe",44:"safe_item",
    45:"tank",46:"camera_pos",47:"tinted_glass"}
# ObjectRecord-based types: word1 = {s16 model(PROP enum), s16 pad}, word2 = flags
OBJRECORD_TYPES = {1,3,4,5,6,7,8,10,11,12,13,17,20,21,36,39,40,42,43,45,47}

INTRO_SIZES = {0:3, 1:4, 2:4, 3:8, 4:2, 5:2, 6:10, 7:1, 8:1}
INTRO_END = 9
INTRO_NAMES = {0:"spawn",1:"item",2:"ammo",3:"swirl",4:"anim",5:"cuff",
               6:"camera",7:"watch",8:"credits"}

LANG_BANKS = [None,"ame","arch","ark","ash","azt","cat","cave","arec","crad",
    "cryp","dam","depo","dest","dish","ear","eld","imp","jun","lee","len","lip",
    "lue","oat","pam","pete","ref","rit","run","sevb","sev","sevx","sevxb",
    "sho","silo","stat","tra","wax","gun","title","mpmenu","propobj",
    "mpweapons","options","misc"]

def parse_enum(header_text, member_prefix, anchor):
    """Extract an enum's members in order from C source, located by an anchor member."""
    i = header_text.find(anchor)
    if i == -1: return []
    start = header_text.rfind("{", 0, i)
    end = header_text.find("}", i)
    names = []
    for m in re.finditer(r"^\s*(" + member_prefix + r"\w+)\s*[,=]", header_text[start:end], re.M):
        names.append(m.group(1))
    return names

# PROP model enum (obj field of ObjectRecord indexes this)
try:
    bc = open(os.path.join(DECOMP, "src", "bondconstants.h"), encoding="utf-8", errors="replace").read()
    PROP_ENUM = parse_enum(bc, "PROP_", "PROP_ALARM1")
    BODY_ENUM = parse_enum(bc, "BODY_", "BODY_Jaws")
except OSError:
    PROP_ENUM, BODY_ENUM = [], []

def prop_name(n):
    return PROP_ENUM[n] if 0 <= n < len(PROP_ENUM) else f"model_{n}"
def body_name(n):
    return BODY_ENUM[n] if 0 <= n < len(BODY_ENUM) else f"body_{n}"

# ---- text banks ----
_bank_cache = {}
def get_text(textid):
    bank, index = textid >> 10, textid & 0x3FF
    if not (0 < bank < len(LANG_BANKS)) or LANG_BANKS[bank] is None:
        return None
    if bank not in _bank_cache:
        path = os.path.join(FILES, f"L{LANG_BANKS[bank]}E.bin")
        _bank_cache[bank] = open(path, "rb").read() if os.path.exists(path) else None
    d = _bank_cache[bank]
    if d is None: return None
    off = struct.unpack(">I", d[index*4:index*4+4])[0] if index*4+4 <= len(d) else 0
    if not (0 < off < len(d)): return None
    end = d.find(b"\x00", off)
    return d[off:end].decode("ascii", "replace").replace("\n", " ")

def s16(v): return v - 0x10000 if v >= 0x8000 else v

def decode_setup(path):
    d = open(path, "rb").read()
    hdr = struct.unpack(">10I", d[:0x28])
    pathtbl, pathlink, intro, props, paths, ailists, pads, pad3ds = hdr[:8]
    out = {"file": os.path.basename(path), "size": len(d)}

    # pads
    plist = []
    for off in range(pads, pad3ds, 44):
        v = struct.unpack(">9f2I", d[off:off+44])
        name_off = v[9]
        name = None
        if 0 < name_off < len(d):
            e = d.find(b"\x00", name_off)
            name = d[name_off:e].decode("ascii", "replace")
        plist.append({"pos": [round(x,1) for x in v[0:3]], "name": name})
    out["pads"] = plist

    # pad3ds (64 bytes: pos3 up3 look3 bbox6 name)
    p3list = []
    for off in range(pad3ds, props, 64):
        v = struct.unpack(">15fI", d[off:off+64])
        name_off = v[15]
        name = None
        if 0 < name_off < len(d):
            e = d.find(b"\x00", name_off)
            name = d[name_off:e].decode("ascii", "replace")
        p3list.append({"pos": [round(x,1) for x in v[0:3]],
                       "bbox": [round(x,1) for x in v[9:15]], "name": name})
    out["pad3ds"] = p3list

    # prop records
    objs = []
    pos, end = props, intro
    while pos < end:
        w0 = struct.unpack(">I", d[pos:pos+4])[0]
        t = w0 & 0xFF
        if t == PROPDEF_END: break
        nw = PROP_SIZES.get(t)
        if nw is None:
            objs.append({"type": f"UNKNOWN_{t:#x}", "offset": pos}); break
        words = struct.unpack(f">{nw}I", d[pos:pos+4*nw])
        rec = {"type": TYPE_NAMES.get(t, str(t))}
        if t == 9:  # guard
            h = struct.unpack(">HHHHHHHHHh", d[pos+4:pos+0x18])
            rec.update(chrnum=h[0], pad=s16(h[1]), body_id=h[2], body=body_name(h[2]),
                       ailist=h[3], preset=h[4], chrpreset=h[5],
                       health=h[6], reaction=h[7], flags=f"{h[8]:#06x}", head=h[9])
        elif t in OBJRECORD_TYPES:
            model, pad = struct.unpack(">hh", d[pos+4:pos+8])
            flags = struct.unpack(">I", d[pos+8:pos+12])[0]
            rec.update(model=prop_name(model), pad=pad, flags=f"{flags:#010x}")
        elif t == 35:  # watch menu objective text
            rec.update(objective=words[1], textid=f"{words[2]:#x}", text=get_text(words[2]))
        elif t == 23:  # objective start
            rec.update(objective=words[1], textid=f"{words[2]:#x}",
                       text=get_text(words[2]), difficulty=words[3])
        elif nw > 1:
            rec["params"] = [f"{w:#x}" for w in words[1:min(nw, 8)]]
        objs.append(rec)
        pos += 4*nw
    out["objects"] = objs

    # intro records
    intros = []
    pos, end = intro, pathlink
    while pos < end:
        t = struct.unpack(">I", d[pos:pos+4])[0]
        if t == INTRO_END: break
        nw = INTRO_SIZES.get(t)
        if nw is None: break
        words = struct.unpack(f">{nw}I", d[pos:pos+4*nw])
        rec = {"type": INTRO_NAMES.get(t, str(t))}
        if t == 0: rec["pad"] = words[1]
        elif t == 1: rec.update(item_right=prop_name(words[1]), item_left=s16(words[2] & 0xffff) if words[2] != 0xffffffff else -1)
        elif t == 2: rec.update(ammo_type=words[1], amount=words[2])
        elif t == 5: rec["bond_cuffs"] = words[1]
        intros.append(rec)
        pos += 4*nw
    out["intro"] = intros

    # ai lists
    ails = []
    pos = ailists
    while pos + 8 <= len(d):
        off, aid = struct.unpack(">2I", d[pos:pos+8])
        if off == 0: break
        ails.append({"id": f"{aid:#x}", "offset": off})
        pos += 8
    for i, a in enumerate(ails):  # sizes from gaps
        nxt = ails[i+1]["offset"] if i+1 < len(ails) else ailists
        a["bytes"] = max(0, nxt - a["offset"])
    out["ailists"] = ails
    return out

def main():
    os.makedirs(OUT, exist_ok=True)
    summary = ["# GoldenEye setup decode summary", ""]
    for path in sorted(glob.glob(os.path.join(FILES, "Usetup*.bin"))):
        s = decode_setup(path)
        name = s["file"].replace("Usetup", "").replace("Z.bin", "")
        with open(os.path.join(OUT, f"{name}.json"), "w") as f:
            json.dump(s, f, indent=1)
        from collections import Counter
        tc = Counter(o["type"] for o in s["objects"])
        guards = [o for o in s["objects"] if o["type"] == "guard"]
        objectives = [o for o in s["objects"] if o["type"] == "objective_start"]
        summary.append(f"## {name}")
        summary.append(f"- pads: {len(s['pads'])}, pad3ds: {len(s['pad3ds'])}, "
                       f"objects: {len(s['objects'])}, ai lists: {len(s['ailists'])}")
        top = ", ".join(f"{k}×{v}" for k,v in tc.most_common(8))
        summary.append(f"- object mix: {top}")
        if guards:
            hs = [g["health"] for g in guards]
            summary.append(f"- guards: {len(guards)} (health {min(hs)}–{max(hs)})")
        for o in objectives:
            summary.append(f"- objective {o.get('objective')}: {o.get('text') or o.get('textid')}")
        summary.append("")
    open(os.path.join(OUT, "SETUPS.md"), "w", encoding="utf-8").write("\n".join(summary))
    print(f"decoded {len(glob.glob(os.path.join(FILES,'Usetup*.bin')))} setups -> {OUT}/")

if __name__ == "__main__":
    main()
