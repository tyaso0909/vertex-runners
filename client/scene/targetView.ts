/**
 * 的の見た目。
 * - 人型の的：撃たれると光り、倒れると後ろに倒れる
 * - 訓練用タレット：頭が狙った相手の方へ回る。狙いを定めている間は赤いレーザーを出し、撃つと光る
 * どちらも、撃たれたら頭の上に体力ゲージを出す。ソナーで見つかると壁越しに赤く光って見える。
 */
import * as THREE from 'three';
import type { Target } from '../../shared/targets';

interface TargetVisual {
  root: THREE.Object3D;
  /** 人型の的の倒れる本体／タレットの回る頭 */
  dummy: THREE.Object3D;
  flashMats: THREE.MeshStandardMaterial[];
  /** タレットの赤い目（狙っている間に明るくなる） */
  eyeMats: THREE.MeshStandardMaterial[];
  bar: THREE.Group;
  barFill: THREE.Mesh;
  flash: number;
  /** 倒れ具合（0＝立っている、1＝倒れている） */
  fall: number;
  prev: THREE.Vector3;
  cur: THREE.Vector3;
  barShow: number;
  shownHealth: number;
  /** 壁越しに見せる赤い影（ソナー） */
  xray: THREE.Object3D[];
  xrayK: number;
  laser: THREE.Mesh | null;
  muzzle: THREE.Object3D | null;
  muzzleFlash: number;
  flashSprite: THREE.Mesh | null;
  yaw: number;
  pitch: number;
  /** ドローンのプロペラと、壊れたときの落ち方 */
  rotors: THREE.Object3D[];
  dead: number;
}

/** ソナーで見えている敵の色（壁越しでも見える） */
const XRAY_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color('#ff3050').multiplyScalar(1.6),
  transparent: true,
  opacity: 0.55,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});

export class TargetView {
  readonly group = new THREE.Group();
  private visuals = new Map<number, TargetVisual>();

  constructor(model: THREE.Group, targets: Target[], turretModel?: THREE.Group, droneModel?: THREE.Group) {
    const barBgMat = new THREE.MeshBasicMaterial({ color: 0x120a20, transparent: true, opacity: 0.8, depthWrite: false });
    const barGeo = new THREE.PlaneGeometry(0.72, 0.075);
    const laserMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ff2040').multiplyScalar(2.2),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const laserGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 4, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const flashMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ffb070').multiplyScalar(3),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    for (const t of targets) {
      const turret = t.kind === 'turret' && !!turretModel;
      const drone = t.kind === 'drone' && !!droneModel;
      const root = (turret ? turretModel! : drone ? droneModel! : model).clone(true);
      const dummy = root.getObjectByName(turret ? 'TurretHead' : drone ? 'DroneBody' : 'Dummy') ?? root;
      const rotors: THREE.Object3D[] = [];
      for (let k = 0; k < 4; k++) {
        const r = root.getObjectByName(`Rotor${k}`);
        if (r) rotors.push(r);
      }
      // 光らせるために、的ごとにマテリアルを複製する
      const flashMats: THREE.MeshStandardMaterial[] = [];
      const eyeMats: THREE.MeshStandardMaterial[] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
          const c = (m as THREE.MeshStandardMaterial).clone();
          if (c.emissive.getHex() === 0) {
            if (turret || drone || isInside(mesh, dummy)) flashMats.push(c);
          } else if (c.name === 'TRed') eyeMats.push(c);
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
      });
      // ソナー用の赤い影（同じ形を、奥行きを無視して描く）
      const xray: THREE.Object3D[] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.xray) return;
        const x = new THREE.Mesh(mesh.geometry, XRAY_MAT);
        x.userData.xray = true;
        x.renderOrder = 10;
        x.visible = false;
        mesh.add(x);
        xray.push(x);
      });

      const bar = new THREE.Group();
      const bg = new THREE.Mesh(barGeo, barBgMat);
      const fillMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4f7b').multiplyScalar(1.6), toneMapped: false, depthWrite: false });
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.045), fillMat);
      fill.position.z = 0.001;
      bar.add(bg, fill);
      bar.position.y = turret ? 1.85 : drone ? 0.55 : 2.05;
      bar.visible = false;
      root.add(bar);

      let laser: THREE.Mesh | null = null;
      let muzzle: THREE.Object3D | null = null;
      let flashSprite: THREE.Mesh | null = null;
      if (turret) {
        // 銃口：頭の子にして、頭と一緒に回す
        const m = root.getObjectByName('Muzzle');
        muzzle = new THREE.Object3D();
        dummy.add(muzzle);
        if (m) muzzle.position.copy(m.position).sub(dummy.position);
        else muzzle.position.set(0, 0, 0.59);
        laser = new THREE.Mesh(laserGeo, laserMat);
        laser.visible = false;
        laser.frustumCulled = false;
        this.group.add(laser);
        flashSprite = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), flashMat);
        flashSprite.visible = false;
        muzzle.add(flashSprite);
      }

      root.position.set(t.pos.x, t.pos.y, t.pos.z);
      root.rotation.y = (t.yaw * Math.PI) / 180;
      this.group.add(root);
      this.visuals.set(t.id, {
        root,
        dummy,
        flashMats,
        eyeMats,
        bar,
        barFill: fill,
        flash: 0,
        fall: 0,
        prev: root.position.clone(),
        cur: root.position.clone(),
        barShow: 0,
        shownHealth: t.health,
        xray,
        xrayK: 0,
        laser,
        muzzle,
        muzzleFlash: 0,
        flashSprite,
        yaw: t.aimYaw,
        pitch: 0,
        rotors,
        dead: 0,
      });
    }
  }

  /** ゲームロジックが1ティック進んだあとに呼ぶ（動く的の位置を補間するため） */
  afterTick(targets: Target[]): void {
    for (const t of targets) {
      const v = this.visuals.get(t.id);
      if (!v) continue;
      v.prev.copy(v.cur);
      v.cur.set(t.pos.x, t.pos.y, t.pos.z);
    }
  }

  onHit(id: number): void {
    const v = this.visuals.get(id);
    if (!v) return;
    v.flash = 1;
    v.barShow = 3;
  }

  /** タレットが撃った */
  onTurretShot(id: number): void {
    const v = this.visuals.get(id);
    if (v) v.muzzleFlash = 0.06;
  }

  /** タレットの銃口の位置（世界座標） */
  muzzleOf(id: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const v = this.visuals.get(id);
    if (!v?.muzzle) return null;
    return v.muzzle.getWorldPosition(out);
  }

  /**
   * aimPointOf は、タレットが狙っている相手の胸の位置を返す（レーザーの先）
   */
  update(dt: number, alpha: number, targets: Target[], camera: THREE.Camera, aimPointOf?: (entityId: number, from: THREE.Vector3) => THREE.Vector3 | null): void {
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const t of targets) {
      const v = this.visuals.get(t.id);
      if (!v) continue;
      v.root.position.lerpVectors(v.prev, v.cur, alpha);

      if (t.kind === 'turret' && v.muzzle) {
        this.updateTurret(dt, t, v, aimPointOf);
      } else if (t.kind === 'drone') {
        // プロペラを回す。壊れたら回りながら小さくなって消える
        for (const r of v.rotors) r.rotation.y += dt * (t.alive ? 40 : 6);
        v.dead = t.alive ? 0 : Math.min(1, v.dead + dt * 3);
        if (!t.alive) v.root.rotation.y += dt * 14;
        v.root.scale.setScalar(Math.max(0.001, 1 - v.dead));
        v.root.visible = v.dead < 1;
      } else {
        // 倒れる・起き上がる
        const targetFall = t.alive ? 0 : 1;
        v.fall += (targetFall - v.fall) * Math.min(1, dt * (t.alive ? 7 : 11));
        v.dummy.rotation.x = -v.fall * (Math.PI / 2) * 0.97;
        // 引き寄せられてよろめいている間は揺れる
        if (t.stagger > 0) v.dummy.rotation.z = Math.sin(t.stagger * 25) * 0.12 * Math.min(1, t.stagger * 2);
        else v.dummy.rotation.z *= Math.exp(-dt * 10);
      }

      // 撃たれたときに白く光る。タレットは日陰でも形がわかるよう、ふだんから少しだけ光らせる
      v.flash = Math.max(0, v.flash - dt * 9);
      const glow = t.kind === 'turret' && t.alive ? 0.22 : 0;
      for (const m of v.flashMats) {
        if (v.flash > 0.01) m.emissive.setRGB(1, 0.85, 0.85);
        else m.emissive.setRGB(0.55, 0.62, 0.8);
        m.emissiveIntensity = Math.max(glow, v.flash * 1.6);
      }

      // ソナーで見つかっている間は壁越しに赤く見せる
      const reveal = t.alive && t.revealed > 0 && t.revealDelay <= 0;
      v.xrayK += ((reveal ? 1 : 0) - v.xrayK) * Math.min(1, dt * 12);
      for (const x of v.xray) x.visible = v.xrayK > 0.02;

      // 体力ゲージ（撃たれてから少しの間だけ表示）
      v.barShow = Math.max(0, v.barShow - dt);
      v.shownHealth += (t.health - v.shownHealth) * Math.min(1, dt * 14);
      v.bar.visible = v.barShow > 0 && t.alive;
      if (v.bar.visible) {
        const k = Math.max(0.0001, v.shownHealth / t.maxHealth);
        v.barFill.scale.x = k;
        v.barFill.position.x = -0.34 * (1 - k);
        // ゲージは常にカメラの方を向ける
        const wp = new THREE.Vector3();
        v.bar.getWorldPosition(wp);
        const yaw = Math.atan2(camPos.x - wp.x, camPos.z - wp.z);
        v.bar.rotation.y = yaw - v.root.rotation.y;
      }
    }
    XRAY_MAT.opacity = 0.4 + 0.2 * Math.sin(performance.now() / 90);
  }

  private updateTurret(dt: number, t: Target, v: TargetVisual, aimPointOf?: (entityId: number, from: THREE.Vector3) => THREE.Vector3 | null) {
    // 頭を狙いの向きへ（ロジックの向きを、なめらかに追う）
    const wantYaw = t.alive ? t.aimYaw : v.yaw;
    let dy = wantYaw - v.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    v.yaw += dy * Math.min(1, dt * 20);
    const wantPitch = t.alive ? t.aimPitch : -0.6; // 壊れたら頭を垂れる
    v.pitch += (wantPitch - v.pitch) * Math.min(1, dt * (t.alive ? 20 : 6));
    // 頭の正面（+Z）を、視線と同じ決め方の yaw に合わせる（yaw の正面は -Z なので半回転）
    v.dummy.rotation.set(-v.pitch, v.yaw + Math.PI - v.root.rotation.y, 0, 'YXZ');

    // 目：狙っている間は明るく、撃つ直前は点滅
    const locking = t.alive && t.aimTarget >= 0;
    const lockK = Math.min(1, t.aimTime / 0.8);
    for (const m of v.eyeMats) m.emissiveIntensity = !t.alive ? 0.1 : locking ? 4 + 6 * lockK : 1.5;

    // 狙いのレーザー
    if (v.laser) {
      const from = v.muzzle!.getWorldPosition(new THREE.Vector3());
      const aim = locking && aimPointOf ? aimPointOf(t.aimTarget, from.clone()) : null;
      v.laser.visible = !!aim;
      if (aim) {
        v.laser.position.copy(from);
        v.laser.lookAt(aim);
        v.laser.scale.set(1 + lockK, 1 + lockK, from.distanceTo(aim));
        (v.laser.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.35 * lockK;
      }
    }
    v.muzzleFlash -= dt;
    if (v.flashSprite) {
      v.flashSprite.visible = v.muzzleFlash > 0;
      v.flashSprite.rotation.z = Math.random() * Math.PI;
    }
  }
}

function isInside(o: THREE.Object3D, parent: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === parent) return true;
  return false;
}
