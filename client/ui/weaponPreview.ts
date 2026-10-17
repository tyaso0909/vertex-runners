/**
 * ロードアウト画面の武器の 3D 表示。サイト・アタッチメントを付けた武器を、ゆっくり回して見せる（ガンスミスのような見た目）。
 * 同じ描き手で、武器・サイトの小さな絵（カードに出す画像）も作る。WebGL の描き手は 1 つだけ使う。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GrenadeId, SightId, WeaponId } from '../../config';
import type { WeaponCustom } from '../../shared/weaponCustom';
import { applyWeaponMods } from '../weapons/weaponMods';

export class WeaponPreview {
  /** 回して見せる表示（画面のどこかに置く） */
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.PerspectiveCamera(26, 2, 0.01, 20);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  private readonly holder = new THREE.Group();
  private readonly models = new Map<WeaponId, THREE.Object3D>();
  private shown: { id: WeaponId; key: string } | null = null;
  private spin = 0.6;
  private running = false;
  private last = 0;
  private dragging = false;
  private lastX = 0;
  private spinVel = 0;

  constructor(
    private readonly weapons: Record<WeaponId, THREE.Object3D>,
    private readonly parts: THREE.Object3D,
    private readonly grenades: Partial<Record<GrenadeId, THREE.Object3D>> = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lo-wpreview';
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.35;
      this.renderer.setClearColor(0x000000, 0);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.65;
      pmrem.dispose();
    } catch {
      this.renderer = null; // 絵がなくても選べる
    }
    this.scene.add(new THREE.HemisphereLight('#d6c8ff', '#1a1028', 1.3));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(2, 3, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#4fd1ff', 2.0);
    rim.position.set(-2, 1, -3);
    this.scene.add(rim);
    this.scene.add(this.holder);
    // ドラッグで回す
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.spin += dx * 0.012;
      this.spinVel = dx * 0.5;
    });
    const up = () => (this.dragging = false);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  private model(id: WeaponId): THREE.Object3D {
    let m = this.models.get(id);
    if (!m) {
      m = this.weapons[id].clone(true);
      this.models.set(id, m);
    }
    return m;
  }

  /** 回して見せる武器を決める */
  show(id: WeaponId, custom: WeaponCustom): void {
    const key = `${custom.sight}|${custom.attachments.join(',')}`;
    if (this.shown && this.shown.id === id && this.shown.key === key) return;
    this.shown = { id, key };
    this.holder.clear();
    const m = this.model(id);
    applyWeaponMods(m, id, custom, this.parts);
    this.holder.add(m);
    this.frame(m, this.holder);
    this.start();
  }

  /** モデルの中心を原点に置き、大きさをそろえる */
  private frame(m: THREE.Object3D, holder: THREE.Object3D) {
    m.position.set(0, 0, 0);
    m.scale.setScalar(1);
    m.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    // 長い銃は長さで、背の高い銃（ハンドガン）は高さで大きさを決める（どちらも枠に収まるように）
    const k = 1 / Math.max(size.x, size.z, size.y * 1.6);
    m.scale.setScalar(k);
    m.position.copy(c).multiplyScalar(-k);
    holder.updateMatrixWorld(true);
  }

  private start() {
    if (this.running || !this.renderer) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.canvas.isConnected || this.canvas.offsetParent === null) {
        this.running = false;
        return;
      }
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.render(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private render(dt: number) {
    const r = this.renderer!;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      r.setSize(w, h, false);
      this.cam.aspect = w / h;
      this.cam.updateProjectionMatrix();
    }
    if (!this.dragging) {
      this.spinVel *= Math.exp(-dt * 3);
      this.spin += (0.3 + this.spinVel * 0.02) * dt;
    }
    // 少し上から、斜めに見る（銃は -Z が前）
    this.holder.rotation.set(0, this.spin + Math.PI / 2, 0);
    const d = 1.75 / Math.min(1, this.cam.aspect * 0.5);
    this.cam.position.set(0, d * 0.22, d);
    this.cam.lookAt(0, 0, 0);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.cam);
  }

  /** カードに出す武器の絵（横から。サイト・アタッチメント付き） */
  thumb(id: WeaponId, custom: WeaponCustom, w = 240, h = 96): HTMLCanvasElement {
    const g = new THREE.Group();
    const m = this.weapons[id].clone(true);
    applyWeaponMods(m, id, custom, this.parts);
    g.add(m);
    return this.snapshot(g, w, h, 'side');
  }

  /** カードに出すサイトの絵 */
  sightThumb(id: SightId, w = 160, h = 96): HTMLCanvasElement {
    const g = new THREE.Group();
    const p = this.parts.getObjectByName(`Sight_${id}`);
    if (p) g.add(p.clone(true));
    return this.snapshot(g, w, h, 'angle');
  }

  /** カードに出すグレネードの絵（斜め上から） */
  grenadeThumb(id: GrenadeId, w = 160, h = 112): HTMLCanvasElement {
    const g = new THREE.Group();
    const src = this.grenades[id];
    if (src) {
      const m = src.clone(true);
      // 刺さる星は正面から、ほかは少し傾けて見せる
      if (id === 'firestar' || id === 'gravity') {
        m.rotation.set(0, Math.PI / 2, 0.35);
        m.scale.setScalar(0.8);
      }
      else if (id === 'satchel') m.rotation.set(-0.5, 0.6, 0);
      else m.rotation.set(0, 0, -0.35);
      g.add(m);
    }
    return this.snapshot(g, w, h, 'side');
  }

  /** 1 枚だけ描いて、2D のキャンバスに写す */
  private snapshot(obj: THREE.Object3D, w: number, h: number, view: 'side' | 'angle'): HTMLCanvasElement {
    const out = document.createElement('canvas');
    const pr = 2;
    out.width = w * pr;
    out.height = h * pr;
    const r = this.renderer;
    if (!r) return out;
    const prevVisible = this.holder.visible;
    this.holder.visible = false;
    this.scene.add(obj);
    obj.updateMatrixWorld(true);
    if (view === 'angle') obj.rotation.set(0.0, -0.75, 0);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    // 銃口（-Z）が右を向くように、+X の側から見る
    const cam = this.ortho;
    cam.position.set(c.x + 5, c.y + (view === 'angle' ? 1.2 : 0), c.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(c);
    const horiz = Math.max(size.z, view === 'angle' ? size.x : 0);
    const half = Math.max(horiz / 2 / (w / h), size.y / 2) * (view === 'angle' ? 1.25 : 1.04);
    cam.left = (-half * w) / h;
    cam.right = (half * w) / h;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    const prevSize = r.getSize(new THREE.Vector2());
    const prevPr = r.getPixelRatio();
    r.setPixelRatio(pr);
    r.setSize(w, h, false);
    r.render(this.scene, cam);
    out.getContext('2d')?.drawImage(r.domElement, 0, 0, out.width, out.height);
    r.setPixelRatio(prevPr);
    r.setSize(prevSize.x, prevSize.y, false);
    this.scene.remove(obj);
    this.holder.visible = prevVisible;
    return out;
  }
}
