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
music, `-` / `=` set volume.

Fire rates (60Hz ticks), spread, damage, magazine size, recoil and muzzle-flash
frames all come from ROM data; gunshots, ricochets and reloads are the decoded
SFX, and impact sounds vary by target material.

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

**First-person view** (`gallery/app.js`)
- FOV is **46°** vertical (`player.c: c_perspfovy = 46.0f`). GE renders 4:3, so
  other aspect ratios preserve the horizontal field instead of stretching.
- The weapon matrix is the camera matrix scaled by **0.1**
  (`gunfire.c`, `IDO_POINT_ONE`) translated to the WeaponStats `PosX/PosY/PosZ`,
  identity rotation. Relative weapon sizes on screen are authentic: the KF7 sits
  at `PosZ = -16` and dominates, the PP7 at `-33.5` and looks small.
- `window.__P` nudges placement live (`__repose()` re-applies); `window.__inspect(key,
  view, size, flat)` and `window.__sheet([keys])` render models in isolation.

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

- **Characters don't pose.** Their per-joint matrices come from the skeletal
  animation system (`ANIM_ENTRY_*` compressed bitstreams), which isn't ported, so
  character models sit at bind positions. Weapons and props are correct at rest.
- **Level geometry** (`bg/*.seg`) isn't decoded; those files use a different
  container.
- Grenades, mines and throwing knives aren't simulated in the range.
