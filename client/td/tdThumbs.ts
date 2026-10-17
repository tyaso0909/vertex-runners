/**
 * 購入メニューのカードに出す、タレット・設置物の小さな絵（3D のモデルを1枚ずつ描く）。
 * タワーディフェンスを始めるときに1度だけ、一時的な描き手で描いて 2D のキャンバスに写し、描き手は捨てる。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { TdAssets } from '../assets';
import { makeDeployedPod } from './deviceViews';
import { part } from './viewUtil';

export type ThumbKey = 'mg' | 'rocket' | 'slow' | 'repair' | 'decoy' | 'wiretrap' | 'barricade' | 'jumppad' | 'mg2' | 'mg3';

export class TdThumbs {
  private readonly pics = new Map<ThumbKey, HTMLCanvasElement>();

  constructor(assets: TdAssets, w = 220, h = 150) {
    let r: THREE.WebGLRenderer | null = null;
    try {
      const canvas = document.createElement('canvas');
      r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      return; // 絵がなくても選べる
    }
    const pr = 2;
    r.setPixelRatio(pr);
    r.setSize(w, h, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.25;
    r.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
    scene.add(new THREE.HemisphereLight('#d6c8ff', '#1a1028', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(3, 4, -2);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#4fd1ff', 1.8);
    rim.position.set(-3, 1.5, 3);
    scene.add(rim);
    const cam = new THREE.PerspectiveCamera(30, w / h, 0.05, 100);

    const shot = (k: ThumbKey, obj: THREE.Object3D, look = 0.55) => {
      scene.add(obj);
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      // 斜め前の少し上から（正面は -Z）
      const dir = new THREE.Vector3(0.85, look, -1).normalize();
      const rad = Math.max(size.x, size.y * 1.15, size.z) * 0.62 + 0.1;
      const dist = rad / Math.sin((cam.fov * Math.PI) / 360) / Math.min(1, cam.aspect * 0.9);
      cam.position.copy(c).addScaledVector(dir, dist);
      cam.lookAt(c);
      r!.render(scene, cam);
      const out = document.createElement('canvas');
      out.width = w * pr;
      out.height = h * pr;
      out.getContext('2d')?.drawImage(r!.domElement, 0, 0, out.width, out.height);
      this.pics.set(k, out);
      scene.remove(obj);
    };
    for (const k of ['mg', 'rocket', 'slow', 'repair', 'decoy', 'barricade', 'jumppad'] as const) shot(k, assets[k].clone(true), k === 'jumppad' ? 1.1 : k === 'barricade' ? 0.5 : 0.45);
    // ワイヤートラップ：開いた機雷を3つ並べて、レーザーでつなぐ
    const g = new THREE.Group();
    const laser = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3a6a').multiplyScalar(3), toneMapped: false });
    for (let i = 0; i < 3; i++) {
      const p = makeDeployedPod(assets.wiretrap);
      p.position.set((i - 1) * 0.62, 0, 0);
      g.add(p);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.24, 6), laser);
    beam.rotation.z = Math.PI / 2;
    beam.position.y = 0.62;
    g.add(beam);
    shot('wiretrap', g, 0.7);
    // 強化したタレット（レベル 2・3）
    for (const lv of [2, 3]) {
      const t = assets.mg.clone(true);
      for (let l = 2; l <= lv; l++) {
        const u = part(assets.upgrade, `Up${l}`);
        if (u) t.add(u.clone(true));
      }
      shot(lv === 2 ? 'mg2' : 'mg3', t);
    }
    laser.dispose();
    pmrem.dispose();
    r.dispose();
    r.forceContextLoss();
  }

  /** 絵の複製（同じ絵を何か所にも出せるように） */
  get(k: ThumbKey): HTMLCanvasElement {
    const src = this.pics.get(k);
    const c = document.createElement('canvas');
    if (!src) return c;
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')?.drawImage(src, 0, 0);
    return c;
  }
}
