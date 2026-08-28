#!/usr/bin/env python3
"""Extract the object/character model tables to extracted/setups/OBJECTS.json.

Setup records reference models by index:
  - ObjectRecords index PitemZ_entries[] (loadobjectmodel.c modelLoad), built
    from assets/obseg/prop/propItemModelFileRecord.inc.c -- one PROPFILERECORD
    (name, scale) per include, in PROP_* enum order. The model file is
    "P<name>Z" and objInit multiplies the record scale by the setup record's
    extrascale/256.
  - Guard bodies index c_item_entries[] (bondview2.c), built the same way from
    assets/obseg/chr/chrModelFileRecords.inc.c in BODIES enum order (which, on
    the retail ROM, has the ALL_BONDS trio compiled out -- same strip as
    decode_setups).
"""
import json, os, re

DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")
OUT = "extracted/setups"

def strip_all_bonds(text):
    return re.sub(r"#ifdef ALL_BONDS.*?#endif", "", text, flags=re.S)

def parse_enum(header_text, member_prefix, anchor):
    i = header_text.find(anchor)
    if i == -1: return []
    start = header_text.rfind("{", 0, i)
    end = header_text.find("}", i)
    return [m.group(1) for m in
            re.finditer(r"^\s*(" + member_prefix + r"\w+)\s*[,=]",
                        header_text[start:end], re.M)]

def include_dirs(path, kind):
    src = open(path, encoding="utf-8", errors="replace").read()
    return re.findall(r"assets/obseg/%s/(\w+)/" % kind, src)

def record_scale(kind, name):
    """(model file name, scale). Prop records are a PROPFILERECORD(name, scale)
    macro; chr records are raw initialisers {&hdr, "CnameZ", scale, ...}."""
    if kind == "prop":
        p = os.path.join(DECOMP, "assets", "obseg", "prop", name, "propFileRecord.inc.c")
        m = re.search(r"PROPFILERECORD\(\s*(\w+)\s*,\s*([0-9.]+)",
                      open(p, encoding="utf-8", errors="replace").read())
        return "P%sZ" % m.group(1), float(m.group(2))
    p = os.path.join(DECOMP, "assets", "obseg", "chr", name, "chrModelFileRecord.inc.c")
    m = re.search(r'"(\w+)"\s*,\s*([0-9.]+)',
                  open(p, encoding="utf-8", errors="replace").read())
    return m.group(1), float(m.group(2))

def main():
    bc = strip_all_bonds(open(os.path.join(DECOMP, "src", "bondconstants.h"),
                              encoding="utf-8", errors="replace").read())
    prop_enum = parse_enum(bc, "PROP_", "PROP_ALARM1")
    all_bodies = parse_enum(bc, "BODY_", "BODY_Jaws")

    prop_dirs = include_dirs(os.path.join(DECOMP, "assets", "obseg", "prop",
                                          "propItemModelFileRecord.inc.c"), "prop")
    chr_dirs = include_dirs(os.path.join(DECOMP, "assets", "obseg", "chr",
                                         "chrModelFileRecords.inc.c"), "chr")
    props = {}
    for i, d in enumerate(prop_dirs):
        if i >= len(prop_enum): break
        f, scale = record_scale("prop", d)
        props[prop_enum[i]] = {"file": f, "scale": scale}
    bodies = {}
    for i, d in enumerate(chr_dirs):
        if i >= len(all_bodies): break
        f, scale = record_scale("chr", d)
        bodies[all_bodies[i]] = {"file": f, "scale": scale}

    os.makedirs(OUT, exist_ok=True)
    json.dump({"props": props, "bodies": bodies},
              open(os.path.join(OUT, "OBJECTS.json"), "w"), indent=1)
    print("props: %d (%d enum), bodies: %d (%d enum) -> %s/OBJECTS.json"
          % (len(props), len(prop_enum), len(bodies), len(all_bodies), OUT))

if __name__ == "__main__":
    main()
