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
        self.attrs = []      # (r,g,b) colour or unit normal, per vertex
        self.lit = []        # per-vertex: True if attr bytes are a normal
        self.faces = []      # (vi1,vi2,vi3, uv1,uv2,uv3, texid)
        self.cur_tex = None
        self.seen_nodes = set()
        self.gunfire = None
        self.cur_switch = -1     # -1 = always-visible geometry
        self.n_switches = 0
        self.geomode = 0         # RSP geometry mode (G_TEXTURE_GEN etc.)
        self.mtx = {}            # matrix index -> (tx,ty,tz)  (rotations are identity at rest)
        self.cur_mtx = (0.0, 0.0, 0.0)
        # header Switches array: gunfire.c uses Switches[1] as the muzzle-flash
        # switch node and Switches[3] as its placement data
        self.switches = [self.u32(4*i) & 0xffffff for i in range(ns)]
        self.flash_node = self.switches[1] if ns > 1 and self.switches[1] else None

    def u16(self, o): return struct.unpack(">H", self.d[o:o+2])[0]
    def u32(self, o): return struct.unpack(">I", self.d[o:o+4])[0]
    def off(self, v): return v & 0xffffff

    def vertex(self, addr, translate, lit):
        x, y, z, f, s, t = struct.unpack(">6h", self.d[addr:addr+12])
        translate = self.cur_mtx
        w, h = self.tex.get(self.cur_tex, (32, 32))
        u = s / 32.0 / max(w, 1)
        v = 1.0 - t / 32.0 / max(h, 1)
        self.verts.append((x+translate[0], y+translate[1], z+translate[2]))
        if lit:   # colour slots hold a signed vertex normal
            nx, ny, nz = struct.unpack(">3b", self.d[addr+12:addr+15])
            ln = max((nx*nx+ny*ny+nz*nz) ** 0.5, 1e-6)
            nx, ny, nz = nx/ln, ny/ln, nz/ln
            self.attrs.append((nx, ny, nz))
            if self.geomode & 0x40000:   # G_TEXTURE_GEN: UVs come from the normal
                u = nx * 0.5 + 0.5
                v = 1.0 - (ny * 0.5 + 0.5)
        else:     # prelit vertex colour
            self.attrs.append((self.d[addr+12]/255, self.d[addr+13]/255, self.d[addr+14]/255))
        self.uvs.append((u, v))
        self.lit.append(lit)
        return len(self.verts) - 1

    def run_dl(self, o, vtx_base, translate, depth=0, lit=False):
        vbuf = [0]*32
        if depth > 8: return
        while o + 8 <= len(self.d):
            w0, w1 = struct.unpack(">2I", self.d[o:o+8])
            cmd = w0 >> 24
            o += 8
            if cmd == 0xB8: return
            elif cmd == 0x06:      # G_DL
                if (w1 >> 24) in (5, 6):
                    self.run_dl(self.off(w1), vtx_base, translate, depth+1, lit)
                if (w0 >> 16) & 0xFF == 1: return
            elif cmd == 0x01:      # G_MTX: load matrix from segment 3 (index = off/64)
                if (w1 >> 24) == 3:
                    self.cur_mtx = self.mtx.get((w1 & 0xFFFFFF) // 64, (0.0, 0.0, 0.0))
            elif cmd == 0xB7:      # G_SETGEOMETRYMODE
                self.geomode |= w1
            elif cmd == 0xB6:      # G_CLEARGEOMETRYMODE
                self.geomode &= ~w1
            elif cmd == 0xC0:
                self.cur_tex = w1 & 0xFFFF
            elif cmd == 0x04:      # G_VTX
                n = ((w0 >> 20) & 0xF) + 1
                v0 = (w0 >> 16) & 0xF
                # segment 5 = absolute file offset; segment 4 = offset relative to
                # this record's Vertices array (set as a segment base at load time)
                seg = w1 >> 24
                if seg == 5:
                    addr = self.off(w1)
                elif seg == 4 and vtx_base:
                    addr = vtx_base + self.off(w1)
                else:
                    addr = None
                if addr is None or addr + 16*n > len(self.d):
                    for i in range(n):
                        vbuf[v0+i] = -1
                else:
                    for i in range(n):
                        vbuf[v0+i] = self.vertex(addr + 16*i, translate, lit)
            elif cmd == 0xB1:  # TRI4
                tris = []
                for k in range(4):
                    x = (w1 >> (8*k)) & 0xF
                    y = (w1 >> (8*k+4)) & 0xF
                    z = (w0 >> (4*k)) & 0xF
                    if x == y == z == 0: continue
                    tris.append((x, y, z))
                env = bool(self.geomode & 0x40000)
                for x, y, z in tris:
                    if vbuf[x] < 0 or vbuf[y] < 0 or vbuf[z] < 0: continue
                    self.faces.append((vbuf[x], vbuf[y], vbuf[z], self.cur_tex, self.cur_switch, lit, env))
            elif cmd == 0xBF:  # TRI1
                a, b, c = (w1 >> 16) & 0xFF, (w1 >> 8) & 0xFF, w1 & 0xFF
                ia, ib, ic = vbuf[a//10], vbuf[b//10], vbuf[c//10]
                if ia >= 0 and ib >= 0 and ic >= 0:
                    self.faces.append((ia, ib, ic, self.cur_tex, self.cur_switch, lit,
                                       bool(self.geomode & 0x40000)))
            # everything else (rdp state, matrices) ignored

    def calc_matrices(self, addr, parent, seen=None):
        """model.c subcalcmatrices: matrix[MatrixID0] = parent * translate(Origin)."""
        if seen is None: seen = set()
        if addr == 0 or addr in seen: return
        seen.add(addr)
        raw = self.u16(addr)
        op = raw & 0xFF
        data = self.off(self.u32(addr+4))
        here = parent
        if op in (2, 21) and data:
            ox, oy, oz = struct.unpack(">3f", self.d[data:data+12])
            here = (parent[0]+ox, parent[1]+oy, parent[2]+oz)
            m0 = struct.unpack(">h", self.d[data+0x0e:data+0x10])[0]
            if m0 >= 0: self.mtx[m0] = here
            if raw & 0x100:
                m1 = struct.unpack(">h", self.d[data+0x10:data+0x12])[0]
                if m1 >= 0: self.mtx[m1] = here
            if raw & 0x200:
                m2 = struct.unpack(">h", self.d[data+0x12:data+0x14])[0]
                if m2 >= 0: self.mtx[m2] = here
        elif op == 1 and data:
            mi = struct.unpack(">h", self.d[data+2:data+4])[0]
            if mi >= 0: self.mtx[mi] = here
            grp = self.off(self.u32(data+4))
            if grp: self.calc_matrices(grp, here, seen)
        child = self.off(self.u32(addr+0x14))
        nxt = self.off(self.u32(addr+0x0c))
        if child: self.calc_matrices(child, here, seen)
        if nxt: self.calc_matrices(nxt, parent, seen)

    def node(self, addr, translate):
        if addr == 0 or addr in self.seen_nodes: return
        self.seen_nodes.add(addr)
        op = self.u16(addr) & 0xFF
        data = self.off(self.u32(addr+4))
        child = self.off(self.u32(addr+0x14))
        nxt = self.off(self.u32(addr+0x0c))
        t = translate
        if op == 18:              # switch node: one child shown at a time
            sw = 'fl' if (self.flash_node and addr == self.flash_node) else self.n_switches
            if sw != 'fl': self.n_switches += 1
            ch = self.off(self.u32(addr+0x14))
            j = 0
            while ch:
                self.cur_switch = (sw, j)
                self.node(ch, t)
                ch2 = self.off(self.u32(ch+0x0c))
                # the child list is walked via our normal next-recursion; stop here
                break
            self.cur_switch = -1
            nxt2 = self.off(self.u32(addr+0x0c))
            if nxt2: self.node(nxt2, translate)
            return
        if op == 1 and data:      # header record (characters): tree at Data->FirstGroup
            grp = self.off(self.u32(data+4))
            if grp: self.node(grp, t)
        elif op in (2, 21) and data:   # group: transform lives in the matrix table
            pass
        elif op == 4 and data:    # display list (guns)
            pri, sec = self.u32(data), self.u32(data+4)
            lit = self.d[data+18] in (3, 4)     # GunLighting / fog+lighting
            for gdl in (pri, sec):
                if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+12)), translate, lit=lit)
        elif op == 24 and data:   # display list with collision table (props/chars)
            pri, sec = self.u32(data), self.u32(data+4)
            mtype = struct.unpack(">h", self.d[data+0x18:data+0x1a])[0]
            lit = mtype in (3, 4)
            for gdl in (pri, sec):
                if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+8)), translate, lit=lit)
        elif op == 22 and data:   # primary-only display list
            gdl = self.u32(data+8)
            if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+4)), translate)
        elif op == 12 and data:   # gunfire (muzzle flash)
            vals = struct.unpack(">7f", self.d[data:data+28])
            img = self.u32(data+24)
            self.gunfire = {"offset": vals[0:3], "size": vals[3:6],
                            "scale": struct.unpack(">f", self.d[data+0x1c:data+0x20])[0]}
        if child: self.node(child, t)
        if isinstance(self.cur_switch, tuple):
            sw, j = self.cur_switch
            if nxt:
                self.cur_switch = (sw, j + 1)
                self.node(nxt, translate)
                self.cur_switch = (sw, j)
            return
        if nxt: self.node(nxt, translate)

    def export_obj(self, path, name):
        def mat(tid, sw, lit, env):
            base = f"tex_{tid}"
            if isinstance(sw, tuple):
                base += (f"_fl{sw[1]}" if sw[0] == 'fl' else f"_sw{sw[0]}_{sw[1]}")
            return base + ("_lit" if lit else "") + ("_env" if env else "")
        used = sorted(set((f[3], f[4], f[5], f[6]) for f in self.faces),
                      key=lambda x: (str(x[0]), str(x[1]), x[2], x[3]))
        with open(path + ".mtl", "w") as m:
            for tid, sw, lit, env in used:
                m.write(f"newmtl {mat(tid, sw, lit, env)}\n")
                png = self.texmap.get(tid)
                if png: m.write(f"map_Kd ../images/{png}\n")
                m.write("\n")
        with open(path + ".obj", "w") as f:
            f.write(f"mtllib {name}.mtl\n")
            for i, v in enumerate(self.verts):
                r, g, b = (1.0, 1.0, 1.0) if self.lit[i] else self.attrs[i]
                f.write(f"v {v[0]} {v[1]} {v[2]} {r:.3f} {g:.3f} {b:.3f}\n")
            for u in self.uvs: f.write(f"vt {u[0]:.4f} {u[1]:.4f}\n")
            for i in range(len(self.verts)):
                if self.lit[i]:
                    nx, ny, nz = self.attrs[i]
                    f.write(f"vn {nx:.3f} {ny:.3f} {nz:.3f}\n")
                else:
                    f.write("vn 0 1 0\n")
            last = object()
            for a, b, c, tid, sw, lit, env in self.faces:
                key = (tid, sw, lit, env)
                if key != last:
                    f.write(f"usemtl {mat(tid, sw, lit, env)}\n"); last = key
                f.write(f"f {a+1}/{a+1}/{a+1} {b+1}/{b+1}/{b+1} {c+1}/{c+1}/{c+1}\n")

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
            dec.calc_matrices(root, (0.0, 0.0, 0.0))
            dec.node(root, (0.0, 0.0, 0.0))
        except (struct.error, IndexError, RecursionError):
            failed.append(name); continue
        if not dec.faces:
            failed.append(name); continue
        dec.export_obj(os.path.join(OUT, name), name)
        switches = {}
        for f in dec.faces:
            if isinstance(f[4], tuple):
                switches.setdefault(f"{f[4][0]}_{f[4][1]}", set()).add(f[3])
        has_flash = any(isinstance(f[4], tuple) and f[4][0] == 'fl' for f in dec.faces)
        bbox = None
        if dec.verts:
            xs, ys, zs = zip(*dec.verts)
            bbox = [round(min(xs),1), round(min(ys),1), round(min(zs),1),
                    round(max(xs),1), round(max(ys),1), round(max(zs),1)]
        manifest[name] = {"tris": len(dec.faces), "verts": len(dec.verts),
                          "textures": sorted(set(f[3] for f in dec.faces if f[3] is not None)),
                          "switches": {k: sorted(x for x in v if x is not None) for k, v in switches.items()},
                          "bbox": bbox,
                          "has_flash": has_flash,
                          "source": "decomp" if name in info else "heuristic"}
        if dec.gunfire: manifest[name]["muzzle_flash"] = dec.gunfire
    json.dump(manifest, open(os.path.join(OUT, "MODELS.json"), "w"), indent=1)
    print(f"exported {len(manifest)} models -> {OUT}/ ; {len(failed)} failed/empty")
    if failed: print("  failed:", " ".join(failed[:20]), "..." if len(failed) > 20 else "")

if __name__ == "__main__":
    main()
