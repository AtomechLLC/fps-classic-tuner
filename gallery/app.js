import * as THREE from 'three';
import { OBJLoader } from './lib/OBJLoader.js';
import { MTLLoader } from './lib/MTLLoader.js';

const EX = '../extracted';
window.__P = { x: 3, y: 10, z: 0, rx: 0.12, ry: -0.38, rz: 0.03, ms: 0.33, k: 0.010, near: 0.05 };

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
const cam = new THREE.PerspectiveCamera(60, 1, 0.05, 400);
cam.position.set(0, 1.6, 0);
const gunCam = new THREE.PerspectiveCamera(60, 1, 0.02, 60);   // separate pass so gun never clips

scene.add(new THREE.HemisphereLight(0xcfd8e8, 0x30302a, 1.15));
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
  const rows = [
    { z: -14, imgs: [9, 10, 9] },      // STOMEMAN stone-man reliefs
    { z: -32, imgs: [10, 9, 10] },
    { z: -55, imgs: [9, 10, 9] },
    { z: -85, imgs: [10, 9, 10] },
  ];
  for (const r of rows)
    r.imgs.forEach((img, i) => mkTarget((i - 1) * 6.5, r.z, {
      img, w: 1.35, h: 1.9, hp: 8, hit: 'wood', name: `target @${-r.z}m` }));
  // material test blocks
  const blocks = [
    { img: 8,   hit: 'metal', x: -10, z: -20 },   // yellow stripes
    { img: 195, hit: 'stone', x: 10, z: -20 },    // BRICK
    { img: 33,  hit: 'wood',  x: -10, z: -45 },   // AMMOCRATE1
    { img: 34,  hit: 'wood',  x: 10, z: -45 },    // AMMOCRATE2
  ];
  for (const b of blocks) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshLambertMaterial({ map: geTex(b.img, 1) }));
    m.position.set(b.x, 0.8, b.z);
    m.userData = { hp: Infinity, hit: b.hit, block: true };
    scene.add(m);
    targets.push(m);
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
const objLoader = new OBJLoader();
const mtlLoader = new MTLLoader();
const gunScene = new THREE.Scene();
gunScene.add(new THREE.HemisphereLight(0xffffff, 0x556, 2.3));
const gl2 = new THREE.DirectionalLight(0xfff5e0, 1.8);
gl2.position.set(-1, 2, 1);
gunScene.add(gl2);
const gl3 = new THREE.DirectionalLight(0xccd5ff, 0.8);
gl3.position.set(1, -0.5, 1);
gunScene.add(gl3);
const gunMount = new THREE.Group();
gunScene.add(gunMount);

const gunCache = new Map();
async function loadGunModel(name) {
  if (gunCache.has(name)) return gunCache.get(name);
  const p = (async () => {
    const mtl = await mtlLoader.setPath(`${EX}/models/`).loadAsync(`${name}.mtl`);
    mtl.preload();
    const obj = await objLoader.setMaterials(mtl).setPath(`${EX}/models/`).loadAsync(`${name}.obj`);
    const flashGroups = {};          // child index -> [materials]
    obj.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = [];
      for (let m of mats) {
        const sw = m.name.match(/_sw(\d+)_(\d+)/);
        const lit = /_lit$/.test(m.name);
        const map = m.map || null;
        if (map) { map.magFilter = THREE.NearestFilter; map.colorSpace = THREE.SRGBColorSpace;
                   map.wrapS = map.wrapT = THREE.RepeatWrapping; }
        let nm;
        const tid = +(m.name.match(/^tex_(\d+)/) || [0, -1])[1];
        const ie = IMAGES[tid];
        const envStrip = ie && (ie.w === 1 || ie.h === 1
          || /SPECULAR|SHINE|CHROME/i.test(ie.name || ''));   // texture-gen highlight
        if (envStrip && lit) {        // approximate N64 env-mapped metal
          nm = new THREE.MeshPhongMaterial({ color: 0xb9bec6, specular: 0xffffff,
            shininess: 55, side: THREE.DoubleSide });
        } else if (lit) {             // vertex-normal lit geometry (gun bodies)
          nm = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
        } else {                      // prelit: baked vertex colours
          nm = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: true });
        }
        if (map && !(sw && sw[1] === '0')) nm.alphaTest = 0.35;
        nm.name = m.name;
        if (sw) {
          const swi = +sw[1], child = +sw[2];
          if (swi === 0) {            // muzzle flash switch
            nm.transparent = true; nm.blending = THREE.AdditiveBlending;
            nm.depthWrite = false; nm.alphaTest = 0;
            nm.visible = false;
            (flashGroups[child] = flashGroups[child] || []).push(nm);
          } else if (child > 0) {     // non-default switch state
            nm.visible = false;
          }
        }
        out.push(nm);
      }
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    return { obj, flashGroups };
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
  const { obj, flashGroups } = await loadGunModel(modelName);
  if (state.key !== key) return;
  gunMount.clear();
  // GE view frame: model +z into screen; stats give on-screen offset + scale
  const gp = st.vfx.gun_screen_pos;
  const P = window.__P;
  const bb = MODELS[modelName].bbox || [0,0,0,0,0,400];
  const lenZ = Math.max(bb[5] - bb[2], 100);
  const norm = Math.pow(407 / lenZ, 0.8);      // soft-normalise long guns
  obj.rotation.set(P.rx, Math.PI + P.ry, P.rz);
  obj.scale.setScalar((st.crosshair_speed || 0.8) * P.ms * norm);
  obj.position.set(gp[0] + P.x, gp[1] + P.y, Math.min(gp[2], -28) + P.z);
  gunMount.add(obj);
  state.gun = obj; state.flashGroups = flashGroups;
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
  const kids = Object.keys(state.flashGroups);
  if (kids.length) {
    const j = kids[Math.floor(Math.random() * kids.length)];
    state.curFlash = state.flashGroups[j];
    for (const m of state.curFlash) m.visible = true;
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

  // gun pose: GE view units (cm-ish) scaled to metres; recoil pulls back/up
  const K = window.__P.k;
  gunMount.scale.setScalar(K);
  gunMount.position.set(0, Math.sin(now * 1.8) * 0.004 + state.recoil * 0.01,
                        state.kick * 0.06);
  gunMount.rotation.set(state.recoil * 0.09, 0, 0);

  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    gunCam.aspect = w / h; gunCam.updateProjectionMatrix();
  }
  renderer.autoClear = true;
  renderer.render(scene, cam);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(gunScene, gunCam);
}
tick();

// ---- debug hooks (harmless in production) ----
window.__repose = () => {
  gunCam.near = window.__P.near || 0.02;
  gunCam.updateProjectionMatrix();
  return selectWeapon(state.key);
};
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
