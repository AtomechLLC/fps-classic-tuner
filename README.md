# GoldenEye 007 — asset pipeline & shooting gallery

Reverse-engineered asset extraction from the GoldenEye 007 (USA) N64 ROM,
plus a browser shooting gallery for testing every weapon with authentic
stats, models, and sounds. Format knowledge is grounded in the
[n64decomp/007](https://github.com/n64decomp/007) decompilation.

## Pipeline (run in order)

```
python unpack_rom.py        # 1172 blocks + file table -> extracted/files/
python decode_images.py     # all 2698 textures -> extracted/images/  (+hit materials)
python extract_models.py    # OBJ+MTL: 92 guns, 339 props, 79 chars -> extracted/models/
python extract_sounds.py    # 261 SFX -> extracted/sounds/*.wav
python extract_weapons.py   # ballistics/rates/recoil/VFX -> extracted/weapons/
python decode_setups.py     # stage setups (guards, objectives, pads) -> extracted/setups/
```

`extract_textures.py` is the older record-level texture dump (superseded by
`decode_images.py`). Scripts expect the decomp clone path in `GE_DECOMP`
(defaults to the session scratchpad clone) and the ROM at
`GoldenEye 007 (USA)/GoldenEye 007 (USA).z64`.

## Shooting gallery

```
python -m http.server 8613
# open http://localhost:8613/gallery/
```

21 weapons on the rack. Mouse aims (pointer lock), click/hold fires, R
reloads, wheel or [ ] switches weapon. Fire rate (60Hz ticks), spread,
damage, mag size, recoil, and the muzzle-flash frames all come straight
from the ROM data; gunshots are the real decoded SFX, and impact sounds
vary by target material.
