// 3D terrain view: HiRISE-textured height field, route ribbon, markers, cameras.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const SEG = 512;                 // terrain mesh segments per side
const CLS_COLORS = [new THREE.Color('#35e08a'), new THREE.Color('#ffc21a'), new THREE.Color('#ff4d4d')];

export class TerrainScene {
  constructor(container, grid, orthoImg) {
    this.container = container;
    this.n = grid.n; this.cell = grid.cell; this.size = grid.n * grid.cell;
    this.dem = grid.dem; this.elevMin = grid.elevMin; this.elevMax = grid.elevMax;
    this.exag = 1.5;
    this.mode = 'orbit';
    this.ortho = orthoImg;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.sky = new THREE.Color('#c9976b');
    this.scene.background = this.sky;
    this.scene.fog = new THREE.Fog(this.sky, 2500, 12000);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 30000);
    this.camera.position.set(-250, 1250, 1500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 180, -60);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 60; this.controls.maxDistance = 7000;
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;

    // sun: directional light with a shadow map over the whole box (re-rendered only when the sun moves)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.ambient = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.4);
    this.sun.castShadow = true;
    const sh = this.sun.shadow, ext = this.size * 0.75;
    sh.mapSize.set(4096, 4096);
    Object.assign(sh.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 200, far: 9000 });
    sh.bias = -0.0004; sh.normalBias = 1.6;
    this.scene.add(this.sun, this.sun.target);
    this.sunDir = new THREE.Vector3(-0.5, 0.7, -0.3).normalize();
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: TerrainScene.sunTexture(), fog: false, transparent: true, depthWrite: false }));
    this.sunSprite.scale.setScalar(1500);
    this.scene.add(this.sunSprite);

    // composited texture: tinted orthophoto + active data layer
    this.texCanvas = document.createElement('canvas');
    this.texCanvas.width = this.texCanvas.height = Math.min(4096, this.renderer.capabilities.maxTextureSize);
    this.texture = new THREE.CanvasTexture(this.texCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.overlay = null; this.overlayAlpha = 0.6;
    this.composite();

    const geo = new THREE.PlaneGeometry(this.size, this.size, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    this.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.texture }));
    this.terrain.castShadow = this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.applyHeights();
    this.setSun(50 * Math.PI / 180, 80 * Math.PI / 180);

    this.routeGroup = new THREE.Group(); this.scene.add(this.routeGroup);
    this.escapeGroup = new THREE.Group(); this.scene.add(this.escapeGroup);
    this.markerGroup = new THREE.Group(); this.scene.add(this.markerGroup);
    this.traverseGroup = new THREE.Group(); this.scene.add(this.traverseGroup);

    // "you are here" puck
    this.puck = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0x4fc3ff }));
    this.puck.visible = false; this.scene.add(this.puck);

    this.routeSamples = null; this.escapeCells = null; this.markers = []; this.follow = null;
    this.ray = new THREE.Raycaster();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- terrain
  /** real elevation (m) at box coordinates x east / y south, bilinear */
  heightAt(x, y) {
    const n = this.n, fx = x / this.cell - 0.5, fy = y / this.cell - 0.5;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(fx))), j0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
    const d = this.dem, k = j0 * n + i0;
    return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + n] * (1 - tx) + d[k + n + 1] * tx) * ty;
  }
  /** box coordinates -> world position, lifted `lift` metres above ground */
  world(x, y, lift = 0, out = new THREE.Vector3()) {
    return out.set(x - this.size / 2, (this.heightAt(x, y) - this.elevMin) * this.exag + lift, y - this.size / 2);
  }
  applyHeights() {
    const pos = this.terrain.geometry.attributes.position, step = this.size / SEG;
    for (let r = 0; r <= SEG; r++) for (let c = 0; c <= SEG; c++) {
      pos.setY(r * (SEG + 1) + c, (this.heightAt(c * step, r * step) - this.elevMin) * this.exag);
    }
    pos.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this.terrain.geometry.computeBoundingSphere();
  }
  setExaggeration(e) {
    this.exag = e; this.applyHeights();
    this.rebuildRoute(); this.rebuildEscape(); this.rebuildMarkers(); this.rebuildTraverse();
    if (this.sunPos) this.setSun(this.sunPos.el, this.sunPos.az);
  }

  // ---------------------------------------------------------------- sun
  static sunTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.12, 'rgba(255,250,235,1)');
    g.addColorStop(0.22, 'rgba(200,225,255,.55)'); g.addColorStop(1, 'rgba(160,200,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  /**
   * Sun elevation / azimuth (radians, azimuth clockwise from north).
   * The vertical component is stretched with the terrain exaggeration, so a shadow falls on the
   * same map position as it would on the real, un-exaggerated terrain.
   */
  setSun(el, az) {
    this.sunPos = { el, az };
    const up = Math.max(el, 0.004);
    this.sunDir.set(Math.cos(up) * Math.sin(az), Math.sin(up) * this.exag, -Math.cos(up) * Math.cos(az)).normalize();
    const mid = (this.elevMax - this.elevMin) * this.exag / 2;
    this.sun.target.position.set(0, mid, 0);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 4500);
    const deg = el * 180 / Math.PI, sm = (a, b) => { const t = Math.max(0, Math.min(1, (deg - a) / (b - a))); return t * t * (3 - 2 * t); };
    const day = sm(-4, 14), direct = sm(-0.5, 9);
    this.sun.intensity = 2.5 * direct;
    this.sun.color.setRGB(1, 0.9 + 0.05 * sm(0, 25), 0.74 + 0.14 * sm(0, 25));
    this.ambient.intensity = 0.3 + 0.95 * day;
    // butterscotch day sky, cold grey-blue dusk (Mars sunsets are blue), dark night
    const night = new THREE.Color('#0b0c13'), dusk = new THREE.Color('#6f7690'), noon = new THREE.Color('#c9976b');
    this.sky.copy(night).lerp(dusk, sm(-8, 1)).lerp(noon, sm(0, 16));
    this.scene.fog.color.copy(this.sky);
    this.sunSprite.visible = el > -0.02;
    this.renderer.shadowMap.needsUpdate = true;
  }
  setOverlay(canvas, alpha) { this.overlay = canvas; this.overlayAlpha = alpha; this.composite(); }
  composite() {
    const c = this.texCanvas, ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.drawImage(this.ortho, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#f2b88c'; ctx.fillRect(0, 0, c.width, c.height);   // Mars tint for the grey HiRISE image
    ctx.globalCompositeOperation = 'source-over';
    if (this.overlay) {
      ctx.globalAlpha = this.overlayAlpha; ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.overlay, 0, 0, c.width, c.height);
      ctx.globalAlpha = 1;
    }
    this.texture.needsUpdate = true;
  }

  // ---------------------------------------------------------------- picking
  /** screen position -> box coordinates {x, y} of the terrain point under the cursor (ray march) */
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction, half = this.size / 2;
    const above = (t) => {
      const x = o.x + d.x * t + half, z = o.z + d.z * t + half;
      if (x < 0 || z < 0 || x > this.size || z > this.size) return null;
      return o.y + d.y * t - (this.heightAt(x, z) - this.elevMin) * this.exag;
    };
    let prev = null, tPrev = 0;
    for (let t = 0; t < 14000; t += 3) {
      const a = above(t);
      if (a !== null && a <= 0) {
        let lo = prev === null ? Math.max(0, t - 3) : tPrev, hi = t;
        for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; const am = above(m); if (am !== null && am <= 0) hi = m; else lo = m; }
        return { x: o.x + d.x * hi + half, y: o.z + d.z * hi + half };
      }
      prev = a; tPrev = t;
    }
    return null;
  }

  // ---------------------------------------------------------------- route ribbon
  ribbon(xs, ys, cls, width, lift, opacity = 0.95) {
    const m = xs.length;
    if (m < 2) return null;
    const pos = new Float32Array(m * 6), col = new Float32Array(m * 6), idx = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      let tx = xs[b] - xs[a], ty = ys[b] - ys[a];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const nx = -ty * width / 2, ny = tx * width / 2;
      this.world(xs[i] + nx, ys[i] + ny, lift, p); pos.set([p.x, p.y, p.z], i * 6);
      this.world(xs[i] - nx, ys[i] - ny, lift, p); pos.set([p.x, p.y, p.z], i * 6 + 3);
      const c = CLS_COLORS[cls ? cls[i] : 2];
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      if (i < m - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
  }
  static smooth(a, w = 2) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(a.length - 1, i + w); k++) { s += a[k]; c++; }
      out[i] = s / c;
    }
    out[0] = a[0]; out[a.length - 1] = a[a.length - 1];
    return out;
  }
  clearGroup(g) { for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); } }
  setRoute(samples) { this.routeSamples = samples; this.rebuildRoute(); }
  rebuildRoute() {
    this.clearGroup(this.routeGroup);
    const s = this.routeSamples; if (!s || s.x.length < 2) return;
    const first = this.mode === 'hud';
    const mesh = this.ribbon(TerrainScene.smooth(s.x), TerrainScene.smooth(s.y), s.cls, first ? 0.9 : 7, first ? 0.12 : 2.2 * this.exag);
    if (mesh) this.routeGroup.add(mesh);
  }
  setEscape(cells, xyOf) {
    this.escapeCells = cells ? { xs: Float32Array.from(cells, (k) => xyOf(k)[0]), ys: Float32Array.from(cells, (k) => xyOf(k)[1]) } : null;
    this.rebuildEscape();
  }
  rebuildEscape() {
    this.clearGroup(this.escapeGroup);
    const e = this.escapeCells; if (!e) return;
    const first = this.mode === 'hud';
    const mesh = this.ribbon(TerrainScene.smooth(e.xs), TerrainScene.smooth(e.ys), null, first ? 1.2 : 9, first ? 0.2 : 3.2 * this.exag, 1);
    if (mesh) this.escapeGroup.add(mesh);
  }
  setTraverse(points, visible) { this.traversePts = points; this.traverseVisible = visible; this.rebuildTraverse(); }
  rebuildTraverse() {
    this.clearGroup(this.traverseGroup);
    if (!this.traversePts || !this.traverseVisible) return;
    const pts = this.traversePts.map((p) => this.world(p.x, p.y, 1.5 * this.exag));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, fog: false }));
    this.traverseGroup.add(line);
  }

  // ---------------------------------------------------------------- markers
  label(text, color) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const font = '600 30px system-ui, sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 40;
    c.width = w; c.height = 48;
    ctx.font = font;
    // paper tag with a colour key on the left
    ctx.fillStyle = 'rgba(245,244,239,.96)'; ctx.strokeStyle = '#1c1b19'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(2, 2, w - 4, 44, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color; ctx.fillRect(3, 3, 12, 42);
    ctx.fillStyle = '#1c1b19'; ctx.fillRect(15, 3, 1.5, 42);
    ctx.textBaseline = 'middle'; ctx.fillText(text, 26, 25);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, fog: false }));
    sp.scale.set(0.028 * w / 48, 0.028, 1);
    sp.renderOrder = 10;
    return sp;
  }
  /** markers: [{x, y, text, color, kind:'hab'|'stop'|'wp', dim}] */
  setMarkers(markers) { this.markers = markers; this.rebuildMarkers(); }
  rebuildMarkers() {
    this.clearGroup(this.markerGroup);
    const first = this.mode === 'hud';
    for (const m of this.markers) {
      const base = this.world(m.x, m.y, 0);
      const h = (first ? 14 : 55) * (m.kind === 'hab' ? 1.3 : 1) * (first ? 1 : this.exag);
      const col = new THREE.Color(m.color);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(first ? 0.12 : 1.1, first ? 0.12 : 1.1, h, 6),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: m.dim ? 0.45 : 1, fog: false }));
      pole.position.copy(base).y += h / 2;
      this.markerGroup.add(pole);
      if (m.kind === 'hab') {
        const dome = new THREE.Mesh(new THREE.SphereGeometry(first ? 5 : 14, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshLambertMaterial({ color: 0xf4f6fa }));
        dome.castShadow = true;
        dome.position.copy(base); this.markerGroup.add(dome);
      }
      if (m.kind === 'hab') this.renderer.shadowMap.needsUpdate = true;
      if (!m.dim || !first) {
        const sp = this.label(m.text, m.color);
        if (m.dim) sp.material.opacity = 0.6;
        sp.position.copy(base).y += h + (first ? 1.5 : 14);
        this.markerGroup.add(sp);
      }
    }
  }

  // ---------------------------------------------------------------- cameras
  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    this.camera.fov = mode === 'hud' ? 68 : 45;
    this.camera.near = mode === 'hud' ? 0.2 : 0.5;
    this.camera.updateProjectionMatrix();
    this.scene.fog.near = mode === 'hud' ? 300 : 2500;
    this.scene.fog.far = mode === 'hud' ? 5200 : 12000;
    if (mode === 'orbit' && this.savedCam) {
      this.camera.position.copy(this.savedCam.p); this.controls.target.copy(this.savedCam.t);
    } else if (mode !== 'orbit' && !this.savedCam) {
      this.savedCam = { p: this.camera.position.clone(), t: this.controls.target.clone() };
    }
    if (mode === 'orbit') this.savedCam = null;
    this.traverseGroup.visible = mode !== 'hud';
    this.rebuildRoute(); this.rebuildEscape(); this.rebuildMarkers();
  }
  /** position on the route: {x, y, ax, ay} (ax/ay = point a little further along, to look at) */
  setFollow(f) {
    this.follow = f;
    this.puck.visible = !!f && this.mode !== 'hud';
    if (!f) return;
    this.world(f.x, f.y, 4 * this.exag, this.puck.position);
    const s = this.mode === 'orbit' ? Math.max(6, this.camera.position.distanceTo(this.puck.position) / 130) : 5;
    this.puck.scale.setScalar(s);
  }
  frame() {
    const f = this.follow;
    if (this.mode === 'orbit') this.controls.update();
    else if (f) {
      let dx = f.ax - f.x, dy = f.ay - f.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      if (this.mode === 'hud') {
        const eye = this.world(f.x, f.y, 1.75);
        const look = this.world(f.x + dx * 14, f.y + dy * 14, 1.2);
        this.camera.position.lerp(eye, 0.35);
        this.lookTarget = (this.lookTarget || look.clone()).lerp(look, 0.12);
        this.camera.lookAt(this.lookTarget);
      } else { // chase camera for the fly-over
        const here = this.world(f.x, f.y, 6);
        const cam = this.world(Math.max(0, Math.min(this.size, f.x - dx * 170)), Math.max(0, Math.min(this.size, f.y - dy * 170)), 0);
        cam.y = Math.max(cam.y + 40, here.y + 85);
        this.camera.position.lerp(cam, 0.06);
        this.lookTarget = (this.lookTarget || here.clone()).lerp(here, 0.15);
        this.camera.lookAt(this.lookTarget);
      }
    }
    this.sunSprite.position.copy(this.camera.position).addScaledVector(this.sunDir, 20000);
    this.renderer.render(this.scene, this.camera);
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
}
