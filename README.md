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

Open `http://localhost:8613/gallery/`. Mouse aims (pointer lock), click/hold
fires, **R** reloads, **Tab** / wheel / `[` `]` switches weapon, **M** toggles
music, **G** toggles the targets returning fire (visual only — off by default),
`-` / `=` set volume.

Fire rates (60Hz ticks), spread, damage, magazine size, recoil and muzzle-flash
frames all come from ROM data; gunshots, ricochets and reloads are the decoded
SFX, and impact sounds vary by target material.

Targets are the guards the game actually places: identities come from the guard
records in the decoded stage setups, each wears the head and hat model GE would
give it, and each holds the `Pchr*` weapon model in its right hand — propobj.c
attaches that to the body's `Switches[3]` node, the joint-9 wrist, with identity
rotation. Armed guards periodically play GE's firing animations (`fire_standing`
/ `fire_hip`, `fire_standing_one_handed_weapon` for the officer's TT-33), light
the flash quad baked into the held model as a `_sw` switch, and send tracers
harmlessly past the player; hits play the `hit_*` flinch animations. Each guard
has `chr.c`'s `maxdamage` of **4.0** — so the WeaponStats
damage figures give the real number of hits (four PP7 body shots, one Golden Gun
round), and a head hit drops a guard outright. They grunt when hit and thump
when they fall, using GE's own `GET_HIT_*` and `BODY_FALL_*` samples.

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
