/**
 * ゴースト：ベスト記録のときの走りを、半透明の青い影として再生する。
 * 選んでいるキャラクターのモデルとアニメーションを使い、記録した動き（走る・空中・壁走り・スライディング）に合わせて切り替える。
 */
import * as THREE from 'three';
import type { CharacterModel } from '../assets';
import { CharacterView } from '../characters/characterView';
import { GhostPose, ghostSample } from '../../shared/timeAttack';

const POSE_ANIM = {
  [GhostPose.Run]: 'Run',
  [GhostPose.Air]: 'Jump',
  [GhostPose.WallRun]: 'WallRun',
  [GhostPose.Slide]: 'Slide',
  [GhostPose.Idle]: 'Idle',
} as const;

/** ゴーストの濃さ */
const OPACITY = 0.42;

export class GhostView {
  readonly group = new THREE.Group();
  private readonly view: CharacterView;
  private readonly mat: THREE.MeshBasicMaterial;
  private frames: ArrayLike<number> | null = null;
  private interval = 2;
  private pose: GhostPose = GhostPose.Idle;
  enabled = true;

  constructor(model: CharacterModel) {
    this.view = new CharacterView(model);
    this.mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#5fe0ff').multiplyScalar(1.6),
      transparent: true,
      opacity: OPACITY,
      depthWrite: false,
      toneMapped: false,
    });
    this.view.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = this.mat;
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 4;
    });
    this.group.add(this.view.root);
    this.group.visible = false;
  }

  setFrames(frames: ArrayLike<number> | null, interval: number): void {
    this.frames = frames && frames.length ? frames : null;
    this.interval = interval;
    this.group.visible = false;
  }

  get hasGhost(): boolean {
    return !!this.frames;
  }

  /** time＝走り始めてからの時間。null なら隠す */
  update(dt: number, time: number | null, camera: THREE.Camera): void {
    const s = this.frames && this.enabled && time !== null ? ghostSample(this.frames, this.interval, time) : null;
    this.group.visible = !!s;
    if (!s) return;
    this.view.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    // モデルの正面（+Z）を、視線の向き（yaw の正面は -Z）に合わせる
    this.view.root.rotation.y = s.yaw + Math.PI;
    if (s.pose !== this.pose) {
      this.pose = s.pose;
      this.view.play(POSE_ANIM[s.pose] ?? 'Run', 0.15);
    }
    this.view.update(dt);
    // 近すぎるときは薄く（自分の視界をふさがないように）
    const d = camera.getWorldPosition(new THREE.Vector3()).distanceTo(this.view.root.position);
    this.mat.opacity = OPACITY * Math.min(1, Math.max(0, (d - 1) / 3));
  }

  dispose(): void {
    this.mat.dispose();
    this.view.dispose();
    this.group.removeFromParent();
  }
}
