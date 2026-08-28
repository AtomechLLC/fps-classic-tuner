# GoldenEye 007 — asset pipeline & shooting gallery

Reverse-engineered asset extraction from the GoldenEye 007 (USA) N64 ROM, plus a
browser shooting range for testing every weapon with its real stats, models and
sounds. Format knowledge is grounded in the
[n64decomp/007](https://github.com/n64decomp/007) decompilation — the ROM is the
source of all data, the decomp supplies the struct layouts and semantics.

## Pipeline (run in order)

```bash
python unpack_rom.py        # 1172 blocks + file table  -> extracted/files/
python decode_images.py     # all 2698 textures         -> extracted/images/
python add_image_colors.py  # per-texture average RGBA   (annotates IMAGES.json)
python extract_models.py    # OBJ+MTL, 510 models       -> extracted/models/
python extract_sounds.py    # 261 SFX as WAV            -> extracted/sounds/
python extract_weapons.py   # ballistics/rates/VFX      -> extracted/weapons/
python decode_setups.py     # stage setups              -> extracted/setups/
python extract_characters.py # heads, hats, skeletons, roster -> extracted/characters/
python extract_animations.py # skeletal animations      -> extracted/animations/
python render_music.py 2    # a music track as WAV      -> extracted/music/
```

Scripts read the ROM at `GoldenEye 007 (USA)/GoldenEye 007 (USA).z64` and locate
the decomp via `GE_DECOMP` (defaults to a scratchpad clone).
`extract_textures.py` is the older record-level texture dump, superseded by
`decode_images.py`.

## Shooting gallery

```bash
python -m http.server 8613
```

Open `http://localhost:8613/gallery/`. WASD moves (GE-style: strafe+forward is
unnormalised, so diagonals run ~1.4× like the game), mouse aims (pointer lock), click/hold
fires, **R** or right-click reloads, **Z** (held) zooms scoped weapons, **Tab** / wheel / `[` `]` switches weapon, **M** toggles
music, **X** dual-wields any `CAN_DUAL_WIELD` weapon (mirrored left copy per
`MIRROR_DUAL`, pistols alternate hands per `DUAL_WIELD_ALTERNATING_FIRE`,
per-hand ammo bottom-right/bottom-left), **G** toggles the targets returning
fire (visual only — off by default),
**P** sends half the guards walking patrol loops (GE's own `walking` gaits, at
`chraction.c`'s 0.5× playback with movement matched to each gait's measured
planted-foot speed, so feet don't slide),
`-` / `=` set volume. Launching with `?mute` starts silent (used by automated
sessions); `=` brings the volume back.

Fire rates (60Hz ticks), spread, damage, magazine size, recoil and muzzle-flash
frames all come from ROM data; gunshots, ricochets and reloads are the decoded
SFX, and impact sounds vary by target material. The rest of the WeaponStats
drive behaviour too: recoil is gunfire.c's -- the gun (not the view) pitches to
`RecoilUp` degrees and pulls back ~`RecoilBack` cm on a quarter-sine rise and
half-cosine recovery whose tick counts are the top two bytes of `RecoilSpeed`;
`Zoom` is the right-mouse zoom (KF7 30°, AR33 20°, sniper 6.1–60° on the wheel);
`PenetrationObjects` lets a round pass through that many bodies (Ruger 10);
`SoundTriggerRate` gates the gunshot sample under full auto; `Sway` scales the
idle bob; the crosshair floats ahead of the turn, eases home at
`CrosshairSpeed`, and the weapon follows it by `GunPlay`; and firing while the
range is hot draws return fire sooner in proportion to the weapon's AI
loudness.

Targets are the guards the game actually places: identities come from the guard
records in the decoded stage setups, each wears the head and hat model GE would
give it, and each holds the `Pchr*` weapon model in its right hand — propobj.c
attaches that to the body's `Switches[3]` node, the joint-9 wrist, with identity
rotation. Armed guards periodically play GE's firing animations (`fire_standing`
/ `fire_hip`, `fire_standing_one_handed_weapon` for the officer's TT-33), light
the flash quad baked into the held model as a `_sw` switch, and send tracers
harmlessly past the player; hits play the `hit_*` flinch animations. Each guard
has `chr.c`'s `maxdamage` of **4.0** with
`handles_shot_actors`' body-part multipliers: head ×4, chest ×2, limbs ×1 — so a
PP7 kills in one head shot, two chest shots or four limb shots, and a Klobb head
shot (0.6 × 4 = 2.4) is *not* lethal. Which part a bullet struck comes from the
ROM itself: every body-part group in a character model carries an op-10 bounding
box whose first word is the `HITTARGET` part id, exported per matrix slot in
`.skin.json`. Hits on the held gun do nothing (a metal ping); a soft hat is
knocked flying and lies where it lands, a steel helmet ricochets, and the
moonraker helmet counts as the head — all per `handles_shot_actors`. Flinches
pick the animation for the side and limb that was struck. They grunt when hit
and thump when they fall, using GE's own `GET_HIT_*` and `BODY_FALL_*` samples.

The HUD's stat panel charts each weapon's ROM parameters as bars — damage,
fire rate, magazine, spread, recoil, kick, penetration and AI loudness —
normalised against the whole rack so a bar means the same thing on every
weapon (with big outliers like the Golden Gun's damage 100 clamped at full
rather than flattening the scale).

Two pieces of range instrumentation are deliberately *not* from the original
game: floating damage numbers (colour-coded by multiplier — red ×4, amber ×2,
white ×1, grey blocked), and an HP bar over a damaged guard that divides itself
into segments the size of the last hit taken, so the remaining full segments
read directly as hits-to-kill at that damage.

## Format notes (the non-obvious parts)

Things that cost real debugging time, recorded so they don't have to be
rediscovered:

**Models** (`extract_models.py`)
- Files have no header. `numSwitches`/`numtextures` come from the decomp's
  per-model `ModelFileHeader.inc.c`; a validity-scored heuristic covers the rest.
- Node opcodes carry flag bits in the high byte (`0x100`/`0x200` select extra
  matrix slots), so compare `opcode & 0xFF`.
- Part placement: display lists select a matrix with `G_MTX` (opcode `0x01`,
  segment 3, index = offset/64). Matrices are built like `model.c
  subcalcmatrices()`: `matrix[MatrixID0] = parent * translate(Group.Origin)`.
- `G_VTX` addresses vertices two ways: **segment 5** = absolute file offset,
  **segment 4** = offset relative to that record's own `Vertices` pointer.
  Missing the second form reads the texture table as vertex data.
- The RSP vertex buffer persists across nested display lists.
- Switch nodes (`opcode 18`) are toggles: `modelApplyToggleRelations()` shows the
  node `rodata->Controls` points at, and `modelInit` defaults them **visible**.
  Muzzle flash is the `gunfire` node, defaulting **hidden**; `gunfire.c` reaches
  it through header `Switches[1]`.
- Shiny weapons use `G_TEXTURE_GEN` (geometry mode `0x40000`), which derives UVs
  from the vertex normal rather than the stored s/t. Without it the Golden Gun
  samples the black edge of its gradient and renders black.
- Some models store degenerate `(0,0,0)` normals, which normalize to NaN and
  render pure black; the exporter rebuilds those from face geometry.
- Vertex colour slots hold a *normal* when the record's ModelType is 3 or 4
  (GunLighting / fog+lighting), and a prelit colour otherwise.
- GunLighting is a real diffuse pass, not decoration: the combiner multiplies
  TEXEL0 by SHADE from those normals, lit by `g_WeaponEnvmapLight` (gun.c) —
  ambient `0x96` grey, white diffuse from signed direction `(-78, 77, 46)`,
  over the player's left shoulder. The AR33's grey gradient (texture 2293) is a
  specular strip that only reads correctly under that light; shown flat it is a
  painted pale streak, and the barrel gloss in reference footage is this
  shading, not a texture effect.
- **Never normalise UVs at vertex-load time.** The RSP's vertex buffer
  persists across texture switches, so vertices loaded under a 32×32 texture
  are frequently drawn under 64×64 art. UVs are raw s10.5 texel coordinates,
  normalised per FACE against that face's texture at export (duplicating a
  vertex when differently-sized textures share it). Getting this wrong tiled
  the sniper eyepiece's single lens circle into repeating arcs.
- The texture command's w0 carries s/t sampling modes (0 wrap, 1 mirror, 2/3
  clamp), exported as a `_w<st>` material suffix. Mirrored art stores half a
  symmetric image; Repeat instead of MirroredRepeat cuts circles in half.
- Backface culling is data: the display lists set and clear `G_CULL_BACK`
  (`0x2000`) per record, and the exporter tags cull-cleared faces `_ds`.
  Forcing DoubleSide draws faces the game culls — harmless mostly, wrong when
  a view exposes an interior. A mirrored dual-wield copy must swap the cull
  side, since negative scale flips winding.
- The zoomed weapon stays at its hip position in GE. Centring a scoped rifle
  for an aim pose puts the camera dead behind the scope, a view the model was
  never authored for (its interior shows); only non-scoped weapons take the
  centred ADS pose.
- Coplanar detail is layered by **display-list order**: the sniper scope's
  dark cover draws over its white lens-glint disc in the same primary list.
  The exporter tags later coplanar faces `_ovl` and **lifts them 0.75 model
  units along the winding-derived face normal** — a real geometric separation,
  so plain depth testing reproduces the layering from every angle. Two failed
  approaches are worth recording: depth-bias (polygonOffset) is angle-fragile
  and cannot express pairwise order where three surfaces meet; and lifting
  along the *shading* normals pushes faces inside the body, because those are
  lighting data that oppose the winding on most of the sniper's check ring —
  winding is the outward authority (it is what the hardware culls by). The
  plane key for tagging must also be quantised coarsely and promoted per
  (material, plane), or float noise splits a quad's two triangles across the
  tag boundary. And the MTL must define every name the skin groups use —
  `_ovl` included: `MTLLoader.create` on a missing name silently yields an
  unmapped grey material, which rendered every overlay triangle untextured
  and mimicked a geometry bug convincingly enough to burn a day.
- A display-list record has **two** lists. `model.c` draws `Primary` opaque
  (`OPA_SURF`) and then `Secondary` translucent (`XLU_SURF`) — the struct calls
  these "secondary surfaces". They are decals lying exactly on the skin: 12 of
  the rocket launcher's 20 secondary triangles are coplanar with a primary
  face to within 0.00 units. Drawing them opaque z-fights, which is what made
  the launcher's lettering flicker. The exporter tags them `_sec`.

**First-person view** (`gallery/app.js`)
- FOV is **60°** vertical (`fr.h: FOV_Y_F`). `player.c` initialises
  `c_perspfovy` to 46, but level setup immediately calls
  `set_cur_player_fovy(FOV_Y_F)` and the zoom system drives it from 60 (hip) down
  to 6.1 (max sniper zoom) — 46 is never what you play at. Taking the initialiser
  at face value made every weapon render ~50% too large.
- Weapon placement is **entirely ROM-derived, with nothing fitted per weapon**.
  `gunfire.c` builds the weapon matrix in camera space: the basis is the camera
  basis scaled by `IDO_POINT_ONE` (0.1, uniform — `matrix_scalar_multiply` hits
  all twelve basis elements), and the position is the WeaponStats
  `PosX/PosY/PosZ`. So one model unit is 0.1 GE units, and **a GE unit is a
  centimetre**: the KF7 measures 853 model units end to end (85.3 cm against a
  real 87 cm), the shotgun 74.8 and the sniper rifle 109.2. Relative sizes on
  screen are therefore authentic — the KF7 at `PosZ = -16` dominates, the PP7 at
  `-33.5` looks small.
- Weapons point along model **+z**; the flash matrix sits at the model's z
  maximum on every gun (DD44 298/298, PP7 201/201, sniper 804/804).
- First-person guns are built from the `.skin.json` as one mesh per matrix
  slot, each at its gunfire.c rest position, so the moving parts are separate
  objects. The manifest's `movers` records which slot is the cylinder, hammer,
  slide and bolt (header `Switches[4..7]`); firing throws the slide/bolt back
  by the WeaponStats `BoltRecoilBack` (PP7 30 units, TT-33 60) and returns it,
  a revolver advances its cylinder a sixth turn and drops the hammer, and
  reloading pulls the weapon down out of view and back, GE-style.
- The weapon pass uses GE's own near plane, `c_perspnear = 10` units = 0.10 m.
  Shoulder-fired weapons are authored with their stock behind the eye (the
  rocket launcher by 39 cm, the M16 by 9 cm) and the game simply clips it.
  Pulling the near plane closer to "show more" instead renders that stock
  centimetres from the lens, where it smears across half the screen.
- Validated against `reference/ge_ref_TEST_DD44.jpg`: at 854×480 the DD44's
  muzzle lands within 8 px horizontally and 4 px vertically of the real frame.
- `window.__P` nudges placement live (`scale`/`pos` multiply the ROM values;
  `__repose()` re-applies); `window.__inspect(key, view, size, flat)` and
  `window.__sheet([keys])` render models in isolation.

**Characters and animation** (`extract_characters.py`, `extract_animations.py`)
- Character **bodies have no rest pose**: `process_02_position` in model.c
  decodes a 3-axis rotation per joint from the animation bitstream and only then
  builds the matrix, so with no rotation the limbs stay on their local +x and
  splay to four times the figure's height (a guard 681 units tall spans 2167
  across). The animation is not optional decoration; it *is* the pose.
- The joint matrix is `parent * translate(Origin) * rotate(anim)`, and
  `matrix_4x4_set_rotation_around_xyz` composes Rz*Ry*Rx — three.js Euler
  order `'ZYX'`. `extract_models.py` writes a `.skin.json` beside each model
  giving the matrix-slot tree and each vertex's slot, with positions already in
  bone space.
- A group's `0x100`/`0x200` opcode flags give it extra matrix slots at the same
  origin; `modelBuildGroupMatrices` drives those with the **quaternion** halved,
  not the angles.
- **Animation layout**: ge007.ld places `animation_data` immediately after
  `animation_entries`, so the data blob's start is the entries segment's end,
  and the segment's own start falls out of the furthest frame any animation
  reads. A ModelAnimation gives frame count, a bit width and bits-per-frame;
  `loadAnimationFrame` reads frame N at `address + N * (bits >> 3)`. Within a
  frame, joint J reads three consecutive values at index `Joints[J].mtxA`
  (`mtxB` for the mirrored copy, where y and z are negated).
- Guard idle is nearly static by design — about 4° of sway at the neck and
  ankles over 163 frames — so "the bones aren't moving" is not a symptom.
- Animations carry a second bit-packed stream (header `unk08`/`unk10` →
  descriptor table + stream, `unk0C` bits per frame): the root joint's
  **absolute hip position** and yaw. Idle-style animations point at a shared
  all-zero descriptor block. The walk cycles animate **in place** — their root
  x/z barely move — so ground speed is not in the animation; it belongs to the
  actor code. `chraction.c` plays guard walks at 0.5×, and the ground speed
  that keeps the planted foot pinned is measured from the posed skeleton:
  2.19 m/s at 1.0× for `walking` (1.10 at GE's rate).
- `Box3.setFromObject` ignores skinning and returns bind-pose bounds, which
  stands every character waist-deep in the floor; walk the vertices through
  `SkinnedMesh.applyBoneTransform` instead.
- Raycasting a SkinnedMesh **is** pose-aware in three r160, but its early-out
  test uses the geometry's bounding sphere, computed from the raw bone-space
  positions — a small blob near the origin. Rays missing the blob are rejected
  before the triangle test, making posed guards randomly bulletproof; give the
  geometry a bounding sphere that covers every reachable pose.
- `headHat_array_8003E464` (chr.c) seats a hat on a head: an offset in units of
  21.3 and a per-axis scale, indexed `[head][HATTYPE]`. A peaked cap also sets
  `headVisible = 0`.
- The `BODIES`/`HEADS` enums contain three `#ifdef ALL_BONDS` members
  (Connery/Dalton/Moore tuxedos) that the retail ROM does **not** build — it
  ships no model for any of them. Parsing the enum without stripping that block
  shifts every id from 6 upward by three, which labelled Natalya's escort in
  Archives/Bunker/Train as "Jaws", a character who is not in the game.
- A setup guard's `health` field is not health: `chraction.c` assigns it to
  `hearingscale` as `health / 1000`.
- Hit locations are data, not code: each body-part group carries an op-10
  bounding-box node whose **first word is the `HITTARGET` part id** —
  `chrTestHit` returns it when a ray crosses the box. A group's own bbox is a
  *sibling* of its child groups in the node chain, so when walking, siblings
  inherit the slot the node was entered with (attributing them to the child
  group shifts every part one joint down the limb).

**Textures** (`decode_images.py`)
- `g_Textures` (code segment, RAM `0x80049300`) holds 24-bit compressed sizes;
  offsets are prefix sums from segment base `0x8f7df0`.
- Rare's own codecs: huffman, RLE, lookup tables, 7 blur predictors, plus a
  zlib/1172 path. 1×1 textures are flat colours used with texture-gen.

**Audio**
- SFX: ALBankFile ctl at `0x2ebde0`, tbl at `0x2f1990`, VADPCM, 22050 Hz.
  Weapon `Sound` is a direct index into this bank.
- Music: 63-track `RareALSeqBankFile` at `0x419790`, 1172-compressed compressed-MIDI.

## Known gaps

- **Animation cross-fades between different animations aren't implemented.**
  Frame-to-frame interpolation is (a per-joint quaternion slerp between the two
  neighbouring frames, as `model.c` does), but GE also blends two *animations*
  during transitions (`anim2` and the `unk84` slerp); the range switches
  animations with a hard cut.
  The `MatrixID2` bend/stretch (a y-only half turn with a scale from
  `modelGetBendStretchScale`) is also skipped — no character model in the range
  uses it.
- **Level geometry** (`bg/*.seg`) isn't decoded; those files use a different
  container.
- Grenades, mines and throwing knives aren't simulated in the range.
