/**
 * 三人称のキャラクター表示（Blender で作った全身モデルとアニメーション）。
 * キャラクター選択画面のプレビューで使い、フェーズ4以降はボットや他のプレイヤーの表示にも使う。
 *
 * 武器は右手の骨に「親子付け」せず、毎フレーム両手の位置から向きを決めて置く
 * （右手がグリップ、左手の方向が銃口）。どのアニメーションでも両手と銃が離れない。
 */
import * as THREE from 'three';
import type { CharacterModel } from '../assets';

export type CharacterAnim = 'Idle' | 'Run' | 'WallRun' | 'Slide' | 'Jump' | 'Shoot' | 'Ability' | 'Death' | 'Crouch';
/** キャラクター選択画面で切り替えられる動き */
export const CHARACTER_ANIMS: CharacterAnim[] = ['Idle', 'Run', 'WallRun', 'Slide', 'Jump', 'Shoot', 'Ability'];

/** 一度だけ再生する動き（終わったら前の動きに戻る） */
const ONE_SHOT: Partial<Record<CharacterAnim, boolean>> = { Shoot: true, Ability: true };
/** 最後の姿勢で止まる動き */
const HOLD_LAST: Partial<Record<CharacterAnim, boolean>> = { Death: true };

// 毎フレームの計算で使い回す入れ物（新しく作らない）
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _r = new THREE.Vector3();
const _l = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _g = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _front = new THREE.Vector3(0, -0.05, 1).normalize();

export class CharacterView {
  readonly root: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterAnim, THREE.AnimationAction>();
  private readonly handR: THREE.Object3D | null;
  private readonly handL: THREE.Object3D | null;
  private base: CharacterAnim = 'Idle';
  private current: THREE.AnimationAction | null = null;
  private weapon: THREE.Object3D | null = null;
  private weaponGrip = new THREE.Vector3();
  /** 片手を離す動き（アビリティ）の間は、銃を体の正面へ向ける */
  private freeHand = 0;
  private oneShotTimer = 0;
  private oneShotName: CharacterAnim | null = null;

  /** root を渡すと、それを使う（試合用に軽くしたモデル。actorModel.ts） */
  constructor(model: CharacterModel, root?: THREE.Object3D) {
    this.root = root ?? model.scene.clone(true);
    if (!root)
      this.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of model.animations) {
      const name = clip.name as CharacterAnim;
      const act = this.mixer.clipAction(clip);
      if (ONE_SHOT[name]) {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = false;
      }
      if (HOLD_LAST[name]) {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      }
      this.actions.set(name, act);
    }
    // glTF の書き出しで骨の名前の "." が消えることがあるので、両方の名前で探す
    this.handR = this.root.getObjectByName('hand.R') ?? this.root.getObjectByName('handR') ?? null;
    this.handL = this.root.getObjectByName('hand.L') ?? this.root.getObjectByName('handL') ?? null;
    this.spine = this.root.getObjectByName('spine') ?? null;
    this.chest = this.root.getObjectByName('chest') ?? null;
    this.play('Idle', 0);
  }

  private readonly spine: THREE.Object3D | null;
  private readonly chest: THREE.Object3D | null;
  /** 上半身を上下に向ける（狙う向き。ラジアン、上が +） */
  aimPitch = 0;

  /** その動きがあるか（歩兵にはない動きもある） */
  has(name: CharacterAnim): boolean {
    return this.actions.has(name);
  }

  /** 続けて再生する動きの速さ */
  setSpeed(scale: number): void {
    if (this.current && this.oneShotTimer <= 0) this.current.timeScale = scale;
  }

  /** 銃口の位置（世界座標）。武器を持っていなければ右手 */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const m = this.weapon?.getObjectByName('Muzzle') ?? this.handR;
    if (!m) return this.root.getWorldPosition(out);
    return m.getWorldPosition(out);
  }

  /** 頭の上（名札を出す位置）のめやす */
  get weaponObject(): THREE.Object3D | null {
    return this.weapon;
  }

  /** 続けて再生する動きを変える（fade 秒かけて切り替える） */
  play(name: CharacterAnim, fade = 0.2): void {
    if (ONE_SHOT[name]) {
      this.playOnce(name);
      return;
    }
    this.base = name;
    if (this.oneShotTimer > 0) return;
    this.switchTo(name, fade);
  }

  /** 一度だけの動き（射撃・アビリティ） */
  playOnce(name: CharacterAnim): void {
    const act = this.actions.get(name);
    if (!act) return;
    this.oneShotName = name;
    this.oneShotTimer = act.getClip().duration;
    act.reset();
    this.switchTo(name, 0.08);
  }

  private switchTo(name: CharacterAnim, fade: number) {
    const act = this.actions.get(name);
    if (!act || act === this.current) return;
    act.reset().play();
    act.timeScale = 1;
    if (this.current && fade > 0) this.current.crossFadeTo(act, fade, false);
    else if (this.current) this.current.stop();
    this.current = act;
  }

  /** 武器を持たせる（GripR が右手に来るように置く）。share なら複製せずにそのまま使う */
  setWeapon(model: THREE.Object3D | null, share = false): void {
    if (this.weapon) this.root.remove(this.weapon);
    this.weapon = model ? (share ? model : model.clone(true)) : null;
    if (!this.weapon) return;
    this.weapon.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    const grip = this.weapon.getObjectByName('GripR');
    this.weaponGrip.copy(grip ? grip.position : new THREE.Vector3(0, -0.15, 0.04));
    this.root.add(this.weapon);
  }

  get animation(): CharacterAnim {
    return this.oneShotName ?? this.base;
  }

  update(dt: number): void {
    if (this.oneShotTimer > 0) {
      this.oneShotTimer -= dt;
      if (this.oneShotTimer <= 0) {
        this.oneShotName = null;
        this.switchTo(this.base, 0.15);
      }
    }
    this.mixer.update(dt);
    // 上半身を狙う向きへ（背骨と胸で分けて曲げる）。骨の +X 回転が前かがみ
    if (this.aimPitch !== 0 && this.base !== 'Death') {
      this.spine?.rotateX(-this.aimPitch * 0.35);
      this.chest?.rotateX(-this.aimPitch * 0.45);
    }
    const wantFree = this.oneShotName === 'Ability' ? 1 : 0;
    this.freeHand += (wantFree - this.freeHand) * Math.min(1, dt * 10);
    this.placeWeapon();
  }

  private placeWeapon() {
    const w = this.weapon;
    if (!w || !this.handR || !this.handL || !w.visible) return;
    // 両手の骨と、その親（根元まで）だけを更新する（骨格全体を毎フレーム更新すると重い）
    this.handR.updateWorldMatrix(true, false);
    this.handL.updateWorldMatrix(true, false);
    const inv = _inv.copy(this.root.matrixWorld).invert();
    const r = _r.setFromMatrixPosition(this.handR.matrixWorld).applyMatrix4(inv);
    const l = _l.setFromMatrixPosition(this.handL.matrixWorld).applyMatrix4(inv);
    // 銃口の向き：右手から左手へ。左手を離しているときは体の正面（+Z）へ
    const dir = _dir.copy(l).sub(r);
    if (dir.lengthSq() < 1e-6 || dir.length() > 0.5) dir.set(0, 0, 1);
    dir.normalize().lerp(_front, this.freeHand).normalize();
    // three.js の武器モデルは銃口が -Z。lookAt(目, 注視点) は Z 軸を「目 − 注視点」に向けるので、-Z が dir を向く
    const m = _m.lookAt(_zero, dir, _up);
    w.quaternion.setFromRotationMatrix(m);
    // 手のひらの少し内側をグリップに合わせる
    w.position.copy(r).sub(_g.copy(this.weaponGrip).applyQuaternion(w.quaternion));
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
