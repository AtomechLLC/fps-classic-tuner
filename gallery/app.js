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
    bufCache.set(url, fetch(url).then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b)).catch(() => null));
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
  // lane dividers
  for (const x of [-4, 4]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.3, 3),
      new THREE.MeshLambertMaterial({ color: 0x3a4048 }));
    d.position.set(x, 0.65, -1.5);
    scene.add(d);
  }
}


/** The material rules for GE props and characters, shared so a skinned body
 *  and a static prop are shaded identically. `skinning` needs no flag in three
 *  r150+; the SkinnedMesh drives it. */
function geMaterial(m, name = m.name) {
  const map = m.map || null;
  if (map) { map.magFilter = THREE.NearestFilter; map.colorSpace = THREE.SRGBColorSpace;
             map.wrapS = map.wrapT = THREE.RepeatWrapping; }
  const lit = /_lit(_|$)/.test(name);
  const nm = lit
    ? new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide })
    : new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
  if (map) nm.alphaTest = 0.35;
  if (/_sec$/.test(name)) {        // Secondary display list: decals on the skin
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
const HEAD_BY_MODEL = Object.fromEntries(CHARS.heads.map(h => [h.model, h]));
// The colour variants are the same mesh as the entry the table is keyed on.
const HAT_BASE = { PhatberetblueZ: 'PhatberetZ', PhatberetredZ: 'PhatberetZ',
                   PhatfurryblackZ: 'PhatfurryZ', PhatfurrybrownZ: 'PhatfurryZ',
                   PhathelmetgreyZ: 'PhathelmetZ', PhattbirdbrownZ: 'PhattbirdZ' };

const MM = 0.001;                     // character models are in millimetres too

async function mkEnemy(x, z, spec) {
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
  const neck = rig.bones.find(b => b.userData.joint === 3) || rig.bones[0];
  const head = (await loadProp(spec.head)).clone(true);
  head.userData.zone = 'head';        // the hit test walks ancestors for this
  neck.add(head);

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
  // drop is wherever the posed feet land.
  g.position.set(x, 0, z);
  g.updateWorldMatrix(false, true);
  rig.holder.position.y = -skinnedBounds(rig).min.y;

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

  g.position.set(x, 0, z);
  g.userData = {
    // chr.c:1656 -- every guard spawns with maxdamage 4.0, so weapon damage
    // straight from WeaponStats gives the real number of hits: four PP7 body
    // shots, one Golden Gun round.
    hp: CHARS.guard_max_damage, maxhp: CHARS.guard_max_damage,
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
  const rows = [-14, -32, -55, -85];
  let i = 0;
  for (const z of rows)
    for (const x of lanes) {
      const spec = ENEMIES[i % ENEMIES.length];
      const patrols = (i % 2) === 1;            // every other guard walks a beat
      i++;
      try {
        const g = await mkEnemy(x + (Math.abs(z) % 7) * 0.1 - 0.3, z, spec);
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

// ---- impact sounds per material (real GE hit SFX + ricochets) ----
const sfx = n => soundByName(n);
const HIT_SOUNDS = {
  flesh: [sfx('HIT_BULLET_FLESH_SFX')],
  wood:  [sfx('HIT_BULLET_WOOD_SFX'), ...RICO.slice(0, 4)],
  metal: [sfx('HIT_BULLET_METAL_A_SFX'), sfx('HIT_BULLET_METAL_B_SFX'), ...RICO.slice(4, 8)],
  stone: RICO.slice(8, 16),
  other: RICO.slice(16, 20),
};
const EXPLO_SOUNDS = ['EXPLOSION_2A_SFX','EXPLOSION_2B_SFX','EXPLOSION_3_SFX','EXPLOSION_4A_SFX']
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
const sparkGeo = new THREE.SphereGeometry(0.035, 4, 4);
function spawnSpark(p, big = false) {
  for (let i = 0; i < (big ? 7 : 3); i++) {
    const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffcc55 }));
    m.position.copy(p);
    m.userData = { vel: new THREE.Vector3((Math.random()-.5)*4, Math.random()*3.5, (Math.random()-.5)*4) };
    addFx(m, 0.22 + Math.random()*0.15, 'spark');
  }
}
function spawnTracer(from, to) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({
    color: 0xffe9a0, transparent: true, opacity: 0.85 }));
  addFx(l, 0.06, 'tracer');
}
const decalGeo = new THREE.CircleGeometry(0.035, 8);
function spawnDecal(p, normal) {
  const m = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({
    color: 0x111111, transparent: true, opacity: 0.9 }));
  m.position.copy(p).addScaledVector(normal, 0.01);
  m.lookAt(p.clone().add(normal));
  addFx(m, 9, 'decal');
}
const casingGeo = new THREE.BoxGeometry(0.012, 0.012, 0.03);
const casingMat = new THREE.MeshLambertMaterial({ color: 0xc8a248 });
function spawnCasing() {
  const m = new THREE.Mesh(casingGeo, casingMat);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  if (state.ejectObj) gunPointWorld(state.ejectObj, m.position);
  else m.position.copy(cam.position).addScaledVector(right, 0.28).addScaledVector(fwd, 0.35)
    .add(new THREE.Vector3(0, -0.12, 0));
  m.userData = { vel: right.clone().multiplyScalar(1.4 + Math.random())
      .add(new THREE.Vector3(0, 2 + Math.random(), 0)),
      rot: new THREE.Vector3(Math.random()*20, Math.random()*20, 0) };
  addFx(m, 0.9, 'casing');
}
let shake = 0;
function explode(p, radius, damage) {
  play(EXPLO_SOUNDS[Math.floor(Math.random()*EXPLO_SOUNDS.length)],
       { vol: 1.6, at: p, pitch: 0.95 + Math.random()*0.1 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa63e, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  ball.position.copy(p);
  addFx(ball, 0.35, 'explosion');
  const light = new THREE.PointLight(0xffa040, 60, radius * 4);
  light.position.copy(p);
  addFx(light, 0.25, 'light');
  spawnSpark(p, true);
  const d = cam.position.distanceTo(p);
  shake = Math.min(1.2, shake + 3.5 / Math.max(d * 0.35, 1));
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

    function makeGunMat(m) {
      const fl = m.name.match(/_fl(\d+)/);
      const lit = /_lit(_|$)/.test(m.name);
      const sec = /_sec$/.test(m.name);
      const map = m.map || null;
      if (map) { map.magFilter = THREE.NearestFilter; map.colorSpace = THREE.SRGBColorSpace;
                 map.wrapS = map.wrapT = THREE.RepeatWrapping; }
      let nm;
      const tid = +(m.name.match(/^tex_(\d+)/) || [0, -1])[1];
      const ie = IMAGES[tid];
      const isEnv = /_env(_|$)/.test(m.name);              // G_TEXTURE_GEN geometry
      const flatCol = ie && ie.w === 1 && ie.h === 1;      // 1x1 = flat colour + texture-gen
      const envStrip = ie && (ie.w === 1 || ie.h === 1);   // 1xN strip = flat/gradient
      if (isEnv && map) {
        // N64 texture generation samples by the VIEW-space normal; a matcap
        // does the same, where baked UVs pinned faces to one texel.
        nm = new THREE.MeshMatcapMaterial({ matcap: map, side: THREE.DoubleSide });
      } else if (flatCol && lit) {  // 1x1 flat colour = solid tinted metal
        const c = (ie && (ie.opaque || ie.avg)) || [24, 24, 28];
        nm = new THREE.MeshPhongMaterial({
          color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255),
          specular: 0xcccccc, shininess: 26, side: THREE.DoubleSide });
      } else if (envStrip && lit) { // specular strip texture: keep the texture, untinted
        nm = new THREE.MeshPhongMaterial({ map, specular: 0xbbbbbb,
          shininess: 22, side: THREE.DoubleSide });
      } else if (lit) {
        // GunLighting: TEXEL0 * SHADE from vertex normals under GE's gun light.
        nm = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
      } else {                      // prelit: baked vertex colours
        nm = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
      }
      if (map && !fl) nm.alphaTest = 0.35;
      if (sec && !fl) {             // Secondary display list: decal on the skin
        nm.transparent = true; nm.depthWrite = false;
        nm.polygonOffset = true; nm.polygonOffsetFactor = -2; nm.polygonOffsetUnits = -2;
      }
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
          mats.push(makeGunMat(mtl.create(pt.matName) || new THREE.MeshBasicMaterial()));
        }
        g.setIndex(index);
        const mesh = new THREE.Mesh(g, mats);
        mesh.position.set(r[0], r[1], r[2]);
        mesh.userData.base = new THREE.Vector3(r[0], r[1], r[2]);
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
        const mesh = new THREE.Mesh(ng, makeGunMat(mtl.create(pt.matName)));
        mesh.position.copy(c);
        mesh.visible = false;
        mesh.renderOrder = 10;
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
  // gunfire.c recoil: ticks since the shot, or -1 when settled
  recoilTick: -1, gunRest: null,
  zooming: false, fovCur: 0, sniperZoom: 15,
  lastSnd: -1,
  ret: { x: 0, y: 0 },          // floating crosshair, NDC
  score: 0, shots: 0, hits: 0,
  hostile: false,               // G: guards return fire (visual only)
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
  const st = WEAPONS[key];
  const modelName = `G${key}Z`;
  if (!MODELS[modelName]) return;
  state.key = key; state.stats = st;
  state.ammo = st.mag_size > 0 ? st.mag_size : Infinity;
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
  state.recoilTick = -1;
  gunMount.add(holder);
  gunMount.scale.setScalar(1);
  state.gun = holder; state.flashGroups = flashGroups; state.flashMeshes = flashMeshes;
  state.movers = movers; state.slideT = 0; state.cylFrom = 0; state.cylTo = 0; state.cylT = 1;
  state.hammerT = 0; state.muzzleObj = muzzleObj; state.ejectObj = ejectObj;
  updateHud();
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
  document.getElementById('wname').textContent = DISPLAY[state.key] || state.key;
  document.getElementById('ammo').innerHTML = state.reloading ? '<small>RELOADING…</small>'
    : (state.ammo === Infinity ? '∞'
       : `<span class="ge-reserve">∞</span> <span class="ge-bullet">▮</span> ${state.ammo}`);
  const fi = fireInterval(st);
  document.getElementById('stats').innerHTML =
    `<b>${DISPLAY[state.key] || state.key}</b> · ${fi.auto ? 'auto' : 'single'}` +
    ` · ${(st.sound_name || '').replace('_SFX','').toLowerCase()}<br>` +
    statBars(st);
  document.getElementById('score').innerHTML =
    `hits <b>${state.hits}</b> / ${state.shots} &nbsp; score <b>${state.score}</b>`;
}

// ---- firing ----
const CLIPOUT = soundByName('GUN_CLIPOUT_SFX') || soundByName('GUN_CLIP_OUT_SFX');
const CLIPIN = soundByName('GUN_CLIPIN_SFX') || soundByName('GUN_CLIP_IN_SFX');
const DRYFIRE = soundByName('CLICK_SFX') || soundByName('BEEP_QUIET_SFX');

function reload() {
  const st = state.stats;
  if (state.reloading || !st || st.mag_size <= 0 || state.ammo === st.mag_size) return;
  state.reloading = true;
  state.reloadStart = performance.now() / 1000;
  state.reloadDur = 1.4;
  updateHud();
  if (CLIPOUT) play(CLIPOUT, { vol: 0.45 });
  setTimeout(() => { if (CLIPIN) play(CLIPIN, { vol: 0.45 }); }, 700);
  setTimeout(() => {
    state.ammo = st.mag_size; state.reloading = false; updateHud();
  }, 1400);
}

function shoot(now) {
  const st = state.stats;
  if (!st || state.reloading) return;
  if (state.ammo <= 0) {
    if (DRYFIRE) play(DRYFIRE, { vol: 0.3 });
    state.nextShot = now + 0.25;
    reload();
    return;
  }
  state.ammo--;
  state.shots++;
  // SoundTriggerRate: automatics only retrigger the gunshot sample every N
  // ticks (KF7 4, AR33 5, RC-P90 2) -- at full auto the samples would overlap.
  const strate = st.sound_trigger_rate;
  if (!strate || now - state.lastSnd >= strate / 60 - 1e-4) {
    play(soundById(parseInt(st.sound_id, 16)), { vol: 0.55, pitch: 0.97 + Math.random() * 0.06 });
    state.lastSnd = now;
  }
  // start (or re-peak) the gunfire.c recoil envelope
  if (st.vfx.recoil_up > 0 || st.vfx.recoil_back > 0) state.recoilTick = 0;
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
  const muzzle = state.muzzleObj ? gunPointWorld(state.muzzleObj, new THREE.Vector3())
    : cam.position.clone()
      .addScaledVector(right, 0.22).addScaledVector(up, -0.18).addScaledVector(aim, 0.6);
  for (let pi = 0; pi < pellets; pi++) {
    const dir = aim.clone()
      .addScaledVector(right, (Math.random()-0.5)*spread)
      .addScaledVector(up, (Math.random()-0.5)*spread)
      .normalize();
    if (EXPLOSIVE[state.key]) { fireProjectile(state.key, dir); continue; }
    raycaster.set(cam.position, dir);
    raycaster.far = 300;
    const allHits = raycaster.intersectObjects(targets, true);
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
      // chraction.c handles_shot_actors: the part decides everything below
      const bp = g.userData.enemy ? resolveBodyPart(g, h) : null;
      const mat = bp ? bp.sound : (g.userData.hit || 'other');
      const set = HIT_SOUNDS[mat];
      play(set[Math.floor(Math.random() * set.length)], { vol: 0.8, at: h.point, pitch: 0.9 + Math.random()*0.2 });
      spawnSpark(h.point);
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
                       : dir.clone().negate();
      spawnDecal(h.point, n);
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
  state.flashT = 0.055;
  // gunfire.c cycles the action: the slide/bolt (Switches[6]/[7]) throw back
  // by BoltRecoilBack model units and return; a revolver advances its cylinder
  // one chamber and drops the hammer.
  if ((state.movers.slide || state.movers.bolt) && st.vfx.bolt_recoil_back > 0)
    state.slideT = 1;
  if (state.movers.cylinder) {
    state.cylFrom = state.cylTo; state.cylTo += Math.PI / 3; state.cylT = 0;
  }
  if (state.movers.hammer) state.hammerT = 1;
  const kids = Object.keys(state.flashMeshes || {});
  if (kids.length) {
    const j = kids[Math.floor(Math.random() * kids.length)];
    state.curFlash = state.flashMeshes[j];
    const s = 1 + Math.random() * 0.25;              // gunfire.c flashscale
    const ext = st.vfx.muzzle_flash_extension || 1;  // stretch along the barrel
    const spin = Math.random() * Math.PI * 2;
    for (const m of state.curFlash) {
      m.visible = true;
      m.scale.set(s, s, s * ext);
      m.rotation.z = spin;
    }
  }
  if (st.vfx.ejects_cartridges) spawnCasing();
  updateHud();
}

// ---- input ----
const look = { yaw: 0, pitch: 0 };
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
  if (locked && e.button === 2 && state.stats && state.stats.zoom_fov > 0) state.zooming = true;
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) state.firing = false;
  if (e.button === 2) state.zooming = false;
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
  if (e.code === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyG') toggleHostile();
  if (e.code === 'KeyP') {
    state.patrol = !state.patrol;
    const el = document.getElementById('patrol');
    if (el) el.textContent = state.patrol ? 'PATROLS OUT' : '';
  }
  if (e.code === 'KeyR') reload();
  if (e.code === 'Minus') master.gain.value = Math.max(0, master.gain.value - 0.05);
  if (e.code === 'Equal') master.gain.value = Math.min(1, master.gain.value + 0.05);
  if (e.code === 'BracketRight') cycle(1);
  if (e.code === 'BracketLeft') cycle(-1);
});
document.addEventListener('wheel', e => {
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

// ---- main loop ----
buildRange();
buildTargets().then(buildProps);
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
            t.position.x += dx / dist * speed * dt;
            t.position.z += dz / dist * speed * dt;
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
        // off duty: turn back to the firing line
        if (Math.abs(t.rotation.y) > 0.01 && u.downT <= 0)
          t.rotation.y *= Math.max(0, 1 - dt * 5);
      }
      // The death animations pivot the body around the hip joint, but the
      // animation's root translation isn't decoded, so without help the corpse
      // ends horizontal a metre off the floor. Re-ground from the posed
      // vertices while falling; once the pose holds, stop paying for it.
      if (u.downT > 0 && !animEnded) {
        t.updateWorldMatrix(true, true);
        u.rig.holder.position.y -= skinnedBounds(u.rig).min.y;
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
        u.hp = u.maxhp;
        u.lastDmg = 0;
        updateHpBar(t);
        if (u.rig) {
          u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0;
          poseSkeleton(u.rig, u.anim, 0, u.flip);
          t.updateWorldMatrix(true, true);
          u.rig.holder.position.y -= skinnedBounds(u.rig).min.y;
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
      if (m.position.y < 0.02) { m.position.y = 0.02; u.vel.set(0,0,0); u.rot.set(0,0,0); }
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
    const hit = raycaster.intersectObjects(targets, true)[0];
    p.position.addScaledVector(u.vel, dt);
    p.lookAt(p.position.clone().add(dir));
    u.life -= dt;
    const out = p.position.y <= 0.02 || p.position.z <= -113 || Math.abs(p.position.x) >= 12.8
      || p.position.z >= 6 || p.position.y >= 6.9;
    if (hit || out || u.life <= 0) {
      const at = hit ? hit.point : p.position.clone();
      at.y = Math.max(at.y, 0.05);
      scene.remove(p); projectiles.splice(i, 1);
      explode(at, u.radius, state.stats ? state.stats.damage * 8 : 8);
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
    const k = Math.exp(-dt * 4 * xs);
    state.ret.x *= k; state.ret.y *= k;
    const el = document.getElementById('crosshair');
    if (el) el.style.transform =
      `translate(-50%,-50%) translate(${(state.ret.x * canvas.clientWidth / 2).toFixed(1)}px, ${(-state.ret.y * canvas.clientHeight / 2).toFixed(1)}px)`;
  }

  // gunfire.c recoil: pitch to RecoilUp degrees muzzle-up and pull back a
  // RecoilBack/1000 fraction of the gun-to-aim distance (~RecoilBack cm),
  // rising on a quarter sine over byte0 ticks of RecoilSpeed and recovering
  // on a half cosine over byte1.
  if (state.gunRest && state.gun) {
    const st2 = state.stats;
    let rk = 0;
    if (st2 && state.recoilTick >= 0) {
      const rs = st2.vfx.recoil_speed >>> 0;
      const rise = (rs >>> 24) & 255 || 4, fall = (rs >>> 16) & 255 || 8;
      state.recoilTick += dt * 60;
      if (state.recoilTick < rise) rk = Math.sin(state.recoilTick * Math.PI / 2 / rise);
      else if (state.recoilTick < rise + fall)
        rk = Math.cos((state.recoilTick - rise) * Math.PI / fall) * 0.5 + 0.5;
      else { rk = 0; state.recoilTick = -1; }
    }
    const g = state.gun;
    const play = st2 ? st2.vfx.gun_play : [3, 3, 8.5];
    g.rotation.x = state.gunRest.rot.x + THREE.MathUtils.degToRad(st2 ? st2.vfx.recoil_up : 0) * rk;
    g.position.set(
      state.gunRest.pos.x + state.ret.x * play[2] * 0.01,
      state.gunRest.pos.y + state.ret.y * play[1] * 0.01,
      state.gunRest.pos.z + (st2 ? st2.vfx.recoil_back : 0) * 0.01 * rk);
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
  const swayAmp = 0.004 * (state.stats ? state.stats.vfx.sway : 1);   // Sway stat
  gunMount.position.set(dip * 0.03, Math.sin(now * 1.8) * swayAmp - dip * 0.09,
                        dip * 0.04);
  gunMount.rotation.set(-dip * 0.42, 0, dip * 0.18);
  // action cycling: slide/bolt throw straight back and return
  if (state.slideT > 0) {
    state.slideT = Math.max(0, state.slideT - dt / 0.11);
    const k = state.slideT > 0.72 ? (1 - state.slideT) / 0.28 : state.slideT / 0.72;
    const back = (state.stats ? state.stats.vfx.bolt_recoil_back : 0) * k;
    for (const part of ['slide', 'bolt']) {
      const m2 = state.movers[part];
      if (m2) m2.position.set(m2.userData.base.x, m2.userData.base.y, m2.userData.base.z - back);
    }
  }
  if (state.cylT < 1 && state.movers.cylinder) {
    state.cylT = Math.min(1, state.cylT + dt / 0.16);
    const e = state.cylT * state.cylT * (3 - 2 * state.cylT);
    state.movers.cylinder.rotation.z = state.cylFrom + (state.cylTo - state.cylFrom) * e;
  }
  if (state.hammerT > 0 && state.movers.hammer) {
    state.hammerT = Math.max(0, state.hammerT - dt / 0.13);
    const hk = state.hammerT > 0.7 ? (1 - state.hammerT) / 0.3 : state.hammerT / 0.7;
    state.movers.hammer.rotation.x = -0.5 * hk;
  }

  const w = canvas.clientWidth, h = canvas.clientHeight;
  // A zero-sized canvas (hidden tab, collapsed pane) makes aspect NaN, which
  // poisons both projection matrices and renders nothing until the next resize.
  if (w < 8 || h < 8) return;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    const aspect = w / h;
    // GE renders 4:3 at 60 degrees vertical, i.e. a ~75 degree horizontal
    // field. Hold THAT constant: on wide windows the vertical FOV shrinks
    // (vert-) instead of the horizontal blowing out to ~91 degrees at 16:9,
    // which stretched everything near the screen edges.
    const hFromGE = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(GE_FOVY) / 2) * (4 / 3));
    const vfov = a => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hFromGE / 2) / Math.max(a, 0.4)));
    cam.aspect = aspect;
    cam.fov = aspect > (4 / 3) ? vfov(aspect) : GE_FOVY;
    cam.updateProjectionMatrix();
    gunCam.aspect = aspect; gunCam.fov = cam.fov; gunCam.near = window.__P.near;
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
window.__dbg = { state, selectWeapon, shoot, look, targets, scene, cam, renderer, gunMount, gunScene, gunCam, tick, poseSkeleton, loadAnim };
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
