import * as THREE from 'three';
import { OBJLoader } from './lib/OBJLoader.js';
import { MTLLoader } from './lib/MTLLoader.js';

const EX = '../extracted';
// Tuning knobs over the ROM-derived placement; all neutral by default.
// `scale` and `pos` multiply the authentic model scale and screen offset.
window.__P = { scale: 1, pos: 1, rx: 0, ry: 0, rz: 0, near: 0.10 };
// Aim solved geometrically: the barrel axis is set nearly parallel to the
// view axis with a slight inward convergence, so perspective carries it
// onto the crosshair. A weapon aimed at a distant point is almost parallel
// to your line of sight -- the large yaw I had before was a stylistic
// angle that pushed the muzzle off to one side.

// ---- display names (canonical GE names) ----
const DISPLAY = {
  wppk: 'PP7 Special Issue', wppksil: 'PP7 (Silenced)', tt33: 'DD44 Dostovei',
  skorpion: 'Klobb', ak47: 'KF7 Soviet', uzi: 'ZMG (9mm)', mp5k: 'D5K Deutsche',
  mp5ksil: 'Silenced D5K', spectre: 'Phantom', m16: 'AR33 Assault Rifle',
  fnp90: 'RC-P90', shotgun: 'Shotgun', autoshot: 'Automatic Shotgun',
  sniperrifle: 'Sniper Rifle', ruger: 'Cougar Magnum', goldengun: 'Golden Gun',
  silverwppk: 'Silver PP7', goldwppk: 'Gold PP7', laser: 'Moonraker Laser',
  grenadelaunch: 'Grenade Launcher', rocketlaunch: 'Rocket Launcher',
  throwknife: 'Throwing Knife', grenade: 'Hand Grenade', timedmine: 'Timed Mine',
  proximitymine: 'Proximity Mine', remotemine: 'Remote Mine', taser: 'Taser',
  watchlaser: 'Watch Laser', flarepistol: 'Flare Pistol', pitongun: 'Piton Gun',
};
// weapons worth putting on the rack, in GE order
const ROSTER = ['wppk','wppksil','tt33','skorpion','ak47','uzi','mp5k','mp5ksil',
  'spectre','m16','fnp90','shotgun','autoshot','sniperrifle','ruger','goldengun',
  'silverwppk','goldwppk','laser','grenadelaunch','rocketlaunch'];

// ---- data ----
// cache: 'no-cache' revalidates against the extractor outputs -- a stale
// cached index otherwise survives page reloads and 404s new animations.
const [WEAPONS, MODELS, SOUNDS, IMAGES, CHARS, ANIMS] = await Promise.all([
  fetch(`${EX}/weapons/WEAPONS.json`, { cache: 'no-cache' }).then(r => r.json()),
  fetch(`${EX}/models/MODELS.json`, { cache: 'no-cache' }).then(r => r.json()),
  fetch(`${EX}/sounds/SOUNDS.json`, { cache: 'no-cache' }).then(r => r.json()),
  fetch(`${EX}/images/IMAGES.json`, { cache: 'no-cache' }).then(r => r.json()),
  fetch(`${EX}/characters/CHARACTERS.json`, { cache: 'no-cache' }).then(r => r.json()),
  fetch(`${EX}/animations/ANIMATIONS.json`, { cache: 'no-cache' }).then(r => r.json()),
]);
const soundById = i => SOUNDS[i] && `${EX}/sounds/${SOUNDS[i].file}`;
const soundByName = n => { const e = SOUNDS.find(s => s.name === n); return e && `${EX}/sounds/${e.file}`; };
const RICO = SOUNDS.filter(s => /^RICO_/.test(s.name)).map(s => `${EX}/sounds/${s.file}`);

// ---- audio ----
const actx = new (window.AudioContext || window.webkitAudioContext)();
const master = actx.createGain();
// ?mute silences everything from launch -- used by automated/Claude sessions so
// test volleys don't play out loud. = raises the volume again if wanted.
const MUTED = new URLSearchParams(location.search).has('mute');
// ?level=dam loads real mission geometry instead of the practice range
const LEVEL = new URLSearchParams(location.search).get('level') || 'range';
master.gain.value = MUTED ? 0 : 0.30;     // master volume (- / = keys)
master.connect(actx.destination);
const bufCache = new Map();
// background music (rendered from the ROM's own sequence + instrument bank)
const music = { gain: actx.createGain(), src: null, on: true, started: false };
music.gain.gain.value = 0.42;
music.gain.connect(master);
async function startMusic() {
  if (music.started) return;
  music.started = true;
  try {
    // GoldenEye title theme cover (Brandon Wiebe OST remake); fallbacks after
    let buf = await loadBuf('../extracted/music/goldeneye_theme_cover.mp3');
    if (!buf) buf = await loadBuf('../extracted/music/facility_hacker_remix.mp3');
    if (!buf) buf = await loadBuf('../extracted/music/track02.wav');
    if (!buf) { music.started = false; return; }
    const src = actx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(music.gain);
    src.start();
    music.src = src;
  } catch (e) { music.started = false; }
}
function toggleMusic() {
  music.on = !music.on;
  music.gain.gain.value = music.on ? 0.42 : 0;
}
async function loadBuf(url) {
  if (!url) return null;
  if (!bufCache.has(url)) {
    bufCache.set(url, fetch(url, { cache: 'no-cache' }).then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b)).catch(() => null));
  }
  return bufCache.get(url);
}
function play(url, { vol = 1, pitch = 1, at = null, delay = 0 } = {}) {
  loadBuf(url).then(buf => {
    if (!buf) return;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    let v = vol;
    if (at) {                              // distance attenuation
      const d = cam.position.distanceTo(at);
      v *= Math.min(1, 9 / Math.max(d, 1));
    }
    const g = actx.createGain(); g.gain.value = v;
    src.connect(g); g.connect(master);
    src.start(actx.currentTime + delay);
  });
}

// ---- renderer / scene ----
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d12);
scene.fog = new THREE.Fog(0x0a0d12, 60, 160);
// fr.h: FOV_Y_F = 60. player.c initialises c_perspfovy to 46, but level setup
// immediately calls set_cur_player_fovy(FOV_Y_F) and the zoom system drives it
// from 60 (hip) down to 6.1 (max sniper zoom), so 60 is what you actually play at.
const GE_FOVY = 60;
const cam = new THREE.PerspectiveCamera(GE_FOVY, 1, 0.05, 400);
cam.position.set(0, 1.6, 0);
// Separate pass so the weapon is never clipped by world geometry. The near
// plane is GE's own c_perspnear = 10 units = 0.10 m: shoulder-fired weapons
// (rocket launcher, M16, sniper rifle) are authored with their stock behind
// the eye, and the game simply clips it. Pulling the near plane closer to
// 'show more' instead renders that stock centimetres from the lens, where it
// projects across half the screen.
const gunCam = new THREE.PerspectiveCamera(GE_FOVY, 1, 0.10, 60);

scene.add(new THREE.HemisphereLight(0xcfd8e8, 0x30302a, 1.15));
// some GE prop faces have inward normals; ambient keeps them from going pure black
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xfff2d9, 1.3);
sun.position.set(-14, 22, -8);
scene.add(sun);

const texLoader = new THREE.TextureLoader();
function geTex(id, rep = 1) {
  const e = IMAGES[id];
  const t = texLoader.load(`${EX}/images/${e.png}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rep, rep);
  return t;
}

// ---- the range ----
const RANGE_L = 120, RANGE_W = 26, WALL_H = 7;
function buildRange() {
  // lane dividers at the firing line
  for (const x of [-4, 4]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.3, 3),
      new THREE.MeshLambertMaterial({ color: 0x3a4048 }));
    d.position.set(x, 0.65, -1.5);
    scene.add(d);
  }
  buildRangeBackdrop();
}

/** The range lives on the Runway's tarmac instead of a generic grey box: the
 *  level geometry shifts so the firing line sits at the range origin and the
 *  lanes run down the airstrip (flat at world y -6.59 for well over 120 m). */
const RANGE_BG = { rooms: [] };
async function buildRangeBackdrop() {
  try {
    const { obj, rooms } = await loadLevelGeometry('run');
    // firing line at world (92, -6.59, -105): past the threshold trench, with
    // the full flat strip ahead and the hangar apron behind the shooter
    obj.position.set(-92, 6.59, 105);
    scene.add(obj);
    obj.updateMatrixWorld(true);
    for (const r of rooms) r.userData.bbox = new THREE.Box3().setFromObject(r);
    RANGE_BG.rooms = rooms;
    // bgfog.c LEVELID_RUNWAY: fog colour (0x10,0x30,0x40) -- the airstrip's
    // teal night -- NearFog 6000 / FarFog 15000 at visibility 1.0 = 60..150 m
    scene.background = new THREE.Color(0x103040);
    scene.fog = new THREE.Fog(0x103040, 60, 150);
    cam.far = 400; cam.updateProjectionMatrix();
  } catch (e) {
    console.log('backdrop failed, building the plain box', e);
    buildRangeBox();
  }
}

/** The original enclosed range, kept as the fallback if the level assets are missing. */
function buildRangeBox() {
  const floorT = geTex(20, 24);    // GRAVELGREY
  const wallT = geTex(85, 16);     // DARK_CONCRETE_WALL
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(RANGE_W, RANGE_L),
    new THREE.MeshLambertMaterial({ map: floorT }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -RANGE_L / 2 + 6);
  scene.add(floor);
  const wallMat = new THREE.MeshLambertMaterial({ map: wallT });
  const mkWall = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z); m.rotation.y = ry; scene.add(m);
  };
  mkWall(RANGE_W, WALL_H, 0, WALL_H/2, -RANGE_L + 6, 0);            // far wall
  mkWall(RANGE_W, WALL_H, 0, WALL_H/2, 6, Math.PI);                 // behind player
  mkWall(RANGE_L, WALL_H, -RANGE_W/2, WALL_H/2, -RANGE_L/2 + 6, Math.PI/2);
  mkWall(RANGE_L, WALL_H,  RANGE_W/2, WALL_H/2, -RANGE_L/2 + 6, -Math.PI/2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RANGE_W, RANGE_L),
    new THREE.MeshLambertMaterial({ color: 0x23262c }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, WALL_H, -RANGE_L / 2 + 6);
  scene.add(ceil);
}


/** The material rules for GE props and characters, shared so a skinned body
 *  and a static prop are shaded identically. `skinning` needs no flag in three
 *  r150+; the SkinnedMesh drives it. */
// N64 s/t sampling modes from the texture command, encoded in the material
// name as _w<state><t>: 0 wrap, 1 mirror, 2/3 clamp. Mirrored art stores half a
// symmetric image; Repeat instead of MirroredRepeat cuts circles in half.
const WRAP_MODES = [THREE.RepeatWrapping, THREE.MirroredRepeatWrapping,
                    THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping];
function applyWrap(map, name) {
  const wm = name.match(/_w(\d)(\d)/);
  const ws = wm ? WRAP_MODES[+wm[1]] : THREE.RepeatWrapping;
  const wt = wm ? WRAP_MODES[+wm[2]] : THREE.RepeatWrapping;
  let m2 = map;
  if (ws !== THREE.RepeatWrapping || wt !== THREE.RepeatWrapping) {
    m2 = map.clone(); m2.needsUpdate = true;   // wrap is per-usage, texture is shared
  }
  m2.magFilter = THREE.NearestFilter; m2.colorSpace = THREE.SRGBColorSpace;
  m2.wrapS = ws; m2.wrapT = wt;
  return m2;
}

function geMaterial(m, name = m.name) {
  const map = m.map ? applyWrap(m.map, name) : null;
  const lit = /_lit(_|$)/.test(name);
  const side = /_ds(_|$)/.test(name) ? THREE.DoubleSide : THREE.FrontSide;
  const nm = lit
    ? new THREE.MeshLambertMaterial({ map, side })
    : new THREE.MeshBasicMaterial({ map, side, vertexColors: true });
  if (map) nm.alphaTest = 0.35;
  if (/_sec(_|$)/.test(name)) {    // Secondary display list: decals on the skin
    nm.transparent = true; nm.depthWrite = false;
    nm.polygonOffset = true; nm.polygonOffsetFactor = -2; nm.polygonOffsetUnits = -2;
  }
  nm.name = name;
  return nm;
}

// ---- GE prop models as range furniture/targets ----
const propCache = new Map();
async function loadProp(modelName) {
  if (propCache.has(modelName)) return propCache.get(modelName);
  const p = (async () => {
    const ml = new MTLLoader().setPath(`${EX}/models/`);
    const mtl = await ml.loadAsync(`${modelName}.mtl`);
    mtl.preload();
    const ol = new OBJLoader().setMaterials(mtl).setPath(`${EX}/models/`);
    const obj = await ol.loadAsync(`${modelName}.obj`);
    obj.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map(m => geMaterial(m));
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    return obj;
  })();
  propCache.set(modelName, p);
  return p;
}

/** Place a prop at (x,z), scaled so it stands `height` metres tall, base on the floor. */
async function placeProp(modelName, x, z, height, opts = {}) {
  const src = await loadProp(modelName);
  const inst = src.clone(true);
  const bb = new THREE.Box3().setFromObject(inst);
  const sz = bb.getSize(new THREE.Vector3());
  const sc = height / Math.max(sz.y, 1e-3);
  inst.scale.setScalar(sc);
  const bb2 = new THREE.Box3().setFromObject(inst);
  const ctr = bb2.getCenter(new THREE.Vector3());
  const g = new THREE.Group();
  inst.position.set(-ctr.x, -bb2.min.y, -ctr.z);
  if (opts.ry) inst.rotation.y = opts.ry;
  g.add(inst);
  g.position.set(x, 0, z);
  g.userData = {
    hp: opts.hp ?? Infinity, maxhp: opts.hp ?? Infinity,
    hit: opts.hit || 'metal', downT: 0, wobble: 0, flash: 0,
    name: opts.name || modelName, prop: true,
  };
  scene.add(g);
  targets.push(g);
  return g;
}

// ---- skeletal characters ----
// model.c builds a joint as `parent * translate(Origin) * rotate(anim)`, and
// matrix_4x4_set_rotation_around_xyz composes it Rz*Ry*Rx -- three.js 'ZYX'.
// The rotation only ever comes from the animation, which is why an unposed body
// splays: every bone sits on its own +x axis until a frame turns it.
const TAU = Math.PI * 2;
const animCache = new Map();
function loadAnim(name) {
  if (!animCache.has(name))
    animCache.set(name, fetch(`${EX}/animations/${ANIMS.animations[name].file}`, { cache: 'no-cache' }).then(r => r.json()));
  return animCache.get(name);
}

/** Pose one skeleton from a fractional animation frame.
 *  GE samples two frames (framea/frameb) and blends them with a quaternion
 *  slerp (model.c, the unk2c path); sampling only whole frames steps visibly
 *  at 60 Hz on the slower death falls. */
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(),
      _qi = new THREE.Quaternion();
function jointQuat(f, j, flip, out) {
  const i = flip ? j.mtxB : j.mtxA;
  let x = f[i] * TAU / 65535, y = f[i+1] * TAU / 65535, z = f[i+2] * TAU / 65535;
  if (flip) { y = y ? TAU - y : 0; z = z ? TAU - z : 0; }
  _e.set(x, y, z, 'ZYX');
  return out.setFromEuler(_e);
}
function poseSkeleton(rig, anim, frame, flip = false) {
  const n = anim.frames;
  const fa = ((Math.floor(frame) % n) + n) % n;
  const t = frame - Math.floor(frame);
  // the frame after the last blends back to the start only when the loop does
  const fb = fa + 1 < n ? fa + 1 : (anim.loop ? 0 : fa);
  const A = anim.data[fa], B = anim.data[fb];
  for (const b of rig.bones) {
    if (!b.userData.joint) continue;              // joint 0 is the model root
    const j = rig.joints[b.userData.joint];
    if (!j) continue;
    jointQuat(A, j, flip, _q);
    if (t > 0 && fb !== fa) {
      jointQuat(B, j, flip, _q2);
      _q.slerp(_q2, t);
    }
    // MatrixID1 bones are the same joint at half the turn (GE's bend/stretch);
    // modelBuildGroupMatrices halves the quaternion rather than the angles.
    if (b.userData.half) _q.slerpQuaternions(_qi.identity(), _q, 0.5);
    b.quaternion.copy(_q);
  }
}

/** World bounds of a posed skeleton. Box3.setFromObject reads the bind-pose
 *  geometry and ignores skinning, which put every guard waist-deep in the
 *  floor; this walks the vertices through their bone transforms instead. */
const _bv = new THREE.Vector3();
function skinnedBounds(rig) {
  rig.mesh.updateMatrixWorld(true);
  rig.skeleton.update();
  const pos = rig.mesh.geometry.attributes.position;
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    _bv.fromBufferAttribute(pos, i);
    rig.mesh.applyBoneTransform(i, _bv);
    box.expandByPoint(_bv.applyMatrix4(rig.mesh.matrixWorld));
  }
  return box;
}

const bodyCache = new Map();
/** Build a SkinnedMesh from a model's .skin.json: geometry in bone space plus
 *  the matrix-slot tree the exporter recorded. */
async function loadBody(modelName) {
  if (bodyCache.has(modelName)) return bodyCache.get(modelName);
  const p = (async () => {
    const [skin, mtl] = await Promise.all([
      fetch(`${EX}/models/${modelName}.skin.json`, { cache: 'no-cache' }).then(r => r.json()),
      new MTLLoader().setPath(`${EX}/models/`).loadAsync(`${modelName}.mtl`),
    ]);
    mtl.preload();
    const slots = Object.keys(skin.matrices).map(Number).sort((a, b) => a - b);
    const slotIndex = new Map(slots.map((s, i) => [s, i]));
    const bones = slots.map(sl => {
      const m = skin.matrices[String(sl)];
      const b = new THREE.Bone();
      b.position.set(m.origin[0], m.origin[1], m.origin[2]);
      b.userData = { slot: sl, joint: m.joint, half: m.half };
      return b;
    });
    slots.forEach((sl, i) => {
      const par = skin.matrices[String(sl)].parent;
      if (slotIndex.has(par)) bones[slotIndex.get(par)].add(bones[i]);
    });
    const roots = bones.filter(b => !b.parent);

    const n = skin.position.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(skin.position, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(skin.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(skin.color, 3));
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i*4] = slotIndex.get(skin.vertexMatrix[i]) ?? 0; sw[i*4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const index = [], mats = [];
    for (const [name, tri] of Object.entries(skin.groups)) {
      g.addGroup(index.length, tri.length, mats.length);
      index.push(...tri);
      mats.push(geMaterial(mtl.create(name) || new THREE.MeshBasicMaterial(), name));
    }
    g.setIndex(index);
    g.computeVertexNormals();
    // Raycasting a SkinnedMesh is pose-aware (getVertexPosition applies the
    // bones), but the raycaster's early-out sphere is computed from the raw
    // bone-space positions -- a small blob near the holder origin. Any shot
    // whose ray misses that blob is rejected before the per-triangle test,
    // which made guards randomly bulletproof mid-animation. Swap in a sphere
    // that bounds every reachable pose.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4000);
    const mesh = new THREE.SkinnedMesh(g, mats);
    mesh.frustumCulled = false;
    return { mesh, bones, roots, skeleton: new THREE.Skeleton(bones), skin,
             vertexMatrix: skin.vertexMatrix, hitpart: skin.hitpart || {} };
  })();
  bodyCache.set(modelName, p);
  return p;
}

/** A fresh, independently poseable instance of a body. */
async function instanceBody(modelName, skelName) {
  const src = await loadBody(modelName);
  const bones = src.bones.map(b => {
    const c = new THREE.Bone();
    c.position.copy(b.position);
    c.userData = { ...b.userData };
    return c;
  });
  src.bones.forEach((b, i) => {
    const pi = src.bones.indexOf(b.parent);
    if (pi >= 0) bones[pi].add(bones[i]);
  });
  const roots = bones.filter(b => !b.parent);
  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(src.mesh.geometry, src.mesh.material);
  mesh.frustumCulled = false;
  const holder = new THREE.Group();
  roots.forEach(r => holder.add(r));
  holder.add(mesh);
  mesh.bind(skeleton);
  const joints = (CHARS.skeletons[skelName] || CHARS.skeletons.guard).joints;
  return { holder, mesh, bones, skeleton, joints,
           vertexMatrix: src.vertexMatrix, hitpart: src.hitpart };
}

// ---- targets ----
const targets = [];
const raycaster = new THREE.Raycaster();
// breakable glass panes (placeDamGlass): shootable, but not "targets" -- no
// score, no HP bar, just glass.c's shard-grid break on the first hit
const GLASS_PANES = [];
// ---- enemies ----
// Each lane target is a real GoldenEye guard: the game's body model, posed by
// the game's own animation, wearing the head and hat GE would give it.
//
// Identities come from the guard records in the ROM's stage setups
// (extracted/characters/CHARACTERS.json), so this is the cast you actually
// shoot at in GoldenEye, not an invented line-up.
// wep: the Pchr* held-weapon model GE renders in a guard's hand; wkey: the
// weapon whose sound and fire rate it uses. Unarmed characters have neither
// and stand in idle_unarmed.
const ENEMIES = [
  { body: 'CrusguardZ',     head: 'CheadgrantZ',     hat: 'PhatberetZ',      name: 'Russian Soldier',         wep: 'PchrkalashZ',  wkey: 'ak47' },
  { body: 'CtrevguardZ',    head: 'CheadbalaclavaZ', hat: null,              name: 'Janus Special Forces',    wep: 'PchrkalashZ',  wkey: 'ak47' },
  { body: 'ColiveguardZ',   head: 'CheadbZ',         hat: 'PhattbirdZ',      name: 'Russian Infantry',        wep: 'PchrkalashZ',  wkey: 'ak47' },
  { body: 'CcamguardZ',     head: 'CheadduncanZ',    hat: 'PhatberetredZ',   name: 'Jungle Commando',         wep: 'Pchrm16Z',     wkey: 'm16' },
  { body: 'CnavyguardZ',    head: 'CheadkarlZ',      hat: 'PhathelmetZ',     name: 'Janus Marine',            wep: 'Pchrmp5kZ',    wkey: 'mp5k' },
  { body: 'CsnowguardZ',    head: 'CheadmarkZ',      hat: 'PhatfurryZ',      name: 'Arctic Commando',         wep: 'PchrkalashZ',  wkey: 'ak47' },
  { body: 'CmoonguardZ',    head: 'CheadneilZ',      hat: 'PhatmoonZ',       name: 'Moonraker Elite',         wep: 'PchrlaserZ',   wkey: 'laser' },
  { body: 'CgreatguardZ',   head: 'CheadleeZ',       hat: 'PhathelmetgreyZ', name: 'Siberian Special Forces', wep: 'PchrshotgunZ', wkey: 'shotgun' },
  { body: 'CgreyguardZ',    head: 'CheadstevehZ',    hat: 'PhatberetblueZ',  name: 'Siberian Guard',          wep: 'PchrkalashZ',  wkey: 'ak47' },
  { body: 'CcommguardZ',    head: 'CheadjimZ',       hat: 'PhattbirdbrownZ', name: 'Naval Officer',           wep: 'Pchrtt33Z',    wkey: 'tt33', pistol: true },
  { body: 'CtechmanZ',      head: 'CheadchrisZ',     hat: null,              name: 'Scientist' },
  { body: 'CtechwomanZ',    head: 'CheadsallyZ',     hat: null,              name: 'Civilian', female: true },
];
// Jaws: GE's one designated heavy (BODY_Jaws, a single spawn in the whole ROM,
// azt only). Named-cast bodies sculpt the head in, so head/hat are null; he's
// unarmed in every appearance -- a melee threat, not a shooter. hp is a
// SetMyHealthTotal-style override (see mkEnemy) well above the grunt default.
const HEAVY = { body: 'CjawsZ', head: null, hat: null, name: 'Jaws', hp: 64 };
const HEAD_BY_MODEL = Object.fromEntries(CHARS.heads.map(h => [h.model, h]));
// The colour variants are the same mesh as the entry the table is keyed on.
const HAT_BASE = { PhatberetblueZ: 'PhatberetZ', PhatberetredZ: 'PhatberetZ',
                   PhatfurryblackZ: 'PhatfurryZ', PhatfurrybrownZ: 'PhatfurryZ',
                   PhathelmetgreyZ: 'PhathelmetZ', PhattbirdbrownZ: 'PhattbirdZ' };

const MM = 0.001;                     // character models are in millimetres too

async function mkEnemy(x, z, spec, y = 0) {
  const g = new THREE.Group();
  const skelName = CHARS.body_skeleton[spec.body] || 'guard';
  const rig = await instanceBody(spec.body, skelName);
  const idle = await loadAnim(spec.wep ? 'idle' : 'idle_unarmed');
  poseSkeleton(rig, idle, 0);
  rig.holder.scale.setScalar(MM);
  g.add(rig.holder);

  // The head is its own model in GE, attached at the neck joint; chr.c renders
  // it with the neck's matrix. SKEL_NECK is joint 3, so parent the head to
  // whichever bone reads that joint and it follows the animation for free.
  // Unique named-cast bodies (Jaws, Trevelyan, ...) sculpt the head into the
  // body mesh itself instead of using the generic interchangeable head prop,
  // so spec.head is null for those and there's nothing to attach here.
  const neck = rig.bones.find(b => b.userData.joint === 3) || rig.bones[0];
  if (spec.head) {
    const head = (await loadProp(spec.head)).clone(true);
    head.userData.zone = 'head';      // the hit test walks ancestors for this
    neck.add(head);
  }

  if (spec.hat) {
    const key = HAT_BASE[spec.hat] || spec.hat;
    const fit = (HEAD_BY_MODEL[spec.head] || {}).hats?.[key];
    const hat = (await loadProp(spec.hat)).clone(true);
    const sc = fit ? fit.scale : [1, 1, 1];
    hat.scale.set(sc[0], sc[1], sc[2]);
    const off = fit ? fit.offset : [0, 0, 0];
    // chr.c seats the hat on the head's own matrix and nudges it with
    // headHat_array_8003E464. Work in model units off the manifest's bounds:
    // measuring the live objects returns world metres, because everything here
    // hangs off a bone under a millimetre-scaled holder.
    const hbb = MODELS[spec.head].bbox, bbb = MODELS[spec.hat].bbox;
    const brim = hbb[4] - (bbb[4] - bbb[1]) * sc[1] * 0.72;
    hat.position.set(off[0] - (bbb[0] + bbb[3]) / 2 * sc[0],
                     brim - bbb[1] * sc[1] + off[1],
                     off[2] - (bbb[2] + bbb[5]) / 2 * sc[2]);
    hat.userData.zone = 'hat';
    hat.userData.hatKey = HAT_BASE[spec.hat] || spec.hat;
    neck.add(hat);
  }

  // Stand the figure on the floor: its root joint sits at hip height, so the
  // drop is wherever the posed feet land (relative to the group's own ground y).
  g.position.set(x, y, z);
  g.updateWorldMatrix(false, true);
  rig.holder.position.y = g.position.y - skinnedBounds(rig).min.y;

  let wepObj = null;
  if (spec.wep) {
    // propobj.c: the right-hand weapon's basemtx is the chr model's Switches[3]
    // node -- the joint-9 wrist group on every guard body -- with identity
    // rotation, so the prop parents straight onto that bone.
    const wrist = rig.bones.find(b => b.userData.joint === 9)
               || rig.bones.find(b => b.userData.joint === 8);
    wepObj = (await loadProp(spec.wep)).clone(true);
    // muzzle = the -x end of the held model (they run along the wrist's x axis)
    wepObj.userData.muzzleX = (MODELS[spec.wep].bbox || [-400])[0];
    // The chr props carry their own muzzle flash as a switch (_sw) group --
    // GE toggles it while the guard fires. Clone those materials (the prop
    // cache shares them between instances), hide them, and keep them as this
    // guard's flash.
    wepObj.userData.zone = 'gun';
    wepObj.userData.flashMats = [];
    wepObj.traverse(o => {
      if (!o.isMesh) return;
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
        if (!/_sw/.test(m.name)) return m;
        const f = m.clone();
        f.visible = false; f.transparent = true;
        f.blending = THREE.AdditiveBlending; f.depthWrite = false; f.alphaTest = 0;
        wepObj.userData.flashMats.push(f);
        return f;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });
    if (wrist) wrist.add(wepObj);
  }

  const hpBar = makeHpBar();
  hpBar.sprite.position.set(0, 2.02, 0);
  g.add(hpBar.sprite);

  g.position.set(x, y, z);
  g.userData = {
    // chr.c:1656 -- every guard spawns with maxdamage 4.0, so weapon damage
    // straight from WeaponStats gives the real number of hits: four PP7 body
    // shots, one Golden Gun round. A level's AI script can override this per
    // character with SetMyHealthTotal (aicommands.def GUARD_SET_HEALTH_TOTAL)
    // to make a specific guard tougher -- spec.hp mirrors that same override.
    hp: spec.hp ?? CHARS.guard_max_damage, maxhp: spec.hp ?? CHARS.guard_max_damage,
    hit: 'flesh', downT: 0, wobble: 0, flash: 0,
    name: spec.name, female: !!spec.female, enemy: true,
    rig, anim: idle, idleAnim: idle, frame: Math.random() * idle.frames,
    animName: 'idle', flip: Math.random() < 0.5, animRate: 1,
    wepObj, wkey: spec.wkey || null, pistol: !!spec.pistol,
    walkAnim: spec.female ? 'walking_female' : (spec.wep ? 'walking' : 'walking_unarmed'),
    hpBar, lastDmg: 0,
    nextFire: performance.now() / 1000 + 3 + Math.random() * 6,
  };
  scene.add(g);
  targets.push(g);
  return g;
}

async function buildTargets() {
  const lanes = [-6.5, 0, 6.5];
  const rows = [-14, -32, -55, -85, -110, -132];
  let i = 0;
  for (const z of rows)
    for (const x of lanes) {
      const spec = ENEMIES[i % ENEMIES.length];
      const patrols = (i % 2) === 1;            // every other guard walks a beat
      i++;
      // the front row's centre lane sits directly between the player and
      // Jaws (0, -20) -- shift that one target out past the right lane so
      // he isn't the first thing blocking the shot to the heavy.
      const lx = (z === -14 && x === 0) ? 9.5 : x;
      try {
        const g = await mkEnemy(lx + (Math.abs(z) % 7) * 0.1 - 0.3, z, spec);
        if (patrols) {
          const hx = g.position.x, hz = g.position.z;
          const rx = 2.2, rz = Math.min(1.8, Math.abs(hz) - 6 > 0 ? 1.8 : 0.8);
          g.userData.patrol = {
            points: [[hx - rx, hz], [hx, hz - rz], [hx + rx, hz], [hx, hz + rz]],
            next: Math.floor(Math.random() * 4),
          };
        }
      }
      catch (e) { console.log('enemy failed', spec.body, e); }
    }
  // one heavy, dead centre of the firing lanes, ahead of the regular grid
  try { await mkEnemy(0, -20, HEAVY); }
  catch (e) { console.log('heavy failed', e); }
}

/** Real GoldenEye props: material test pieces and range dressing. */
async function buildProps() {
  const jobs = [
    // material test line: metal drums, gas barrels, wooden crates
    ['Poil_drum1Z',  -10,  -20, 0.95, { hit: 'metal' }],
    ['Poil_drum6Z',   -8.6,-21.4, 0.95, { hit: 'metal' }],
    ['PgasbarrelZ',   10,  -20, 1.05, { hit: 'metal' }],
    ['Pammo_crate5Z',-10,  -45, 0.55, { hit: 'wood' }],
    ['Pboxes2x4Z',    10,  -45, 1.60, { hit: 'wood' }],
    ['PgastankZ',    -11,  -70, 1.90, { hit: 'metal' }],
    ['Poil_drum3Z',   11,  -70, 0.95, { hit: 'metal' }],
    ['Poil_drum5Z',   12.2,-71.5, 0.95, { hit: 'metal' }],
    // dressing near the firing line
    ['Pmetal_chair1Z', -6.5, 2.5, 0.95, { hit: 'metal', ry: 0.6 }],
    ['Pbookshelf1Z',    9.5, 1.0, 1.85, { hit: 'wood', ry: -0.4 }],
  ];
  for (const [name, x, z, h, opts] of jobs) {
    try { await placeProp(name, x, z, h, opts); }
    catch (e) { console.log('prop failed', name, e); }
  }
}

// ---- impact sounds + visuals per material ----
// tex.c's g_HitTypeSounds[]: one {sfx[], impacttype[]} record per material,
// indexed by the low nibble of the hit texture's material id. Each record's
// impacttype list picks a random g_ImpactTypes[] entry (decal/puff size);
// water's list is EMPTY (thing2_len 0) -- water gets a sound and nothing
// else, no decal, no puff. Character hits use isnd_chr, apptype 0: a puff,
// but the table gives it no decal entry either -- GE never draws a bullet
// hole or blood on a body, only the gray hit-puff from chr.c.
const sfx = n => soundByName(n);
const HIT_SOUNDS = {
  default:   [sfx('HIT_BULLET_STONE1_SFX'), sfx('HIT_BULLET_STONE2_SFX')],
  stone:     [sfx('HIT_BULLET_STONE1_SFX'), sfx('HIT_BULLET_STONE2_SFX')],
  wood:      [sfx('HIT_BULLET_WOOD_SFX'), sfx('HIT_BULLET_WOOD2_SFX')],
  metal:     [sfx('HIT_BULLET_METAL_A_SFX'), sfx('HIT_BULLET_METAL_A3_SFX'), sfx('HIT_BULLET_METAL_A4_SFX')],
  metalobj:  [sfx('HIT_METAL_OBJECT1_SFX'), sfx('HIT_METAL_OBJECT2_SFX')],
  glass:     [sfx('HIT_BULLET_GLASS_SFX')],
  glass_xlu: [sfx('HIT_BULLET_GLASS_SFX')],
  water:     [sfx('HIT_BULLET_WATER_SFX')],
  snow:      [sfx('HIT_BULLET_SNOW_SFX')],
  dirt:      [sfx('HIT_BULLET_DIRT1_SFX'), sfx('HIT_BULLET_DIRT2_SFX')],
  mud:       [sfx('HIT_BULLET_MUD1_SFX'), sfx('HIT_BULLET_MUD2_SFX'), sfx('HIT_BULLET_MUD3_SFX')],
  tile:      [sfx('HIT_BULLET_TILE_SFX')],
  flesh:     [sfx('HIT_BULLET_FLESH_SFX')],
  other:     RICO.slice(16, 20),
};
// GE's own material table has no decal/puff entry for water or characters
// (tex.c isnd_water/isnd_chr thing2_len); characters still get chr.c's puff,
// just no decal -- everyone else (including water) is handled in impactFX().
const NO_DECAL = new Set(['water', 'flesh']);
const NO_PUFF = new Set(['water']);
// Occasional ricochet whine layered over hard-surface hits -- gunfire.c's own
// ricochet chance is a separate system from the material table; approximated
// here as a flat chance so hard cover still pings now and then.
const RICO_KINDS = new Set(['stone', 'metal', 'metalobj', 'tile', 'default']);
// g_ImpactTypes[]: decal/puff half-size in N64 units (~cm); most solid
// materials share the {6,6} entry, glass's table picks a bigger 6/8/12 mix.
const IMPACT_SIZE = {
  default: 0.045, stone: 0.045, wood: 0.045, metal: 0.045, metalobj: 0.045,
  tile: 0.045, dirt: 0.045, mud: 0.045, snow: 0.045, other: 0.045,
  glass: 0.07, glass_xlu: 0.07, flesh: 0.055,
};
// texture id -> GE hit-material kind, from IMAGES.json's per-texture
// hit_texture (itself g_Textures' embedded material id, HIT_STONE etc.)
const HIT_TEX = {};
for (let i = 0; i < IMAGES.length; i++) {
  const h = IMAGES[i] && IMAGES[i].hit_texture;
  if (h) HIT_TEX[i] = h.replace(/^HIT_/, '').toLowerCase();
}
/** Which material a level-geometry face is, from the tex_<id> its hit material
 *  is baked into (extract_bg.py/extract_models.py both name materials this
 *  way). Level rooms carry every material GE authored -- water, glass, snow,
 *  tile -- not just one hard-coded "stone" for the whole mesh. */
function levelFaceMaterial(obj, face) {
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  const mi = face && typeof face.materialIndex === 'number' ? face.materialIndex : 0;
  const name = (mats[mi] || mats[0] || {}).name || '';
  const m = /^tex_(\d+)/.exec(name);
  return (m && HIT_TEX[+m[1]]) || 'stone';
}
const EXPLO_SOUNDS = ['EXPLOSION_2A_SFX','EXPLOSION_2B_SFX','EXPLOSION_3_SFX','EXPLOSION_4A_SFX','EXPLOSION_4B_SFX']
  .map(sfx).filter(Boolean);
// guard reactions: GE grunts on a hit and thumps on the way down
const HURT_MALE = SOUNDS.filter(s => /^GET_HIT_MALE/.test(s.name)).map(s => `${EX}/sounds/${s.file}`);
const HURT_GIRL = SOUNDS.filter(s => /^GET_HIT_GIRL/.test(s.name)).map(s => `${EX}/sounds/${s.file}`);
const BODY_FALL = SOUNDS.filter(s => /^BODY_FALL_/.test(s.name)).map(s => `${EX}/sounds/${s.file}`);

// ---- sparks / tracers / decals / explosions ----
const fx = [];
function addFx(mesh, ttl, kind) {
  mesh.userData = Object.assign(mesh.userData || {}, { t: ttl, ttl, kind });
  scene.add(mesh); fx.push(mesh);
  return mesh;
}
// A soft radial-gradient blob, shared by every dust puff and smoke cloud --
// glass2.c's bullet_spark_create is a camera-facing billboard, not the hard
// little spark spheres a modern shooter would draw.
const puffCanvas = document.createElement('canvas');
puffCanvas.width = puffCanvas.height = 32;
{
  const pc = puffCanvas.getContext('2d');
  const g = pc.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  pc.fillStyle = g; pc.fillRect(0, 0, 32, 32);
}
const puffTex = new THREE.CanvasTexture(puffCanvas);
const sparkGeo = new THREE.SphereGeometry(0.035, 4, 4);
function spawnSpark(p, big = false) {
  for (let i = 0; i < (big ? 7 : 3); i++) {
    const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffcc55 }));
    m.position.copy(p);
    m.userData = { vel: new THREE.Vector3((Math.random()-.5)*4, Math.random()*3.5, (Math.random()-.5)*4) };
    addFx(m, 0.22 + Math.random()*0.15, 'spark');
  }
}
// g_BulletSparkColors: almost every entry is white or pale yellow (255,255,200);
// the one red entry in the table is never actually selected in play, matching
// chr.c having no blood -- so every material's puff draws from these two.
const PUFF_TINTS = [0xffffff, 0xfffdc8];
function spawnImpactPuff(p, normal, size = 0.045, tint = null) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: puffTex, color: tint || PUFF_TINTS[Math.random() < 0.5 ? 0 : 1],
    transparent: true, depthWrite: false, opacity: 0.8 }));
  sp.position.copy(p).addScaledVector(normal, 0.02);
  const s = size * (2.2 + Math.random() * 0.6);
  sp.scale.set(s, s, 1);
  sp.userData = { drift: normal.clone().multiplyScalar(0.3 + Math.random() * 0.2), size0: s };
  addFx(sp, 0.16 + Math.random() * 0.08, 'puff');
}
function spawnTracer(from, to) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({
    color: 0xffe9a0, transparent: true, opacity: 0.85 }));
  addFx(l, 0.06, 'tracer');
}
const decalGeo = new THREE.CircleGeometry(1, 16);
function spawnDecal(p, normal, size = 0.035, ttl = 9) {
  const m = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({
    color: 0x111111, transparent: true, opacity: 0.9 }));
  m.scale.setScalar(size);
  m.position.copy(p).addScaledVector(normal, 0.01);
  m.lookAt(p.clone().add(normal));
  addFx(m, ttl, 'decal');
}
// ---- glass: window/pane shards, glass.c's shard-grid break ----
const shardGeo = new THREE.PlaneGeometry(1, 1);
function spawnGlassShard(pos, size, tinted) {
  const m = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({
    // v1..v3 env-mapped gradient in glass.c runs blue -> pale yellow; a flat
    // pale blue-white reads the same on an unlit billboard shard
    color: tinted ? 0x4a5a66 : 0xcfe6ff, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false }));
  m.position.copy(pos);
  m.scale.setScalar(size);
  m.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
  // horizontal drift symmetric, vertical biased upward -- glassCreateShard's
  // randSymmetricX/Z and randBiasedY (-0.12..1.0), scaled to m/s
  m.userData = {
    vel: new THREE.Vector3((Math.random() - 0.5) * 5,
                            (Math.random() * 1.12 - 0.12) * 5.5,
                            (Math.random() - 0.5) * 5),
    spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
  };
  addFx(m, 1.1 + Math.random() * 0.7, 'shard');
}
/** A handful of shards for a glancing hit on glass that's part of the static
 *  level mesh -- can't remove individual triangles from that shared buffer,
 *  so the pane itself stays (matches GE: bg glass textures use the plain
 *  decal/puff table, only dedicated glass PropRecords use glass.c's break). */
function spawnGlassShards(p, normal, count, tinted) {
  for (let i = 0; i < count; i++)
    spawnGlassShard(p.clone().addScaledVector(normal, 0.02 + Math.random() * 0.05),
                    0.05 + Math.random() * 0.05, tinted);
}
/** One bullet impact's full visual+audio response, dispatched by GE hit
 *  material: tex.c's g_HitTypeSounds table drives every branch here (which
 *  sound, whether a puff spawns at all, whether a decal follows the puff). */
function impactFX(kind, point, normal) {
  const set = HIT_SOUNDS[kind] || HIT_SOUNDS.other;
  let snd = set[Math.floor(Math.random() * set.length)];
  if (RICO_KINDS.has(kind) && Math.random() < 0.18) snd = RICO[Math.floor(Math.random() * RICO.length)];
  if (snd) play(snd, { vol: 0.8, at: point, pitch: 0.9 + Math.random() * 0.2 });
  if (NO_PUFF.has(kind)) return;                    // water: sound only (tex.c thing2_len 0)
  const isGlass = kind === 'glass' || kind === 'glass_xlu';
  spawnImpactPuff(point, normal, IMPACT_SIZE[kind] || 0.045, isGlass ? 0xdcecff : null);
  if (NO_DECAL.has(kind)) return;                   // flesh: no hole or blood, chr.c has none
  spawnDecal(point, normal, IMPACT_SIZE[kind] || 0.045);
  if (isGlass) spawnGlassShards(point, normal, 5, kind === 'glass_xlu');
}
/** A whole breakable glass pane (placeDamGlass): glass.c's shard grid --
 *  count scaled by pane area like sub_GAME_7F0A1DA0's shard_size formula --
 *  covering the entire pane, then the pane itself is gone. */
function shatterGlassPane(g) {
  if (g.userData.broken) return;
  g.userData.broken = true;
  const { side, up, lk, ctr, w, h, tinted } = g.userData;
  play(sfx('GLASS_SHATTERING_SFX') || sfx('HIT_GLASS_SMASH_SFX'), { vol: 1.1, at: ctr });
  const n = Math.max(10, Math.min(40, Math.round((w * h) / 0.05)));
  for (let i = 0; i < n; i++) {
    const pos = ctr.clone()
      .addScaledVector(side, (Math.random() - 0.5) * w)
      .addScaledVector(up, (Math.random() - 0.5) * h);
    spawnGlassShard(pos, 0.06 + Math.random() * 0.08, tinted);
  }
  scene.remove(g);
  const i = GLASS_PANES.indexOf(g);
  if (i >= 0) GLASS_PANES.splice(i, 1);
}
const casingGeo = new THREE.BoxGeometry(0.012, 0.012, 0.03);
const casingMat = new THREE.MeshLambertMaterial({ color: 0xc8a248 });
function spawnCasing(side = 0) {
  const m = new THREE.Mesh(casingGeo, casingMat);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const eo = side === 0 ? state.ejectObj : state.ejectObjL;
  if (eo) gunPointWorld(eo, m.position);
  else m.position.copy(cam.position).addScaledVector(right, 0.28).addScaledVector(fwd, 0.35)
    .add(new THREE.Vector3(0, -0.12, 0));
  // dam terrain isn't flat like the range floor -- ground the landing check
  // under wherever the casing actually falls, not a fixed world y
  const floorY = (LEVEL === 'dam'
    ? (damGround(m.position.x, m.position.z, 2, 6, DAM.groundY) ?? DAM.groundY)
    : 0) + 0.02;
  m.userData = { vel: right.clone().multiplyScalar(1.4 + Math.random())
      .add(new THREE.Vector3(0, 2 + Math.random(), 0)),
      rot: new THREE.Vector3(Math.random()*20, Math.random()*20, 0), landed: false, floorY };
  addFx(m, 0.9, 'casing');
}
let shake = 0;
// ---- explosion: fireball + gunfire.c-style shrapnel + explosion.c's smoke ----
function spawnShrapnel(p) {
  // explosion.c's standard grenade/mine entry: 200 bits, size 6, hvel 30,
  // vvel 6-15 (N64 units/tick) -- scaled down in COUNT for the browser (a
  // couple dozen reads the same as two hundred at this camera distance) but
  // keeping the same character: small gray tumbling debris, biased upward.
  const n = 26;
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({
      color: 0x3a3a36, side: THREE.DoubleSide, transparent: true }));
    m.position.copy(p);
    m.scale.setScalar(0.04 + Math.random() * 0.05);
    m.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
    const ang = Math.random() * TAU, h = 2 + Math.random() * 2.5;
    m.userData = {
      vel: new THREE.Vector3(Math.cos(ang) * h, 4 + Math.random() * 5, Math.sin(ang) * h),
      spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
    };
    addFx(m, 0.9 + Math.random() * 0.5, 'shard');
  }
}
function spawnSmoke(p) {
  // explosion.c smoketype 6 (the grenade/mine entry): size 300 (~3 m), colour
  // (64,64,64), duration 900 ticks (~15 s). Compressed to ~8 s here -- still
  // clearly lingers, without a rocket volley fouling the range in smoke.
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: puffTex, color: 0x404040, transparent: true, depthWrite: false, opacity: 0 }));
  sp.position.copy(p).add(new THREE.Vector3(0, 0.4, 0));
  addFx(sp, 8, 'smoke');
}
function explode(p, radius, damage, normal = null) {
  play(EXPLO_SOUNDS[Math.floor(Math.random()*EXPLO_SOUNDS.length)],
       { vol: 1.6, at: p, pitch: 0.95 + Math.random()*0.1 });
  // Float the fireball clear of the wall it hit -- centered exactly on the
  // impact point, half of the additive sphere clips into the surface and its
  // silhouette sits flush with the flat scorch decal below, which reads as a
  // dark polygon cut out of the middle of the ball instead of two separate
  // things at different depths.
  const off = normal ? normal.clone().multiplyScalar(radius * 0.15) : new THREE.Vector3();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa63e, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  ball.position.copy(p).add(off);
  addFx(ball, 0.35, 'explosion');
  const light = new THREE.PointLight(0xffa040, 60, radius * 4);
  light.position.copy(p).add(off);
  addFx(light, 0.25, 'light');
  spawnShrapnel(p);
  spawnSmoke(p.clone().add(off));
  // explosionScorchTick: a persistent dark mark on whatever surface it hit --
  // bigger and longer-lived than an ordinary bullet hole
  if (normal) spawnDecal(p, normal, 0.5 + Math.random() * 0.3, 30);
  // explosionScreenShake: sum of explosion_size/distance*15 across active
  // blasts; explosion_size here is the same radius (m) fireProjectile passed.
  const d = cam.position.distanceTo(p);
  shake = Math.min(1.4, shake + (radius / Math.max(d, 1)) * 0.6);
  for (const t of targets) {
    const u = t.userData;
    if (u.hp === Infinity || u.downT > 0) continue;
    const dist = t.position.distanceTo(p);
    if (dist < radius) {
      const edmg = damage * (1 - dist / radius) * 4;
      u.hp -= edmg;
      if (u.enemy) {
        spawnDamageNumber(t.position.clone().add(new THREE.Vector3(0, 1.4, 0)), edmg, 1);
        if (edmg > 0) u.lastDmg = edmg;
        updateHpBar(t);
      }
      hitReact(t);
      state.hits++;
      if (u.hp <= 0) {
        u.downT = 3.4; state.score += 50;
        if (u.enemy) { playDeath(t, false); updateHpBar(t); }
      }
    }
  }
  updateHud();
}
function hitReact(t) {
  const u = t.userData;
  u.wobble = 1;
  const mats = u.rig ? [].concat(u.rig.mesh.material) : (u.board ? [u.board.material] : []);
  if (!mats.length) return;
  if (!u.baseColor) u.baseColor = mats.map(m => m.color.clone());
  mats.forEach(m => m.color.setRGB(1.6, 0.6, 0.6));
  u.flashMats = mats;
  u.flash = 0.12;
}
// ---- walk gaits ----
// GE's walk cycles animate in place (their root-motion channel holds the hip's
// absolute position; x/z barely move), so ground speed comes from the gait:
// how fast the planted foot travels backward relative to the root, measured
// per animation from the posed skeleton (units/frame at 1.0x playback).
// chraction.c plays guard walks at 0.5x speed, so both the playback rate and
// the movement speed halve together and the feet never slide.
const WALK_RATE = 0.5;                     // modelSetAnimation(..., 0.5f, ...)
const WALK_SPEED = {                       // m/s at 1.0x playback
  walking: 2.19, walking_unarmed: 3.15, walking_female: 3.84,
};

// ---- range UI: floating damage numbers and HP bars ----
// Not from the original game -- range instrumentation. The HP bar divides
// itself into segments the size of the last hit taken, so the number of full
// segments left is the number of hits like that one still needed.
function makeTextSprite(text, colour) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeText(text, 64, 32);
  ctx.fillStyle = colour; ctx.fillText(text, 64, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
  sp.scale.set(0.40, 0.20, 1);
  return sp;
}
function spawnDamageNumber(pos, dmg, mult) {
  const colour = mult >= 4 ? '#ff5232' : mult >= 2 ? '#ffb63c'
               : mult > 0 ? '#ffffff' : '#8f9aa6';
  const text = mult === 0 ? '0' : (Number.isInteger(dmg) ? String(dmg) : dmg.toFixed(1));
  const sp = makeTextSprite(text, colour);
  sp.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, 0.04, 0));
  scene.add(sp);
  addFx(sp, 0.8, 'dmgnum');
}

function makeHpBar() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 20;
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(0.62, 0.097, 1);
  sprite.visible = false;
  sprite.raycast = () => {};   // UI: never blocks a shot (and Sprite.raycast
                               // needs a camera the hit raycaster doesn't have)
  return { sprite, cv, tex };
}
/** Redraw an enemy's bar. Hidden at full health and while down. */
function updateHpBar(t) {
  const u = t.userData, b = u.hpBar;
  if (!b) return;
  if (u.downT > 0 || u.hp >= u.maxhp || u.hp <= 0) { b.sprite.visible = false; return; }
  const frac = u.hp / u.maxhp;
  const ctx = b.cv.getContext('2d');
  ctx.clearRect(0, 0, 128, 20);
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, 128, 20);
  ctx.fillStyle = frac > 0.5 ? '#46c94b' : frac > 0.25 ? '#ffb63c' : '#ff5232';
  ctx.fillRect(2, 2, 124 * frac, 16);
  // segment lines every lastDmg of health, from empty toward full: the fill
  // then reads directly as hits-to-kill at the last shot's damage
  if (u.lastDmg > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.95)';
    for (let hp = u.lastDmg; hp < u.maxhp - 1e-6; hp += u.lastDmg) {
      ctx.fillRect(2 + 124 * (hp / u.maxhp) - 1, 2, 2, 16);
    }
  }
  b.tex.needsUpdate = true;
  b.sprite.visible = true;
}

// ---- body-part damage (chraction.c handles_shot_actors) ----
// HITTARGET part numbers, from the op-10 bbox nodes in each body model.
const PART_HEAD = 8, PART_CHEST = 15;
const PART_LEFT = new Set([1, 2, 3, 9, 10, 11]);    // left limbs
const PART_ARM = new Set([9, 10, 11, 12, 13, 14]);  // arms/shoulders/hands
/**
 * Work out what a ray hit on an enemy actually struck and what GE does about
 * it: head x4, chest x2, limbs x1; the held gun soaks the shot for nothing;
 * a soft hat is knocked off, a steel helmet ricochets, and the moonraker
 * helmet counts as the head (all per handles_shot_actors).
 */
function resolveBodyPart(g, h) {
  let zone = null, zobj = null;
  for (let o = h.object; o && o !== g; o = o.parent)
    if (o.userData && o.userData.zone) { zone = o.userData.zone; zobj = o; break; }
  if (zone === 'gun')
    return { part: 100, mult: 0, head: false, sound: 'metal', object: zobj };
  if (zone === 'hat') {
    const key = zobj.userData.hatKey;
    if (key === 'PhatmoonZ')                        // moon helmet: head hit
      return { part: PART_HEAD, mult: 4, head: true, sound: 'flesh', object: zobj };
    if (key === 'PhathelmetZ')                      // steel helmet: ricochet
      return { part: 110, mult: 0, head: false, sound: 'metal', object: zobj };
    return { part: 110, mult: 0, head: false, sound: 'other', dropHat: true, object: zobj };
  }
  if (zone === 'head')
    return { part: PART_HEAD, mult: 4, head: true, sound: 'flesh', object: zobj };
  let part = PART_CHEST;
  const rig = g.userData.rig;
  if (rig && h.object === rig.mesh && h.face) {
    const slot = rig.vertexMatrix[h.face.a];
    part = rig.hitpart[String(slot)] ?? PART_CHEST;
  }
  const mult = part === PART_HEAD ? 4 : part === PART_CHEST ? 2 : 1;
  return { part, mult, head: part === PART_HEAD, sound: 'flesh', object: null };
}

/** Knock a soft hat off (propobjSetDropped): reparent to the world and let it
 *  tumble to the floor, where it stays. */
function dropHat(g, hat) {
  if (!hat || hat.userData.dropped) return;
  hat.userData.dropped = true;
  hat.updateWorldMatrix(true, false);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  hat.matrixWorld.decompose(pos, q, sc);
  hat.removeFromParent();
  hat.position.copy(pos); hat.quaternion.copy(q); hat.scale.copy(sc);
  scene.add(hat);
  hat.userData.fall = { vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 1.4, (Math.random() - 0.5) * 0.8),
                        rot: new THREE.Vector3(Math.random() * 5, Math.random() * 5, 0) };
  droppedHats.push(hat);
}
const droppedHats = [];

// ---- guards fire back (visually -- the range never hurts the player) ----
const _muz = new THREE.Vector3();
function guardFire(t, now) {
  const u = t.userData;
  const fireAnim = u.pistol ? 'fire_standing_one_handed_weapon'
                 : (Math.random() < 0.5 ? 'fire_standing' : 'fire_hip');
  loadAnim(fireAnim).then(a => {
    if (u.downT > 0 || (u.animName !== 'idle' && !u.animName.startsWith('walking'))) return;
    u.anim = a; u.animName = fireAnim; u.frame = 0; u.animRate = 1;
    const st = WEAPONS[u.wkey];
    // shots land in the middle of the animation, spaced at the weapon's own
    // auto rate (60 Hz ticks), three rounds for a rifle burst, one for a pistol
    const rate = (st && st.auto_firing_rate_ticks) ? st.auto_firing_rate_ticks / 60 : 0.5;
    const nshots = u.pistol ? 1 : 3;
    for (let i = 0; i < nshots; i++) {
      setTimeout(() => {
        if (u.downT > 0 || !u.wepObj) return;
        // muzzle: the held models run along the wrist's x axis, muzzle at -x
        _muz.set(u.wepObj.userData.muzzleX || -400, 0, 0);
        u.wepObj.updateWorldMatrix(true, false);
        const m = _muz.clone().applyMatrix4(u.wepObj.matrixWorld);
        if (st) play(soundById(parseInt(st.sound_id, 16)), { vol: 0.5, at: m, pitch: 0.95 + Math.random() * 0.1 });
        const fm = u.wepObj.userData.flashMats || [];
        if (fm.length) {
          fm.forEach(x => { x.visible = true; });
          setTimeout(() => fm.forEach(x => { x.visible = false; }), 70);
        } else {
          spawnSpark(m, true);
        }
        // a tracer that always misses: past the player's head, wide
        const miss = cam.position.clone()
          .add(new THREE.Vector3((Math.random() - 0.5) * 3, 0.5 + Math.random(), 0));
        spawnTracer(m, m.clone().lerp(miss, 1.3));   // past the player, not across the sky
      }, 350 + i * Math.max(rate, 0.09) * 1000);
    }
  });
}

/** Non-fatal hit: play GE's flinch for the side and limb that was struck. */
function playFlinch(t, bp) {
  const u = t.userData;
  if (!u.rig || u.downT > 0) return;
  const left = bp ? PART_LEFT.has(bp.part) : Math.random() < 0.5;
  const arm = bp ? PART_ARM.has(bp.part) : Math.random() < 0.5;
  const name = `hit_${left ? 'left' : 'right'}_${arm ? 'arm' : 'shoulder'}`;
  loadAnim(name).then(a => {
    if (u.downT > 0) return;
    u.anim = a; u.animName = name; u.frame = 0; u.animRate = 1;
  });
}

// GE's own death animations, picked by where the shot landed.
const DEATHS = ['death_forward_face_down', 'death_backward_fall_face_up1',
                'death_backward_spin_face_down_right', 'death_fetal_position_left'];
const HEAD_DEATHS = ['death_head', 'death_neck'];
function playDeath(g, head) {
  const u = g.userData;
  if (!u.rig) return;
  const pool = head ? HEAD_DEATHS : DEATHS;
  const name = pool[Math.floor(Math.random() * pool.length)];
  loadAnim(name).then(a => {
    if (u.downT <= 0) return;
    u.anim = a; u.animName = name; u.frame = 0; u.animRate = 1;
    u.downT = Math.max(u.downT, a.frames / 60);
  });
}

/** A guard grunts when hit and thumps when it goes down; a headshot skips the grunt. */
function reactSound(g, at, head) {
  if (!g.userData.enemy) return;
  const dead = g.userData.hp <= 0;
  if (dead) {
    if (BODY_FALL.length)
      play(BODY_FALL[Math.floor(Math.random() * BODY_FALL.length)], { vol: 0.7, at, delay: 0.25 });
    return;
  }
  if (head) return;
  const set = g.userData.female ? HURT_GIRL : HURT_MALE;
  if (set.length) play(set[Math.floor(Math.random() * set.length)], { vol: 0.7, at });
}

function hitMarker() {
  const el = document.getElementById('crosshair');
  el.style.color = '#ff2';
  el.style.fontSize = '30px';
  setTimeout(() => { el.style.color = '#d33'; el.style.fontSize = '22px'; }, 70);
}

// ---- projectiles (rocket / grenade rounds) ----
const projectiles = [];
const EXPLOSIVE = {
  rocketlaunch:  { speed: 26, grav: 0,  radius: 7 },
  grenadelaunch: { speed: 20, grav: 13, radius: 5 },
};
function projMesh(kind) {
  if (kind === 'rocketlaunch') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.42, 8),
      new THREE.MeshLambertMaterial({ color: 0x8a8f66 }));
    body.rotation.x = -Math.PI / 2;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb050, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false }));
    glow.position.z = 0.28;
    g.add(body, glow);
    return g;
  }
  return new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8),
    new THREE.MeshLambertMaterial({ color: 0x3c4a30 }));
}
function fireProjectile(kind, dir) {
  const spec = EXPLOSIVE[kind];
  const m = projMesh(kind);
  if (state.muzzleObj) gunPointWorld(state.muzzleObj, m.position);
  else m.position.copy(cam.position).addScaledVector(dir, 0.9).add(new THREE.Vector3(0, -0.15, 0));
  m.lookAt(m.position.clone().add(dir));
  m.userData = { vel: dir.clone().multiplyScalar(spec.speed), grav: spec.grav,
                 radius: spec.radius, life: 6 };
  scene.add(m);
  projectiles.push(m);
}

// ---- weapon view models ----
// The weapon pass is lit with GE's own gun light, g_WeaponEnvmapLight (gun.c):
// ambient 0x96 grey, white diffuse from direction (0xb2, 0x4d, 0x2e) -- signed
// (-78, 77, 46), i.e. over the player's left shoulder. The gun matrix is
// camera-space, so a fixed light in this scene is exactly what the game does.
const gunScene = new THREE.Scene();
gunScene.add(new THREE.AmbientLight(0xffffff, 0x96 / 255));
const gunLight = new THREE.DirectionalLight(0xffffff, 1.0);
gunLight.position.set(-78, 77, 46);   // direction TO the light, N64 convention
gunScene.add(gunLight, gunLight.target);
const gunMount = new THREE.Group();
gunScene.add(gunMount);

const gunCache = new Map();
async function loadGunModel(name) {
  if (gunCache.has(name)) return gunCache.get(name);
  const p = (async () => {
    // Guns are built from the exporter's skin data rather than the flat OBJ:
    // one mesh per matrix slot, each at its gunfire.c rest position, so the
    // slide, bolt, cylinder and hammer are separately movable -- the same
    // slots gunfire.c drives when the game animates a shot.
    const ml = new MTLLoader().setPath(`${EX}/models/`);
    const [mtl, skin] = await Promise.all([
      ml.loadAsync(`${name}.mtl`),
      fetch(`${EX}/models/${name}.skin.json`, { cache: 'no-cache' }).then(r => r.json()),
    ]);
    mtl.preload();
    const flashGroups = {};          // flash frame -> [materials]

    function makeGunMat(m, seq) {
      const fl = m.name.match(/_fl(\d+)/);
      const lit = /_lit(_|$)/.test(m.name);
      const sec = /_sec(_|$)/.test(m.name);
      const ovl = /_ovl$/.test(m.name);
      // G_CULL_BACK from the display list: only faces the game leaves
      // two-sided render two-sided. DoubleSide everywhere was showing the
      // BACKS of forward-facing detail discs (the sniper's white lens
      // glint) that the game culls away.
      const side = /_ds(_|$)/.test(m.name) ? THREE.DoubleSide : THREE.FrontSide;
      const map = m.map ? applyWrap(m.map, m.name) : null;
      let nm;
      const tid = +(m.name.match(/^tex_(\d+)/) || [0, -1])[1];
      const ie = IMAGES[tid];
      const isEnv = /_env(_|$)/.test(m.name);              // G_TEXTURE_GEN geometry
      const flatCol = ie && ie.w === 1 && ie.h === 1;      // 1x1 = flat colour + texture-gen
      const envStrip = ie && (ie.w === 1 || ie.h === 1);   // 1xN strip = flat/gradient
      if (isEnv && map) {
        // N64 texture generation samples by the VIEW-space normal; a matcap
        // does the same, where baked UVs pinned faces to one texel.
        nm = new THREE.MeshMatcapMaterial({ matcap: map, side });
      } else if (flatCol && lit) {  // 1x1 flat colour = solid tinted metal
        const c = (ie && (ie.opaque || ie.avg)) || [24, 24, 28];
        nm = new THREE.MeshPhongMaterial({
          color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255),
          specular: 0xcccccc, shininess: 26, side });
      } else if (envStrip && lit) { // specular strip texture: keep the texture, untinted
        nm = new THREE.MeshPhongMaterial({ map, specular: 0xbbbbbb,
          shininess: 22, side });
      } else if (lit) {
        // GunLighting: TEXEL0 * SHADE from vertex normals under GE's gun light.
        nm = new THREE.MeshLambertMaterial({ map, side });
      } else {                      // prelit: baked vertex colours
        nm = new THREE.MeshBasicMaterial({ map, side, vertexColors: true });
      }
      if (map && !fl) nm.alphaTest = 0.35;
      if (sec && !fl) {             // Secondary display list: decal on the skin
        nm.transparent = true; nm.depthWrite = false;
        nm.polygonOffset = true; nm.polygonOffsetFactor = -2; nm.polygonOffsetUnits = -2;
      }
      // _ovl faces are geometrically lifted 0.75 units in the exporter, so
      // plain depth testing reproduces the game's DL-order layering; no
      // depth-bias tricks (they proved angle-fragile).
      nm.name = m.name;
      if (fl) {                     // muzzle-flash frames (header Switches[1])
        nm.transparent = true; nm.blending = THREE.AdditiveBlending;
        nm.depthWrite = false; nm.alphaTest = 0;
        nm.visible = false;
        (flashGroups[+fl[1]] = flashGroups[+fl[1]] || []).push(nm);
      }
      return nm;
    }

    const posA = new THREE.Float32BufferAttribute(skin.position, 3);
    const uvA = new THREE.Float32BufferAttribute(skin.uv, 2);
    const colA = new THREE.Float32BufferAttribute(skin.color, 3);
    const nrmA = new THREE.Float32BufferAttribute(skin.normal, 3);
    const vm = skin.vertexMatrix;
    const rest = k => (skin.rest && skin.rest[String(k)]) || [0, 0, 0];

    const obj = new THREE.Group();
    const slotMesh = {};             // slot -> Mesh (movable part)
    const flashMeshes = {};          // flash frame -> [meshes]
    const all = new THREE.Box3();
    const flash = new THREE.Box3();
    const bv = new THREE.Vector3();

    // bucket each material's triangles by the matrix slot they bind to
    const slots = {};                // slot -> [{matName, tris:[...]}]
    for (const [matName, tris] of Object.entries(skin.groups)) {
      const bySlot = {};
      for (let i = 0; i < tris.length; i += 3)
        (bySlot[vm[tris[i]]] = bySlot[vm[tris[i]]] || []).push(tris[i], tris[i+1], tris[i+2]);
      for (const [sl, list] of Object.entries(bySlot))
        (slots[sl] = slots[sl] || []).push({ matName, tris: list });
    }
    // material sequence = first appearance in the DL (skin.groups preserves it)
    const matSeq = {};
    Object.keys(skin.groups).forEach((n, i) => { matSeq[n] = i; });
    for (const [sl, parts] of Object.entries(slots)) {
      const r = rest(sl);
      const isFlashSlot = parts.every(pt => /_fl\d/.test(pt.matName));
      // 'all'/'flash' boxes in baked model space, for muzzle placement
      for (const pt of parts)
        for (const vi of pt.tris) {
          bv.fromBufferAttribute(posA, vi).add(new THREE.Vector3(r[0], r[1], r[2]));
          all.expandByPoint(bv);
          if (/_fl\d/.test(pt.matName)) flash.expandByPoint(bv);
        }
      const solid = parts.filter(pt => !/_fl\d/.test(pt.matName));
      if (solid.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', posA); g.setAttribute('uv', uvA);
        g.setAttribute('color', colA); g.setAttribute('normal', nrmA);
        const index = [], mats = [];
        for (const pt of solid) {
          g.addGroup(index.length, pt.tris.length, mats.length);
          index.push(...pt.tris);
          mats.push(makeGunMat(mtl.create(pt.matName) || new THREE.MeshBasicMaterial(), matSeq[pt.matName]));
        }
        g.setIndex(index);
        const mesh = new THREE.Mesh(g, mats);
        mesh.position.set(r[0], r[1], r[2]);
        mesh.userData.base = new THREE.Vector3(r[0], r[1], r[2]);
        // preserve DL order across meshes so coplanar ties resolve like the
        // game: renderOrder sorts the opaque pass, LessEqualDepth lets the
        // later draw win at equal depth
        mesh.renderOrder = Math.min(...solid.map(pt => matSeq[pt.matName]));
        obj.add(mesh);
        slotMesh[sl] = mesh;
      }
      // flash frames become their own centred meshes so gunfire.c's per-shot
      // random scale and MuzzleFlashExtension stretch can be applied
      for (const pt of parts) {
        const fm = pt.matName.match(/_fl(\d+)/);
        if (!fm) continue;
        const P = [], U = [];
        for (const vi of pt.tris) {
          P.push(posA.getX(vi) + r[0], posA.getY(vi) + r[1], posA.getZ(vi) + r[2]);
          U.push(uvA.getX(vi), uvA.getY(vi));
        }
        const ng = new THREE.BufferGeometry();
        ng.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        ng.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
        ng.computeBoundingBox();
        const c = ng.boundingBox.getCenter(new THREE.Vector3());
        ng.translate(-c.x, -c.y, -c.z);        // scale about the flash centre
        const mesh = new THREE.Mesh(ng, makeGunMat(mtl.create(pt.matName), matSeq[pt.matName]));
        mesh.position.copy(c);
        mesh.visible = false;
        mesh.renderOrder = 1000;               // flashes above everything
        obj.add(mesh);
        (flashMeshes[+fm[1]] = flashMeshes[+fm[1]] || []).push(mesh);
      }
    }
    // the moving parts gunfire.c drives, by slot from the manifest
    const movers = {};
    for (const [label, sl] of Object.entries((MODELS[name] || {}).movers || {}))
      if (slotMesh[sl]) movers[label] = slotMesh[sl];
    // markers: the muzzle is where the flash quads sit (fall back to the front
    // of the model), the eject port is at the action (slide/bolt rest)
    const muzzleObj = new THREE.Object3D();
    if (!flash.isEmpty()) flash.getCenter(muzzleObj.position);
    else { all.getCenter(muzzleObj.position); muzzleObj.position.z = all.max.z; }
    obj.add(muzzleObj);
    const ejectObj = new THREE.Object3D();
    const action = movers.slide || movers.bolt;
    if (action) ejectObj.position.copy(action.userData.base).add(new THREE.Vector3(30, 20, 0));
    else { all.getCenter(ejectObj.position); ejectObj.position.z = all.min.z * 0.3 + all.max.z * 0.7; }
    obj.add(ejectObj);
    return { obj, flashGroups, flashMeshes, all, flash, movers, muzzleObj, ejectObj };
  })();
  gunCache.set(name, p);
  return p;
}

// ---- weapon state ----
const state = {
  key: null, stats: null, gun: null, flashGroups: {},
  ammo: 0, reserve: Infinity, firing: false, nextShot: 0, reloading: false,
  recoil: 0, kick: 0, flashT: 0,
  movers: {}, slideT: 0, cylFrom: 0, cylTo: 0, cylT: 1, hammerT: 0,
  reloadStart: 0, reloadDur: 0,
  // gunfire.c recoil: per hand, ticks since the shot, or -1 when settled
  recoilTicks: [-1, -1], slideTs: [0, 0], gunRest: null,
  zooming: false, fovCur: 0, sniperZoom: 15, adsK: 0,
  dual: false, gunL: null, gunRestL: null, moversL: {}, flashMeshesL: {}, ammoL: 0,
  muzzleObjL: null, ejectObjL: null, dualSide: 0, recoilTickL: -1, slideSide: 0,
  lastSnd: -1,
  ret: { x: 0, y: 0 },          // floating crosshair, NDC
  score: 0, shots: 0, hits: 0,
  hostile: false,               // G: guards return fire (visual only)
  moving: false,
  patrol: false,                // P: some guards walk patrol loops
};

/** World position of a point on the first-person gun. The gun renders in its
 *  own camera-space scene (gunCam at the origin), so a marker's scene position
 *  maps to the world through the player camera's matrix. */
function gunPointWorld(markerObj, out) {
  markerObj.getWorldPosition(out);
  return out.applyMatrix4(cam.matrixWorld);
}

function fireInterval(st) {
  const auto = st.auto_firing_rate_ticks, single = st.single_firing_rate_ticks;
  if (auto !== null && auto !== undefined) return { t: Math.max(auto, 1) / 60, auto: true };
  return { t: Math.max(single <= 0 ? 8 : single, 4) / 60, auto: false };
}

async function selectWeapon(key) {
  const st = activeStats(key);          // stock ROM stats, or the editor's tune
  const modelName = `G${key}Z`;
  if (!MODELS[modelName]) return;
  state.key = key; state.stats = st;
  state.zooming = false;
  state.ammo = st.mag_size > 0 ? st.mag_size : Infinity;
  state.ammoL = (state.dual && st.flags.includes('CAN_DUAL_WIELD') && st.mag_size > 0) ? st.mag_size : 0;
  state.reloading = false;
  document.querySelectorAll('#picker button').forEach(b =>
    b.classList.toggle('sel', b.dataset.key === key));
  const { obj, flashGroups, flashMeshes, movers, muzzleObj, ejectObj } = await loadGunModel(modelName);
  if (state.key !== key) return;
  gunMount.clear();
  const P = window.__P;
  const holder = new THREE.Group();
  // Weapon models are authored with the muzzle at +z: across every gun the
  // flash matrix sits at the model's z maximum (DD44 298/298, PP7 201/201,
  // sniper 804/804, shotgun 678/678). So the barrel direction is a fixed
  // convention, not something to infer per-model -- deriving it from flash
  // mesh bounds was fragile and had the DD44 pointing sideways.
  // Detach and reset before measuring: Box3.setFromObject uses WORLD bounds, so
  // a model still parented to the previous holder would be measured through that
  // holder's scale -- giving a tiny size and, in turn, an enormous new scale.
  // That was the burst of distorted geometry when cycling weapons quickly.
  // Placement comes straight from the ROM rather than being fitted per weapon.
  // gunfire.c builds the weapon matrix in camera space: the basis is the camera
  // basis scaled by IDO_POINT_ONE (0.1), and the position is the WeaponStats
  // PosX/PosY/PosZ. So a model unit is 0.1 GE units, and a GE unit is one
  // centimetre -- the KF7 measures 853 model units end to end, i.e. 85.3 cm
  // against a real 87 cm weapon, and the shotgun (74.8) and sniper rifle
  // (109.2) agree just as closely. One constant converts to metres and the
  // ROM's own offsets do the rest, which is what makes the KF7 fill the screen
  // at PosZ -16 while the PP7 sits small and far forward at -33.5.
  const GE_CM = 0.01;                     // 1 GE unit -> metres
  const [gx, gy, gz] = st.vfx.gun_screen_pos;
  obj.removeFromParent();
  obj.position.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  obj.rotation.set(0, Math.PI, 0);        // muzzle +z -> camera forward -z
  holder.add(obj);
  holder.scale.setScalar(0.1 * GE_CM * P.scale);
  holder.position.set(gx * GE_CM * P.pos, gy * GE_CM * P.pos, gz * GE_CM * P.pos);
  holder.rotation.set(P.rx, P.ry, P.rz);
  state.gunRest = { pos: holder.position.clone(), rot: holder.rotation.clone() };
  gunMount.add(holder);
  gunMount.scale.setScalar(1);
  // GE dual wield: any CAN_DUAL_WIELD weapon takes a second copy in the left
  // hand at -PosX (gunSetHorizontalOffset for GUNLEFT), and MIRROR_DUAL ones
  // render x-mirrored -- gunfire.c negates the gun matrix's first column.
  state.gunL = null; state.moversL = {}; state.flashMeshesL = {};
  state.muzzleObjL = null; state.ejectObjL = null; state.recoilTickL = -1;
  if (state.dual && st.flags.includes('CAN_DUAL_WIELD')) {
    const objL = obj.clone(true);
    // match cloned nodes to originals by traversal order
    const orig = [], copy = [];
    obj.traverse(o => orig.push(o));
    objL.traverse(o => copy.push(o));
    const twin = o => copy[orig.indexOf(o)];
    const moversL = {};
    for (const [lbl, m] of Object.entries(movers)) moversL[lbl] = twin(m);
    const flashMeshesL = {};
    for (const [f, arr] of Object.entries(flashMeshes)) flashMeshesL[f] = arr.map(twin);
    const holderL = new THREE.Group();
    holderL.add(objL);
    holderL.scale.copy(holder.scale);
    if (st.flags.includes('MIRROR_DUAL')) {
      holderL.scale.x *= -1;
      // mirroring flips triangle winding: single-sided materials must cull
      // the opposite face on this copy, so it gets its own swapped clones
      objL.traverse(o => {
        if (!o.isMesh) return;
        const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(mm => {
          if (mm.side === THREE.DoubleSide) return mm;
          const c2 = mm.clone();
          c2.side = mm.side === THREE.FrontSide ? THREE.BackSide : THREE.FrontSide;
          return c2;
        });
        o.material = Array.isArray(o.material) ? mats : mats[0];
      });
    }
    holderL.position.set(-gx * GE_CM * P.pos, gy * GE_CM * P.pos, gz * GE_CM * P.pos);
    holderL.rotation.copy(holder.rotation);
    gunMount.add(holderL);
    state.gunL = holderL;
    state.gunRestL = { pos: holderL.position.clone(), rot: holderL.rotation.clone() };
    state.moversL = moversL;
    state.flashMeshesL = flashMeshesL;
    state.muzzleObjL = twin(muzzleObj);
    state.ejectObjL = twin(ejectObj);
  }
  state.gun = holder; state.flashGroups = flashGroups; state.flashMeshes = flashMeshes;
  state.movers = movers; state.slideTs = [0, 0]; state.recoilTicks = [-1, -1];
  state.cylFrom = [0, 0]; state.cylTo = [0, 0]; state.cylT = [1, 1]; state.hammerT = [0, 0];
  state.muzzleObj = muzzleObj; state.ejectObj = ejectObj;
  updateHud();
  renderEditor();
  loadBuf(soundById(parseInt(st.sound_id, 16)));
}

// Per-parameter bar chart, normalised against the whole rack so a bar means
// the same thing on every weapon. Values are the ROM's own numbers.
const STAT_ROWS = [
  { label: 'damage',  get: st => st.damage },
  { label: 'rate',    get: st => Math.round(60 / fireInterval(st).t), unit: 'rpm' },
  { label: 'mag',     get: st => st.mag_size },
  { label: 'spread',  get: st => st.inaccuracy },
  { label: 'recoil',  get: st => st.vfx.recoil_up },
  { label: 'kick',    get: st => st.vfx.recoil_back },
  { label: 'pierce',  get: st => st.penetration_objects },
  { label: 'noise',   get: st => st.ai_noise.loudness_max },
];
// Robust scale: the Golden Gun's damage (100, against the Ruger's 2.5) would
// flatten every other bar, so when the top value is a big outlier the scale is
// the runner-up and the outlier clamps at full.
const STAT_MAX = STAT_ROWS.map(r => {
  // distinct values, descending; the scale is the largest one that is not a
  // >3x outlier over the next (both golden guns tie at damage 100, so ties
  // must collapse before the outlier test)
  const u = [...new Set(ROSTER.map(k => r.get(WEAPONS[k]) || 0))].sort((a, b) => b - a);
  let scale = u[u.length - 1] || 0;
  for (let i = 0; i < u.length - 1; i++)
    if (u[i] <= 3 * u[i + 1]) { scale = u[i]; break; }
  return Math.max(scale, 1e-6);
});

function statBars(st) {
  return STAT_ROWS.map((r, i) => {
    const v = r.get(st) || 0;
    const pct = Math.min(100, v / STAT_MAX[i] * 100);
    const txt = (Number.isInteger(v) ? v : v.toFixed(1)) + (r.unit ? ' ' + r.unit : '');
    return `<div class="sbrow"><span class="sbl">${r.label}</span>` +
      `<span class="sbt"><span class="sbf" style="width:${pct.toFixed(1)}%"></span></span>` +
      `<span class="sbv">${txt}</span></div>`;
  }).join('');
}

function updateHud() {
  const st = state.stats;
  if (!st) return;
  document.getElementById('wname').textContent = (DISPLAY[state.key] || state.key)
    + (MODS[state.key] && MODS[state.key].on ? ' ⚙TUNED' : '');
  const fmt = n => n === Infinity ? '∞'
    : `<span class="ge-reserve">∞</span> <span class="ge-bullet">▮</span> ${n}`;
  document.getElementById('ammo').innerHTML =
    state.reloading ? '<small>RELOADING…</small>' : fmt(state.ammo);
  const al = document.getElementById('ammoL');
  if (al) al.innerHTML = state.gunL
    ? (state.reloading ? '<small>RELOADING…</small>' : fmt(state.ammoL)) : '';
  const fi = fireInterval(st);
  document.getElementById('stats').innerHTML =
    `<b>${DISPLAY[state.key] || state.key}</b> · ${fi.auto ? 'auto' : 'single'}` +
    ` · ${(st.sound_name || '').replace('_SFX','').toLowerCase()}<br>` +
    statBars(st);
  document.getElementById('score').innerHTML =
    `hits <b>${state.hits}</b> / ${state.shots} &nbsp; score <b>${state.score}</b>`;
}

// ---- weapon editor ----
// WEAPONS keeps the ROM's own numbers untouched; edits live in a per-weapon
// deep clone here, and `on` flips which of the two state.stats points at.
// Everything the sim reads (fire rate, spread, recoil, zoom...) is read live
// per shot/frame, so a swap or slider drag takes effect on the very next one.
const MODS = {};                        // key -> { stats: clone, on: bool }
function activeStats(key) {
  const m = MODS[key];
  return m && m.on ? m.stats : WEAPONS[key];
}
function modFor(key) {
  if (!MODS[key]) MODS[key] = { stats: JSON.parse(JSON.stringify(WEAPONS[key])), on: false };
  return MODS[key];
}
const edGet = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
function edSet(o, p, v) {
  const ks = p.split('.'), last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}
// One row per WeaponStats field the gallery reads (plus the two the sim
// doesn't use yet, marked °). auto ticks is nullable: null = semi-auto,
// so it gets a checkbox that writes null when cleared.
const ED_FIELDS = [
  { path: 'damage',                     label: 'damage',       min: 0,   max: 100, step: 0.1 },
  { path: 'auto_firing_rate_ticks',     label: 'auto ticks',   min: 1,   max: 30,  step: 1, nullable: true },
  { path: 'single_firing_rate_ticks',   label: 'single ticks', min: 0,   max: 60,  step: 1 },
  { path: 'mag_size',                   label: 'mag size',     min: 0,   max: 100, step: 1 },
  { path: 'inaccuracy',                 label: 'spread',       min: 0,   max: 60,  step: 0.5 },
  { path: 'penetration_objects',        label: 'pierce',       min: 0,   max: 10,  step: 1 },
  { path: 'zoom_fov',                   label: 'zoom fov',     min: 0,   max: 60,  step: 1 },
  { path: 'crosshair_speed',            label: 'xhair speed',  min: 0,   max: 2,   step: 0.05 },
  { path: 'sound_trigger_rate',         label: 'snd every',    min: 0,   max: 10,  step: 1 },
  { path: 'ai_noise.loudness_max',      label: 'ai loudness',  min: 0,   max: 200, step: 1 },
  { path: 'force_of_impact',            label: 'impact °',     min: 0,   max: 20,  step: 0.5 },
  { path: 'aim_lock_speed',             label: 'aim lock °',   min: 0,   max: 1,   step: 0.01 },
  { path: 'vfx.recoil_up',              label: 'recoil up',    min: 0,   max: 30,  step: 0.1 },
  { path: 'vfx.recoil_back',            label: 'recoil back',  min: 0,   max: 30,  step: 0.1 },
  { path: 'vfx.bolt_recoil_back',       label: 'slide travel', min: 0,   max: 30,  step: 0.1 },
  { path: 'vfx.muzzle_flash_extension', label: 'flash size',   min: 0,   max: 10,  step: 0.1 },
  { path: 'vfx.sway',                   label: 'sway',         min: 0,   max: 5,   step: 0.05 },
  { path: 'vfx.ejects_cartridges',      label: 'eject brass',  bool: true },
  { path: 'vfx.gun_screen_pos.0',       label: 'gun x',        min: -40, max: 40,  step: 0.5 },
  { path: 'vfx.gun_screen_pos.1',       label: 'gun y',        min: -40, max: 40,  step: 0.5 },
  { path: 'vfx.gun_screen_pos.2',       label: 'gun z',        min: -40, max: 40,  step: 0.5 },
  { path: 'vfx.gun_play.0',             label: 'play x',       min: 0,   max: 20,  step: 0.5 },
  { path: 'vfx.gun_play.1',             label: 'play y',       min: 0,   max: 20,  step: 0.5 },
  { path: 'vfx.gun_play.2',             label: 'play z',       min: 0,   max: 20,  step: 0.5 },
];

/** Re-point state.stats after an edit or A/B swap and refresh what depends on it. */
function applyStats() {
  const st = activeStats(state.key);
  state.stats = st;
  // mag ammo is a snapshot taken at weapon select; re-snapshot within the new cap
  state.ammo = st.mag_size > 0
    ? Math.min(state.ammo === Infinity ? st.mag_size : state.ammo, st.mag_size) : Infinity;
  if (state.gunL) state.ammoL = st.mag_size > 0 ? Math.min(state.ammoL, st.mag_size) : 0;
  // gun_screen_pos was baked into the holder's rest pose at build time; the
  // per-frame sway/recoil recomputes from gunRest, so updating that is enough
  const GE_CM = 0.01, P = window.__P;
  const [gx, gy, gz] = st.vfx.gun_screen_pos;
  if (state.gunRest) state.gunRest.pos.set(gx * GE_CM * P.pos, gy * GE_CM * P.pos, gz * GE_CM * P.pos);
  if (state.gunRestL) state.gunRestL.pos.set(-gx * GE_CM * P.pos, gy * GE_CM * P.pos, gz * GE_CM * P.pos);
  updateHud();
  refreshEditor();
}

function toggleTuned() {
  const m = MODS[state.key];
  if (!m) return;                       // nothing edited on this weapon yet
  m.on = !m.on;
  applyStats();
}

const edRows = [];                      // live input refs for refresh-in-place
function renderEditor() {
  const el = document.getElementById('editor');
  const btn = document.getElementById('edbtn');
  if (!el || !btn) return;
  btn.classList.toggle('sel', !!state.editorOpen);
  el.style.display = state.editorOpen ? '' : 'none';
  if (!state.editorOpen) return;
  const key = state.key;
  const m = MODS[key];
  edRows.length = 0;
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'edhead';
  head.innerHTML = `<h3 style="flex:1">${DISPLAY[key] || key}</h3>`;
  const ab = document.createElement('button');
  ab.id = 'edab';
  ab.onclick = toggleTuned;
  const rs = document.createElement('button');
  rs.textContent = 'reset';
  rs.onclick = () => { delete MODS[key]; applyStats(); renderEditor(); };
  head.append(ab, rs);
  el.appendChild(head);
  const stMod = m ? m.stats : WEAPONS[key];   // rows show the tune-in-progress
  for (const f of ED_FIELDS) {
    const orig = edGet(WEAPONS[key], f.path);
    if (orig === undefined) continue;         // field absent on this weapon
    const row = document.createElement('div');
    row.className = 'edrow';
    const lab = document.createElement('label');
    lab.textContent = f.label;
    lab.title = f.path;
    row.appendChild(lab);
    if (f.bool) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!edGet(stMod, f.path);
      cb.onchange = () => onEdit(f, cb.checked);
      row.appendChild(cb);
      edRows.push({ f, row, cb });
    } else {
      let cb = null;
      if (f.nullable) {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.title = 'off = semi-auto (null)';
        row.appendChild(cb);
      }
      const rng = document.createElement('input');
      rng.type = 'range';
      rng.min = f.min; rng.max = f.max; rng.step = f.step;
      const num = document.createElement('input');
      num.type = 'number';
      num.min = f.min; num.max = f.max; num.step = f.step;
      const cur = edGet(stMod, f.path);
      rng.value = num.value = cur ?? f.min;
      if (cb) {
        cb.checked = cur != null;
        rng.disabled = num.disabled = cur == null;
        cb.onchange = () => onEdit(f, cb.checked ? +rng.value : null);
      }
      rng.oninput = () => { num.value = rng.value; onEdit(f, +rng.value); };
      num.onchange = () => { rng.value = num.value; onEdit(f, +num.value); };
      row.append(rng, num);
      edRows.push({ f, row, rng, num, cb });
    }
    el.appendChild(row);
    // the two tick fields ARE the fire rate, in the ROM's 60 Hz-tick unit --
    // show the resulting rounds/minute so the number means something
    if (f.path === 'single_firing_rate_ticks') {
      const rr = document.createElement('div');
      rr.className = 'edrow';
      rr.innerHTML = '<label>= rate</label><span id="edratev" style="color:#fff"></span>';
      el.appendChild(rr);
    }
  }
  const note = document.createElement('div');
  note.className = 'ednote';
  note.textContent = 'Values are the ROM’s own units. Gold = differs from stock. '
    + '° = extracted but not used by this range sim yet. V swaps stock/tuned.';
  el.appendChild(note);
  refreshEditor();
}

/** Update highlights/toggle text without rebuilding rows (keeps slider focus). */
function refreshEditor() {
  const ab = document.getElementById('edab');
  if (!ab) return;
  const m = MODS[state.key];
  ab.textContent = m && m.on ? 'TUNED' : 'STOCK';
  ab.classList.toggle('on', !!(m && m.on));
  const stMod = m ? m.stats : WEAPONS[state.key];
  const rv = document.getElementById('edratev');
  if (rv) {
    const fi = fireInterval(stMod);
    const fo = fireInterval(WEAPONS[state.key]);
    rv.textContent = `${Math.round(60 / fi.t)} rpm (${fi.auto ? 'full-auto' : 'semi'})`
      + (fi.t !== fo.t || fi.auto !== fo.auto ? ` · stock ${Math.round(60 / fo.t)}` : '');
  }
  for (const r of edRows) {
    const orig = edGet(WEAPONS[state.key], r.f.path);
    const cur = edGet(stMod, r.f.path);
    r.row.classList.toggle('mod', cur !== orig);
    if (r.f.bool) { if (document.activeElement !== r.cb) r.cb.checked = !!cur; continue; }
    if (r.cb) {
      r.cb.checked = cur != null;
      r.rng.disabled = r.num.disabled = cur == null;
    }
    if (cur != null && document.activeElement !== r.num && document.activeElement !== r.rng)
      r.rng.value = r.num.value = cur;
  }
}

function onEdit(f, v) {
  if (v !== null && typeof v === 'number' && !Number.isFinite(v)) return;
  const m = modFor(state.key);
  edSet(m.stats, f.path, v);
  m.on = true;                          // editing means "let me feel it"
  applyStats();
}

document.getElementById('edbtn').onclick = () => {
  state.editorOpen = !state.editorOpen;
  renderEditor();
};

// ---- firing ----
const CLIPOUT = soundByName('GUN_CLIPOUT_SFX') || soundByName('GUN_CLIP_OUT_SFX');
const CLIPIN = soundByName('GUN_CLIPIN_SFX') || soundByName('GUN_CLIP_IN_SFX');
const DRYFIRE = soundByName('CLICK_SFX') || soundByName('BEEP_QUIET_SFX');

function reload() {
  const st = state.stats;
  if (state.reloading || !st || st.mag_size <= 0
      || (state.ammo === st.mag_size && (!state.gunL || state.ammoL === st.mag_size))) return;
  state.reloading = true;
  state.reloadStart = performance.now() / 1000;
  state.reloadDur = 1.4;
  updateHud();
  if (CLIPOUT) play(CLIPOUT, { vol: 0.45 });
  setTimeout(() => { if (CLIPIN) play(CLIPIN, { vol: 0.45 }); }, 700);
  setTimeout(() => {
    state.ammo = st.mag_size;
    if (state.gunL) state.ammoL = st.mag_size;
    state.reloading = false; updateHud();
  }, 1400);
}

function shoot(now) {
  const st = state.stats;
  if (!st || state.reloading) return;
  const dualUp = !!state.gunL;
  const altFire = dualUp && st.flags.includes('DUAL_WIELD_ALTERNATING_FIRE');
  if (state.ammo <= 0 && (!dualUp || state.ammoL <= 0)) {
    if (DRYFIRE) play(DRYFIRE, { vol: 0.3 });
    state.nextShot = now + 0.25;
    reload();
    return;
  }
  // which hand(s) shoot: alternating duals swap sides per trigger pull and
  // skip an empty hand; simultaneous duals fire both together
  let sides;
  if (altFire) {
    state.dualSide = 1 - state.dualSide;
    if (state.dualSide === 1 && state.ammoL <= 0) state.dualSide = 0;
    if (state.dualSide === 0 && state.ammo <= 0) state.dualSide = 1;
    sides = [state.dualSide];
  } else if (dualUp) {
    sides = [];
    if (state.ammo > 0) sides.push(0);
    if (state.ammoL > 0) sides.push(1);
  } else sides = [0];
  for (const sd of sides) { if (sd === 0) state.ammo--; else state.ammoL--; }
  state.shots += sides.length;
  // SoundTriggerRate: automatics only retrigger the gunshot sample every N
  // ticks (KF7 4, AR33 5, RC-P90 2) -- at full auto the samples would overlap.
  const strate = st.sound_trigger_rate;
  if (!strate || now - state.lastSnd >= strate / 60 - 1e-4) {
    play(soundById(parseInt(st.sound_id, 16)), { vol: 0.55, pitch: 0.97 + Math.random() * 0.06 });
    state.lastSnd = now;
  }

  // gunfire.c noise: firing while the range is hot draws return fire sooner,
  // scaled by the weapon's AI loudness
  if (state.hostile) {
    const loud = Math.min(1, (st.ai_noise.loudness_max || 0) / 25);
    const tnow = performance.now() / 1000;
    for (const t of targets)
      if (t.userData.enemy && t.userData.wkey && t.userData.downT <= 0 && Math.random() < loud * 0.35)
        t.userData.nextFire = Math.min(t.userData.nextFire, tnow + 0.6 + Math.random() * 1.5);
  }
  // spread: inaccuracy in GE arbitrary units; scale to radians
  const spread = st.inaccuracy * 0.0022;
  const pellets = (state.key === 'shotgun' || state.key === 'autoshot') ? 5 : 1;
  // shots go through the floating crosshair, not the screen centre
  raycaster.setFromCamera(new THREE.Vector2(state.ret.x, state.ret.y), cam);
  const aim = raycaster.ray.direction.clone().normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  // one round per firing hand (five pellets for the single-hand shotgun)
  const rounds = [];
  for (const sd of sides) for (let pi = 0; pi < pellets; pi++) rounds.push(sd);
  let pi = -1;
  for (const sd of rounds) {
    pi++;
    const mo = sd === 0 ? state.muzzleObj : state.muzzleObjL;
    const muzzle = mo ? gunPointWorld(mo, new THREE.Vector3())
      : cam.position.clone()
        .addScaledVector(right, 0.22).addScaledVector(up, -0.18).addScaledVector(aim, 0.6);
    const dir = aim.clone()
      .addScaledVector(right, (Math.random()-0.5)*spread)
      .addScaledVector(up, (Math.random()-0.5)*spread)
      .normalize();
    if (EXPLOSIVE[state.key]) { fireProjectile(state.key, dir); continue; }
    raycaster.set(cam.position, dir);
    raycaster.far = 300;
    const allHits = raycaster.intersectObjects(solidObjects(), true);
    // Penetration: the round passes through up to PenetrationObjects bodies
    // (Ruger 10, RC-P90 3, AR33 2); anything that is not an enemy stops it.
    const hits = [];
    const seenRoots = new Set();
    for (const hh of allHits) {
      let root = hh.object;
      while (root.parent && !root.userData.hit) root = root.parent;
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      hits.push(hh);
      if (!root.userData.enemy || hits.length >= (st.penetration_objects || 1)) break;
    }
    const end = hits.length ? hits[hits.length - 1].point
      : cam.position.clone().addScaledVector(dir, 130);
    spawnTracer(muzzle, end);
    for (const h of hits) {
      let g = h.object;
      while (g.parent && !g.userData.hit) g = g.parent;
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
                       : dir.clone().negate();
      if (g.userData.glassPane) { shatterGlassPane(g); continue; }
      // chraction.c handles_shot_actors: the part decides everything below
      const bp = g.userData.enemy ? resolveBodyPart(g, h) : null;
      const kind = bp ? bp.sound
        : g.userData.isLevel ? levelFaceMaterial(h.object, h.face)
        : (g.userData.hit || 'other');
      impactFX(kind, h.point, n);
      hitReact(g);
      if (g.userData.rig && (!bp || bp.mult > 0)) playFlinch(g, bp);
      if (g.userData.hp !== Infinity && g.userData.downT <= 0) {
        if (pi === 0) state.hits++;
        hitMarker();
        const mult = bp ? bp.mult : 1;
        const head = bp ? bp.head : false;
        if (bp && bp.dropHat) dropHat(g, bp.object);
        const dmg = st.damage * mult;
        g.userData.hp -= dmg;
        if (g.userData.enemy) {
          spawnDamageNumber(h.point, dmg, mult);
          if (dmg > 0) g.userData.lastDmg = dmg;
          updateHpBar(g);
        }
        state.score += Math.max(1, Math.round(-g.position.z)) * (head ? 2 : 1);
        if (mult > 0) reactSound(g, h.point, head);
        if (g.userData.hp <= 0) {
          g.userData.downT = 3.4;
          state.score += 50;
          playDeath(g, head);
        }
      }
    }
  }
  // The recoil kicks the aim cursor AFTER the rounds have left -- the bullet
  // is gone before the gun moves, so the first shot lands exactly where the
  // cursor pointed and only follow-ups climb. (Kicking before the ray made
  // the Cougar Magnum throw its own first round high.)
  state.ret.y = Math.min(0.13, state.ret.y + st.vfx.recoil_up * 0.0045);
  state.ret.x = Math.max(-0.16, Math.min(0.16,
    state.ret.x + (Math.random() - 0.5) * st.vfx.recoil_up * 0.0022));
  state.flashT = 0.055;
  // gunfire.c cycles the fired hand's action: slide/bolt throw back by
  // BoltRecoilBack and return; a revolver advances its cylinder and drops the
  // hammer. Each firing hand also starts its own recoil envelope.
  state.curFlash = [];
  for (const sd of sides) {
    const movers = sd === 0 ? state.movers : state.moversL;
    if (st.vfx.recoil_up > 0 || st.vfx.recoil_back > 0) state.recoilTicks[sd] = 0;
    if ((movers.slide || movers.bolt) && st.vfx.bolt_recoil_back > 0) state.slideTs[sd] = 1;
    if (movers.cylinder) {
      state.cylFrom[sd] = state.cylTo[sd]; state.cylTo[sd] += Math.PI / 3; state.cylT[sd] = 0;
    }
    if (movers.hammer) state.hammerT[sd] = 1;
    const fm = sd === 0 ? state.flashMeshes : state.flashMeshesL;
    const kids = Object.keys(fm || {});
    if (kids.length) {
      const j = kids[Math.floor(Math.random() * kids.length)];
      const s = 1 + Math.random() * 0.25;              // gunfire.c flashscale
      const ext = st.vfx.muzzle_flash_extension || 1;  // stretch along the barrel
      const spin = Math.random() * Math.PI * 2;
      for (const m of fm[j]) {
        m.visible = true;
        m.scale.set(s, s, s * ext);
        m.rotation.z = spin;
        state.curFlash.push(m);
      }
    }
    if (st.vfx.ejects_cartridges) spawnCasing(sd);
  }
  updateHud();
}

// ---- input ----
const look = { yaw: 0, pitch: 0 };
// WASD movement. GE's own quirk is kept deliberately: forward+strafe are NOT
// normalised, so diagonals run ~1.4x -- the classic GE/PD speedrun strafe.
const keys = new Set();
const MOVE_SPEED = 5.0;                  // m/s, Bond's full run
function moveTick(dt) {
  if (!locked) return;
  let mx = 0, mz = 0;
  if (keys.has('KeyW')) mz += 1;
  if (keys.has('KeyS')) mz -= 1;
  if (keys.has('KeyD')) mx += 1;
  if (keys.has('KeyA')) mx -= 1;
  state.moving = !!(mx || mz);
  if (!state.moving) return;
  const sy = Math.sin(look.yaw), cy = Math.cos(look.yaw);
  const dx = (-sy * mz + cy * mx) * MOVE_SPEED * dt;
  const dz = (-cy * mz - sy * mx) * MOVE_SPEED * dt;
  if (LEVEL === 'dam') {
    if (!DAM.ready) { state.moving = false; return; }
    const nx = cam.position.x + dx, nz = cam.position.z + dz;
    const len = Math.hypot(dx, dz);
    // wall: chest-height ray along the move; ground: step must stay walkable
    _dray.set(new THREE.Vector3(cam.position.x, DAM.groundY + 0.9, cam.position.z),
              new THREE.Vector3(dx / len, 0, dz / len));
    _dray.far = len + 0.35;
    if (_dray.intersectObjects(damNear(nx, nz), false).length) { state.moving = false; return; }
    const g = damGround(nx, nz);
    if (g === null || Math.abs(g - DAM.groundY) > 1.1) { state.moving = false; return; }
    cam.position.x = nx; cam.position.z = nz;
    DAM.groundY = g;
    // same cylinder push-out as the range: no walking through guards or crates
    for (const t of targets) {
      if (t.userData.dead) continue;
      const dx2 = cam.position.x - t.position.x, dz2 = cam.position.z - t.position.z;
      const d2 = dx2 * dx2 + dz2 * dz2;
      if (d2 > 1e-6 && d2 < 0.45 * 0.45) {
        const dd = Math.sqrt(d2);
        cam.position.x = t.position.x + dx2 / dd * 0.45;
        cam.position.z = t.position.z + dz2 / dd * 0.45;
      }
    }
    return;
  }
  cam.position.x += dx;
  cam.position.z += dz;
  // stay inside the range walls
  cam.position.x = Math.max(-RANGE_W / 2 + 0.4, Math.min(RANGE_W / 2 - 0.4, cam.position.x));
  cam.position.z = Math.max(-RANGE_L + 6.6, Math.min(5.4, cam.position.z));
  // don't walk through guards or props: cylinder push-out
  for (const t of targets) {
    const dx = cam.position.x - t.position.x, dz = cam.position.z - t.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 1e-6 && d2 < 0.45 * 0.45) {
      const dd = Math.sqrt(d2);
      cam.position.x = t.position.x + dx / dd * 0.45;
      cam.position.z = t.position.z + dz / dd * 0.45;
    }
  }
}
document.addEventListener('keyup', e => keys.delete(e.code));
let locked = false;
canvas.addEventListener('click', () => {
  if (!locked) {
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    actx.resume();
    startMusic();
  }
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  document.getElementById('msg').style.display = locked ? 'none' : '';
});
document.addEventListener('mousemove', e => {
  if (!locked) return;
  const sens = 0.0022 * (state.fovCur ? Math.min(1, state.fovCur / 46.8) : 1);
  look.yaw -= e.movementX * sens;
  look.pitch -= e.movementY * sens;
  look.pitch = Math.max(-1.35, Math.min(1.35, look.pitch));
  // the crosshair leads the turn and eases back (GE floating aim)
  state.ret.x = Math.max(-0.16, Math.min(0.16, state.ret.x + e.movementX * 0.0009));
  state.ret.y = Math.max(-0.13, Math.min(0.13, state.ret.y - e.movementY * 0.0009));
});
document.addEventListener('mousedown', e => {
  if (locked && e.button === 0) state.firing = true;
  if (locked && e.button === 2) {
    // scoped weapons: tap toggles the zoom (a quick click-and-release was
    // unzooming before the ease was even visible); others: hold to aim
    if (state.stats && state.stats.zoom_fov > 0) state.zooming = !state.zooming;
    else state.zooming = true;
  }
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) state.firing = false;
  if (e.button === 2 && !(state.stats && state.stats.zoom_fov > 0)) state.zooming = false;
});
document.addEventListener('contextmenu', e => { if (locked) e.preventDefault(); });
function toggleHostile() {
  state.hostile = !state.hostile;
  if (state.hostile) {
    // stagger the first volleys so the whole range doesn't open up at once
    const now = performance.now() / 1000;
    for (const t of targets)
      if (t.userData.enemy) t.userData.nextFire = now + 1 + Math.random() * 6;
  }
  const el = document.getElementById('hostile');
  if (el) el.textContent = state.hostile ? 'RANGE IS HOT' : '';
}
document.addEventListener('keydown', e => {
  // typing in the weapon editor's number fields must not fire game hotkeys
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  keys.add(e.code);
  if (e.code === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyG') toggleHostile();
  if (e.code === 'KeyX' && state.stats && state.stats.flags.includes('CAN_DUAL_WIELD')) {
    state.dual = !state.dual;
    selectWeapon(state.key);      // rebuild with or without the left hand
  }
  if (e.code === 'KeyP') {
    state.patrol = !state.patrol;
    const el = document.getElementById('patrol');
    if (el) el.textContent = state.patrol ? 'PATROLS OUT' : '';
  }
  if (e.code === 'KeyR') reload();
  if (e.code === 'KeyE') { state.editorOpen = !state.editorOpen; renderEditor(); }
  if (e.code === 'KeyV') toggleTuned();
  if (e.code === 'Minus') master.gain.value = Math.max(0, master.gain.value - 0.05);
  if (e.code === 'Equal') master.gain.value = Math.min(1, master.gain.value + 0.05);
  if (e.code === 'BracketRight') cycle(1);
  if (e.code === 'BracketLeft') cycle(-1);
});
document.addEventListener('wheel', e => {
  // scrolling the weapon editor panel must not switch weapons underneath it
  if (e.target && e.target.closest && e.target.closest('#editor')) return;
  // while the sniper is zoomed the wheel drives its 6.1..60 degree zoom range
  // (camera_sniper_zoom_in/out); otherwise it switches weapons
  if (state.zooming && state.key === 'sniperrifle') {
    state.sniperZoom = Math.max(6.1, Math.min(60, state.sniperZoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
    return;
  }
  cycle(e.deltaY > 0 ? 1 : -1);
});
function cycle(d) {
  const list = roster;
  const i = (list.indexOf(state.key) + d + list.length) % list.length;
  selectWeapon(list[i]);
}

// ---- weapon picker ----
const roster = ROSTER.filter(k => WEAPONS[k] && MODELS[`G${k}Z`]);
const picker = document.getElementById('picker');
for (const k of roster) {
  const b = document.createElement('button');
  b.textContent = DISPLAY[k] || k;
  b.dataset.key = k;
  b.onclick = () => selectWeapon(k);
  picker.appendChild(b);
}

// ---- GE levels: real mission geometry decoded from the bg segment ----
// One OBJ per level, one mesh per room; extract_bg.py keeps raw bg-file
// coordinates, so everything (rooms, setup pads) shares one conversion:
// world units = bg units / levelscale (bgroomtrans.c), and 1 world unit = 1 cm.
const DAM = { ready: false, rooms: [], groundY: 0 };
const _dray = new THREE.Raycaster();
function damNear(x, z, pad = 1.5) {
  const out = [];
  for (const r of DAM.rooms) {
    const b = r.userData.bbox;
    if (b && x > b.min.x - pad && x < b.max.x + pad &&
             z > b.min.z - pad && z < b.max.z + pad) out.push(r);
  }
  return out;
}
function damGround(x, z, up = 1.6, down = 8, baseY = null) {
  const base = baseY !== null ? baseY : (DAM.ready ? DAM.groundY : cam.position.y);
  _dray.set(new THREE.Vector3(x, base + up, z), new THREE.Vector3(0, -1, 0));
  _dray.far = up + down;
  const h = _dray.intersectObjects(damNear(x, z), false)[0];
  return h ? h.point.y : null;
}
/** What bullets and grenades collide with: the targets plus the surrounding level. */
function solidObjects() {
  return (LEVEL === 'dam' ? targets.concat(DAM.rooms) : targets.concat(RANGE_BG.rooms))
    .concat(GLASS_PANES);
}

/** Load an extract_bg.py level: one mesh per room, GE materials, world scaled
 *  to metres (bg units x 1/levelscale = cm). Shared by the dam and the range's
 *  runway backdrop. */
async function loadLevelGeometry(name) {
  const [mtl, meta] = await Promise.all([
    new MTLLoader().setPath(`${EX}/levels/`).loadAsync(`${name}.mtl`),
    fetch(`${EX}/levels/${name}.json`, { cache: 'no-cache' }).then(r => r.json()),
  ]);
  mtl.preload();
  const obj = await new OBJLoader().setMaterials(mtl).setPath(`${EX}/levels/`).loadAsync(`${name}.obj`);
  const S = meta.world_per_bg * 0.01;    // bg units -> world units (cm) -> metres
  obj.scale.setScalar(S);
  const rooms = [];
  obj.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map(m => {
      const nm = geMaterial(m);
      // bg geometry is authored against a mix of cull states the room DLs set
      // as they go; double-sided keeps every wall present from both sides
      nm.side = THREE.DoubleSide;
      if (m.opacity !== undefined && m.opacity < 1) {   // MTL "d" = mean vertex alpha (_sec pass)
        nm.transparent = true; nm.opacity = m.opacity; nm.depthWrite = false;
      }
      return nm;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    // isLevel: hit material comes from the actual face's texture (levelFaceMaterial),
    // not one hit type for the whole room -- a room can span stone, water and glass.
    o.userData = { hit: 'stone', isLevel: true, hp: Infinity, downT: 0, wobble: 0, flash: 0, name: o.name };
    rooms.push(o);
  });
  return { obj, rooms, meta, S };
}

async function buildDam() {
  // bgfog.c stage table, LEVELID_DAM: fog colour (0x10,0x30,0x60), the dusk
  // blue. NearFog 3333 / FarFog 15000 are bg-file units divided by the level's
  // visibility scale (0.2 for the dam), so the blue haze runs ~165 m..750 m.
  scene.background = new THREE.Color(0x103060);
  scene.fog = new THREE.Fog(0x103060, 165, 750);
  cam.far = 900; cam.updateProjectionMatrix();
  const [{ obj, rooms, S }, setup] = await Promise.all([
    loadLevelGeometry('dam'),
    fetch(`${EX}/setups/dam.json`, { cache: 'no-cache' }).then(r => r.json()),
  ]);
  DAM.rooms.push(...rooms);
  scene.add(obj);
  obj.updateMatrixWorld(true);
  for (const r of DAM.rooms) r.userData.bbox = new THREE.Box3().setFromObject(r);
  // spawn on the setup's first pad (the guard post before the first tunnel)
  const pad = setup.pads[0].pos;
  cam.position.set(pad[0] * S, pad[1] * S + 1.6, pad[2] * S);
  // face down the road, toward the next pad (the checkpoint tunnel) -- the
  // spawn pad's own look vector points at the tower stairs beside the pad
  const p1 = (setup.pads[1] || setup.pads[0]).pos;
  look.yaw = Math.atan2(-(p1[0] - pad[0]), -(p1[2] - pad[2]));
  const g = damGround(cam.position.x, cam.position.z, 60, 300);
  DAM.groundY = g !== null ? g : pad[1] * S;
  cam.position.y = DAM.groundY + 1.6;
  DAM.ready = true;
  populateDam(setup, S).catch(e => console.log('populate failed', e));
}

// ---- populate the level from its stage setup ----
// Object records give a PROP_* model and a pad; OBJECTS.json (from the
// decomp's PitemZ_entries / c_item_entries tables) maps those to model files
// and authored scales. objInit's world size = record scale x extrascale/256,
// in the same cm units as the guns, so metres = model units x scale x 0.01.
const DAM_WOOD = /crate|box|desk|table|chair|shelf|card|book|bin1|stool/i;
function padYaw(pad) { return Math.atan2(pad.look[0], pad.look[2]); }

async function placeDamProp(o, p, pad, S) {
  const src = await loadProp(p.file);
  const inst = src.clone(true);
  const sc = p.scale * (o.extrascale || 1) * 0.01;
  inst.scale.setScalar(sc);
  const g = new THREE.Group();
  g.add(inst);
  g.rotation.y = padYaw(pad);
  g.position.set(pad.pos[0] * S, pad.pos[1] * S, pad.pos[2] * S);
  if (o.type === 'prop') {
    // pads sit at the object's centre; stand the base on the floor beneath
    const bb = new THREE.Box3().setFromObject(inst);
    const gnd = damGround(g.position.x, g.position.z, 2, 6, g.position.y);
    if (gnd !== null && Math.abs(gnd - g.position.y) < 1.5) g.position.y = gnd - bb.min.y;
  }
  g.userData = {
    hp: Infinity, maxhp: Infinity, downT: 0, wobble: 0, flash: 0,
    hit: DAM_WOOD.test(p.file) ? 'wood' : 'metal', name: o.model, prop: true,
  };
  scene.add(g);
  targets.push(g);
}

function placeDamGlass(o, pad, S) {
  // glass records use 3D pads: a bbox in the pad's own {side, up, look} frame,
  // one axis flat -- the pane itself. A handful of these decode to
  // implausible extents (tens of metres, or nearly zero) -- the pad3d
  // trailer isn't a clean axis-aligned min/max pair for every glass record,
  // and chasing the exact per-type layout is out of scope here, so clamp to
  // a plausible pane size rather than spawn a building-sized glass sheet.
  const b = pad.bbox;
  const raw = [Math.max(b[1] - b[0], 1), Math.max(b[3] - b[2], 1), Math.max(b[5] - b[4], 1)];
  const clamp = (v, lo, hi) => Math.min(Math.max(v * S, lo), hi) / S;
  // width/height (side, up) read as a plausible window; depth (look) stays a pane's thickness
  const size = [clamp(raw[0], 0.3, 2.2), clamp(raw[1], 0.3, 2.2), clamp(raw[2], 0.02, 0.15)];
  const geo = new THREE.BoxGeometry(size[0] * S, size[1] * S, size[2] * S);
  const tinted = o.type === 'tinted_glass';
  const mat = new THREE.MeshBasicMaterial({
    color: tinted ? 0x24343c : 0x9fb8c8, transparent: true,
    opacity: tinted ? 0.75 : 0.28, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  const up = new THREE.Vector3(...pad.up).normalize();
  const lk = new THREE.Vector3(...pad.look).normalize();
  const side = new THREE.Vector3().crossVectors(up, lk);
  m.matrixAutoUpdate = false;
  const ctr = new THREE.Vector3()
    .addScaledVector(side, (b[0] + b[1]) / 2)
    .addScaledVector(up, (b[2] + b[3]) / 2)
    .addScaledVector(lk, (b[4] + b[5]) / 2)
    .add(new THREE.Vector3(...pad.pos)).multiplyScalar(S);
  m.matrix.makeBasis(side, up, lk).setPosition(ctr);
  m.userData = {
    hit: 'glass', glassPane: true, broken: false, hp: Infinity,
    downT: 0, wobble: 0, flash: 0, name: o.model,
    side: side.clone().normalize(), up: up.clone(), lk: lk.clone(), ctr: ctr.clone(),
    w: size[0] * S, h: size[1] * S, tinted,
  };
  scene.add(m);
  GLASS_PANES.push(m);
}

async function populateDam(setup, S) {
  const tables = await fetch(`${EX}/setups/OBJECTS.json`, { cache: 'no-cache' }).then(r => r.json());
  const padAt = i => (i >= 10000 ? setup.pad3ds[i - 10000] : setup.pads[i]) || null;
  const WKEY = { PROP_CHRKALASH: 'ak47', PROP_CHRTT33: 'tt33', PROP_CHRSNIPERRIFLE: 'sniperrifle' };
  // GE randomises guard heads at spawn (head == -1); hats follow the body
  const HAT_FOR = { ColiveguardZ: 'PhattbirdZ', Cgreatguard2Z: 'PhathelmetgreyZ', CcommguardZ: 'PhattbirdbrownZ' };
  const NAME_FOR = { ColiveguardZ: 'Russian Soldier', Cgreatguard2Z: 'Siberian Guard', CcommguardZ: 'Russian Commandant' };
  const maleHeads = CHARS.heads.filter(h => h.hats && Object.keys(h.hats).length);
  const guards = [];
  let lastGuard = null;
  const propJobs = [];
  for (const o of setup.objects) {
    const flags = parseInt(o.flags || '0', 16);
    if (o.type === 'guard') {
      const body = (tables.bodies[o.body] || {}).file;
      const pad = padAt(o.pad);
      if (!body || !pad) { lastGuard = null; continue; }
      lastGuard = { body, pad, head: maleHeads.length ? maleHeads[(guards.length * 5 + 3) % maleHeads.length].model : null,
                    hat: HAT_FOR[body] || null, name: NAME_FOR[body] || o.body.replace(/^BODY_/, '').replace(/_/g, ' '),
                    wep: 'PchrkalashZ', wkey: 'ak47' };
      guards.push(lastGuard);
    } else if (o.type === 'collectable' && lastGuard && (flags & 0x4000)) {
      // a held-item collectable right after a guard is that guard's weapon
      const p = tables.props[o.model];
      if (p) {
        lastGuard.wep = p.file;
        lastGuard.wkey = WKEY[o.model] || lastGuard.wkey;
        lastGuard.pistol = o.model === 'PROP_CHRTT33';
      }
      lastGuard = null;
    } else if (o.type === 'glass' || o.type === 'tinted_glass') {
      const pad = padAt(o.pad);
      if (pad && pad.bbox) try { placeDamGlass(o, pad, S); } catch (e) { console.log('glass failed', e); }
    } else if (['prop', 'door', 'monitor', 'multi_monitor', 'safe', 'rack'].includes(o.type)) {
      const p = tables.props[o.model];
      const pad = padAt(o.pad);
      if (p && pad) propJobs.push([o, p, pad]);
    }
  }
  for (const [o, p, pad] of propJobs) {
    try { await placeDamProp(o, p, pad, S); } catch (e) { console.log('prop failed', o.model, e); }
  }
  let gi = 0;
  for (const spec of guards) {
    try {
      const x = spec.pad.pos[0] * S, z = spec.pad.pos[2] * S;
      // pads sit at floor height; only take the raycast if it agrees, so an
      // overhang above the pad can't hoist the guard onto its roof
      const padY = spec.pad.pos[1] * S;
      const gy = damGround(x, z, 1, 3, padY);
      const g = await mkEnemy(x, z, spec, gy !== null && Math.abs(gy - padY) < 1.2 ? gy : padY);
      const yaw = padYaw(spec.pad);
      g.rotation.y = yaw;
      g.userData.homeYaw = yaw;
      if ((gi & 1) === 0) {         // every other guard walks a small beat
        g.userData.patrol = {
          points: [[g.position.x - 2.2, g.position.z], [g.position.x, g.position.z - 1.8],
                   [g.position.x + 2.2, g.position.z], [g.position.x, g.position.z + 1.8]],
          next: (gi >> 1) % 4,
        };
      }
      gi++;
    } catch (e) { console.log('guard failed', spec.body, e); }
  }
  console.log(`dam populated: ${gi} guards, ${propJobs.length} props`);
}

// ---- level picker (start overlay): reload with ?level=, keeping ?mute etc ----
for (const b of document.querySelectorAll('#levels button')) {
  if ((b.dataset.level || 'range') === LEVEL) b.classList.add('sel');
  b.addEventListener('click', e => {
    e.stopPropagation();
    if ((b.dataset.level || 'range') === LEVEL) return;
    const q = new URLSearchParams(location.search);
    if (b.dataset.level) q.set('level', b.dataset.level); else q.delete('level');
    location.search = q.toString();
  });
}
if (LEVEL === 'dam') document.getElementById('entermsg').textContent = 'Click to enter the Dam';

// ---- main loop ----
if (LEVEL === 'dam') {
  buildDam();
} else {
  buildRange();
  buildTargets().then(buildProps);
}
selectWeapon('wppk');

let last = performance.now() / 1000;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now() / 1000;
  const dt = Math.min(now - last, 0.05);
  last = now;

  // auto fire
  if (state.firing && state.stats && now >= state.nextShot) {
    const fi = fireInterval(state.stats);
    shoot(now);
    state.nextShot = now + fi.t;
    if (!fi.auto) state.firing = false;
  }
  // recoil decay
  if (state.flashT > 0) {
    state.flashT -= dt;
    if (state.flashT <= 0 && state.curFlash)
      for (const m of state.curFlash) m.visible = false;
  }
  // targets: animation, fall/respawn, wobble, hit flash
  for (const t of targets) {
    const u = t.userData;
    if (u.dead) continue;               // dam corpses hold their final pose
    if (u.rig && u.anim) {
      // GE animations run at 60 Hz, one bitstream frame per tick; walks play
      // at chraction.c's half rate.
      u.frame += dt * 60 * (u.animRate || 1);
      let animEnded = false;
      if (u.frame >= u.anim.frames) {
        if (u.anim.loop || u.animName === 'idle') {
          u.frame %= u.anim.frames;
        } else if (u.downT > 0) {
          u.frame = u.anim.frames - 1;            // deaths hold their last pose
          animEnded = true;
        } else {                                  // fire/flinch: back to idle
          u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0; u.animRate = 1;
        }
      }
      poseSkeleton(u.rig, u.anim, u.frame, u.flip);
      // Patrol: walk the beat between waypoints. Movement only runs while the
      // walk (or idle) animation owns the body, so firing and flinching stop
      // the guard in place and the walk resumes after.
      const canWalk = u.animName === 'idle' || u.animName.startsWith('walking');
      if (state.patrol && u.patrol && u.downT <= 0 && canWalk) {
        if (u.animName === 'idle') {
          loadAnim(u.walkAnim).then(a => {
            if (u.downT <= 0 && u.animName === 'idle') {
              u.anim = a; u.animName = u.walkAnim;
              u.frame = Math.random() * a.frames;
              u.animRate = WALK_RATE;
            }
          });
        } else {
          const wp = u.patrol.points[u.patrol.next];
          const dx = wp[0] - t.position.x, dz = wp[1] - t.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.15) {
            u.patrol.next = (u.patrol.next + 1) % u.patrol.points.length;
          } else {
            const speed = (WALK_SPEED[u.walkAnim] || 2.19) * (u.animRate || 1);
            const px = t.position.x, pz = t.position.z;
            t.position.x += dx / dist * speed * dt;
            t.position.z += dz / dist * speed * dt;
            if (LEVEL === 'dam') {          // walk the terrain, not a flat plane
              const gy = damGround(t.position.x, t.position.z, 0.5, 1.5, t.position.y);
              // a guard's beat stays on walkable ground -- no scaling cliffs
              if (gy !== null && Math.abs(gy - t.position.y) < 0.45) t.position.y = gy;
              else if (gy === null || Math.abs(gy - t.position.y) >= 0.45) {
                t.position.x = px; t.position.z = pz;
                u.patrol.next = (u.patrol.next + 1) % u.patrol.points.length;
              }
            }
            // face the walk direction (enemies are authored facing +z)
            const want = Math.atan2(dx, dz);
            let dy = want - t.rotation.y;
            while (dy > Math.PI) dy -= TAU; while (dy < -Math.PI) dy += TAU;
            t.rotation.y += dy * Math.min(1, dt * 6);
          }
        }
      } else if (canWalk) {
        if (u.animName !== 'idle' && u.downT <= 0) {
          u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0; u.animRate = 1;
        }
        // off duty: turn back to the post's own facing (0 = the firing line)
        const home = u.homeYaw || 0;
        if (Math.abs(t.rotation.y - home) > 0.01 && u.downT <= 0 && !(state.hostile && LEVEL === 'dam'))
          t.rotation.y = home + (t.rotation.y - home) * Math.max(0, 1 - dt * 5);
      }
      // a hot dam guard squares up to the player before firing
      if (LEVEL === 'dam' && state.hostile && u.wkey && u.downT <= 0 && canWalk && !(state.patrol && u.patrol)) {
        const dxp = cam.position.x - t.position.x, dzp = cam.position.z - t.position.z;
        if (dxp * dxp + dzp * dzp < 3600) {
          const want = Math.atan2(dxp, dzp);
          let dy = want - t.rotation.y;
          while (dy > Math.PI) dy -= TAU; while (dy < -Math.PI) dy += TAU;
          t.rotation.y += dy * Math.min(1, dt * 4);
        }
      }
      // The death animations pivot the body around the hip joint, but the
      // animation's root translation isn't decoded, so without help the corpse
      // ends horizontal a metre off the floor. Re-ground from the posed
      // vertices while falling; once the pose holds, stop paying for it.
      if (u.downT > 0 && !animEnded) {
        t.updateWorldMatrix(true, true);
        u.rig.holder.position.y += t.position.y - skinnedBounds(u.rig).min.y;
      }
      if (state.hostile && u.wkey && u.downT <= 0 &&
          (u.animName === 'idle' || u.animName.startsWith('walking')) && now >= u.nextFire) {
        u.nextFire = now + 4 + Math.random() * 8;
        guardFire(t, now);
      }
    }
    if (u.downT > 0) {
      u.downT -= dt;
      if (u.downT <= 0) {
        // in a real level the dead stay dead; the range recycles its targets
        if (LEVEL === 'dam' && u.enemy) { u.dead = true; if (u.hpBar) u.hpBar.sprite.visible = false; continue; }
        u.hp = u.maxhp;
        u.lastDmg = 0;
        updateHpBar(t);
        if (u.rig) {
          u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0;
          poseSkeleton(u.rig, u.anim, 0, u.flip);
          t.updateWorldMatrix(true, true);
          u.rig.holder.position.y += t.position.y - skinnedBounds(u.rig).min.y;
        }
        else t.rotation.x = 0;
      } else if (!u.rig) {
        t.rotation.x = -Math.min(1, (2.2 - u.downT) * 4) * Math.PI / 2;
      }
    }
    if (u.wobble > 0 && !u.rig) {
      u.wobble = Math.max(0, u.wobble - dt * 3.5);
      t.rotation.z = Math.sin(performance.now() * 0.045) * u.wobble * 0.12;
      if (u.wobble === 0) t.rotation.z = 0;
    }
    if (u.flash > 0) {
      u.flash -= dt;
      if (u.flash <= 0 && u.flashMats)
        u.flashMats.forEach((m, i) => m.color.copy(u.baseColor[i]));
    }
  }
  // dropped hats tumble to the floor and stay there
  for (let i = droppedHats.length - 1; i >= 0; i--) {
    const hb = droppedHats[i], f = hb.userData.fall;
    f.vel.y -= 9.8 * dt;
    hb.position.addScaledVector(f.vel, dt);
    hb.rotation.x += f.rot.x * dt; hb.rotation.y += f.rot.y * dt;
    if (hb.position.y <= 0.02) {
      hb.position.y = 0.02;
      droppedHats.splice(i, 1);                    // lies where it fell
    }
  }
  // transient fx
  for (let i = fx.length - 1; i >= 0; i--) {
    const m = fx[i], u = m.userData;
    u.t -= dt;
    if (u.kind === 'spark' && u.vel) {
      u.vel.y -= 12 * dt;
      m.position.addScaledVector(u.vel, dt);
    } else if (u.kind === 'casing') {
      u.vel.y -= 9.8 * dt;
      m.position.addScaledVector(u.vel, dt);
      m.rotation.x += u.rot.x * dt; m.rotation.y += u.rot.y * dt;
      if (m.position.y < u.floorY) {
        m.position.y = u.floorY;
        if (!u.landed) {
          u.landed = true;
          play(sfx('CART_SPENT_SFX'), { vol: 0.3, at: m.position, pitch: 0.85 + Math.random() * 0.3 });
        }
        u.vel.set(0,0,0); u.rot.set(0,0,0);
      }
    } else if (u.kind === 'puff') {
      m.position.addScaledVector(u.drift, dt);
      const k = 1 - u.t / u.ttl, s = u.size0 * (1 + k * 0.6);
      m.scale.set(s, s, 1);
      m.material.opacity = 0.8 * (1 - k);
    } else if (u.kind === 'shard') {
      u.vel.y -= 8 * dt;
      m.position.addScaledVector(u.vel, dt);
      m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
      if (m.position.y < 0.02) { m.position.y = 0.02; u.vel.set(0,0,0); }
      if (u.t < 0.3) m.material.opacity = Math.max(0, u.t / 0.3) * 0.6;
    } else if (u.kind === 'smoke') {
      m.position.y += 0.15 * dt;                    // slow upward drift
      const age = u.ttl - u.t;
      const grow = Math.min(1, age / 1.0);           // ~1s to fully appear
      const fade = u.t < 1.5 ? Math.max(0, u.t / 1.5) : 1;   // ~1.5s to dissolve
      const s = 0.6 + grow * 2.4;                    // explosion.c smoketype size ~3m
      m.scale.set(s, s, 1);
      m.material.opacity = 0.55 * grow * fade;
    } else if (u.kind === 'explosion') {
      const k = 1 - u.t / u.ttl;
      m.scale.setScalar(0.4 + k * 5.5);
      m.material.opacity = 0.95 * (1 - k);
    } else if (u.kind === 'light') {
      m.intensity = 60 * (u.t / u.ttl);
    } else if (u.kind === 'decal' && u.t < 2) {
      m.material.opacity = u.t / 2 * 0.9;
    } else if (u.kind === 'dmgnum') {
      m.position.y += 0.75 * dt;
      m.material.opacity = Math.min(1, u.t / (u.ttl * 0.6));
    }
    if (u.t <= 0) { scene.remove(m); fx.splice(i, 1); }
  }
  // projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i], u = p.userData;
    u.vel.y -= u.grav * dt;
    const step = u.vel.length() * dt;
    const dir = u.vel.clone().normalize();
    raycaster.set(p.position, dir);
    raycaster.far = step + 0.15;
    const hit = raycaster.intersectObjects(solidObjects(), true)[0];
    p.position.addScaledVector(u.vel, dt);
    p.lookAt(p.position.clone().add(dir));
    u.life -= dt;
    // both levels have real geometry in solidObjects() now; the floor plane
    // check just catches a grenade skimming the flat tarmac between rays
    const out = LEVEL === 'dam' ? false : p.position.y <= 0.02;
    if (hit || out || u.life <= 0) {
      const at = hit ? hit.point : p.position.clone();
      if (LEVEL !== 'dam') at.y = Math.max(at.y, 0.05);
      const n = hit && hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      if (hit && hit.object.userData.glassPane) shatterGlassPane(hit.object);
      scene.remove(p); projectiles.splice(i, 1);
      explode(at, u.radius, state.stats ? state.stats.damage * 8 : 8, n);
    }
  }
  shake = Math.max(0, shake - dt * 3);
  const shx = shake > 0 ? (Math.random() - 0.5) * shake * 0.03 : 0;
  const shy = shake > 0 ? (Math.random() - 0.5) * shake * 0.03 : 0;

  // GE's recoil moves the GUN, not the view: the camera stays level and the
  // crosshair stays put (shake is explosions only).
  cam.rotation.set(0, 0, 0);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = look.yaw + shy;
  cam.rotation.x = look.pitch + shx;

  // zoom: ItemStats Zoom, eased; GE fovs are 4:3 vertical, so convert like
  // the base FOV (hold the horizontal field on wide windows)
  {
    const aspect = cam.aspect || (16 / 9);
    // GE keeps the weapon at its hip position while zooming -- the scoped
    // rifles were never authored to be seen from dead behind, and centring
    // them exposed the scope's interior. Only non-scoped weapons take the
    // centred aim pose; Zoom-stat weapons zoom in place like the game.
    const wantAds = state.zooming && !state.gunL
      && !(state.stats && state.stats.zoom_fov > 0);
    state.adsK += ((wantAds ? 1 : 0) - state.adsK) * Math.min(1, dt * 10);
    const fov43 = (state.zooming && state.stats && state.stats.zoom_fov > 0)
      ? (state.key === 'sniperrifle' ? state.sniperZoom : state.stats.zoom_fov)
      : GE_FOVY;
    const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov43) / 2) * (4 / 3));
    const want = aspect > 4 / 3
      ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect))
      : fov43;
    if (!state.fovCur) state.fovCur = want;
    state.fovCur += (want - state.fovCur) * Math.min(1, dt * 9);
    if (Math.abs(state.fovCur - cam.fov) > 0.01) {
      cam.fov = state.fovCur; cam.updateProjectionMatrix();
      gunCam.fov = state.fovCur; gunCam.updateProjectionMatrix();
    }
  }

  // floating crosshair eases home at CrosshairSpeed; the crosshair element and
  // the weapon follow it (gunfire.c gunofs += reticle * GunPlay)
  {
    const xs = state.stats ? state.stats.crosshair_speed || 0.8 : 0.8;
    const k = Math.exp(-dt * 4 * xs * (1 + state.adsK * 5));
    state.ret.x *= k; state.ret.y *= k;
    const el = document.getElementById('crosshair');
    if (el) el.style.transform =
      `translate(-50%,-50%) translate(${(state.ret.x * canvas.clientWidth / 2).toFixed(1)}px, ${(-state.ret.y * canvas.clientHeight / 2).toFixed(1)}px)`;
  }

  // gunfire.c recoil: pitch to RecoilUp degrees muzzle-up and pull back a
  // RecoilBack/1000 fraction of the gun-to-aim distance (~RecoilBack cm),
  // rising on a quarter sine over byte0 ticks of RecoilSpeed and recovering
  // on a half cosine over byte1.
  // both hands: recoil pose and action cycling, each on its own envelope
  const hands = [];
  if (state.gunRest && state.gun)
    hands.push({ i: 0, g: state.gun, rest: state.gunRest, movers: state.movers, mx: 1 });
  if (state.gunRestL && state.gunL)
    hands.push({ i: 1, g: state.gunL, rest: state.gunRestL, movers: state.moversL, mx: -1 });
  for (const hd of hands) {
    const st2 = state.stats;
    let rk = 0;
    if (st2 && state.recoilTicks[hd.i] >= 0) {
      const rs = st2.vfx.recoil_speed >>> 0;
      const rise = (rs >>> 24) & 255 || 4, fall = (rs >>> 16) & 255 || 8;
      state.recoilTicks[hd.i] += dt * 60;
      const rt = state.recoilTicks[hd.i];
      if (rt < rise) rk = Math.sin(rt * Math.PI / 2 / rise);
      else if (rt < rise + fall) rk = Math.cos((rt - rise) * Math.PI / fall) * 0.5 + 0.5;
      else { rk = 0; state.recoilTicks[hd.i] = -1; }
    }
    const play = st2 ? st2.vfx.gun_play : [3, 3, 8.5];
    const ads = hd.i === 0 ? state.adsK : 0;
    hd.g.rotation.x = hd.rest.rot.x + THREE.MathUtils.degToRad(st2 ? st2.vfx.recoil_up : 0) * rk;
    hd.g.position.set(
      (hd.rest.pos.x + hd.mx * state.ret.x * play[2] * 0.01) * (1 - ads),
      hd.rest.pos.y * (1 - ads * 0.45) + state.ret.y * play[1] * 0.01,
      hd.rest.pos.z + (st2 ? st2.vfx.recoil_back : 0) * 0.01 * rk);
    // slide/bolt throw straight back and return
    if (state.slideTs[hd.i] > 0) {
      state.slideTs[hd.i] = Math.max(0, state.slideTs[hd.i] - dt / 0.11);
      const t2 = state.slideTs[hd.i];
      const k = t2 > 0.72 ? (1 - t2) / 0.28 : t2 / 0.72;
      const back = (st2 ? st2.vfx.bolt_recoil_back : 0) * k;
      for (const part of ['slide', 'bolt']) {
        const m2 = hd.movers[part];
        if (m2) m2.position.set(m2.userData.base.x, m2.userData.base.y, m2.userData.base.z - back);
      }
    }
    if (state.cylT[hd.i] < 1 && hd.movers.cylinder) {
      state.cylT[hd.i] = Math.min(1, state.cylT[hd.i] + dt / 0.16);
      const e = state.cylT[hd.i] * state.cylT[hd.i] * (3 - 2 * state.cylT[hd.i]);
      hd.movers.cylinder.rotation.z = state.cylFrom[hd.i] + (state.cylTo[hd.i] - state.cylFrom[hd.i]) * e;
    }
    if (state.hammerT[hd.i] > 0 && hd.movers.hammer) {
      state.hammerT[hd.i] = Math.max(0, state.hammerT[hd.i] - dt / 0.13);
      const hk = state.hammerT[hd.i] > 0.7 ? (1 - state.hammerT[hd.i]) / 0.3 : state.hammerT[hd.i] / 0.7;
      hd.movers.hammer.rotation.x = -0.5 * hk;
    }
  }

  // gun mount: metres, fixed to camera; recoil pulls back/up
  // Reload dips the weapon down and tilts it out of view, GE-style: ease in
  // over the first quarter, hold, ease back over the last quarter.
  let dip = 0;
  if (state.reloading && state.reloadDur > 0) {
    const rp = Math.min(1, (now - state.reloadStart) / state.reloadDur);
    dip = Math.min(rp / 0.25, 1, (1 - rp) / 0.25);
    dip = dip * dip * (3 - 2 * dip);                 // smoothstep
  }
  moveTick(dt);
  // in the dam, ease the eye toward the ground the last step landed on
  if (LEVEL === 'dam' && DAM.ready)
    cam.position.y += (DAM.groundY + 1.6 - cam.position.y) * Math.min(1, dt * 12);
  // gun bob: the Sway stat scales it, and walking swings it harder and faster
  const bobRate = state.moving ? 6.5 : 1.8;
  const swayAmp = (state.moving ? 0.011 : 0.004) * (state.stats ? state.stats.vfx.sway : 1);
  gunMount.position.set(dip * 0.03 + (state.moving ? Math.sin(now * bobRate * 0.5) * swayAmp * 0.7 : 0),
                        Math.sin(now * bobRate) * swayAmp - dip * 0.09,
                        dip * 0.04);
  gunMount.rotation.set(-dip * 0.42, 0, dip * 0.18);

  const w = canvas.clientWidth, h = canvas.clientHeight;
  // A zero-sized canvas (hidden tab, collapsed pane) makes aspect NaN, which
  // poisons both projection matrices and renders nothing until the next resize.
  if (w < 8 || h < 8) return;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    // fov itself is NOT set here -- the zoom block above already recomputes
    // it every frame from cam.aspect (GE's 4:3-vertical hold, un-zoomed or
    // not), and is the single owner of cam.fov/gunCam.fov. This block used to
    // also assign cam.fov directly on every detected resize; on a fixed-size
    // test viewport that only ever fires once at load and is harmless, but on
    // a real window it can re-trigger most frames (fractional devicePixelRatio,
    // a docked DevTools panel nudging clientWidth by sub-pixel amounts), which
    // silently overwrote the zoom block's fov right back to the un-zoomed
    // default every frame -- zooming eased fovCur correctly the whole time,
    // it just never reached the screen.
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    gunCam.aspect = cam.aspect; gunCam.near = window.__P.near;
    gunCam.updateProjectionMatrix();
  }
  renderer.autoClear = true;
  renderer.render(scene, cam);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(gunScene, gunCam);
}
tick();

// ---- debug hooks (harmless in production) ----
// --- model inspection: render one gun isolated, framed, on a neutral backdrop ---
window.__inspect = async (key, view = 'side', w = 560, flat = false) => {
  const modelName = /^[GPC].*Z$/.test(key) ? key : `G${key}Z`;
  const { obj } = await loadGunModel(modelName);
  const scn = new THREE.Scene();
  scn.background = new THREE.Color(0x8a93a0);
  scn.add(new THREE.HemisphereLight(0xffffff, 0x556677, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 1.0); dl.position.set(-1, 2, 1.5); scn.add(dl);
  const dl2 = new THREE.DirectionalLight(0xc9d4ff, 0.35); dl2.position.set(1.5, -0.5, -1); scn.add(dl2);
  // textures load asynchronously: wait for them or the render captures blank/black
  const maps = [];
  obj.traverse(o => { if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (m.map) maps.push(m.map);
    });
  });
  const ready = () => maps.every(t => t.image && t.image.width);
  for (let i = 0; i < 120 && !ready(); i++) await new Promise(r => setTimeout(r, 25));
  maps.forEach(t => { t.needsUpdate = true; });

  const clone = obj.clone(true);
  clone.position.set(0, 0, 0); clone.rotation.set(0, 0, 0); clone.scale.setScalar(1);
  // keep the game's visibility rules (flash + non-default switch states stay hidden)
  if (flat) {                      // neutral material: judge geometry, not shading
    const nm = new THREE.MeshLambertMaterial({ color: 0xd8d8d8, side: THREE.DoubleSide });
    clone.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const rep = mats.map(m => (m.visible === false ? m : nm));
      o.material = Array.isArray(o.material) ? rep : rep[0];
    });
  }
  scn.add(clone);
  const bb = new THREE.Box3().setFromObject(clone);
  const ctr = bb.getCenter(new THREE.Vector3());
  const sz = bb.getSize(new THREE.Vector3());
  const radius = Math.max(sz.x, sz.y, sz.z) * 0.5 || 1;
  const c2 = new THREE.PerspectiveCamera(35, 16/9, radius * 0.01, radius * 40);
  // barrel runs along the longest axis; view perpendicular to it
  const long = (sz.z >= sz.x && sz.z >= sz.y) ? 'z' : (sz.x >= sz.y ? 'x' : 'y');
  const V = (a, b, c) => new THREE.Vector3(a, b, c);
  const dirs = long === 'z'
    ? { side: V(1, 0.18, 0.10), top: V(0.06, 1, 0.10), front: V(0.10, 0.18, 1) }
    : { side: V(0.10, 0.18, 1), top: V(0.10, 1, 0.06), front: V(1, 0.18, 0.10) };
  const fit = Math.max(sz.x, sz.y, sz.z) * 0.5 || 1;
  const d = dirs[view].clone().normalize().multiplyScalar(fit * 2.5);
  c2.position.copy(ctr).add(d);
  c2.lookAt(ctr);
  const rt = new THREE.WebGLRenderTarget(w, Math.round(w * 9 / 16));
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scn, c2);
  const buf = new Uint8Array(rt.width * rt.height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
  renderer.setRenderTarget(prevRT);
  const cv = document.createElement('canvas');
  cv.width = rt.width; cv.height = rt.height;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(rt.width, rt.height);
  for (let y = 0; y < rt.height; y++) {          // flip vertically
    const src = (rt.height - 1 - y) * rt.width * 4;
    img.data.set(buf.subarray(src, src + rt.width * 4), y * rt.width * 4);
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`${key}  [${view}]  ${sz.x.toFixed(0)}x${sz.y.toFixed(0)}x${sz.z.toFixed(0)}`, 8, 20);
  rt.dispose();
  return cv.toDataURL('image/jpeg', 0.82);
};
window.__sheet = async (keys, view = 'side', cell = 300, flat = false) => {
  const cw = cell, ch = Math.round(cell * 9 / 16);
  const cols = 3, rows = Math.ceil(keys.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * cw; cv.height = rows * ch;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#101418'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < keys.length; i++) {
    const url = await window.__inspect(keys[i], view, cw, flat);
    const im = new Image();
    await new Promise(res => { im.onload = res; im.onerror = res; im.src = url; });
    ctx.drawImage(im, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
  }
  return cv.toDataURL('image/jpeg', 0.85);
};
window.__inspectAll = async (view = 'side') => {
  const keys = Array.from(document.querySelectorAll('#picker button')).map(b => b.dataset.key);
  for (const k of keys) {
    try {
      const url = await window.__inspect(k, view);
      await fetch('http://127.0.0.1:8614/' + view + '_' + k, { method: 'POST', body: url });
    } catch (e) { console.log('FAIL', k, e); }
  }
  return keys.length;
};
window.__repose = () => {
  gunCam.near = window.__P.near || 0.02;
  gunCam.updateProjectionMatrix();
  return selectWeapon(state.key);
};
window.THREE = THREE;
window.__dbg = { state, selectWeapon, shoot, look, targets, scene, cam, renderer, gunMount, gunScene, gunCam, tick, poseSkeleton, loadAnim, GLASS_PANES, fx, DAM, explode, shatterGlassPane, impactFX };
window.__shot = (w = 480) => {
  if (canvas.width < 8) {
    renderer.setSize(960, 540, false);
    cam.aspect = 16/9; cam.updateProjectionMatrix();
    gunCam.aspect = 16/9; gunCam.updateProjectionMatrix();
  }
  const cw = canvas.width, ch = canvas.height;
  renderer.autoClear = true; renderer.render(scene, cam);
  renderer.autoClear = false; renderer.clearDepth(); renderer.render(gunScene, gunCam);
  const t = document.createElement('canvas');
  t.width = w; t.height = Math.round(w * ch / cw);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
};
window.__stats = () => {
  const w = canvas.width, h = canvas.height;
  renderer.autoClear = true;
  renderer.render(scene, cam);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(gunScene, gunCam);
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d'); g.drawImage(canvas, 0, 0);
  const region = (x0, y0, x1, y1) => {
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0, gg = 0, b = 0, n = d.length / 4;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; gg += d[i+1]; b += d[i+2];
      colors.add((d[i] >> 4) << 8 | (d[i+1] >> 4) << 4 | (d[i+2] >> 4));
    }
    return { avg: [r/n|0, gg/n|0, b/n|0], colors: colors.size };
  };
  return {
    full: region(0, 0, w, h),
    gun: region(w*0.55|0, h*0.55|0, w*0.95|0, h*0.95|0),
    floor: region(w*0.4|0, h*0.75|0, w*0.6|0, h*0.95|0),
    mid: region(w*0.3|0, h*0.3|0, w*0.7|0, h*0.6|0),
  };
};
