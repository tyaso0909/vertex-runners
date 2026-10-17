/**
 * 一人称カメラ。ゲームロジックの状態（60回/秒）を、画面の更新（モニターのリフレッシュレート）に合わせて
 * なめらかにつなぎ、壁走りの傾き・着地の沈み込み・速度による視野角の広がりなどの演出を加える。
 */
import * as THREE from 'three';
import type { CameraConfig, MovementConfig } from '../config';
import { type Vec3, dot, lenH, rightFromYaw } from '../shared/math';
import { type MoveEvent, type PlayerMovement, eyeHeightOf } from '../shared/movement';

const damp = (cur: number, target: number, rate: number, dt: number) => target + (cur - target) * Math.exp(-rate * dt);

/** 横の視野角（度）→ 縦の視野角（度） */
export const horizontalToVerticalFov = (h: number, aspect: number) => (2 * Math.atan(Math.tan((h * Math.PI) / 360) / Math.max(0.1, aspect)) * 180) / Math.PI;

export class FpsCamera {
  readonly camera: THREE.PerspectiveCamera;
  private eye = 1.66;
  private roll = 0;
  private fov: number;
  private dip = 0;
  private dipVel = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private slideRoll = 0;
  private shake = 0;
  private shakeT = 0;
  /** 画面に出す速さ（表示用になめらかにした値） */
  displaySpeed = 0;

  constructor(
    private readonly cam: CameraConfig,
    private readonly mv: MovementConfig,
  ) {
    this.fov = cam.FOV;
    this.camera = new THREE.PerspectiveCamera(cam.FOV, 16 / 9, 0.05, 2000);
    this.camera.rotation.order = 'YXZ';
  }

  /** ゲームロジックの出来事に反応する（着地の衝撃など） */
  onEvents(events: MoveEvent[]): void {
    for (const e of events) {
      if (e.type === 'land') {
        const d = Math.min(this.cam.LANDING_DIP_MAX, e.impactSpeed * this.cam.LANDING_DIP_PER_SPEED);
        this.dipVel -= d * 14;
      } else if (e.type === 'mantle') {
        this.dipVel -= 0.9;
      } else if (e.type === 'respawn') {
        this.dip = this.dipVel = 0;
      }
    }
  }

  /** 画面を揺らす（爆発など）。amount は 0〜1 */
  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** 走りの揺れ・傾き・沈み込み（武器の表示に使う） */
  get bob() {
    return { phase: this.bobPhase, amount: this.bobAmount };
  }
  get rollRad() {
    return ((this.roll + this.slideRoll) * Math.PI) / 180;
  }
  get dipAmount() {
    return this.dip;
  }

  /** adsFovMul：エイム中の視野角の倍率（1 で通常、小さいほどズーム） */
  update(dt: number, prevPos: Vec3, pos: Vec3, alpha: number, m: PlayerMovement, yaw: number, pitch: number, adsFovMul = 1): void {
    const c = this.cam;
    // 位置：前のティックと今のティックの間を補間
    const x = prevPos.x + (pos.x - prevPos.x) * alpha;
    const y = prevPos.y + (pos.y - prevPos.y) * alpha;
    const z = prevPos.z + (pos.z - prevPos.z) * alpha;

    // 目の高さ（しゃがみ・スライディングでなめらかに下がる）
    this.eye = damp(this.eye, eyeHeightOf(m, this.mv), c.EYE_HEIGHT_LERP, dt);

    // 着地の沈み込み（ばね）。フレームが重くても暴れないよう細かく刻んで計算する
    const k = 140,
      damping = 18;
    for (let left = dt; left > 1e-6; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      this.dipVel += (-k * this.dip - damping * this.dipVel) * h;
      this.dip += this.dipVel * h;
    }
    this.dip = Math.max(-0.35, Math.min(0.1, this.dip));

    // 走っているときの視点の揺れ
    const hs = lenH(m.vel);
    const onGround = m.state === 'ground';
    this.bobAmount = damp(this.bobAmount, onGround ? Math.min(1, hs / this.mv.SPRINT_SPEED) : 0, 10, dt);
    this.bobPhase += hs * dt * 1.15;
    const bobY = Math.sin(this.bobPhase * 2) * c.HEAD_BOB * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * c.HEAD_BOB * 0.6 * this.bobAmount;

    // 壁走り中は壁と反対側へ傾ける
    let targetRoll = 0;
    if (m.state === 'wallrun') {
      const side = dot(m.wallNormal, rightFromYaw(yaw)); // 壁が右にあると負
      targetRoll = -Math.sign(side) * Math.min(1, Math.abs(side) * 1.6) * this.mv.CAMERA_TILT_WALLRUN;
    }
    this.roll = damp(this.roll, targetRoll, c.TILT_LERP, dt);
    // スライディング中はわずかに傾ける
    this.slideRoll = damp(this.slideRoll, m.state === 'slide' ? 2.5 : 0, 8, dt);

    // 速いほど視野角を広げる
    const t = Math.max(0, Math.min(1, (hs - c.FOV_KICK_START_SPEED) / (c.FOV_KICK_FULL_SPEED - c.FOV_KICK_START_SPEED)));
    const kick = c.FOV_SPEED_KICK * t * Math.min(1, adsFovMul);
    this.fov = damp(this.fov, (c.FOV + kick) * adsFovMul, adsFovMul < 0.999 ? 22 : 12, dt);
    // 設定の視野角は横の角度（ふつうの FPS と同じ）。three.js のカメラは縦の角度なので、画面の縦横比で直す
    const vfov = horizontalToVerticalFov(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - vfov) > 0.01) {
      this.camera.fov = vfov;
      this.camera.updateProjectionMatrix();
    }

    const r = rightFromYaw(yaw);
    this.camera.position.set(x + r.x * bobX, y + this.eye + this.dip + bobY, z + r.z * bobX);
    // 爆発などによる揺れ（細かく速い揺れが、すぐおさまる）
    this.shakeT += dt;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const sk = this.shake * this.shake;
    const sx = (Math.sin(this.shakeT * 53) + Math.sin(this.shakeT * 31.7)) * 0.5 * sk * 0.035;
    const sy = (Math.sin(this.shakeT * 47.3) + Math.sin(this.shakeT * 27.1)) * 0.5 * sk * 0.035;
    this.camera.rotation.set(pitch + sy, yaw + sx, ((this.roll + this.slideRoll) * Math.PI) / 180 + sx * 0.6, 'YXZ');

    this.displaySpeed = damp(this.displaySpeed, hs, 12, dt);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 速さに応じた演出の強さ（0〜1）。スピードラインに使う */
  speedFactor(): number {
    const c = this.cam;
    return Math.max(0, Math.min(1, (this.displaySpeed - c.FOV_KICK_START_SPEED) / (c.FOV_KICK_FULL_SPEED - c.FOV_KICK_START_SPEED)));
  }
}
