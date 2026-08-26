#!/usr/bin/env python3
"""Extract GoldenEye 007 weapon stats from the ROM's code segment.

The WeaponStats table (112 bytes per weapon) is located in the decompressed
code block (extracted/00021990.bin). Symbol names and RAM addresses come from
the n64decomp/007 asset source (gunWeaponStats.inc.c, //D:8003xxxx comments);
values are read from the ROM itself. Struct layout: src/game/gun.h.

Fields include on-screen VFX placement (muzzle flash extension, gun position,
recoil animation), ballistics (damage, inaccuracy/spread, penetration),
timing (auto/single firing rates in ticks), audio (sound id, trigger rate),
and AI-audibility (loudness/noise model).
"""
import struct, os, re, json

CODE = "extracted/00021990.bin"
OUT = "extracted/weapons"
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")
INC = os.path.join(DECOMP, "assets", "obseg", "gun", "gunWeaponStats.inc.c")

AMMO = ["NONE","9MM","9MM_2","RIFLE","SHOTGUN","GRENADE","ROCKETS","REMOTEMINE",
        "PROXMINE","TIMEDMINE","KNIFE","GRENADEROUND","MAGNUM","GGUN","DARTS",
        "EXPLOSIVEPEN","BOMBCASE","FLARE","PITON","DYNAMITE","BUG","MICRO_CAMERA",
        "GEKEY","PLASTIQUE","WATCH_LASER","WATCH_MAGNET","UNK","CAMERA","TANK","TOKEN"]
FLAGS = {0x1:"UNK_0001", 0x2:"SINGLE_USE_RELOAD", 0x4:"BURST_FIRE", 0x8:"HAS_AUTO_AIM",
         0x10:"CLICKY", 0x20:"UNK_0020", 0x40:"UNK_0040", 0x80:"DUAL_WIELD_ALTERNATING_FIRE",
         0x100:"ONLY_1_HANDED", 0x200:"HOLD_AS_GUN", 0x400:"MIRROR_DUAL",
         0x800:"SHOW_FIRST_PERSON", 0x1000:"FIRST_SHOT_ACCURACY",
         0x2000:"HIDE_FIRST_PERSON_HAND", 0x4000:"HIDE_FIRST_PERSON_MENU",
         0x8000:"DISABLE_CROUCH", 0x10000:"PLAYER_STAT_HIT", 0x20000:"USE_HOLD_TIME",
         0x40000:"HAS_AMMO", 0x80000:"HIDE_AMMO_DISPLAY", 0x100000:"CAN_DUAL_WIELD",
         0x200000:"AMMO_CLIP_LIMIT", 0x400000:"NO_CLIP_RELOADS"}

def parse_symbols():
    """(ram_addr, name) pairs from the decomp asset file."""
    src = open(INC, encoding="utf-8", errors="replace").read()
    syms = []
    pend = None
    for line in src.splitlines():
        m = re.match(r"\s*//D:(80[0-9A-Fa-f]+)", line)
        if m:
            pend = int(m.group(1), 16); continue
        if pend is None:
            continue
        m = re.match(r"\s*WeaponStats\s+(\w+)\s*=", line)
        if m:
            syms.append((pend, m.group(1).replace("_stats",""))); pend = None; continue
        m = re.match(r"\s*#include <assets/obseg/gun/(\w+)/gunWeaponStat", line)
        if m:
            syms.append((pend, m.group(1))); pend = None
    return syms

def decode(blob, off):
    f = lambda o: struct.unpack(">f", blob[off+o:off+o+4])[0]
    i32 = lambda o: struct.unpack(">i", blob[off+o:off+o+4])[0]
    u32 = lambda o: struct.unpack(">I", blob[off+o:off+o+4])[0]
    u16 = lambda o: struct.unpack(">H", blob[off+o:off+o+2])[0]
    s16v = lambda o: struct.unpack(">h", blob[off+o:off+o+2])[0]
    r = lambda v: round(v, 4)
    ammo = i32(0x1C)
    auto = blob[off+0x22]
    single = struct.unpack(">b", blob[off+0x23:off+0x24])[0]
    bits = u32(0x6C)
    return {
        "vfx": {
            "muzzle_flash_extension": r(f(0x00)),
            "gun_screen_pos": [r(f(0x04)), r(f(0x08)), r(f(0x0C))],
            "gun_play": [r(f(0x10)), r(f(0x14)), r(f(0x18))],
            "ejects_cartridges": u32(0x28) != 0,
            "recoil_speed": i32(0x44),
            "recoil_back": r(f(0x48)),
            "recoil_up": r(f(0x4C)),
            "bolt_recoil_back": r(f(0x50)),
            "sway": r(f(0x40)),
        },
        "ammo_type": AMMO[ammo] if 0 <= ammo < len(AMMO) else ammo,
        "mag_size": s16v(0x20),
        "auto_firing_rate_ticks": None if auto == 0xFF else auto,
        "single_firing_rate_ticks": single,
        "penetration_objects": blob[off+0x24],
        "sound_trigger_rate": blob[off+0x25],
        "sound_id": f"{u16(0x26):#x}",
        "damage": r(f(0x2C)),
        "inaccuracy": r(f(0x30)),
        "zoom_fov": r(f(0x34)),
        "crosshair_speed": r(f(0x38)),
        "aim_lock_speed": r(f(0x3C)),
        "ai_noise": {
            "loudness_min": r(f(0x54)),
            "loudness_max": r(f(0x58)),
            "noise_per_shot": r(f(0x5C)),
            "decay_linear_time": r(f(0x60)),
            "decay_scaled_time": r(f(0x64)),
        },
        "force_of_impact": r(f(0x68)),
        "flags": [n for b, n in FLAGS.items() if bits & b],
    }

def main():
    blob = open(CODE, "rb").read()
    syms = parse_symbols()
    # locate default_weaponstats {1.0,0,0,0,3.0,3.0,8.5,...} to derive the load base
    pat = struct.pack(">7f", 1.0, 0.0, 0.0, 0.0, 3.0, 3.0, 8.5)
    off0 = blob.find(pat)
    assert off0 != -1, "default_weaponstats pattern not found"
    base = syms[0][0] - off0   # syms[0] is default_weaponstats
    print(f"table base: RAM {syms[0][0]:#x} -> file {off0:#x} (base {base:#x})")
    weapons = {}
    for addr, name in syms:
        off = addr - base
        if not (0 <= off + 0x70 <= len(blob)):
            print("  skip", name, "out of range"); continue
        weapons[name] = decode(blob, off)
    os.makedirs(OUT, exist_ok=True)
    json.dump(weapons, open(os.path.join(OUT, "WEAPONS.json"), "w"), indent=1)

    # summary table
    rows = []
    hdr = ["weapon","ammo","mag","auto rate","single rate","damage","spread",
           "penetr.","zoom","recoil up","loud min-max","noise/shot","flags"]
    for name, w in weapons.items():
        if name.startswith(("default","null","joypad")): continue
        fl = ",".join(x for x in w["flags"] if x in
              ("BURST_FIRE","FIRST_SHOT_ACCURACY","CAN_DUAL_WIELD","SINGLE_USE_RELOAD",
               "HAS_AUTO_AIM","NO_CLIP_RELOADS","AMMO_CLIP_LIMIT"))
        rows.append([name, str(w["ammo_type"]), str(w["mag_size"]),
                     str(w["auto_firing_rate_ticks"]), str(w["single_firing_rate_ticks"]),
                     str(w["damage"]), str(w["inaccuracy"]), str(w["penetration_objects"]),
                     str(w["zoom_fov"]), str(w["vfx"]["recoil_up"]),
                     f"{w['ai_noise']['loudness_min']}-{w['ai_noise']['loudness_max']}",
                     str(w["ai_noise"]["noise_per_shot"]), fl])
    widths = [max(len(hdr[i]), max((len(r[i]) for r in rows), default=0)) for i in range(len(hdr))]
    lines = ["# GoldenEye weapon stats (from ROM)", "",
             "Rates are in 60Hz ticks between shots; auto rate `None` = no full-auto mode.",
             "Spread = inaccuracy (KF7 10.0 reference, sniper 0.0). Damage: KF7 1.0, Golden Gun 100.0.", "",
             "| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(hdr)) + " |",
             "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
    for r in rows:
        lines.append("| " + " | ".join(r[i].ljust(widths[i]) for i in range(len(hdr))) + " |")
    open(os.path.join(OUT, "WEAPONS.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"extracted {len(weapons)} weapon stat blocks -> {OUT}/")

if __name__ == "__main__":
    main()
