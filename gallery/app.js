import * as THREE from 'three';
import { OBJLoader } from './lib/OBJLoader.js';
import { MTLLoader } from './lib/MTLLoader.js';

const EX = '../extracted';

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
const bufCache = new Map();
async function loadBuf(url) {
  if (!url) return null;
  if (!bufCache.has(url)) {
    bufCache.set(url, fetch(url).then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b)).catch(() => null));
  }
  return bufCache.get(url);
}
function play(url, { vol = 1, pitch = 1 } = {}) {
  loadBuf(url).then(buf => {
    if (!buf) return;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    const g = actx.createGain(); g.gain.value = vol;
    src.connect(g); g.connect(actx.destination);
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
const gunCam = new THREE.PerspectiveCamera(50, 1, 0.01, 50);   // separate pass so gun never clips

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

// ---- impact sounds per material ----
const HIT_SOUNDS = {
  wood:  RICO.filter((_, i) => i % 4 === 0),
  metal: RICO.filter((_, i) => i % 4 === 1),
  stone: RICO.filter((_, i) => i % 4 === 2),
  other: RICO.filter((_, i) => i % 4 === 3),
};

// ---- sparks / impact fx ----
const sparks = [];
const sparkGeo = new THREE.SphereGeometry(0.03, 4, 4);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc55 });
function spawnSpark(p) {
  const m = new THREE.Mesh(sparkGeo, sparkMat.clone());
  m.position.copy(p);
  m.userData.t = 0.12;
  scene.add(m);
  sparks.push(m);
}

// ---- weapon view models ----
const objLoader = new OBJLoader();
const mtlLoader = new MTLLoader();
const gunScene = new THREE.Scene();
gunScene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
const gl2 = new THREE.DirectionalLight(0xfff5e0, 1.0);
gl2.position.set(-1, 2, 1);
gunScene.add(gl2);
const gunMount = new THREE.Group();
gunScene.add(gunMount);

const gunCache = new Map();
async function loadGunModel(name) {
  if (gunCache.has(name)) return gunCache.get(name);
  const p = (async () => {
    const mtl = await mtlLoader.setPath(`${EX}/models/`).loadAsync(`${name}.mtl`);
    mtl.preload();
    const obj = await objLoader.setMaterials(mtl).setPath(`${EX}/models/`).loadAsync(`${name}.obj`);
    const flashMats = [], flashMeshes = [];
    obj.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let anySwitch = false;
      for (const m of mats) {
        m.side = THREE.DoubleSide;
        if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.colorSpace = THREE.SRGBColorSpace; }
        if (/_sw\d+$/.test(m.name)) {
          anySwitch = true;
          if (/_sw0$/.test(m.name)) {           // switch 0 = muzzle flash frames
            m.transparent = true; m.blending = THREE.AdditiveBlending;
            m.depthWrite = false;
            flashMats.push(m);
          }
          m.visible = false;
        }
      }
      if (anySwitch) flashMeshes.push(o);
    });
    // normalise: GE guns are modelled in cm-ish units at view offsets
    const bbox = new THREE.Box3().setFromObject(obj);
    const size = bbox.getSize(new THREE.Vector3());
    const s = 0.55 / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(s);
    const bbox2 = new THREE.Box3().setFromObject(obj);
    const c = bbox2.getCenter(new THREE.Vector3());
    obj.position.sub(c);
    return { obj, flashMats };
  })();
  gunCache.set(name, p);
  return p;
}

// ---- weapon state ----
const state = {
  key: null, stats: null, gun: null, flashMats: [],
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
  const { obj, flashMats } = await loadGunModel(modelName);
  if (state.key !== key) return;
  gunMount.clear();
  gunMount.add(obj);
  state.gun = obj; state.flashMats = flashMats;
  updateHud();
  loadBuf(soundById(parseInt(st.sound_id, 16)));
}

function updateHud() {
  const st = state.stats;
  if (!st) return;
  document.getElementById('wname').textContent = DISPLAY[state.key] || state.key;
  document.getElementById('ammo').innerHTML = state.reloading ? '<small>RELOADING…</small>'
    : (state.ammo === Infinity ? '∞' : `${state.ammo} <small>/ ${st.mag_size}</small>`);
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
  if (CLIPOUT) play(CLIPOUT, { vol: 0.7 });
  setTimeout(() => { if (CLIPIN) play(CLIPIN, { vol: 0.7 }); }, 700);
  setTimeout(() => {
    state.ammo = st.mag_size; state.reloading = false; updateHud();
  }, 1400);
}

function shoot(now) {
  const st = state.stats;
  if (!st || state.reloading) return;
  if (state.ammo <= 0) {
    if (DRYFIRE) play(DRYFIRE, { vol: 0.5 });
    state.nextShot = now + 0.25;
    reload();
    return;
  }
  state.ammo--;
  state.shots++;
  // sound: sound_trigger_rate throttles repeats in-game; simple per-shot here
  play(soundById(parseInt(st.sound_id, 16)), { vol: 0.9, pitch: 0.97 + Math.random() * 0.06 });
  // spread: inaccuracy in GE arbitrary units; scale to radians
  const spread = st.inaccuracy * 0.0022;
  const dir = new THREE.Vector3(0, 0, -1)
    .applyEuler(new THREE.Euler(look.pitch + (Math.random()-0.5)*spread,
                                look.yaw + (Math.random()-0.5)*spread, 0, 'YX'))
    .normalize();
  raycaster.set(cam.position, dir);
  raycaster.far = 300;
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length) {
    const h = hits[0];
    let g = h.object;
    while (g.parent && !g.userData.hit) g = g.parent;
    const mat = g.userData.hit || 'other';
    const set = HIT_SOUNDS[mat];
    play(set[Math.floor(Math.random() * set.length)], { vol: 0.45, pitch: 0.9 + Math.random()*0.2 });
    spawnSpark(h.point);
    if (g.userData.hp !== Infinity && g.userData.downT <= 0) {
      state.hits++;
      g.userData.hp -= st.damage;
      state.score += Math.max(1, Math.round(-g.position.z));
      if (g.userData.hp <= 0) {
        g.userData.downT = 2.2;
        state.score += 50;
      }
    }
  }
  // recoil + flash
  state.recoil = Math.min(1.5, state.recoil + st.vfx.recoil_up * 0.012 + 0.05);
  state.kick = Math.min(1, state.kick + st.vfx.recoil_back * 0.05 + 0.15);
  state.flashT = 0.055;
  for (const m of state.flashMats) m.visible = true;
  updateHud();
}

// ---- input ----
const look = { yaw: 0, pitch: 0 };
let locked = false;
canvas.addEventListener('click', () => {
  if (!locked) { canvas.requestPointerLock(); actx.resume(); }
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
  if (e.code === 'KeyR') reload();
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
    if (state.flashT <= 0) for (const m of state.flashMats) m.visible = false;
  }
  // targets fall & respawn
  for (const t of targets) {
    const u = t.userData;
    if (u.downT > 0) {
      u.downT -= dt;
      const fall = Math.min(1, (2.2 - u.downT) * 4);
      t.rotation.x = -fall * Math.PI / 2;
      if (u.downT <= 0) { u.hp = u.maxhp; t.rotation.x = 0; }
    }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    sparks[i].userData.t -= dt;
    if (sparks[i].userData.t <= 0) { scene.remove(sparks[i]); sparks.splice(i, 1); }
  }

  const kickPitch = state.recoil * 0.03;
  cam.rotation.set(0, 0, 0);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = look.yaw;
  cam.rotation.x = look.pitch + kickPitch;

  // gun pose (own scene, fixed to camera)
  gunMount.position.set(0.26, -0.23 + state.recoil * 0.008, -0.55 + state.kick * 0.05);
  gunMount.rotation.set(state.recoil * 0.10, Math.PI - 0.06, 0);
  const bob = Math.sin(now * 1.8) * 0.004;
  gunMount.position.y += bob;

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
window.__dbg = { state, selectWeapon, shoot, look, targets, scene, cam, renderer };
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
