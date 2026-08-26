#!/usr/bin/env python3
"""Extract GoldenEye 007 model files (G*/P*/C*) to OBJ + MTL.

File layout (per n64decomp/007 load_object_fill_header):
  [ u32 switch-node pointers x numSwitches ]
  [ 12-byte ModelFileTextures x numtextures ]  {u32 id, u8 W,H,mip,type,depth,sflags,tflags}
  [ ModelNode tree ... vertex arrays ... display lists ]
Pointers are 0x05-segmented: offset = value & 0xffffff.
numSwitches/numtextures come from the decomp's per-model ModelFileHeader.inc.c;
a validity-scored heuristic covers models missing there.

Display lists are Fast3D + GE extensions:
  0x04 G_VTX, 0xBF G_TRI1 (idx*10), 0xB1 G_TRI4 (nibble-packed, all-zero tri = skip),
  0x06 G_DL, 0xB8 G_ENDDL, 0xC0 G_SETTEX (w1 = global texture index).
Texture index = Nth record of the ROM texture segment = extracted/textures order.
"""
import struct, os, re, glob, json, sys

FILES = "extracted/files"
OUT = "extracted/models"
DECOMP = os.environ.get("GE_DECOMP", r"C:\Users\alexy\AppData\Local\Temp\claude\C--Projects-GameDesignSkills-FPS\84e45f69-1c8d-46db-b624-e37129a216e9\scratchpad\007")

def load_header_info():
    """model file name -> (numSwitches, numtextures) from decomp assets."""
    info = {}
    prefix = {"gun": "G", "prop": "P", "chr": "C"}
    for kind, pre in prefix.items():
        for path in glob.glob(os.path.join(DECOMP, "assets", "obseg", kind, "*", "ModelFileHeader.inc.c")):
            src = open(path, encoding="utf-8", errors="replace").read()
            m = re.search(r"MODELFILEHEADER\(\s*(\w+)\s*,(.*)\)", src)
            if not m: continue
            args = [a.strip() for a in m.group(2).split(",")]
            # last 5 args: NUMMATRICES follows NUMSWITCHES; count from the end
            try:
                ns = int(args[-5], 0); nt = int(args[-1], 0)
            except (ValueError, IndexError):
                continue
            info[f"{pre}{m.group(1)}Z"] = (ns, nt)
    return info

def texture_index():
    """global image id -> png filename (from decode_images.py output)"""
    path = "extracted/images/IMAGES.json"
    if not os.path.exists(path): return {}
    return {e["id"]: e["png"] for e in json.load(open(path)) if e["png"]}

def guess_layout(d):
    """Score candidate numSwitches values; return (ns, nt) or None."""
    u32 = lambda o: struct.unpack(">I", d[o:o+4])[0]
    def valid_tex(e):
        if e+12 > len(d): return False
        tid = u32(e); w, h, dep = d[e+4], d[e+5], d[e+8]
        return tid < 4000 and 1 <= w <= 128 and 1 <= h <= 128 and dep <= 3
    def valid_node(o):
        if o+0x18 > len(d): return False
        op = struct.unpack(">H", d[o:o+2])[0]
        if not (1 <= op <= 24): return False
        for p in struct.unpack(">5I", d[o+4:o+0x18]):
            if p and (p >> 24) != 5: return False
        return True
    for ns in range(0, 80):
        base = 4*ns
        ok = all(v == 0 or (v >> 24) == 5 for v in
                 (u32(i) for i in range(0, base, 4)))
        if not ok: continue
        nt = 0
        while valid_tex(base + 12*nt): nt += 1
        if nt and valid_node(base + 12*nt):
            return ns, nt
    return None

class Decoder:
    def __init__(self, d, ns, nt, texmap):
        self.d = d; self.ns = ns; self.nt = nt
        self.texmap = texmap
        self.tex = {}
        for i in range(nt):
            e = 4*ns + 12*i
            tid = self.u32(e)
            self.tex[tid] = (d[e+4], d[e+5])   # W, H
        self.verts = []      # (x,y,z)
        self.uvs = []        # (u,v)
        self.faces = []      # (vi1,vi2,vi3, uv1,uv2,uv3, texid)
        self.cur_tex = None
        self.seen_nodes = set()
        self.gunfire = None

    def u16(self, o): return struct.unpack(">H", self.d[o:o+2])[0]
    def u32(self, o): return struct.unpack(">I", self.d[o:o+4])[0]
    def off(self, v): return v & 0xffffff

    def vertex(self, addr, translate):
        x, y, z, f, s, t = struct.unpack(">6h", self.d[addr:addr+12])
        w, h = self.tex.get(self.cur_tex, (32, 32))
        u = s / 32.0 / max(w, 1)
        v = 1.0 - t / 32.0 / max(h, 1)
        self.verts.append((x+translate[0], y+translate[1], z+translate[2]))
        self.uvs.append((u, v))
        return len(self.verts) - 1

    def run_dl(self, o, vtx_base, translate, depth=0):
        vbuf = [0]*32
        if depth > 8: return
        while o + 8 <= len(self.d):
            w0, w1 = struct.unpack(">2I", self.d[o:o+8])
            cmd = w0 >> 24
            o += 8
            if cmd == 0xB8: return
            elif cmd == 0x06:
                self.run_dl(self.off(w1), vtx_base, translate, depth+1)
                if (w0 >> 16) & 0xFF == 1: return
            elif cmd == 0xC0:
                self.cur_tex = w1 & 0xFFFF
            elif cmd == 0x04:
                n = ((w0 >> 20) & 0xF) + 1
                v0 = (w0 >> 16) & 0xF
                addr = self.off(w1)
                for i in range(n):
                    vbuf[v0+i] = self.vertex(addr + 16*i, translate)
            elif cmd == 0xB1:  # TRI4
                tris = []
                for k in range(4):
                    x = (w1 >> (8*k)) & 0xF
                    y = (w1 >> (8*k+4)) & 0xF
                    z = (w0 >> (4*k)) & 0xF
                    if x == y == z == 0: continue
                    tris.append((x, y, z))
                for x, y, z in tris:
                    self.faces.append((vbuf[x], vbuf[y], vbuf[z], self.cur_tex))
            elif cmd == 0xBF:  # TRI1
                a, b, c = (w1 >> 16) & 0xFF, (w1 >> 8) & 0xFF, w1 & 0xFF
                self.faces.append((vbuf[a//10], vbuf[b//10], vbuf[c//10], self.cur_tex))
            # everything else (rdp state, matrices) ignored

    def node(self, addr, translate):
        if addr == 0 or addr in self.seen_nodes: return
        self.seen_nodes.add(addr)
        op = self.u16(addr)
        data = self.off(self.u32(addr+4))
        child = self.off(self.u32(addr+0x14))
        nxt = self.off(self.u32(addr+0x0c))
        t = translate
        if op == 1 and data:      # header record (characters): tree at Data->FirstGroup
            grp = self.off(self.u32(data+4))
            if grp: self.node(grp, t)
        elif op == 2 and data:    # group: origin offset for children
            ox, oy, oz = struct.unpack(">3f", self.d[data:data+12])
            t = (translate[0]+ox, translate[1]+oy, translate[2]+oz)
        elif op == 4 and data:    # display list (guns)
            pri, sec = self.u32(data), self.u32(data+4)
            for gdl in (pri, sec):
                if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+12)), translate)
        elif op == 24 and data:   # display list with collision table (props/chars)
            pri, sec = self.u32(data), self.u32(data+4)
            for gdl in (pri, sec):
                if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+8)), translate)
        elif op == 22 and data:   # primary-only display list
            gdl = self.u32(data+8)
            if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+4)), translate)
        elif op == 12 and data:   # gunfire (muzzle flash)
            vals = struct.unpack(">7f", self.d[data:data+28])
            img = self.u32(data+24)
            self.gunfire = {"offset": vals[0:3], "size": vals[3:6],
                            "scale": struct.unpack(">f", self.d[data+0x1c:data+0x20])[0]}
        if child: self.node(child, t)
        if nxt: self.node(nxt, translate)

    def export_obj(self, path, name):
        used = sorted(set(f[3] for f in self.faces if f[3] is not None))
        with open(path + ".mtl", "w") as m:
            for tid in used:
                m.write(f"newmtl tex_{tid}\n")
                png = self.texmap.get(tid)
                if png: m.write(f"map_Kd ../images/{png}\n")
                m.write("\n")
        with open(path + ".obj", "w") as f:
            f.write(f"mtllib {name}.mtl\n")
            for v in self.verts: f.write(f"v {v[0]} {v[1]} {v[2]}\n")
            for u in self.uvs: f.write(f"vt {u[0]:.4f} {u[1]:.4f}\n")
            last = object()
            for a, b, c, tid in self.faces:
                if tid != last:
                    f.write(f"usemtl tex_{tid}\n"); last = tid
                f.write(f"f {a+1}/{a+1} {b+1}/{b+1} {c+1}/{c+1}\n")

def main():
    only = sys.argv[1:] or None
    info = load_header_info()
    texmap = texture_index()
    os.makedirs(OUT, exist_ok=True)
    manifest, failed = {}, []
    for path in sorted(glob.glob(os.path.join(FILES, "[GPC]*.bin"))):
        name = os.path.basename(path)[:-4]
        if only and name not in only: continue
        d = open(path, "rb").read()
        layout = info.get(name) or guess_layout(d)
        if not layout:
            failed.append(name); continue
        ns, nt = layout
        root = 4*ns + 12*nt
        dec = Decoder(d, ns, nt, texmap)
        try:
            dec.node(root, (0.0, 0.0, 0.0))
        except (struct.error, IndexError, RecursionError):
            failed.append(name); continue
        if not dec.faces:
            failed.append(name); continue
        dec.export_obj(os.path.join(OUT, name), name)
        manifest[name] = {"tris": len(dec.faces), "verts": len(dec.verts),
                          "textures": sorted(set(f[3] for f in dec.faces if f[3] is not None)),
                          "source": "decomp" if name in info else "heuristic"}
        if dec.gunfire: manifest[name]["muzzle_flash"] = dec.gunfire
    json.dump(manifest, open(os.path.join(OUT, "MODELS.json"), "w"), indent=1)
    print(f"exported {len(manifest)} models -> {OUT}/ ; {len(failed)} failed/empty")
    if failed: print("  failed:", " ".join(failed[:20]), "..." if len(failed) > 20 else "")

if __name__ == "__main__":
    main()
