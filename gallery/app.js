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
master.gain.value = 0.30;                 // master volume (- / = keys)
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
      fetch(`${EX}/models/${modelName}.skin.json`).then(r => r.json()),
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
    return { mesh, bones, roots, skeleton: new THREE.Skeleton(bones), skin };
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
  return { holder, mesh, bones, skeleton, joints };
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
    hat.userData.zone = 'head';
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

  g.position.set(x, 0, z);
  g.userData = {
    // chr.c:1656 -- every guard spawns with maxdamage 4.0, so weapon damage
    // straight from WeaponStats gives the real number of hits: four PP7 body
    // shots, one Golden Gun round.
    hp: CHARS.guard_max_damage, maxhp: CHARS.guard_max_damage,
    hit: 'flesh', downT: 0, wobble: 0, flash: 0,
    name: spec.name, female: !!spec.female, enemy: true,
    rig, anim: idle, idleAnim: idle, frame: Math.random() * idle.frames,
    animName: 'idle', flip: Math.random() < 0.5,
    wepObj, wkey: spec.wkey || null, pistol: !!spec.pistol,
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
      const spec = ENEMIES[i++ % ENEMIES.length];
      try { await mkEnemy(x + (Math.abs(z) % 7) * 0.1 - 0.3, z, spec); }
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
  m.position.copy(cam.position).addScaledVector(right, 0.28).addScaledVector(fwd, 0.35)
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
      u.hp -= damage * (1 - dist / radius) * 4;
      hitReact(t);
      state.hits++;
      if (u.hp <= 0) { u.downT = 2.2; state.score += 50; }
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
// ---- guards fire back (visually -- the range never hurts the player) ----
const _muz = new THREE.Vector3();
function guardFire(t, now) {
  const u = t.userData;
  const fireAnim = u.pistol ? 'fire_standing_one_handed_weapon'
                 : (Math.random() < 0.5 ? 'fire_standing' : 'fire_hip');
  loadAnim(fireAnim).then(a => {
    if (u.downT > 0 || u.animName !== 'idle') return;
    u.anim = a; u.animName = fireAnim; u.frame = 0;
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

/** Non-fatal hit: play one of GE's flinch animations instead of a wobble. */
const FLINCHES = ['hit_left_shoulder', 'hit_right_shoulder', 'hit_left_arm', 'hit_right_arm'];
function playFlinch(t) {
  const u = t.userData;
  if (!u.rig || u.downT > 0) return;
  const name = FLINCHES[Math.floor(Math.random() * FLINCHES.length)];
  loadAnim(name).then(a => {
    if (u.downT > 0) return;
    u.anim = a; u.animName = name; u.frame = 0;
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
    u.anim = a; u.animName = name; u.frame = 0;
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
  m.position.copy(cam.position).addScaledVector(dir, 0.9).add(new THREE.Vector3(0, -0.15, 0));
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
    const ml = new MTLLoader().setPath(`${EX}/models/`);
    const mtl = await ml.loadAsync(`${name}.mtl`);
    mtl.preload();
    const ol = new OBJLoader().setMaterials(mtl).setPath(`${EX}/models/`);
    const obj = await ol.loadAsync(`${name}.obj`);
    const flashGroups = {};          // child index -> [materials]
    obj.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = [];
      for (let m of mats) {
        const sw = m.name.match(/_sw(\d+)_(\d+)/);
        const fl = m.name.match(/_fl(\d+)/);
        const lit = /_lit(_|$)/.test(m.name);
        // Faces from the record's Secondary display list. model.c draws
        // Primary opaque and Secondary in XLU mode straight after it; the
        // struct calls them "secondary surfaces". In practice they are
        // decals laid exactly on the skin -- 12 of the rocket launcher's 20
        // secondary triangles are coplanar with a primary face to within
        // 0.00 model units, which is what made its markings flicker.
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
          // N64 texture generation samples by the VIEW-space normal, so the
          // highlight sweeps as the weapon moves. Baked object-space UVs pin
          // each face to one texel and dark-edge faces vanish, which is why the
          // Golden Gun read as a hollow outline. A matcap does exactly this.
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
          // ModelType 3 (GunLighting) multiplies TEXEL0 by SHADE from the vertex
          // normals -- the exported OBJ carries those normals, and the gun scene
          // now carries GE's own light. This is what makes the barrels gloss:
          // the AR33's grey gradient (texture 2293) is a specular strip that
          // only reads correctly once shading modulates it. The previous flat
          // 0.65 showed it as a painted pale streak.
          nm = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
        } else {                      // prelit: baked vertex colours
          nm = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
        }
        if (map && !fl) nm.alphaTest = 0.35;
        if (sec && !fl) {
          // XLU_SURF does not update Z, so a decal never depth-fights the face
          // it sits on; the polygon offset keeps it in front of that face.
          nm.transparent = true;
          nm.depthWrite = false;
          nm.polygonOffset = true;
          nm.polygonOffsetFactor = -2;
          nm.polygonOffsetUnits = -2;
        }
        nm.name = m.name;
        if (fl) {                     // muzzle-flash frames (header Switches[1])
          nm.transparent = true; nm.blending = THREE.AdditiveBlending;
          nm.depthWrite = false; nm.alphaTest = 0;
          nm.visible = false;
          const frame = +fl[1];
          (flashGroups[frame] = flashGroups[frame] || []).push(nm);
        }                             // ordinary switch children are all part of
                                      // the weapon at rest; only flash is hidden
        out.push(nm);
      }
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    // barrel direction: muzzle flash quads sit at the muzzle in model space.
    // The OBJ is one mesh with material groups, so gather flash-group vertices.
    const all = new THREE.Box3();
    const flash = new THREE.Box3();
    const v = new THREE.Vector3();
    obj.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      all.union(o.geometry.boundingBox);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index;
      for (const g of o.geometry.groups || []) {
        const m = mats[g.materialIndex] || mats[0];
        if (!/_fl\d/.test(m.name)) continue;
        for (let i = g.start; i < g.start + g.count; i++) {
          const vi = idx ? idx.getX(i) : i;
          flash.expandByPoint(v.fromBufferAttribute(pos, vi));
        }
      }
      if ((!o.geometry.groups || !o.geometry.groups.length)
          && mats.some(m => /_fl\d/.test(m.name))) {
        flash.union(o.geometry.boundingBox);
      }
    });
    // GE scales the muzzle flash per shot (random 1.0-1.25, stretched along the
    // barrel by MuzzleFlashExtension). That needs the flash as its own object,
    // so lift each flash frame's triangles out of the baked gun mesh.
    const flashMeshes = {};
    obj.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
      for (const gr of (g.groups || [])) {
        const m = mats[gr.materialIndex] || mats[0];
        const fm = m && m.name.match(/_fl(\d+)/);
        if (!fm) continue;
        const frame = +fm[1];
        const P = [], U = [];
        for (let i = gr.start; i < gr.start + gr.count; i++) {
          const vi = idx ? idx.getX(i) : i;
          P.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          if (uv) U.push(uv.getX(vi), uv.getY(vi));
        }
        if (!P.length) continue;
        const ng = new THREE.BufferGeometry();
        ng.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        if (U.length) ng.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
        ng.computeBoundingBox();
        const c = ng.boundingBox.getCenter(new THREE.Vector3());
        ng.translate(-c.x, -c.y, -c.z);        // scale about the flash centre
        const mesh = new THREE.Mesh(ng, m);
        mesh.position.copy(c);
        mesh.visible = false;
        mesh.renderOrder = 10;
        o.add(mesh);
        (flashMeshes[frame] = flashMeshes[frame] || []).push(mesh);
      }
    });
    return { obj, flashGroups, flashMeshes, all, flash };
  })();
  gunCache.set(name, p);
  return p;
}

// ---- weapon state ----
const state = {
  key: null, stats: null, gun: null, flashGroups: {},
  ammo: 0, reserve: Infinity, firing: false, nextShot: 0, reloading: false,
  recoil: 0, kick: 0, flashT: 0,
  score: 0, shots: 0, hits: 0,
};

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
  const { obj, flashGroups, flashMeshes } = await loadGunModel(modelName);
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
  gunMount.add(holder);
  gunMount.scale.setScalar(1);
  state.gun = holder; state.flashGroups = flashGroups; state.flashMeshes = flashMeshes;
  updateHud();
  loadBuf(soundById(parseInt(st.sound_id, 16)));
}

function updateHud() {
  const st = state.stats;
  if (!st) return;
  document.getElementById('wname').textContent = DISPLAY[state.key] || state.key;
  document.getElementById('ammo').innerHTML = state.reloading ? '<small>RELOADING…</small>'
    : (state.ammo === Infinity ? '∞'
       : `<span class="ge-reserve">∞</span> <span class="ge-bullet">▮</span> ${state.ammo}`);
  const fi = fireInterval(st);
  const rpm = Math.round(60 / fi.t);
  document.getElementById('stats').innerHTML =
    `<b>${DISPLAY[state.key] || state.key}</b><br>` +
    `damage <b>${st.damage}</b> · spread <b>${st.inaccuracy}</b><br>` +
    `${fi.auto ? 'auto' : 'single'} · <b>${rpm}</b> rpm · mag <b>${st.mag_size}</b><br>` +
    `penetration <b>${st.penetration_objects}</b> · loudness <b>${st.ai_noise.loudness_max}</b><br>` +
    `sound <b>${(st.sound_name || '').replace('_SFX','')}</b>`;
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
  play(soundById(parseInt(st.sound_id, 16)), { vol: 0.55, pitch: 0.97 + Math.random() * 0.06 });
  // spread: inaccuracy in GE arbitrary units; scale to radians
  const spread = st.inaccuracy * 0.0022;
  const pellets = (state.key === 'shotgun' || state.key === 'autoshot') ? 5 : 1;
  const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const muzzle = cam.position.clone()
    .addScaledVector(right, 0.22).addScaledVector(up, -0.18).addScaledVector(aim, 0.6);
  for (let pi = 0; pi < pellets; pi++) {
    const dir = aim.clone()
      .addScaledVector(right, (Math.random()-0.5)*spread)
      .addScaledVector(up, (Math.random()-0.5)*spread)
      .normalize();
    if (EXPLOSIVE[state.key]) { fireProjectile(state.key, dir); continue; }
    raycaster.set(cam.position, dir);
    raycaster.far = 300;
    const hits = raycaster.intersectObjects(targets, true);
    const end = hits.length ? hits[0].point
      : cam.position.clone().addScaledVector(dir, 130);
    spawnTracer(muzzle, end);
    if (hits.length) {
      const h = hits[0];
      let g = h.object;
      while (g.parent && !g.userData.hit) g = g.parent;
      const mat = g.userData.hit || 'other';
      const set = HIT_SOUNDS[mat];
      play(set[Math.floor(Math.random() * set.length)], { vol: 0.8, at: h.point, pitch: 0.9 + Math.random()*0.2 });
      spawnSpark(h.point);
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
                       : dir.clone().negate();
      spawnDecal(h.point, n);
      hitReact(g);
      if (g.userData.rig) playFlinch(g);
      if (g.userData.hp !== Infinity && g.userData.downT <= 0) {
        if (pi === 0) state.hits++;
        hitMarker();
        // a head hit drops a GE guard outright, whatever the weapon
        let zone = null;
        for (let o = h.object; o && o !== g; o = o.parent)
          if (o.userData && o.userData.zone) { zone = o.userData.zone; break; }
        const head = zone === 'head';
        g.userData.hp -= head ? g.userData.maxhp : st.damage;
        state.score += Math.max(1, Math.round(-g.position.z)) * (head ? 2 : 1);
        reactSound(g, h.point, head);
        if (g.userData.hp <= 0) {
          g.userData.downT = 3.4;
          state.score += 50;
          playDeath(g, head);
        }
      }
    }
  }
  shake = Math.min(1, shake + st.vfx.recoil_up * 0.004 + 0.02);
  // recoil + flash
  state.recoil = Math.min(1.5, state.recoil + st.vfx.recoil_up * 0.012 + 0.05);
  state.kick = Math.min(1, state.kick + st.vfx.recoil_back * 0.05 + 0.15);
  state.flashT = 0.055;
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
  look.yaw -= e.movementX * 0.0022;
  look.pitch -= e.movementY * 0.0022;
  look.pitch = Math.max(-1.35, Math.min(1.35, look.pitch));
});
document.addEventListener('mousedown', e => { if (locked && e.button === 0) state.firing = true; });
document.addEventListener('mouseup', e => { if (e.button === 0) state.firing = false; });
document.addEventListener('keydown', e => {
  if (e.code === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyR') reload();
  if (e.code === 'Minus') master.gain.value = Math.max(0, master.gain.value - 0.05);
  if (e.code === 'Equal') master.gain.value = Math.min(1, master.gain.value + 0.05);
  if (e.code === 'BracketRight') cycle(1);
  if (e.code === 'BracketLeft') cycle(-1);
});
document.addEventListener('wheel', e => cycle(e.deltaY > 0 ? 1 : -1));
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
  state.recoil = Math.max(0, state.recoil - dt * 6);
  state.kick = Math.max(0, state.kick - dt * 8);
  if (state.flashT > 0) {
    state.flashT -= dt;
    if (state.flashT <= 0 && state.curFlash)
      for (const m of state.curFlash) m.visible = false;
  }
  // targets: animation, fall/respawn, wobble, hit flash
  for (const t of targets) {
    const u = t.userData;
    if (u.rig && u.anim) {
      // GE animations run at 60 Hz, one bitstream frame per tick.
      u.frame += dt * 60;
      if (u.frame >= u.anim.frames) {
        if (u.anim.loop || u.animName === 'idle') {
          u.frame %= u.anim.frames;
        } else if (u.downT > 0) {
          u.frame = u.anim.frames - 1;            // deaths hold their last pose
        } else {                                  // fire/flinch: back to idle
          u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0;
        }
      }
      poseSkeleton(u.rig, u.anim, u.frame, u.flip);
      if (u.wkey && u.downT <= 0 && u.animName === 'idle' && now >= u.nextFire) {
        u.nextFire = now + 4 + Math.random() * 8;
        guardFire(t, now);
      }
    }
    if (u.downT > 0) {
      u.downT -= dt;
      if (u.downT <= 0) {
        u.hp = u.maxhp;
        if (u.rig) { u.anim = u.idleAnim; u.animName = 'idle'; u.frame = 0; }
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

  const kickPitch = state.recoil * 0.03;
  cam.rotation.set(0, 0, 0);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = look.yaw + shy;
  cam.rotation.x = look.pitch + kickPitch + shx;

  // gun mount: metres, fixed to camera; recoil pulls back/up
  gunMount.position.set(0, Math.sin(now * 1.8) * 0.004 + state.recoil * 0.012,
                        state.kick * 0.07);
  gunMount.rotation.set(state.recoil * 0.09, 0, 0);

  const w = canvas.clientWidth, h = canvas.clientHeight;
  // A zero-sized canvas (hidden tab, collapsed pane) makes aspect NaN, which
  // poisons both projection matrices and renders nothing until the next resize.
  if (w < 8 || h < 8) return;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    const aspect = w / h;
    // GE renders 4:3; on wider/narrower windows keep the horizontal field the
    // game had rather than letting the vertical FOV stretch the view
    const hFromGE = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(GE_FOVY) / 2) * (4 / 3));
    const vfov = a => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hFromGE / 2) / Math.max(a, 0.4)));
    cam.aspect = aspect;
    cam.fov = aspect > (4 / 3) ? GE_FOVY : vfov(aspect);
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
