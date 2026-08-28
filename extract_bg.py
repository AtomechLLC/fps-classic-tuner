#!/usr/bin/env python3
"""Extract GoldenEye 007 background (level) geometry to OBJ + MTL.

Level format (n64decomp/007 src/game/bg.c load_bg_file):
  The bg .seg files are raw in the ROM (not 1172-compressed as a whole) at the
  offsets the game's file resource table gives -- see extracted/MANIFEST.txt.
  Header words: [0]=0, [1]=room table, [2]=portals, [3]=env data; offsets are
  0x0F-segment tagged (off = tagged + 0xF1000000, i.e. strip the tag).

  Room table (bg_room_data, 24 bytes): {pPointTableBin, pPriMappingBin,
  pSecMappingBin, f32 pos[3]}. Entry 0 is null, the last real entry is a
  terminator whose pointers mark section ends and whose pos is (0,0,0), so
  rooms run 1..N-1. Each pointer targets a 1172 block inside the seg file:
  the point table decompresses to a plain N64 Vtx array and the mapping bins
  to Fast3D display lists (same dialect as the model files: 0xC0 texture
  command carrying the global image id + s/t wrap modes, G_VTX from segment
  0x0E = the room's Vtx array, TRI4/TRI1).

  World space: bgroomtrans.c scales rooms by room_data_float2 = 1/levelscale
  and translates by room.pos/levelscale -- i.e. bg-file coordinates times
  1/levelscale are world units, and setup pads share the bg-file coordinate
  space. The OBJ keeps raw bg-file coordinates (room pos baked in); the
  manifest carries levelscale so the renderer applies 1/levelscale itself.

Vertex colours ride in the OBJ "v" lines (x y z r g b). Secondary display
lists are the game's translucent pass: their materials get "_sec" and an MTL
"d" opacity from the mean vertex alpha of the faces using them.
"""
import struct, zlib, json, os, sys, re
from collections import defaultdict

ROM = "GoldenEye 007 (USA)/GoldenEye 007 (USA).z64"
OUT = "extracted/levels"

# levelscale per level, from bg.c levelinfotable
LEVELSCALE = {
    "sev": 0.53931433, "silo": 0.47256002, "stat": 0.107202865,
    "arec": 0.49886572, "arch": 0.50678575, "tra": 0.15019713,
    "dest": 0.44757429, "sevb": 0.53931433, "azt": 0.35300568,
    "pete": 0.34187999, "depo": 0.21847887, "ref": 0.94285715,
    "cryp": 0.25608, "dam": 0.23363999, "ark": 1.20648,
    "run": 0.089571431, "sevx": 0.45445713, "jun": 0.094662853,
    "dish": 0.47142857, "cave": 0.26824287, "cat": 0.76852286,
    "crad": 0.23571429, "sho": 0.528, "eld": 0.94285715,
    "ame": 0.65999997, "lue": 0.94285715, "rit": 0.94285715,
    "oat": 0.14142857, "ear": 0.94285715, "lee": 0.94285715,
    "lip": 0.94285715, "len": 0.094662853, "wax": 0.94285715,
    "pam": 0.94285715,
}

def seg_offsets():
    """level short name -> ROM offset of its bg seg, from MANIFEST.txt."""
    out = {}
    for line in open("extracted/MANIFEST.txt"):
        m = re.search(r"(0x[0-9a-f]+)\s+bg/bg_(\w+?)_all_p\.seg", line)
        if m:
            out.setdefault(m.group(2), int(m.group(1), 16))
    return out

def texture_index():
    path = "extracted/images/IMAGES.json"
    table = json.load(open(path))
    return ({e["id"]: e["png"] for e in table if e.get("png")},
            {e["id"]: (e.get("w"), e.get("h")) for e in table})

class Level:
    def __init__(self, rom, base, name):
        self.rom = rom; self.base = base; self.name = name
        self.verts = []     # (x,y,z) absolute bg coords
        self.cols = []      # (r,g,b,a) 0..1
        self.uvs = []       # raw s10.5 texel coords
        self.faces = []     # (a,b,c, texid, sec, wrap, room)
        self.rooms = []     # {id, pos, bbox}
        self.texdims = {}   # texid -> (w,h) from IMAGES.json

    def u32(self, off): return struct.unpack(">I", self.rom[off:off+4])[0]

    def inflate(self, segptr):
        off = self.base + ((segptr + 0xF1000000) & 0xFFFFFFFF)
        assert self.rom[off:off+2] == b"\x11\x72", \
            f"bad 1172 magic at {off:#x}: {self.rom[off:off+2].hex()}"
        d = zlib.decompressobj(wbits=-15)
        return d.decompress(self.rom[off+2:off+0x100000])

    def run_dl(self, gd, vtx, pos, sec, room):
        vbuf = [-1] * 32
        cur_tex, cur_wrap = None, (0, 0)
        o = 0
        while o + 8 <= len(gd):
            w0, w1 = struct.unpack(">2I", gd[o:o+8]); o += 8
            cmd = w0 >> 24
            if cmd == 0xB8: break
            elif cmd == 0xC0:
                cur_tex = w1 & 0xFFF
                cur_wrap = ((w0 >> 22) & 3, (w0 >> 20) & 3)
            elif cmd == 0x04:
                n = ((w0 >> 20) & 0xF) + 1
                v0 = (w0 >> 16) & 0xF
                if (w1 >> 24) != 0x0E: continue     # rooms only load from seg 0e
                addr = w1 & 0xFFFFFF
                for i in range(n):
                    a = addr + 16*i
                    if a + 16 > len(vtx):
                        vbuf[v0+i] = -1; continue
                    x, y, z, f, s, t = struct.unpack(">6h", vtx[a:a+12])
                    r, g, b, al = vtx[a+12], vtx[a+13], vtx[a+14], vtx[a+15]
                    self.verts.append((x + pos[0], y + pos[1], z + pos[2]))
                    self.cols.append((r/255, g/255, b/255, al/255))
                    self.uvs.append((s / 32.0, t / 32.0))
                    vbuf[v0+i] = len(self.verts) - 1
            elif cmd == 0xB1:      # TRI4, nibble packed, all-zero tri = skip
                for k in range(4):
                    x = (w1 >> (8*k)) & 0xF
                    y = (w1 >> (8*k+4)) & 0xF
                    z = (w0 >> (4*k)) & 0xF
                    if x == y == z == 0: continue
                    if vbuf[x] < 0 or vbuf[y] < 0 or vbuf[z] < 0: continue
                    self.faces.append((vbuf[x], vbuf[y], vbuf[z],
                                       cur_tex, sec, cur_wrap, room))
            elif cmd == 0xBF:      # TRI1, idx*10
                a, b, c = (w1 >> 16) & 0xFF, (w1 >> 8) & 0xFF, w1 & 0xFF
                ia, ib, ic = vbuf[a//10], vbuf[b//10], vbuf[c//10]
                if ia >= 0 and ib >= 0 and ic >= 0:
                    self.faces.append((ia, ib, ic, cur_tex, sec, cur_wrap, room))
            # rdp state (b6/b7/b9/ba/bb/e7/fb/fc) has no geometry effect here

    def extract(self):
        rt = self.base + ((self.u32(self.base + 4) + 0xF1000000) & 0xFFFFFFFF)
        entries = []
        i = 0
        while True:
            e = rt + 24*i
            p = struct.unpack(">3I", self.rom[e:e+12])
            pos = struct.unpack(">3f", self.rom[e+12:e+24])
            if i > 0 and p[1] == 0: break
            entries.append((p, pos))
            i += 1
        # the last non-null entry is the section-end terminator (pos 0,0,0)
        nrooms = len(entries) - 1
        for i in range(1, nrooms):
            (pt, pri, sec), pos = entries[i]
            vtx = self.inflate(pt) if pt else b""
            v0 = len(self.verts)
            if pri: self.run_dl(self.inflate(pri), vtx, pos, False, i)
            if sec: self.run_dl(self.inflate(sec), vtx, pos, True, i)
            vs = self.verts[v0:]
            if vs:
                bb = [[min(v[k] for v in vs), max(v[k] for v in vs)]
                      for k in range(3)]
            else:
                bb = [[pos[0], pos[0]], [pos[1], pos[1]], [pos[2], pos[2]]]
            self.rooms.append({"id": i, "pos": list(pos),
                               "min": [bb[0][0], bb[1][0], bb[2][0]],
                               "max": [bb[0][1], bb[1][1], bb[2][1]],
                               "verts": len(vs)})

    def export(self, outdir, texmap, texdims):
        os.makedirs(outdir, exist_ok=True)
        name = self.name
        def matname(tid, sec, wrap):
            base = f"tex_{tid}"
            return (base + ("_sec" if sec else "")
                    + (f"_w{wrap[0]}{wrap[1]}" if wrap != (0, 0) else ""))

        # mean vertex alpha per material (drives MTL "d" for the _sec pass)
        alpha = defaultdict(list)
        for a, b, c, tid, sec, wrap, room in self.faces:
            mn = matname(tid, sec, wrap)
            for vi in (a, b, c): alpha[mn].append(self.cols[vi][3])

        used = sorted({matname(tid, sec, wrap): (tid, sec)
                       for _, _, _, tid, sec, wrap, _ in self.faces}.items())
        with open(os.path.join(outdir, f"{name}.mtl"), "w") as m:
            for mn, (tid, sec) in used:
                m.write(f"newmtl {mn}\n")
                png = texmap.get(tid)
                if png: m.write(f"map_Kd ../images/{png}\n")
                if sec:
                    d = sum(alpha[mn]) / len(alpha[mn])
                    m.write(f"d {d:.3f}\n")
                m.write("\n")

        def face_uv(vi, tid):
            w, h = texdims.get(tid, (None, None))
            w = w or 32; h = h or 32
            rs, rt = self.uvs[vi]
            return (rs / w, 1.0 - rt / h)

        with open(os.path.join(outdir, f"{name}.obj"), "w") as f:
            f.write(f"mtllib {name}.mtl\n")
            for i, v in enumerate(self.verts):
                r, g, b, _ = self.cols[i]
                f.write(f"v {v[0]} {v[1]} {v[2]} {r:.3f} {g:.3f} {b:.3f}\n")
            vt_map, vt_list, face_vt = {}, [], []
            for fc in self.faces:
                tri = []
                for vi in fc[:3]:
                    uv = face_uv(vi, fc[3])
                    key = (round(uv[0], 4), round(uv[1], 4))
                    if key not in vt_map:
                        vt_map[key] = len(vt_list); vt_list.append(key)
                    tri.append(vt_map[key])
                face_vt.append(tri)
            for u in vt_list: f.write(f"vt {u[0]:.4f} {u[1]:.4f}\n")
            last_room, last_mat = None, None
            for fi, (a, b, c, tid, sec, wrap, room) in enumerate(self.faces):
                if room != last_room:
                    f.write(f"o room_{room}\n"); last_room = room; last_mat = None
                mn = matname(tid, sec, wrap)
                if mn != last_mat:
                    f.write(f"usemtl {mn}\n"); last_mat = mn
                t0, t1, t2 = face_vt[fi]
                f.write(f"f {a+1}/{t0+1} {b+1}/{t1+1} {c+1}/{t2+1}\n")

        scale = LEVELSCALE[name]
        json.dump({
            "name": name, "levelscale": scale, "world_per_bg": 1.0 / scale,
            "rooms": self.rooms,
            "verts": len(self.verts), "faces": len(self.faces),
        }, open(os.path.join(outdir, f"{name}.json"), "w"), indent=1)


def main():
    levels = sys.argv[1:] or ["dam"]
    rom = open(ROM, "rb").read()
    offs = seg_offsets()
    texmap, texdims = texture_index()
    for name in levels:
        lvl = Level(rom, offs[name], name)
        lvl.extract()
        lvl.export(OUT, texmap, texdims)
        print(f"{name}: {len(lvl.rooms)} rooms, {len(lvl.verts)} verts, "
              f"{len(lvl.faces)} faces -> {OUT}/{name}.obj")

if __name__ == "__main__":
    main()
