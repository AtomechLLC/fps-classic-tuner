import * as THREE from 'three';
import { OBJLoader } from './lib/OBJLoader.js';
import { MTLLoader } from './lib/MTLLoader.js';

const EX = '../extracted';
window.__P = { scale: 0.55, px: 0.16, py: -0.17, pz: -0.62, rx: 0.05, ry: -0.50, rz: 0.04, near: 0.01 };

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
const [WEAPONS, MODELS, SOUNDS, IMAGES] = await Promise.all([
  fetch(`${EX}/weapons/WEAPONS.json`).then(r => r.json()),
  fetch(`${EX}/models/MODELS.json`).then(r => r.json()),
  fetch(`${EX}/sounds/SOUNDS.json`).then(r => r.json()),
  fetch(`${EX}/images/IMAGES.json`).then(r => r.json()),
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
function play(url, { vol = 1, pitch = 1, at = null } = {}) {
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
    src.start();
  });
}

// ---- renderer / scene ----
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d12);
scene.fog = new THREE.Fog(0x0a0d12, 60, 160);
const GE_FOVY = 46;            // player.c: c_perspfovy = 46.0f
const cam = new THREE.PerspectiveCamera(GE_FOVY, 1, 0.05, 400);
cam.position.set(0, 1.6, 0);
const gunCam = new THREE.PerspectiveCamera(GE_FOVY, 1, 0.02, 60); // separate pass so gun never clips

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
      const out = mats.map(m => {
        const map = m.map || null;
        if (map) { map.magFilter = THREE.NearestFilter; map.colorSpace = THREE.SRGBColorSpace;
                   map.wrapS = map.wrapT = THREE.RepeatWrapping; }
        const lit = /_lit/.test(m.name);
        const nm = lit
          ? new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide })
          : new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
        if (map) nm.alphaTest = 0.35;
        nm.name = m.name;
        return nm;
      });
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

// ---- targets ----
const targets = [];
const raycaster = new THREE.Raycaster();
function mkTarget(x, z, opts) {
  const g = new THREE.Group();
  const boardT = geTex(opts.img, 1);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(opts.w, opts.h),
    new THREE.MeshLambertMaterial({ map: boardT, side: THREE.DoubleSide, transparent: true }));
  board.position.y = 1.5;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12),
    new THREE.MeshLambertMaterial({ color: 0x555 }));
  post.position.y = 0.5;
  g.add(board, post);
  g.position.set(x, 0, z);
  g.userData = { hp: opts.hp, maxhp: opts.hp, board, hit: opts.hit, downT: 0, name: opts.name };
  scene.add(g);
  targets.push(g);
}
function buildTargets() {
  // knock-down silhouette targets down the lanes (planes: cheap and readable)
  const rows = [
    { z: -14, imgs: [9, 10, 9] },      // STOMEMAN stone-man reliefs
    { z: -32, imgs: [10, 9, 10] },
    { z: -55, imgs: [9, 10, 9] },
    { z: -85, imgs: [10, 9, 10] },
  ];
  for (const r of rows)
    r.imgs.forEach((img, i) => mkTarget((i - 1) * 6.5, r.z, {
      img, w: 1.35, h: 1.9, hp: 8, hit: 'wood', name: `target @${-r.z}m` }));
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
  wood:  [sfx('HIT_BULLET_WOOD_SFX'), ...RICO.slice(0, 4)],
  metal: [sfx('HIT_BULLET_METAL_A_SFX'), sfx('HIT_BULLET_METAL_B_SFX'), ...RICO.slice(4, 8)],
  stone: RICO.slice(8, 16),
  other: RICO.slice(16, 20),
};
const EXPLO_SOUNDS = ['EXPLOSION_2A_SFX','EXPLOSION_2B_SFX','EXPLOSION_3_SFX','EXPLOSION_4A_SFX']
  .map(sfx).filter(Boolean);

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
  if (u.board) {
    u.board.material.color.setRGB(1.6, 0.6, 0.6);
    u.flash = 0.15;
  }
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
const gunScene = new THREE.Scene();
gunScene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 0.75));
const gl2 = new THREE.DirectionalLight(0xffffff, 0.95);
gl2.position.set(-0.6, 1.4, 0.8);
gunScene.add(gl2);
const gl3 = new THREE.DirectionalLight(0xc9d4ff, 0.35);
gl3.position.set(1, -0.3, 0.5);
gunScene.add(gl3);
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
        const lit = /_lit$/.test(m.name);
        const map = m.map || null;
        if (map) { map.magFilter = THREE.NearestFilter; map.colorSpace = THREE.SRGBColorSpace;
                   map.wrapS = map.wrapT = THREE.RepeatWrapping; }
        let nm;
        const tid = +(m.name.match(/^tex_(\d+)/) || [0, -1])[1];
        const ie = IMAGES[tid];
        const isEnv = /_env$/.test(m.name);                  // G_TEXTURE_GEN geometry
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

        } else if (lit) {             // vertex-normal lit geometry (gun bodies)
          nm = new THREE.MeshPhongMaterial({ map, specular: 0x8a8a8a, shininess: 30,
            side: THREE.DoubleSide });
        } else {                      // prelit: baked vertex colours
          nm = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
        }
        if (map && !fl) nm.alphaTest = 0.35;
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
  obj.removeFromParent();
  obj.position.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  obj.rotation.set(0, Math.PI, 0);        // muzzle +z -> camera forward -z
  obj.updateWorldMatrix(false, true);
  const raw = new THREE.Box3().setFromObject(obj);
  obj.position.sub(raw.getCenter(new THREE.Vector3()));
  holder.add(obj);
  const size = raw.getSize(new THREE.Vector3());
  const unit = Math.max(size.x, size.y, size.z) || 1;
  holder.scale.setScalar(P.scale / unit);
  holder.position.set(P.px, P.py, P.pz);
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
      if (g.userData.hp !== Infinity && g.userData.downT <= 0) {
        if (pi === 0) state.hits++;
        hitMarker();
        g.userData.hp -= st.damage;
        state.score += Math.max(1, Math.round(-g.position.z));
        if (g.userData.hp <= 0) {
          g.userData.downT = 2.2;
          state.score += 50;
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
buildTargets();
buildProps();
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
  // targets: fall/respawn, wobble, hit flash
  for (const t of targets) {
    const u = t.userData;
    if (u.downT > 0) {
      u.downT -= dt;
      const fall = Math.min(1, (2.2 - u.downT) * 4);
      t.rotation.x = -fall * Math.PI / 2;
      if (u.downT <= 0) { u.hp = u.maxhp; t.rotation.x = 0; }
    }
    if (u.wobble > 0) {
      u.wobble = Math.max(0, u.wobble - dt * 3.5);
      t.rotation.z = Math.sin(performance.now() * 0.045) * u.wobble * 0.12;
      if (u.wobble === 0) t.rotation.z = 0;
    }
    if (u.flash > 0) {
      u.flash -= dt;
      if (u.flash <= 0 && u.board) u.board.material.color.setRGB(1, 1, 1);
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
window.__dbg = { state, selectWeapon, shoot, look, targets, scene, cam, renderer, gunMount, gunScene, gunCam };
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
