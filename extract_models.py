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
        # model.c renders a record's Primary list opaque and its Secondary
        # list translucent (OPA_SURF vs XLU_SURF); the struct comment calls
        # them "secondary surfaces" driven by vertex alpha. Tag them so the
        # renderer can blend rather than depth-fight with the primary skin.
        self.cur_sec = False
        self.cur_mtx_id = 0           # matrix slot the current vertices bind to
        self.vmtx = []                # per-vertex matrix slot, parallel to verts
        self.tree = {}                # matrix slot -> {origin, parent, joint, half}
        self.hitparts = {}            # matrix slot -> HITTARGET part number (op-10 bbox)
        self.n_switches = 0
        self.vbuf = [-1] * 32    # RSP vertex buffer: persists across nested DLs
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
        self.vmtx.append(self.cur_mtx_id)
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
        vbuf = self.vbuf
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
                    self.cur_mtx_id = (w1 & 0xFFFFFF) // 64
                    self.cur_mtx = self.mtx.get(self.cur_mtx_id, (0.0, 0.0, 0.0))
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
                ds = not (self.geomode & 0x2000)   # G_CULL_BACK clear = two-sided
                for x, y, z in tris:
                    if vbuf[x] < 0 or vbuf[y] < 0 or vbuf[z] < 0: continue
                    self.faces.append((vbuf[x], vbuf[y], vbuf[z], self.cur_tex,
                                       self.cur_switch, lit, env, self.cur_sec, ds))
            elif cmd == 0xBF:  # TRI1
                a, b, c = (w1 >> 16) & 0xFF, (w1 >> 8) & 0xFF, w1 & 0xFF
                ia, ib, ic = vbuf[a//10], vbuf[b//10], vbuf[c//10]
                if ia >= 0 and ib >= 0 and ic >= 0:
                    self.faces.append((ia, ib, ic, self.cur_tex, self.cur_switch, lit,
                                       bool(self.geomode & 0x40000), self.cur_sec,
                                       not (self.geomode & 0x2000)))
            # everything else (rdp state, matrices) ignored

    def calc_matrices(self, addr, parent, seen=None, parent_id=-1):
        """model.c subcalcmatrices: matrix[MatrixID0] = parent * translate(Origin).

        Also records the joint tree (`self.tree`): each matrix slot's own
        Group.Origin, its parent slot and the skeleton JointID it takes its
        rotation from. The accumulated translate alone is only a rest layout --
        model.c actually builds `parent * rotate(anim) * translate(Origin)`, so
        the tree is what a poseable export needs.
        """
        if seen is None: seen = set()
        if addr == 0 or addr in seen: return
        seen.add(addr)
        raw = self.u16(addr)
        op = raw & 0xFF
        data = self.off(self.u32(addr+4))
        here = parent
        here_id = parent_id
        if op in (2, 21) and data:
            ox, oy, oz = struct.unpack(">3f", self.d[data:data+12])
            here = (parent[0]+ox, parent[1]+oy, parent[2]+oz)
            joint = self.u16(data+0x0c)
            m0, m1, m2 = struct.unpack(">3h", self.d[data+0x0e:data+0x14])
            if m0 >= 0:
                self.mtx[m0] = here
                self.tree[m0] = {"origin": [ox, oy, oz], "parent": parent_id,
                                 "joint": joint, "half": 0}
                here_id = m0
            # The 0x100/0x200 flags give the group a second and third matrix at
            # the same place; sub_GAME_7F06E2B8 drives those with half the
            # joint's angle (GE's bend/stretch), so they are separate bones.
            for flag, mi, half in ((0x100, m1, 1), (0x200, m2, 2)):
                if (raw & flag) and mi >= 0:
                    self.mtx[mi] = here
                    self.tree[mi] = {"origin": [ox, oy, oz], "parent": parent_id,
                                     "joint": joint, "half": half}
        elif op == 1 and data:
            mi = struct.unpack(">h", self.d[data+2:data+4])[0]
            if mi >= 0:
                self.mtx[mi] = here
                self.tree.setdefault(mi, {"origin": [0.0, 0.0, 0.0],
                                          "parent": parent_id, "joint": 0, "half": 0})
                here_id = mi
            grp = self.off(self.u32(data+4))
            if grp: self.calc_matrices(grp, here, seen, here_id)
        child = self.off(self.u32(addr+0x14))
        nxt = self.off(self.u32(addr+0x0c))
        if child: self.calc_matrices(child, here, seen, here_id)
        if nxt: self.calc_matrices(nxt, parent, seen, parent_id)

    def override_runtime_matrices(self):
        """gunfire.c replaces specific matrix slots at render time.

        subcalcmatrices() accumulates group origins down the parent chain, but
        for the weapon's moving parts the game instead builds
        `gunmtx * translate(node->Data->Origin)` -- i.e. the origin is relative
        to the weapon root, not to the parent chain. Slots come from the header
        Switches array: [4] revolver cylinder, [5] hammer, [6] slide/hinge,
        [7] bolt. Using the accumulated value displaces those parts (on the PP7
        by 58 units down and 73 back), which reads as a hollow gun with a
        detached barrel. Rifles have no Switches[6]/[7] and were unaffected.
        """
        # rwmtx[0] is the weapon root itself: gunfire.c does
        # matrix_4x4_copy(&gunmtx, rwmtx), so slot 0 carries no group origin.
        # Leaving the root group's own origin in it shifts every part bound to
        # slot 0 (the DD44's body by 192 units, stretching it into the hand).
        self.mtx[0] = (0.0, 0.0, 0.0)
        # Switches[3] holds the muzzle-flash placement, written to rwmtx[1].
        if len(self.switches) > 3 and self.switches[3]:
            fd = self.off(self.u32(self.switches[3] + 4))
            if fd and fd + 12 <= len(self.d):
                self.mtx[1] = struct.unpack(">3f", self.d[fd:fd+12])
        for idx in (4, 5, 6, 7):
            if idx >= len(self.switches): break
            node = self.switches[idx]
            if not node or node + 8 > len(self.d): continue
            data = self.off(self.u32(node + 4))
            if not data or data + 0x10 > len(self.d): continue
            ox, oy, oz = struct.unpack(">3f", self.d[data:data+12])
            m0 = struct.unpack(">h", self.d[data+0x0e:data+0x10])[0]
            if m0 >= 0:
                self.mtx[m0] = (ox, oy, oz)

    def node(self, addr, translate, slot=-1):
        if addr == 0 or addr in self.seen_nodes: return
        self.seen_nodes.add(addr)
        raw = self.u16(addr)
        op = raw & 0xFF
        data = self.off(self.u32(addr+4))
        child = self.off(self.u32(addr+0x14))
        nxt = self.off(self.u32(addr+0x0c))
        t = translate
        # A group's own bbox node is a *sibling* of its child groups, so
        # siblings keep the slot this node was entered with; only children see
        # the group's slot.
        slot_in = slot
        if op in (2, 21) and data:
            slot = struct.unpack(">h", self.d[data+0x0e:data+0x10])[0]
        elif op == 10 and data:
            # ModelRoData_BoundingBoxRecord: the first word is the HITTARGET
            # part number chrTestHit returns when a ray crosses this box --
            # this is how GE knows a hit was the head and not the chest.
            self.hitparts[slot] = struct.unpack(">i", self.d[data:data+4])[0]
        if op == 18:
            # model.c modelApplyToggleRelations(): a switch is a toggle --
            #   visible -> node->Child = rodata->Controls  (that node and the
            #              siblings after it in the chain)
            #   hidden  -> node->Child = NULL
            # Switches[1] is the muzzle flash, hidden until the weapon fires.
            sw = 'fl' if (self.flash_node and addr == self.flash_node) else self.n_switches
            if sw != 'fl': self.n_switches += 1
            controls = self.off(self.u32(data)) if data else 0
            shown = controls or self.off(self.u32(addr+0x14))
            if shown:
                self.cur_switch = (sw, 0)
                self.node(shown, t, slot)
                self.cur_switch = -1
            nxt2 = self.off(self.u32(addr+0x0c))
            if nxt2: self.node(nxt2, translate, slot_in)
            return
        if op == 1 and data:      # header record (characters): tree at Data->FirstGroup
            grp = self.off(self.u32(data+4))
            if grp: self.node(grp, t, slot)
        elif op in (2, 21) and data:   # group: transform lives in the matrix table
            pass
        elif op == 4 and data:    # display list (guns)
            pri, sec = self.u32(data), self.u32(data+4)
            # ModelRoData_DisplayListRecord.ModelType (0x12): 3 = GunLighting,
            # 4 = fog/lighting -- those records light from vertex NORMALS stored in
            # the colour slots. 0-2 are prelit and the slots are real colours.
            # Records of both kinds appear in one model (the sniper's wood is lit,
            # its body prelit), so this must be per-record, not per-model.
            lit = self.d[data+18] in (3, 4)
            for is_sec, gdl in enumerate((pri, sec)):
                if not gdl: continue
                self.cur_sec = bool(is_sec)
                self.run_dl(self.off(gdl), self.off(self.u32(data+12)), translate, lit=lit)
            self.cur_sec = False
        elif op == 24 and data:   # display list with collision table (props/chars)
            pri, sec = self.u32(data), self.u32(data+4)
            mtype = struct.unpack(">h", self.d[data+0x18:data+0x1a])[0]
            lit = mtype in (3, 4)
            for is_sec, gdl in enumerate((pri, sec)):
                if not gdl: continue
                self.cur_sec = bool(is_sec)
                self.run_dl(self.off(gdl), self.off(self.u32(data+8)), translate, lit=lit)
            self.cur_sec = False
        elif op == 22 and data:   # primary-only display list
            gdl = self.u32(data+8)
            if gdl: self.run_dl(self.off(gdl), self.off(self.u32(data+4)), translate)
        elif op == 12 and data:   # gunfire (muzzle flash)
            vals = struct.unpack(">7f", self.d[data:data+28])
            img = self.u32(data+24)
            self.gunfire = {"offset": vals[0:3], "size": vals[3:6],
                            "scale": struct.unpack(">f", self.d[data+0x1c:data+0x20])[0]}
        if child: self.node(child, t, slot)
        if isinstance(self.cur_switch, tuple):
            sw, j = self.cur_switch
            if nxt:
                self.cur_switch = (sw, j + 1)
                self.node(nxt, translate, slot_in)
                self.cur_switch = (sw, j)
            return
        if nxt: self.node(nxt, translate, slot_in)

    def overlay_faces(self):
        """Faces drawn coplanar over an earlier face of another material.

        GE layers coplanar detail (the sniper scope's lens glint over its dark
        lens disc) purely by display-list order. A z-buffered renderer needs
        them marked so it can bias them forward; unmarked they shimmer.
        Returns a set of face indices.
        """
        def plane(f):
            a, b, c = self.verts[f[0]], self.verts[f[1]], self.verts[f[2]]
            ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
            wx, wy, wz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
            nx, ny, nz = uy*wz-uz*wy, uz*wx-ux*wz, ux*wy-uy*wx
            ln = (nx*nx+ny*ny+nz*nz) ** 0.5
            if ln < 1e-9: return None
            nx, ny, nz = nx/ln, ny/ln, nz/ln
            d = nx*a[0] + ny*a[1] + nz*a[2]
            if nz < 0 or (nz == 0 and (ny < 0 or (ny == 0 and nx < 0))):
                nx, ny, nz, d = -nx, -ny, -nz, -d
            return (round(nx, 2), round(ny, 2), round(nz, 2), round(d, 0))
        seen = {}
        out = set()
        for i, f in enumerate(self.faces):
            pl = plane(f)
            if pl is None: continue
            first = seen.setdefault(pl, f[3])
            if first != f[3]:
                out.add(i)
        return out

    def export_skin(self, path):
        """A poseable copy of the mesh: geometry in bone space, plus the tree.

        The OBJ keeps its baked rest positions for the existing consumers, but a
        skinned renderer needs three things the OBJ cannot carry -- which matrix
        slot each vertex belongs to, how the slots nest, and the vertex position
        in that slot's own frame. Bone-local position is the baked position
        minus the slot's accumulated origin, which is exactly what the rest
        layout adds, so it is computed here rather than at load time.
        """
        used = sorted(set(self.vmtx))
        tree = {}
        for m in used:
            tree[m] = self.tree.get(m, {"origin": [0.0, 0.0, 0.0], "parent": -1,
                                        "joint": 0, "half": 0})
        pending = [tree[m]["parent"] for m in used]
        while pending:                      # keep the chain complete to the root
            m = pending.pop()
            if m < 0 or m in tree: continue
            e = self.tree.get(m, {"origin": [0.0, 0.0, 0.0], "parent": -1,
                                  "joint": 0, "half": 0})
            tree[m] = e
            pending.append(e["parent"])

        pos, col = [], []
        for i, v in enumerate(self.verts):
            a = self.mtx.get(self.vmtx[i], (0.0, 0.0, 0.0))
            pos += [round(v[0] - a[0], 2), round(v[1] - a[1], 2), round(v[2] - a[2], 2)]
            r, g, b = (1.0, 1.0, 1.0) if self.lit[i] else self.attrs[i]
            col += [round(r, 3), round(g, 3), round(b, 3)]
        # normals, same rebuild rules as the OBJ writer (degenerates from faces)
        geo = [[0.0, 0.0, 0.0] for _ in self.verts]
        for a2, b2, c2, *_r in self.faces:
            pa, pb, pc = self.verts[a2], self.verts[b2], self.verts[c2]
            ux, uy, uz = pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]
            wx, wy, wz = pc[0]-pa[0], pc[1]-pa[1], pc[2]-pa[2]
            fx, fy, fz = uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx
            for vi in (a2, b2, c2):
                geo[vi][0] += fx; geo[vi][1] += fy; geo[vi][2] += fz
        nrm = []
        for i in range(len(self.verts)):
            nx, ny, nz = self.attrs[i] if self.lit[i] else (0.0, 0.0, 0.0)
            if abs(nx) + abs(ny) + abs(nz) < 1e-6:
                nx, ny, nz = geo[i]
                ln = (nx*nx + ny*ny + nz*nz) ** 0.5
                nx, ny, nz = (0.0, 1.0, 0.0) if ln < 1e-9 else (nx/ln, ny/ln, nz/ln)
            nrm += [round(nx, 3), round(ny, 3), round(nz, 3)]
        uv = []
        for u in self.uvs: uv += [round(u[0], 4), round(u[1], 4)]

        def mat(tid, sw, lit, env, sec, ds, ovl=False):
            base = f"tex_{tid}"
            if isinstance(sw, tuple):
                base += (f"_fl{sw[1]}" if sw[0] == 'fl' else f"_sw{sw[0]}_{sw[1]}")
            return (base + ("_lit" if lit else "") + ("_env" if env else "")
                    + ("_sec" if sec else "") + ("_ds" if ds else "")
                    + ("_ovl" if ovl else ""))
        ovl = self.overlay_faces()
        groups = {}
        for i, (a, b, c, tid, sw, lit, env, sec, ds) in enumerate(self.faces):
            groups.setdefault(mat(tid, sw, lit, env, sec, ds, i in ovl), []).extend((a, b, c))

        # Half-turn slots carry no bbox of their own; they take the part of
        # the full slot that reads the same joint (they are the same limb).
        hitparts = dict(self.hitparts)
        by_joint = {v["joint"]: hitparts[k] for k, v in tree.items()
                    if k in hitparts and not v["half"]}
        for k, v in tree.items():
            if k not in hitparts and v["joint"] in by_joint:
                hitparts[k] = by_joint[v["joint"]]
        json.dump({"matrices": {str(k): v for k, v in sorted(tree.items())},
                   "vertexMatrix": self.vmtx,
                   "position": pos, "uv": uv, "color": col, "normal": nrm,
                   "groups": groups,
                   # rest = the slot's translation with the gunfire.c runtime
                   # overrides applied -- group at rest + bone-space vertices
                   # reproduces the baked OBJ exactly
                   "rest": {str(k): [round(c, 2) for c in self.mtx.get(k, (0, 0, 0))]
                            for k in sorted(tree)},
                   "hitpart": {str(k): v for k, v in sorted(hitparts.items())}},
                  open(path + ".skin.json", "w"), separators=(",", ":"))

    def export_obj(self, path, name):
        def mat(tid, sw, lit, env, sec, ds):
            base = f"tex_{tid}"
            if isinstance(sw, tuple):
                base += (f"_fl{sw[1]}" if sw[0] == 'fl' else f"_sw{sw[0]}_{sw[1]}")
            return (base + ("_lit" if lit else "") + ("_env" if env else "")
                    + ("_sec" if sec else "") + ("_ds" if ds else ""))
        used = sorted(set((f[3], f[4], f[5], f[6], f[7], f[8]) for f in self.faces),
                      key=lambda x: (str(x[0]), str(x[1]), x[2], x[3], x[4], x[5]))
        with open(path + ".mtl", "w") as m:
            for tid, sw, lit, env, sec, ds in used:
                m.write(f"newmtl {mat(tid, sw, lit, env, sec, ds)}\n")
                png = self.texmap.get(tid)
                if png: m.write(f"map_Kd ../images/{png}\n")
                m.write("\n")
        with open(path + ".obj", "w") as f:
            f.write(f"mtllib {name}.mtl\n")
            for i, v in enumerate(self.verts):
                r, g, b = (1.0, 1.0, 1.0) if self.lit[i] else self.attrs[i]
                f.write(f"v {v[0]} {v[1]} {v[2]} {r:.3f} {g:.3f} {b:.3f}\n")
            for u in self.uvs: f.write(f"vt {u[0]:.4f} {u[1]:.4f}\n")
            # Some models store degenerate (0,0,0) vertex normals. Those normalize
            # to NaN in a shader and render pure black, so rebuild them from face
            # geometry (area-weighted) and fall back to +Y if still undefined.
            geo = [[0.0, 0.0, 0.0] for _ in self.verts]
            for a, b, c, *_rest in self.faces:
                pa, pb, pc = self.verts[a], self.verts[b], self.verts[c]
                ux, uy, uz = pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]
                wx, wy, wz = pc[0]-pa[0], pc[1]-pa[1], pc[2]-pa[2]
                fx, fy, fz = uy*wz - uz*wy, uz*wx - ux*wz, ux*wy - uy*wx
                for vi in (a, b, c):
                    geo[vi][0] += fx; geo[vi][1] += fy; geo[vi][2] += fz
            for i in range(len(self.verts)):
                nx, ny, nz = self.attrs[i] if self.lit[i] else (0.0, 0.0, 0.0)
                if abs(nx) + abs(ny) + abs(nz) < 1e-6:
                    nx, ny, nz = geo[i]
                    ln = (nx*nx + ny*ny + nz*nz) ** 0.5
                    if ln < 1e-9:
                        nx, ny, nz = 0.0, 1.0, 0.0
                    else:
                        nx, ny, nz = nx/ln, ny/ln, nz/ln
                f.write(f"vn {nx:.3f} {ny:.3f} {nz:.3f}\n")
            last = object()
            for a, b, c, tid, sw, lit, env, sec, ds in self.faces:
                key = (tid, sw, lit, env, sec, ds)
                if key != last:
                    f.write(f"usemtl {mat(tid, sw, lit, env, sec, ds)}\n"); last = key
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
            dec.override_runtime_matrices()
            dec.node(root, (0.0, 0.0, 0.0))
        except (struct.error, IndexError, RecursionError):
            failed.append(name); continue
        if not dec.faces:
            failed.append(name); continue
        dec.export_obj(os.path.join(OUT, name), name)
        # every model gets the sidecar: single-slot guns (sniper rifle, rocket
        # launcher) still need it now that the gun renderer builds from it
        if dec.vmtx:
            dec.export_skin(os.path.join(OUT, name))
        switches = {}
        for f in dec.faces:
            if isinstance(f[4], tuple):
                switches.setdefault(f"{f[4][0]}_{f[4][1]}", set()).add(f[3])
        has_flash = any(isinstance(f[4], tuple) and f[4][0] == 'fl' for f in dec.faces)
        movers = {}
        for idx, label in ((4, "cylinder"), (5, "hammer"), (6, "slide"), (7, "bolt")):
            if idx >= len(dec.switches): break
            node = dec.switches[idx]
            if not node or node + 8 > len(dec.d): continue
            ndata = dec.off(dec.u32(node + 4))
            if not ndata or ndata + 0x10 > len(dec.d): continue
            m0 = struct.unpack(">h", dec.d[ndata+0x0e:ndata+0x10])[0]
            if m0 >= 0: movers[label] = m0
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
                          "movers": movers,
                          "source": "decomp" if name in info else "heuristic"}
        if dec.gunfire: manifest[name]["muzzle_flash"] = dec.gunfire
    json.dump(manifest, open(os.path.join(OUT, "MODELS.json"), "w"), indent=1)
    print(f"exported {len(manifest)} models -> {OUT}/ ; {len(failed)} failed/empty")
    if failed: print("  failed:", " ".join(failed[:20]), "..." if len(failed) > 20 else "")

if __name__ == "__main__":
    main()
