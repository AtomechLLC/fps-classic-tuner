#!/usr/bin/env python3
"""Build the character data the range needs to stand real GoldenEye enemies up.

GE characters are skeletal: chr.c drives every joint from the animation
bitstream, so a body model has no rest pose to export -- see the note in
README. What *is* rigid, and therefore usable as-is, is the head and the hat
the game attaches to it. This script collects:

  - the HEADS enum and the head model each entry uses
  - headHat_array_8003E464 (chr.c), which seats a hat on a head: an offset in
    units of 21.3 and a per-axis scale, indexed [head][hattype]
  - the six hat models, by HATTYPE
  - the BODIES enum, for identifying an enemy
  - the guard roster actually placed in the decoded stage setups

Enum names and the hat table come from the decomp; the roster comes from the
ROM's own setups via decode_setups.py.
"""
import re, os, json, glob

DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")
SETUPS = "extracted/setups"
MODELS = "extracted/models"
OUT = "extracted/characters"

# HEADS enum name -> model file. Most are the developer's own first name; the
# handful that differ are the in-game aliases (the terrorist wears a balaclava).
HEAD_MODEL_ALIAS = {
    "Dave_Dr_Doak": "dave", "Steve_H": "steveh", "Steve_Ellis": "stevee",
    "Terrorist": "balaclava", "Biker": "bike", "Graeme": "graham",
    "Joe_Altered": "joe2", "Marion_Rosika": "marion",
    "Brosnan_Boiler": "brosnanboiler", "Brosnan_Default": "brosnan",
    "Brosnan_Jungle": "brosnantimber", "Brosnan_Parka": "brosnansnow",
    "Brosnan_Tuxedo": "brosnansuit", "Jungle_Fatigues": "natalya",
}
# HATTYPE (bondconstants.h) -> the prop model chr.c attaches. The colour
# variants share a placement entry, so pick the plain one.
HAT_MODELS = ["PhatberetZ", "PhattbirdZ", "PhatpeakedZ",
              "PhathelmetZ", "PhatfurryZ", "PhatmoonZ"]
HAT_NAMES = ["beret", "side cap", "peaked cap", "helmet", "fur hat", "moonraker helmet"]

def strip_all_bonds(text):
    """Drop #ifdef ALL_BONDS blocks.

    The retail ROM has no Connery/Dalton/Moore assets (no body or head models
    for them in the file table), so those three BODIES/HEADS members are not
    compiled in and every id above them shifts by three. Keeping them mislabels
    setup guards: Natalya's escort in Archives/Bunker/Train came out as "Jaws",
    a character who is not in the game.
    """
    return re.sub(r"#ifdef ALL_BONDS.*?#endif", "", text, flags=re.S)

def enum_members(text, name):
    body = re.search(r"typedef enum %s\s*\{(.*?)\}\s*%s" % (name, name), text, re.S)
    out = []
    for line in body.group(1).splitlines():
        line = line.split("//")[0].split("/*")[0].strip()
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?,?$", line)
        if m: out.append(m.group(1))
    return out

def head_hat_table():
    """headHat_array_8003E464: 28 heads x 6 hat types, six floats each."""
    src = open(os.path.join(DECOMP, "assets", "obseg", "chr", "chrHeadHats.inc.c"),
               encoding="utf-8", errors="replace").read()
    nums = [float(x) for x in re.findall(r"-?\d+\.?\d*(?:e-?\d+)?f?", src.split("{", 1)[1])]
    rows = [nums[i:i+6] for i in range(0, len(nums) - 5, 6)]
    return [rows[i:i+6] for i in range(0, len(rows), 6)]

def main():
    bc = strip_all_bonds(open(os.path.join(DECOMP, "src", "bondconstants.h"),
                              encoding="utf-8", errors="replace").read())
    heads = [h for h in enum_members(bc, "HEADS")
             if h.startswith("HEAD_") and not h.startswith(("HEAD_F_START", "HEAD_BOND_START",
                                                            "HEAD_END", "HEAD_COUNT", "HEAD_MALE",
                                                            "HEAD_FEMALE", "HEAD_FIXED", "HEAD_RANDOM"))]
    # The BODIES enum continues into the head list at HEAD_START, so stop there.
    all_bodies = enum_members(bc, "BODIES")
    cut = all_bodies.index("HEAD_START") if "HEAD_START" in all_bodies else len(all_bodies)
    bodies = [b for b in all_bodies[:cut] if b.startswith("BODY_")]
    table = head_hat_table()

    have = {os.path.basename(p)[:-4] for p in glob.glob(os.path.join(MODELS, "*.obj"))}
    head_entries = []
    for i, name in enumerate(heads):
        short = re.sub(r"^HEAD_(Male|Female|Natalya)_?", "", name)
        model = "Chead%sZ" % HEAD_MODEL_ALIAS.get(short, short.lower())
        if model not in have:
            print("  no model for %s (%s)" % (name, model)); continue
        hats = {}
        if i < len(table):                     # only the 28 random male heads wear hats
            for h, row in enumerate(table[i]):
                hats[HAT_MODELS[h]] = {"offset": [row[0] * 21.3, row[1] * 21.3, row[2] * 21.3],
                                       "scale": row[3:6], "hat": HAT_NAMES[h]}
        head_entries.append({"id": i, "name": name, "model": model, "hats": hats})

    # Who actually stands in the game: aggregate the guard records the setups place.
    roster = {}
    for path in sorted(glob.glob(os.path.join(SETUPS, "*.json"))):
        lvl = os.path.basename(path)[:-5]
        for o in json.load(open(path)).get("objects", []):
            if o.get("type") != "guard": continue
            e = roster.setdefault(o.get("body") or "BODY_%s" % o.get("body_id"),
                                  {"body": o.get("body"), "body_id": o.get("body_id"),
                                   "count": 0, "levels": []})
            e["count"] += 1
            if lvl not in e["levels"]: e["levels"].append(lvl)
    roster = sorted(roster.values(), key=lambda e: -e["count"])

    os.makedirs(OUT, exist_ok=True)
    data = {
        # chr.c:1656 -- every guard spawns with maxdamage 4.0, so the WeaponStats
        # damage values (PP7 1.0, shotgun 0.4/pellet, Golden Gun 100) are the
        # authentic number of hits.
        "guard_max_damage": 4.0,
        "hat_models": HAT_MODELS,
        "bodies": bodies,
        "heads": head_entries,
        "roster": roster,
    }
    json.dump(data, open(os.path.join(OUT, "CHARACTERS.json"), "w"), indent=1)
    print("%d heads (%d with hat placements), %d bodies, %d guard identities -> %s/CHARACTERS.json"
          % (len(head_entries), sum(1 for h in head_entries if h["hats"]),
             len(bodies), len(roster), OUT))

if __name__ == "__main__":
    main()
