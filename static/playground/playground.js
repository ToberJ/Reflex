// Reflex playground: four one-factor-at-a-time demo cards (box size / throw distance / payload / lateral offset).
// Each option maps to one simulated cell in ./index.json; "Launch" replays that cell's stored CAUGHT throws in turn
// (traj/*.bin: float32 LE [frames, bodies+1, 7] = xyz + quat wxyz, last record = box; t = 0 at release).
// Robot meshes are shared with the sim3d viewer (../sim3d/robot/); the loading/assembly code below is copied from
// static/sim3d/viewer.js (that module has DOM side effects on import, so it is not imported).
// Viewers (one WebGL context per card) are created lazily: when the card scrolls near the viewport or on Launch.
// Test/deep-link params: ?card=size|distance|payload|offset &opt=<option id> &k=<1-based catch> &t=<s after release,
//   pauses there> &autoplay=1 (start playing) &shot (snapshot canvases into <img> for headless screenshots) &debug
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ROOT = document.getElementById('playground');
const qs = new URLSearchParams(location.search);
const SHOT = qs.has('shot');
if (qs.has('debug'))
  addEventListener('error', e => ROOT.prepend(Object.assign(document.createElement('pre'), { textContent: String(e.message) })));
const HERE = new URL('./', import.meta.url);
const DATA = new URL(ROOT.dataset.src || './', HERE);
const ROBOT = new URL(ROOT.dataset.robot || '../sim3d/robot/', HERE);
const ACCENT = getComputedStyle(ROOT).getPropertyValue('--pg-accent').trim() || '#6b4fa0';
const up = new THREE.Vector3(0, 0, 1);

// ---------- robot camera (egocentric inset, top-left of every viewer) ----------
// There are no recorded camera images in the demo data: the inset is RE-RENDERED live from the robot camera's pose,
// using the same mount and intrinsics as the simulated RGB-D camera the visual encoder consumed:
//  * mount: torso_link + CAM_OFF (0.02, 0, 0.62) m, optical axis = torso +x pitched up CAM_PITCH_UP = 10 deg
//    (box_catch/env/box_v36_saferobust_estimator.py:302-303; pose update render_latent_policy_web.py:263-265:
//    cam_quat = torso_quat * rotY(-CAM_PITCH_UP), Isaac "world" camera convention +x forward / +z up)
//  * intrinsics: 192x144, horizontal_aperture 20.955, focal = aperture/2/tan(53 deg) -> horizontal HALF-angle 53 deg
//    (full 106 deg); vertical_aperture = horizontal * 144/192 (isaaclab camera.py:130-131) -> vertical FOV
//    2*atan(0.75*tan 53 deg) = 89.7 deg (render_latent_policy_web.py:44,204-207; train_amp_latent.py:40,200-204)
const EGO = { off: [0.02, 0.0, 0.62], pitchUp: THREE.MathUtils.degToRad(10), aspect: 192 / 144,
  fovV: 2 * THREE.MathUtils.radToDeg(Math.atan((144 / 192) * Math.tan(THREE.MathUtils.degToRad(53)))),
  near: 0.05, far: 50, sky: 0xd5d9df };
const VIEW_SHIFT = { side: { x: 0.13, y: 0.05, zoom: 0.88 }, behind: { x: 0.05, y: 0.0, zoom: 0.85 },   // fractions of the viewer size
  sidePhone: { x: 0.17, y: 0.07, zoom: 0.85 } };   // narrow viewers (< NARROW_PX): phones and the 1100-1215 px two-column desktop
const EGO_SCALE = 0.8;   // user 10-08: inset 20 % smaller than the first version (all size limits below are scaled by this)
const NARROW_PX = 440;   // one threshold for the inset size, the main-view framing and the .is-narrow label / play-button styles
const EGO_TIP = "Re-rendered live in this viewer from the robot head camera's pose (same mount and 106\u00b0\u00d790\u00b0 field of view " +
  'as the simulated RGB-D camera the policy used); not the recorded camera images.';
// alpha mask so the inset's GL pixels match the CSS frame (rounded top corners; the caption bar sits below the image)
function roundMask(w, h, r) {
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h);
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.beginPath();
  if (g.roundRect) g.roundRect(0, 0, c.width, c.height, [r, r, 0, 0]); else g.rect(0, 0, c.width, c.height);
  g.fill();
  return c;
}

// ---------- card definitions (labels / icons; cells and options come from index.json) ----------
const CARDS = [
  { key: 'size', icon: 'fa-box-open', panel: 'Select Box Size', tileIcon: 'fa-box', scale: [0.85, 1.2, 1.6],
    sub: o => `Interactive 3D replay with the ${o.label.toLowerCase()} box (${o.sub})` },
  { key: 'distance', icon: 'fa-ruler-horizontal', panel: 'Select Throw Distance', tileIcon: 'fa-person-walking-arrow-right', scale: [0.9, 1.2, 1.5],
    sub: o => `Interactive 3D replay of a ${o.label} throw` },
  { key: 'payload', icon: 'fa-weight-hanging', panel: 'Select Payload', tileIcon: 'fa-weight-hanging', scale: [0.75, 1.0, 1.25, 1.55],
    sub: o => (o.default ? 'Interactive 3D replay with the empty box (about 0.18 kg)' : `Interactive 3D replay with a ${o.label} payload`) },
  { key: 'offset', icon: 'fa-arrows-left-right', panel: 'Select Landing Offset', tileIcon: 'fa-arrows-left-right', scale: [0.9, 1.2, 1.5],   // user: three tiles 0.3 / 0.7 / 1.0 m
    sub: o => (parseFloat(o.id) === 0 ? 'Interactive 3D replay of a throw aimed at the robot'
                                      : `Interactive 3D replay of a throw landing ${o.label} to the side`) },
];

// ---------- small DOM helper ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => c !== null && c !== undefined && e.append(c));
  return e;
}
const icon = (cls, style) => el('i', { class: 'fa-solid ' + cls, 'aria-hidden': 'true', style });

// ---------- shared robot assets (copied from sim3d/viewer.js) ----------
const robotMat = new THREE.MeshStandardMaterial({ color: 0xd3d5d9, roughness: 0.5, metalness: 0.12 });
let assetsP = null;
function loadRobotAssets() {
  if (!assetsP) assetsP = (async () => {
    const manifest = await (await fetch(new URL('manifest.json', ROBOT))).json();
    const files = new Set();
    for (const [k, v] of Object.entries(manifest)) if (Array.isArray(v) && !k.startsWith('_')) v.forEach(i => files.add(i.mesh));
    for (const v of Object.values(manifest._links || {})) v.forEach(i => files.add(i.mesh));
    const loader = new GLTFLoader(), geoms = {};
    await Promise.all([...files].map(async f => {
      const g = await loader.loadAsync(new URL(f, ROBOT).href);
      g.scene.traverse(o => { if (o.isMesh && !geoms[f]) geoms[f] = o.geometry; });
      if (geoms[f] && !geoms[f].attributes.normal) geoms[f].computeVertexNormals();
    }));
    return { manifest, geoms };
  })();
  return assetsP;
}
// One Object3D per data body; visuals of fixed-joint children are folded into their parent in the manifest,
// unless that child is itself a body in the data (then it draws its own mesh).
function buildRobot(bodyNames, { manifest, geoms }) {
  const names = new Set(bodyNames), group = new THREE.Group();
  const bodies = bodyNames.map(b => {
    const o = new THREE.Object3D();
    for (const it of manifest[b] || (manifest._links || {})[b] || []) {
      if (it.link !== b && names.has(it.link)) continue;
      if (!geoms[it.mesh]) continue;
      const m = new THREE.Mesh(geoms[it.mesh], robotMat);
      m.position.fromArray(it.pos);
      const [w, x, y, z] = it.quat_wxyz; m.quaternion.set(x, y, z, w);
      m.castShadow = true;
      o.add(m);
    }
    group.add(o);
    return o;
  });
  return { group, bodies };
}

// ---------- trajectory cache ----------
const binCache = new Map();
const fetchBin = file => {
  if (!binCache.has(file)) binCache.set(file, fetch(new URL(file, DATA)).then(r => {
    if (!r.ok) throw new Error(r.status + ' ' + file);
    return r.arrayBuffer();
  }).then(b => new Float32Array(b)).catch(e => { binCache.delete(file); throw e; }));
  return binCache.get(file);
};

// floor: dark grey disc whose alpha fades out towards the rim (radial alpha map)
function floorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, '#fff'); r.addColorStop(0.62, '#fff'); r.addColorStop(1, '#000');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ---------- one 3D viewer ----------
class Viewer {
  constructor(host, idx, assets) {
    this.host = host; this.idx = idx; this.nb = idx.box_body_index ?? idx.bodies.length;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: SHOT });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    host.prepend(r.domElement);
    const s = this.scene = new THREE.Scene();
    s.add(new THREE.HemisphereLight(0xffffff, 0x8a8c90, 1.7));
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 4;
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
    s.add(sun, sun.target);

    this.floor = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(13, 96),
      new THREE.MeshStandardMaterial({ color: 0x4b4e54, roughness: 0.92, transparent: true, alphaMap: floorTexture(), depthWrite: false }));
    disc.receiveShadow = true;
    const grid = new THREE.GridHelper(16, 32, 0x6a6e75, 0x5d6168);
    grid.rotation.x = Math.PI / 2; grid.position.z = 0.002;
    grid.material.transparent = true; grid.material.opacity = 0.55; grid.material.depthWrite = false;
    this.floor.add(disc, grid); s.add(this.floor);

    this.camera = new THREE.PerspectiveCamera(42, 16 / 10, 0.05, 200);
    this.camera.up.copy(up);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.maxPolarAngle = Math.PI * 0.495; this.controls.minDistance = 1; this.controls.maxDistance = 25;
    this.controls.addEventListener('change', () => { this.dirty = true; });

    this.robot = buildRobot(idx.bodies, assets); s.add(this.robot.group);
    this.box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xc8a165, roughness: 0.8 }));
    this.box.castShadow = true;
    this.box.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.box.geometry), new THREE.LineBasicMaterial({ color: 0x5a4425, transparent: true, opacity: 0.6 })));
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc8a165, transparent: true, opacity: 0.55 }));
    this.trail.frustumCulled = false;
    s.add(this.box, this.trail);

    // thrower marker: translucent accent-coloured silhouette standing just behind the release point
    const tm = new THREE.MeshStandardMaterial({ color: ACCENT, transparent: true, opacity: 0.6, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.85, 6, 16), tm); body.rotation.x = Math.PI / 2; body.position.z = 0.6;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), tm); head.position.z = 1.32;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.3, 40), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.z = 0.004;
    this.thrower = new THREE.Group(); this.thrower.add(body, head, ring); s.add(this.thrower);
    this.releaseDot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: ACCENT }));
    s.add(this.releaseDot);
    this.guide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xc4b3e6, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.9 }));
    this.guide.frustumCulled = false; s.add(this.guide);
    // replay-only annotations (trail, release dot, floor guide) live on layer 1: drawn in the main view, not in the robot camera
    [this.trail, this.releaseDot, this.guide].forEach(o => o.layers.set(1));
    this.camera.layers.enable(1);

    // robot camera: rigidly attached to torso_link (see EGO above)
    const ti = idx.bodies.indexOf('torso_link');
    if (ti >= 0) {
      const ego = this.egoCam = new THREE.PerspectiveCamera(EGO.fovV, EGO.aspect, EGO.near, EGO.far);
      ego.position.fromArray(EGO.off);
      // Isaac camera frame (+x optical axis, +z up) = torso frame rotated about +y by -pitchUp;
      // three.js camera axes in that frame: right = -y, up = +z, back = -x
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -EGO.pitchUp);
      const qAxes = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
      ego.quaternion.copy(qPitch).multiply(qAxes);
      this.robot.bodies[ti].add(ego);
      this.egoRT = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
      this.egoMaskTex = new THREE.CanvasTexture(roundMask(1, 1, 0));
      this.egoQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.egoRT.texture, alphaMap: this.egoMaskTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      this.hudScene = new THREE.Scene(); this.hudScene.add(this.egoQuad);
      this.hudCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
      this.egoFrame = el('div', { class: 'pg-ego', hidden: true },   // caption bar below the image, so it never covers the box
        el('div', { class: 'pg-ego-bar', title: EGO_TIP, tabindex: 0, 'aria-label': 'Robot camera view. ' + EGO_TIP },
          icon('fa-video')));   // user 10-08: icon only, no caption text; the re-rendered note stays in the tooltip / aria-label
      host.after(this.egoFrame);
    }

    this.visible = true; this.dirty = true;
    new ResizeObserver(() => this.resize()).observe(host);
    if (this.egoFrame && document.fonts) document.fonts.ready.then(() => this.fitLabel());   // web font changes the caption width
    new IntersectionObserver(e => { this.visible = e[0].isIntersecting; if (this.visible) this.dirty = true; }).observe(host);
    this.resize();
  }
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.dirty = true;
    // the inset covers the top-left: slide the main view's image down-right (the orbit pivot stays the same) and widen a bit,
    // so the thrower and the start of the arc are not hidden behind it (default framings put the thrower left of centre)
    const narrow = w < NARROW_PX;
    const vEl = this.host.closest('.pg-viewer'); if (vEl) vEl.classList.toggle('is-narrow', narrow);
    const sh = this.egoCam ? (VIEW_SHIFT[this.view] || (narrow ? VIEW_SHIFT.sidePhone : VIEW_SHIFT.side)) : null;
    if (sh) { this.camera.zoom = sh.zoom; this.camera.setViewOffset(w, h, -sh.x * w, -sh.y * h, w, h); }
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.egoCam) {   // inset: 0.8 x (~40 % of the viewer width; 38 % and at most 47 % of the height when narrow; 30 % in fullscreen), 4:3 like the 192x144 camera
      const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const frac = full ? 0.3 : (narrow ? 0.38 : 0.4), m = narrow ? 8 : 10, rad = 8, bar = narrow ? 14 : 18;
      const ew = Math.round(EGO_SCALE * (narrow ? Math.min(frac * w, (0.47 * h - m - bar) * EGO.aspect)
                                               : Math.min(frac * w, (h - 2 * m) * EGO.aspect * 0.62))), eh = Math.round(ew / EGO.aspect);
      const pr = this.renderer.getPixelRatio();
      this.egoRT.setSize(Math.round(ew * pr), Math.round(eh * pr));
      // a CanvasTexture is allocated once with immutable storage (three r169 texStorage2D): a new size needs a new texture
      const oldMask = this.egoMaskTex;
      this.egoMaskTex = this.egoQuad.material.alphaMap = new THREE.CanvasTexture(roundMask(Math.round(ew * pr), Math.round(eh * pr), rad * pr));
      oldMask.dispose();
      Object.assign(this.hudCam, { left: 0, right: w, top: h, bottom: 0 }); this.hudCam.updateProjectionMatrix();
      this.egoQuad.position.set(m + ew / 2, h - m - eh / 2, 0); this.egoQuad.scale.set(ew, eh, 1);
      Object.assign(this.egoFrame.style, { left: m + 'px', top: m + 'px', width: ew + 'px', height: (eh + bar) + 'px', borderRadius: rad + 'px' });
      this.egoFrame.firstChild.style.height = bar + 'px';
      this.fitLabel();
    }
  }
  fitLabel() {}   // the caption is an icon only now (user 10-08), nothing to fit

  setThrow(rec, arr) {
    this.rec = rec; this.arr = arr;
    const nb = this.nb, st = (nb + 1) * 7, fps = this.idx.fps;
    const [hx, hy, hz] = rec.box_half_extents;
    this.box.scale.set(2 * hx, 2 * hy, 2 * hz);
    this.box.material.color.set(rec.box_color || '#c8a165');
    const pts = new Float32Array(rec.frames * 3);
    for (let f = 0; f < rec.frames; f++) pts.set(arr.subarray(f * st + nb * 7, f * st + nb * 7 + 3), f * 3);
    this.trail.geometry.dispose();
    this.trail.geometry = new THREE.BufferGeometry();
    this.trail.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.t0 = -rec.launch.t;                          // release-relative time of frame 0
    this.t1 = (rec.frames - 1) / fps - rec.launch.t;
    this.reveal = rec.outcome_t ?? (this.t1 - 1.0);
    // thrower marker 0.35 m behind the release point, facing the robot
    const [px, py, pz] = rec.launch.p, v = rec.launch.v, vh = Math.hypot(v[0], v[1]) || 1;
    this.thrower.position.set(px - 0.35 * v[0] / vh, py - 0.35 * v[1] / vh, 0);
    const sc = Math.max(0.8, Math.min(1.25, pz / 1.35)); this.thrower.scale.setScalar(sc);
    this.releaseDot.position.set(px, py, pz);
    this.guide.geometry.dispose();                     // floor line thrower -> robot start (shows lateral offset)
    this.guide.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(px, py, 0.006), new THREE.Vector3(arr[0], arr[1], 0.006)]);
    this.guide.computeLineDistances();
    this.floor.position.set((arr[0] + px) / 2, (arr[1] + py) / 2, 0);
    this.frame();
  }
  // default view: oblique, from the side of the throw line and slightly in front of the robot; thrower and robot in shot
  frame() {
    const { rec, arr } = this;
    const pr = new THREE.Vector3(arr[0], arr[1], 0), pl = new THREE.Vector3(rec.launch.p[0], rec.launch.p[1], 0);
    const d = pl.clone().sub(pr); const span = Math.max(d.length(), 1); d.normalize();
    const n = new THREE.Vector3(-d.y, d.x, 0);
    const last = (rec.frames - 1) * (this.nb + 1) * 7;   // view from the side the robot does not step towards
    if ((arr[last] - arr[0]) * n.x + (arr[last + 1] - arr[1]) * n.y > 0) n.negate();
    this.sunDir = n.clone().multiplyScalar(2.2).addScaledVector(d, 1.2);   // light from the camera side
    let apex = 1.5;                                   // highest box point of the throw: keep the whole arc in frame
    const st = (this.nb + 1) * 7;
    for (let f = 0; f < rec.frames; f++) apex = Math.max(apex, arr[f * st + this.nb * 7 + 2]);
    // camera beside and slightly behind the robot, looking down the throw line: robot large in front, thrower behind
    const wide = this.camera.aspect < 1.2 ? 1.3 : 1;
    if (this.view === 'behind') {          // offset card (user 2026-10-08): from behind the robot, so the sideways step reads left/right
      const target = pr.clone().addScaledVector(d, 1.2).setZ(0.75);
      const pos = pr.clone().addScaledVector(d, -(4.0 * wide)).setZ(2.0);
      this.home = { target, pos };
      this.resetView();
      return;
    }
    const target = pr.clone().addScaledVector(d, 0.4 * span).setZ(0.45 * apex + 0.2);
    const pos = pr.clone().addScaledVector(n, (2.9 + 0.4 * span + 0.35 * apex) * wide).addScaledVector(d, -(1.5 + 0.12 * span) * wide)
      .setZ(1.6 + 0.12 * span + 0.2 * apex);
    this.home = { target, pos };
    this.resetView();
  }
  resetView() {
    if (!this.home) return;
    this.controls.target.copy(this.home.target); this.camera.position.copy(this.home.pos); this.controls.update();
    this.dirty = true;
  }
  // T = seconds after release
  show(T) {
    if (!this.rec) return false;
    const { arr, nb, rec } = this, st = (nb + 1) * 7, fps = this.idx.fps;
    const f = Math.min(rec.frames - 1, Math.max(0, Math.round((T + rec.launch.t) * fps)));
    const put = (o, i) => {
      const b = f * st + i * 7;
      o.position.set(arr[b], arr[b + 1], arr[b + 2]);
      o.quaternion.set(arr[b + 4], arr[b + 5], arr[b + 6], arr[b + 3]);
    };
    this.robot.bodies.forEach(put);
    put(this.box, nb);
    const f0 = Math.max(0, Math.round(rec.launch.t * fps));
    this.trail.geometry.setDrawRange(f0, Math.max(0, f + 1 - f0));
    const p = this.robot.bodies[0].position;
    this.sun.position.set(p.x + this.sunDir.x, p.y + this.sunDir.y, 6); this.sun.target.position.set(p.x, p.y, 0);
    this.dirty = true;
    return T >= this.reveal;
  }
  render() {
    if (!(this.visible && this.dirty)) return;
    const r = this.renderer;
    r.render(this.scene, this.camera);
    if (this.egoCam && this.rec) {   // robot camera, same scene and same playback frame, composited into the top-left corner
      r.setRenderTarget(this.egoRT); r.setClearColor(EGO.sky, 1);
      r.render(this.scene, this.egoCam);
      r.setRenderTarget(null); r.setClearColor(0x000000, 0);
      r.autoClear = false; r.render(this.hudScene, this.hudCam); r.autoClear = true;
      if (this.egoFrame.hidden) { this.egoFrame.hidden = false; this.fitLabel(); }
    }
    this.dirty = false;
  }
}

// ---------- one demo card ----------
class Card {
  constructor(def, idx) {
    this.def = def; this.idx = idx; this.cfg = idx.cards[def.key];
    this.options = this.cfg.options.map(o => {
      const cell = idx.cells[o.cell];
      const caught = cell ? cell.throws.filter(t => t.outcome === 'caught') : [];
      return { ...o, cellData: cell, caught };
    });
    const dflt = this.defaultIndex();
    this.sel = dflt; this.k = 0; this.T = 0; this.playing = false; this.started = false; this.speed = 1;
    this.build();
    this.select(dflt, false);
  }
  defaultIndex() {
    const D = this.idx.default || {}, os = this.options;
    const want = { size: D.size, distance: D.distance, payload: D.mass, offset: D.offset }[this.def.key];
    let i = os.findIndex(o => o.default);
    if (i < 0) i = os.findIndex(o => o.id === String(want) || parseFloat(o.id) === parseFloat(want));
    if (i < 0) i = os.findIndex(o => o.caught.length);
    return Math.max(0, i);
  }
  fixedLine() {
    const D = this.idx.default || {}, parts = [];
    const sizeOpt = (this.idx.cards.size.options || []).find(o => o.id === D.size);
    if (this.def.key !== 'distance') parts.push(D.distance_range ? `${D.distance_range[0].toFixed(1)}-${D.distance_range[1].toFixed(1)} m throw` : `${D.distance} m throw`);
    if (this.def.key !== 'size') parts.push(`${(D.size || 'medium')} box${sizeOpt ? ' (' + sizeOpt.sub + ')' : ''}`);
    if (this.def.key !== 'payload') parts.push(`empty box (about ${D.mass} kg)`);
    if (this.def.key !== 'offset') parts.push('aimed at the robot');
    return 'Other factors fixed: ' + parts.join(' · ');
  }
  build() {
    const d = this.def;
    this.subEl = el('p', { class: 'pg-sub' }, '');
    const head = el('div', { class: 'pg-head' },
      el('h4', { class: 'pg-title' }, icon(d.icon), ' ', this.cfg.title), this.subEl);
    // selector panel
    let picker;
    if (d.slider) {
      const n = this.options.length;
      this.range = el('input', { type: 'range', min: 0, max: n - 1, step: 1, value: this.sel, 'aria-label': this.cfg.title });
      this.readout = el('span', { class: 'pg-readout' }, '');
      const ticks = el('div', { class: 'pg-ticks' }, this.options.map((o, i) =>
        el('span', { class: i % 2 ? 'pg-tick minor' : 'pg-tick' }, i % 2 ? '' : parseFloat(o.id).toFixed(1))));
      this.range.addEventListener('input', () => this.select(+this.range.value, true));
      picker = el('div', { class: 'pg-slider' },
        el('div', { class: 'pg-slider-top' }, el('span', { class: 'pg-slider-cap' }, 'Lateral landing offset'), this.readout),
        el('div', { class: 'pg-slider-row' }, icon('fa-crosshairs pg-slider-end'), this.range, icon('fa-person-walking-arrow-right pg-slider-end')),
        ticks);
    } else {
      this.tiles = this.options.map((o, i) => {
        const dis = !o.caught.length;
        const t = el('button', { type: 'button', class: 'pg-tile', 'aria-pressed': 'false', disabled: dis,
          title: dis ? 'no example recorded' : undefined },
          icon(o.default && d.key === 'payload' ? 'fa-feather' : d.tileIcon, `font-size:${(d.scale || [])[i] || 1.2}em`),
          el('span', { class: 'pg-tile-label' }, o.default && d.key === 'payload' ? 'Empty' : o.label),
          el('span', { class: 'pg-tile-sub' }, o.default && d.key === 'payload' ? '0.18 kg · default' : (o.sub || ' ')));
        t.addEventListener('click', () => this.select(i, true));
        return t;
      });
      picker = el('div', { class: 'pg-tiles', style: `grid-template-columns:repeat(${this.tiles.length},1fr)` }, this.tiles);
    }
    const panel = el('div', { class: 'pg-panel' },
      el('div', { class: 'pg-panel-title' }, icon('fa-sliders'), ' ', d.panel), picker,
      el('p', { class: 'pg-fixed' }, this.fixedLine()));
    // buttons
    this.btnLaunch = el('button', { type: 'button', class: 'pg-launch' }, icon('fa-play'), ' ', el('span', {}, 'Launch'));
    this.btnFull = el('button', { type: 'button', class: 'pg-full' }, icon('fa-expand'), ' Fullscreen');
    this.btnLaunch.addEventListener('click', () => this.launch());
    this.btnFull.addEventListener('click', () => this.fullscreen());
    const buttons = el('div', { class: 'pg-buttons' }, this.btnLaunch, this.btnFull);
    // viewer
    this.badge = el('span', { class: 'pg-badge' }, '');
    this.caption = el('span', { class: 'pg-caption' }, '');
    this.timeEl = el('span', { class: 'pg-time' }, '');
    this.msg = el('div', { class: 'pg-msg' }, 'loading…');
    this.sp05 = el('button', { type: 'button', title: 'Half speed' }, '0.5x');
    this.sp1 = el('button', { type: 'button', class: 'is-on', title: 'Real time' }, '1x');
    this.btnReset = el('button', { type: 'button', title: 'Reset camera', 'aria-label': 'Reset camera' }, icon('fa-rotate-left'));
    [[this.sp05, 0.5], [this.sp1, 1]].forEach(([b, v]) => b.addEventListener('click', () => {
      this.speed = v; this.sp05.classList.toggle('is-on', v === 0.5); this.sp1.classList.toggle('is-on', v === 1);
    }));
    this.btnReset.addEventListener('click', () => this.viewer && this.viewer.resetView());
    this.overlayPlay = el('button', { type: 'button', class: 'pg-overlay-play', 'aria-label': 'Launch' }, icon('fa-play'));
    this.overlayPlay.addEventListener('click', () => this.launch());
    this.canvasBox = el('div', { class: 'pg-canvas' }, this.msg);
    this.viewerEl = el('div', { class: 'pg-viewer' }, this.canvasBox,
      el('div', { class: 'pg-hud pg-hud-tr' }, el('span', { class: 'pg-seg' }, this.sp05, this.sp1), this.btnReset),
      el('div', { class: 'pg-hud pg-hud-bl' }, this.badge, this.caption),   // top-left is the robot-camera inset
      el('div', { class: 'pg-hud pg-hud-br' }, this.timeEl),
      this.overlayPlay);
    this.root = el('div', { class: 'pg-card', id: 'pg-' + d.key }, head,
      el('div', { class: 'pg-body' }, panel, buttons, this.viewerEl));
    new IntersectionObserver((e, ob) => {
      if (e[0].isIntersecting) { ob.disconnect(); this.ensureViewer(); }
    }, { rootMargin: '300px 0px' }).observe(this.viewerEl);
  }
  get opt() { return this.options[this.sel]; }
  select(i, user) {
    if (this.options[i] && !this.options[i].caught.length && user) {
      if (this.range) this.range.value = this.sel;     // slider: a value without a recorded catch is not selectable
      return;
    }
    this.sel = i; this.k = 0; this.started = false; this.playing = false;
    const o = this.opt;
    this.subEl.textContent = this.def.sub(o);
    if (this.tiles) this.tiles.forEach((t, j) => { t.classList.toggle('is-selected', j === i); t.setAttribute('aria-pressed', j === i); });
    if (this.range) { this.range.value = i; this.readout.textContent = parseFloat(o.id).toFixed(1) + ' m';
      this.range.style.setProperty('--pct', (100 * i / (this.options.length - 1)) + '%'); }
    this.btnLaunch.disabled = !o.caught.length;
    this.btnLaunch.title = o.caught.length ? '' : 'no example recorded';
    this.updateLaunchLabel();
    this.loadCurrent();
  }
  updateLaunchLabel() {
    const n = this.opt.caught.length;
    this.btnLaunch.lastChild.textContent = !n ? 'No example recorded'
      : 'Launch';
  }
  async ensureViewer() {
    if (this.viewer || this.viewerP) return this.viewerP;
    this.viewerP = (async () => {
      const assets = await loadRobotAssets();
      this.viewer = new Viewer(this.canvasBox, this.idx, assets);
      if (this.def.key === 'offset') { this.viewer.view = 'behind'; this.viewer.resize(); }
      ROOT.dispatchEvent(new CustomEvent('pg-viewer'));
      await this.loadCurrent();
    })().catch(e => { console.error(e); this.msg.textContent = 'could not load the 3D replay'; });
    return this.viewerP;
  }
  async loadCurrent() {
    const o = this.opt, rec = o.caught[this.k], tok = (this.tok = (this.tok || 0) + 1);
    this.caption.textContent = '';
    this.setBadge(false);
    if (!rec) { this.msg.textContent = 'no example recorded'; this.msg.hidden = false; return; }
    this.caption.textContent = this.captionFor(rec);
    if (!this.viewer) return;
    this.msg.textContent = 'loading…'; this.msg.hidden = false;
    let arr;
    try { arr = await fetchBin(rec.file); } catch (e) { console.error(e); if (tok === this.tok) this.msg.textContent = 'could not load trajectory'; return; }
    if (tok !== this.tok) return;                       // superseded by a newer selection
    if (arr.length !== rec.frames * (this.viewer.nb + 1) * 7) { this.msg.textContent = 'could not load trajectory'; return; }
    this.msg.hidden = true;
    this.viewer.setThrow(rec, arr);
    this.T = this.viewer.t0;                            // first frame (pre-launch: box held at the release point)
    this.draw();
    // prefetch the other catches of this cell
    o.caught.forEach(r => fetchBin(r.file).catch(() => {}));
  }
  captionFor(rec) {   // no on-screen counter (user 2026-10-08)
    return '';
  }
  setBadge(on) {
    const sustained = (this.opt.cellData || {}).criterion === 'sustained';
    this.badge.textContent = on ? (sustained ? 'Caught and held' : 'Caught') : '';
    this.badge.className = 'pg-badge' + (on ? ' is-on' : '');
  }
  async launch() {
    const o = this.opt;
    if (!o.caught.length) return;
    const n = o.caught.length;      // a random recorded catch each time, never the same one twice in a row
    if (n > 1) { let k; do { k = Math.floor(Math.random() * n); } while (this.started && k === this.k); this.k = k; }
    this.started = true; this.playing = true;
    this.updateLaunchLabel();
    this.viewerEl.classList.add('is-started');
    await this.ensureViewer();
    await this.loadCurrent();
    if (this.viewer && this.viewer.rec) { this.T = this.viewer.t0; this.playing = true; }
  }
  fullscreen() {
    const v = this.viewerEl;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  }
  tick(dt) {
    if (!this.viewer || !this.viewer.rec) return;
    if (this.playing) {
      this.T += dt * this.speed;
      if (this.T >= this.viewer.t1) { this.T = this.viewer.t1; this.playing = false; }
      this.draw();
    }
    this.viewer.render();
  }
  draw() {
    const v = this.viewer; if (!v || !v.rec) return;
    const T = Math.min(this.T, v.t1), on = v.show(T) && this.started;
    this.setBadge(on);
    this.timeEl.textContent = this.started ? 't = ' + (T >= 0 ? '+' : '−') + Math.abs(T).toFixed(2) + ' s' : '';
    this.viewerEl.classList.toggle('is-started', this.started);
  }
}

// ---------- app ----------
let cards = [];
async function init() {
  let idx;
  try { idx = await (await fetch(new URL('index.json', DATA))).json(); }
  catch (e) { console.error(e); ROOT.append(el('p', { class: 'pg-error' }, 'Could not load the interactive demo data.')); return; }
  const grid = el('div', { class: 'pg-grid' });
  cards = CARDS.filter(d => idx.cards[d.key]).map(d => new Card(d, idx));
  cards.forEach(c => grid.append(c.root));
  ROOT.append(grid);
  loadRobotAssets().catch(e => console.error(e));   // start mesh download early

  const target = cards.find(c => c.def.key === qs.get('card'));
  if (SHOT || target) await Promise.all(cards.map(c => c.ensureViewer()));
  if (target) {
    const oi = target.options.findIndex(o => o.id === qs.get('opt') || parseFloat(o.id) === parseFloat(qs.get('opt')));
    if (oi >= 0) target.select(oi, true);
    const want = qs.has('k') ? Math.max(1, +qs.get('k')) - 1 : 0;
    if (qs.has('t') || qs.has('autoplay')) {
      target.started = true; target.k = Math.min(want, Math.max(0, target.opt.caught.length - 1));
      target.updateLaunchLabel();
      await target.loadCurrent();
      if (target.viewer && target.viewer.rec) {
        target.T = qs.has('t') ? Math.max(target.viewer.t0, Math.min(target.viewer.t1, +qs.get('t'))) : target.viewer.t0;
        target.playing = !qs.has('t');
        target.draw();
      }
    }
    if (!SHOT) target.root.scrollIntoView({ block: 'center' });
  }
  if (SHOT) {
    ROOT.classList.add('pg-noanim');               // headless screenshots do not advance CSS transitions
    await new Promise(r => setTimeout(r, +qs.get('shotms') || 300));   // &shotms=: snapshot later (autoplay test)
    cards.forEach(c => { if (c.viewer) { c.viewer.dirty = true; c.viewer.visible = true; c.viewer.render();
      c.canvasBox.append(el('img', { src: c.viewer.renderer.domElement.toDataURL(), class: 'pg-shot' })); } });
  }
  if (qs.has('debug') && cards[0] && cards[0].viewer) {
    const gl = cards[0].viewer.renderer.getContext();
    ROOT.prepend(el('pre', {}, 'renderer ' + gl.getParameter(gl.RENDERER) + ' calls ' + cards[0].viewer.renderer.info.render.calls));
  }
  ROOT.dataset.ready = '1';
}

// fullscreen changes the viewer size; ResizeObserver handles the canvas, nothing else to do
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  cards.forEach(c => c.tick(dt));
  if (!SHOT) requestAnimationFrame(loop);
}
if (SHOT) setInterval(() => loop(performance.now()), 40);   // headless screenshots do not run rAF
else requestAnimationFrame(loop);
init();
