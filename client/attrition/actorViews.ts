/**
 * 試合に出るほかの参加者（味方・敵のパイロット、歩兵）の表示。
 * - ゲームロジックの状態（位置・動き・武器・アビリティ）から、モデル・アニメーション・武器を合わせる
 * - 味方は青、敵は赤の縁取り（キャラクターのテーマカラーはモデルの色）。歩兵は灯りの色でチームがわかる
 * - 味方（パイロット・歩兵）は、輪郭を細い青い線で囲む
 * - 倒されると、崩れ落ちながら光の粒になって消える（仕様 7.4）
 * - 光学迷彩（ほぼ透明）・フェイズシフト（紫の影）・ソナーで見えた敵（壁越しに赤い影）
 * - 頭の上の名札：味方はいつも、敵は見えているときだけ
 */
import { ASSAULT_HEIGHT } from '../../shared/td/units';
import { type WeaponCustom, customKey } from '../../shared/weaponCustom';
import { applyWeaponMods } from '../weapons/weaponMods';
import * as THREE from 'three';
import { CHARACTER_IDS, type CharacterId, type WeaponId, charactersConfig } from '../../config';
import type { Assets, TdAssets } from '../assets';
import { CharacterView } from '../characters/characterView';
import { ActorTemplate, type ActorFx, makeFx, markOutlineStencil, mergeWeapon, outlineMaterial } from '../characters/actorModel';
import { isCloaked, isPhased } from '../../shared/abilities';
import type { Entity, Simulation } from '../../shared/simulation';
import { activeSlot } from '../../shared/weapons';
import { lenH } from '../../shared/math';

export const ALLY_COLOR = new THREE.Color('#3fb6ff');
export const ENEMY_COLOR = new THREE.Color('#ff3b3b');
/** 味方の輪郭の色・濃さ */
const ALLY_OUTLINE = new THREE.Color('#4cc0ff');
const ALLY_OUTLINE_OPACITY = 0.7;

/** ActorViews で表示する参加者の種類（パイロット・歩兵・重装兵・迫撃砲兵は人の形、爆弾兵はクモ型のロボット） */
export type ActorKind = 'pilot' | 'grunt' | 'assault' | 'heavy' | 'mortar';
const ACTOR_KINDS = new Set<string>(['pilot', 'grunt', 'assault', 'heavy', 'mortar', 'holo']);

export interface ActorViewsOptions {
  /** タワーディフェンス：爆弾兵・重装兵のモデルと、名札の出し方（味方は体力・ダウンも出す。壁越しにも見える） */
  td?: TdAssets;
}

const DEATH_HOLD = 0.45;
const DISSOLVE_TIME = 1.25;

const damp = (cur: number, target: number, rate: number, dt: number) => target + (cur - target) * Math.exp(-rate * dt);
const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

class ActorView {
  readonly outer = new THREE.Group();
  readonly view: CharacterView;
  readonly fx: ActorFx;
  private readonly materials: THREE.Material[];
  /** いま持たせている武器（武器の種類とカスタマイズ） */
  weaponKey: string | null = null;
  prev = new THREE.Vector3();
  cur = new THREE.Vector3();
  bodyYaw = 0;
  roll = 0;
  deadTime = -1;
  removed = false;
  /** ブーストのホロパイロット（味方には立体映像に見え、敵には本物のパイロットに見える。消えるときは一瞬） */
  holo = false;
  lastShootAnim = 0;
  hit = 0;
  readonly tag: HTMLElement;
  tagVisible = false;
  losTimer = Math.random() * 0.2;
  los = false;
  private ghost: THREE.SkinnedMesh[] = [];
  private ghostMat: THREE.MeshBasicMaterial | null = null;
  private outlineMat: THREE.MeshBasicMaterial | null = null;
  readonly rope: THREE.Line;
  private height = 1.8;
  /** ダウンしている（崩れた姿勢で止まる） */
  private downedShown = false;
  private tagHp: HTMLElement | null = null;
  private tagDown: HTMLElement | null = null;
  private tagState = '';

  constructor(
    readonly id: number,
    readonly kind: ActorKind,
    readonly character: CharacterId,
    readonly team: number,
    readonly ally: boolean,
    readonly name: string,
    template: ActorTemplate,
    tagLayer: HTMLElement,
    readonly td = false,
  ) {
    this.fx = makeFx(ally ? ALLY_COLOR : ENEMY_COLOR);
    this.fx.rim.value = ally ? 0.12 : 0.32;
    const inst = template.instantiate(this.fx);
    this.materials = inst.materials;
    this.view = new CharacterView({ scene: inst.root as THREE.Group, animations: template.animations }, inst.root);
    this.outer.add(this.view.root);
    if (ally) this.addOutline();
    // 名札
    this.tag = document.createElement('div');
    this.tag.className = `actor-tag ${ally ? 'ally' : 'enemy'} ${kind === 'pilot' ? 'pilot' : 'grunt'}${td ? ' td' : ''}`;
    if (kind === 'pilot') {
      const def = charactersConfig[character];
      // タワーディフェンスの味方：名前・キャラクター・体力・ダウン中の残り時間
      if (td && ally) this.tag.innerHTML = `<span class="down"></span><b style="--char:${def.COLOR}">${name}<small>${def.NAME}</small></b><s><u></u></s><i></i>`;
      else this.tag.innerHTML = `<b style="--char:${def.COLOR}">${name}</b><i></i>`;
    } else this.tag.innerHTML = td ? '<s><u></u></s><i></i>' : '<i></i>';
    this.tagHp = this.tag.querySelector('u');
    this.tagDown = this.tag.querySelector('.down');
    tagLayer.appendChild(this.tag);
    // ワイヤーフックの線
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.rope = new THREE.Line(g, new THREE.LineBasicMaterial({ color: new THREE.Color('#ff5a6a').multiplyScalar(2.5), toneMapped: false }));
    this.rope.frustumCulled = false;
    this.rope.visible = false;
    this.outer.add(this.rope);
  }

  setWeapon(key: string, model: THREE.Object3D) {
    if (this.weaponKey === key) return;
    this.weaponKey = key;
    this.view.setWeapon(model.clone(true), true);
    this.band = -1;
  }

  /** 味方の輪郭（体を少し膨らませた裏側を青く塗る） */
  private addOutline() {
    this.outlineMat = outlineMaterial(this.fx, ALLY_OUTLINE, ALLY_OUTLINE_OPACITY);
    const bodies: THREE.SkinnedMesh[] = [];
    this.view.root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && (sm.name === 'ActorBody' || sm.name === 'ActorBodyLod') && sm.geometry.attributes.aOutline) bodies.push(sm);
    });
    for (const sm of bodies) {
      markOutlineStencil(sm.material as THREE.Material);
      const om = new THREE.SkinnedMesh(sm.geometry, this.outlineMat);
      om.name = 'ActorOutline';
      om.userData.outlineOf = sm.name;
      om.visible = sm.visible;
      om.userData.ghost = true; // ソナーの影を作るときに数えない
      om.castShadow = false;
      om.receiveShadow = false;
      om.renderOrder = 1;
      sm.parent!.add(om);
      om.bind(sm.skeleton, sm.bindMatrix);
    }
  }

  /** ソナーで見えている敵の、壁越しの赤い影 */
  setGhost(on: boolean) {
    if (on && !this.ghost.length) {
      this.ghostMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a3a').multiplyScalar(1.6), transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, toneMapped: false });
      this.view.root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (!sm.isSkinnedMesh || sm.userData.ghost || sm.name === 'ActorBodyLod') return;
        const gm = new THREE.SkinnedMesh(sm.geometry, this.ghostMat!);
        gm.userData.ghost = true;
        gm.renderOrder = 50;
        gm.frustumCulled = false;
        sm.parent!.add(gm);
        gm.bind(sm.skeleton, sm.bindMatrix);
        this.ghost.push(gm);
      });
    }
    for (const g of this.ghost) g.visible = on;
  }

  /** 動きの計算を間引くための、たまった時間 */
  private animAcc = Math.random() * 0.05;
  private band = -1;
  private detailShown = true;
  private meshes: THREE.Mesh[] | null = null;

  /**
   * 毎フレーム：位置だけはいつも合わせ、動き（アニメーション・武器の置き方）は、
   * 画面に映っていない・遠い参加者ほど間引いて計算する（重さを減らす）
   */
  tick(dt: number, e: Entity | undefined, alpha: number, visible: boolean, dist: number) {
    const dying = !e || e.dead || this.deadTime >= 0;
    this.setDetail(dist, visible || dist < 25 || dying);
    // 画面に見えている参加者は、遠くても毎フレーム動かす（間引くと動きがカクカクして見える。間引いても軽くなるのは 0.2ms ほど）。
    // 画面の外は、影が見える近くだけ 1 秒に 15 回、遠いと動かさない
    const interval = dying || visible ? 0 : dist < 25 ? 1 / 15 : Infinity;
    this.animAcc += dt;
    if (this.animAcc < interval) {
      this.outer.position.lerpVectors(this.prev, this.cur, alpha);
      return;
    }
    const d = Math.min(this.animAcc, 0.25);
    this.animAcc = 0;
    this.update(d, e, alpha);
  }

  /** 遠い参加者は影を落とさず、武器を描かない。画面の外の遠い参加者は描かない（影も） */
  private setDetail(dist: number, shown: boolean) {
    if (!this.meshes) {
      this.meshes = [];
      this.view.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !o.userData.ghost && o.name !== 'ActorOutline') this.meshes!.push(m);
      });
    }
    if (shown !== this.detailShown) {
      this.detailShown = shown;
      this.outer.visible = shown;
    }
    // 0：近い（細かいモデル・影あり）、1：遠い（面を減らしたモデル・影なし）、2：とても遠い（武器も描かない）。
    // 境目で行ったり来たりしないように、切り替えは境目から 2m 離れてから
    const want = dist < 30 ? 0 : dist < 60 ? 1 : 2;
    let band = this.band;
    if (band < 0) band = want;
    else if (want > band && dist > (band === 0 ? 32 : 62)) band = want;
    else if (want < band && dist < (band === 1 ? 28 : 58)) band = want;
    if (band === this.band) return;
    this.band = band;
    const hasLod = this.meshes.some((m) => m.name === 'ActorBodyLod');
    const far = band > 0 && hasLod;
    for (const m of this.meshes) {
      if (m.name === 'ActorBody') {
        m.visible = !far;
        m.castShadow = band === 0;
      } else if (m.name === 'ActorBodyLod') m.visible = far;
      else if (m.name === 'ActorClear') m.visible = !far;
    }
    this.view.root.traverse((o) => {
      if (o.name === 'ActorOutline') o.visible = o.userData.outlineOf === (far ? 'ActorBodyLod' : 'ActorBody');
    });
    const w = this.view.weaponObject;
    if (w) {
      w.visible = band < 2;
      const hasWeaponLod = !!w.getObjectByName('WeaponBodyLod');
      w.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        o.castShadow = band === 0;
        if (hasWeaponLod && o.name === 'WeaponBody') o.visible = band === 0;
        if (o.name === 'WeaponBodyLod') o.visible = band > 0;
      });
    }
  }

  update(dt: number, e: Entity | undefined, alpha: number) {
    const p = new THREE.Vector3().lerpVectors(this.prev, this.cur, alpha);
    this.outer.position.copy(p);
    const fx = this.fx;
    this.hit = Math.max(0, this.hit - dt * 5);
    fx.hit.value = this.hit;
    if (this.holo && (!e || e.dead)) {
      // ホロパイロット：倒れずに、ちらついて消える
      if (this.deadTime < 0) this.deadTime = 0;
      this.deadTime += dt;
      fx.dissolve.value = Math.min(1, this.deadTime / 0.22);
      fx.hit.value = 1 - fx.dissolve.value;
      this.view.update(dt);
      return;
    }
    if (!e || e.dead) {
      if (this.deadTime < 0) {
        this.deadTime = 0;
        this.view.play('Death', 0.08);
        this.setGhost(false);
        this.rope.visible = false;
      }
      this.deadTime += dt;
      fx.dissolve.value = Math.min(1, Math.max(0, (this.deadTime - DEATH_HOLD) / DISSOLVE_TIME));
      fx.cloak.value = 0;
      fx.phase.value = 0;
      this.view.aimPitch = 0;
      this.view.update(dt);
      return;
    }
    if (this.deadTime >= 0) {
      // 復活した
      this.deadTime = -1;
      fx.dissolve.value = 0;
      this.view.play('Idle', 0);
    }
    // ダウン：崩れてうずくまった姿勢のまま、蘇生を待つ
    if (e.downed > 0) {
      if (!this.downedShown) {
        this.downedShown = true;
        this.view.play('Death', 0.12);
        this.rope.visible = false;
      }
      fx.cloak.value = 0;
      fx.phase.value = 0;
      fx.rim.value = 0.25 + 0.2 * Math.sin(performance.now() / 160);
      this.view.aimPitch = 0;
      this.view.update(dt);
      return;
    }
    if (this.downedShown) {
      this.downedShown = false;
      this.view.play('Idle', 0.2);
    }
    const m = e.movement;
    this.height = m.height;
    // 体の向き：狙う向き。走っている間は進む向きへ寄せる（後ろ向きに走るときは狙う向きのまま）
    const aimYaw = e.lastCmd.yaw;
    const hs = lenH(m.vel);
    let want = aimYaw;
    const firing = e.arsenal.sinceShot < 0.6;
    if (hs > 1.5 && m.state !== 'wallrun') {
      const moveYaw = Math.atan2(-m.vel.x, -m.vel.z);
      const d = angDiff(moveYaw, aimYaw);
      if (Math.abs(d) < 2.2) want = aimYaw + (firing ? THREE.MathUtils.clamp(d, -0.9, 0.9) : d);
    }
    if (m.state === 'wallrun') want = Math.atan2(-m.vel.x, -m.vel.z);
    this.bodyYaw += angDiff(want, this.bodyYaw) * Math.min(1, dt * 12);
    // 壁走り中は壁と反対側へ傾く
    let wantRoll = 0;
    if (m.state === 'wallrun') {
      const fx2 = -Math.sin(this.bodyYaw),
        fz2 = -Math.cos(this.bodyYaw);
      const side = fx2 * m.wallNormal.z - fz2 * m.wallNormal.x; // 壁が右なら +
      wantRoll = side > 0 ? -0.32 : 0.32;
    }
    this.roll = damp(this.roll, wantRoll, 10, dt);
    this.view.root.rotation.set(0, this.bodyYaw + Math.PI, 0);
    this.view.root.rotateZ(this.roll);
    this.view.aimPitch = THREE.MathUtils.clamp(e.lastCmd.pitch, -0.9, 0.9);

    // 動き
    const v = this.view;
    if (m.state === 'wallrun') v.play('WallRun', 0.12);
    else if (m.state === 'slide') v.play(v.has('Slide') ? 'Slide' : 'Crouch', 0.12);
    else if (m.state === 'air' || m.state === 'mantle') v.play('Jump', 0.2);
    else if (hs > 1.2) {
      v.play('Run', 0.18);
      v.setSpeed(this.kind !== 'pilot' ? hs / 4.2 : Math.max(0.6, hs / 7.5));
    } else if (m.crouched && v.has('Crouch')) v.play('Crouch', 0.2);
    else v.play('Idle', 0.25);
    v.update(dt);

    // アビリティの見た目
    // 味方のホロパイロットは、半分透けてちらつく立体映像に見せる（敵からは本物と同じ見た目）
    const holoLook = this.holo && this.ally ? 0.5 + 0.12 * Math.sin(performance.now() / 45 + this.id) : 0;
    fx.cloak.value = Math.max(holoLook, damp(fx.cloak.value, isCloaked(e.ability) ? 1 : 0, 6, dt));
    fx.phase.value = damp(fx.phase.value, isPhased(e.ability) || e.ability.phaseWindup > 0 ? 1 : 0, 10, dt);
    fx.rim.value = (this.ally ? 0.12 : 0.32) * (e.invuln > 0 ? 4 : 1) + (e.ability.overdrive > 0 ? 0.8 : 0) + (this.holo && this.ally ? 1.2 : 0);
    const g = m.grapple;
    this.rope.visible = !!g;
    if (g) {
      const hand = this.view.muzzleWorld(new THREE.Vector3());
      this.outer.worldToLocal(hand);
      const tgt = this.outer.worldToLocal(new THREE.Vector3(g.point.x, g.point.y, g.point.z));
      const pos = this.rope.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, hand.x, hand.y, hand.z);
      pos.setXYZ(1, tgt.x, tgt.y, tgt.z);
      pos.needsUpdate = true;
    }
  }

  get headY(): number {
    // 爆弾兵は小さいクモ型のロボット（体の高さは動きのためのもので、見た目よりずっと高い）
    if (this.kind === 'assault') return ASSAULT_HEIGHT + 0.25;
    return this.height + (this.downedShown ? -0.5 : 0.35);
  }

  /** タワーディフェンスの名札の中身（体力・ダウン） */
  updateTdTag(e: Entity) {
    if (this.tagHp) {
      const k = Math.max(0, Math.min(1, e.health / e.maxHealth));
      this.tagHp.style.transform = `scaleX(${k.toFixed(3)})`;
      if (!this.ally) this.tag.classList.toggle('hurt', k < 0.999);
    }
    const state = e.downed > 0 ? (e.reviverId >= 0 && e.reviveProgress > 0 ? 'reviving' : 'downed') : '';
    if (state !== this.tagState) {
      this.tagState = state;
      this.tag.classList.toggle('downed', !!state);
      this.tag.classList.toggle('reviving', state === 'reviving');
    }
    if (this.tagDown && state) this.tagDown.textContent = state === 'reviving' ? '蘇生中' : `${e.downed.toFixed(1)}`;
  }

  /** 消え終わった */
  get gone(): boolean {
    if (this.holo) return this.deadTime >= 0.3;
    return this.deadTime >= DEATH_HOLD + DISSOLVE_TIME + 0.1;
  }

  dispose() {
    this.view.dispose();
    for (const m of this.materials) m.dispose();
    this.ghostMat?.dispose();
    this.outlineMat?.dispose();
    this.tag.remove();
    this.outer.removeFromParent();
  }
}

export class ActorViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, ActorView>();
  private readonly templates = new Map<CharacterId | 'grunt' | 'assault' | 'heavy' | 'mortar', ActorTemplate>();
  /** 三人称で持たせる武器（武器の種類とカスタマイズの組み合わせごとに作り置き） */
  private readonly weaponCache = new Map<string, THREE.Object3D>();
  private readonly assets: Assets;

  /** サイト・アタッチメントを付けて、1 つの形にまとめた武器 */
  private weaponFor(id: WeaponId, custom: WeaponCustom): THREE.Object3D {
    const key = `${id}|${customKey(custom)}`;
    let w = this.weaponCache.get(key);
    if (!w) {
      const m = this.assets.weapons[id].clone(true);
      applyWeaponMods(m, id, custom, this.assets.weaponParts);
      w = mergeWeapon(m, this.assets.weaponLods[id]);
      this.weaponCache.set(key, w);
    }
    return w;
  }
  private readonly tagLayer: HTMLElement;
  private readonly tmp = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly proj = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();

  constructor(
    assets: Assets,
    readonly playerTeam: number,
    private readonly opts: ActorViewsOptions = {},
  ) {
    for (const id of CHARACTER_IDS) this.templates.set(id, new ActorTemplate(assets.characters[id], assets.characterLods[id]));
    this.templates.set('grunt', new ActorTemplate(assets.grunt, assets.gruntLod));
    if (opts.td) {
      this.templates.set('assault', new ActorTemplate(opts.td.assault, opts.td.assaultLod));
      this.templates.set('heavy', new ActorTemplate(opts.td.heavy, opts.td.heavyLod));
      this.templates.set('mortar', new ActorTemplate(opts.td.mortar, opts.td.mortarLod));
    }
    this.assets = assets;
    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'actor-tags';
    document.getElementById('hud')!.appendChild(this.tagLayer);
  }

  /**
   * シェーダーの準備用：キャラクターの種類ごとに、味方と敵の表示を1つずつ作る。
   * 試合の途中で初めて画面に出たときにシェーダーを作ると、その瞬間に画面が止まるので、読み込みのときに作っておく
   */
  warmObjects(): THREE.Object3D[] {
    const vs: ActorView[] = [];
    let id = -1000;
    for (const [key, tpl] of this.templates) {
      const kind: ActorKind = key === 'grunt' || key === 'assault' || key === 'heavy' || key === 'mortar' ? key : 'pilot';
      const character = (kind === 'pilot' ? key : 'meia') as CharacterId;
      for (const ally of [true, false]) {
        const v = new ActorView(id--, kind, character, ally ? this.playerTeam : this.playerTeam + 1, ally, '', tpl, this.tagLayer, !!this.opts.td);
        // サイトを付けた武器も、シェーダーを作っておく
        v.setWeapon('ar|warm', this.weaponFor('ar', { sight: 'holo', attachments: ['suppressor', 'laser'] }));
        if (!ally) v.setGhost(true);
        v.tag.remove();
        // 遠く用の体・武器も作るように、すべての部品を見える状態にしておく（入れ物ごと隠すので画面には出ない）
        v.outer.traverse((o) => (o.visible = true));
        vs.push(v);
      }
    }
    return vs.map((v) => v.outer);
  }

  /** スレットスコープをのぞいている（Game が毎フレーム決める） */
  threatScope = false;
  private readonly losCache = new Map<number, { t: number; vis: boolean }>();
  private readonly losDir = new THREE.Vector3();

  /** カメラから参加者の胸まで、間に壁がないか（0.1 秒ごとに調べ直す） */
  private inSight(id: number, sim: Simulation, cam: THREE.Vector3, pos: THREE.Vector3, dt: number): boolean {
    let c = this.losCache.get(id);
    if (!c) this.losCache.set(id, (c = { t: 0, vis: false }));
    c.t -= dt;
    if (c.t > 0) return c.vis;
    c.t = 0.1;
    const d = this.losDir.set(pos.x - cam.x, pos.y + 1.2 - cam.y, pos.z - cam.z);
    const len = d.length();
    if (len > 170) return (c.vis = false);
    d.divideScalar(len);
    c.vis = !sim.world.raycast({ x: cam.x, y: cam.y, z: cam.z }, { x: d.x, y: d.y, z: d.z }, Math.max(0, len - 0.4));
    return c.vis;
  }

  get(id: number): ActorView | undefined {
    return this.views.get(id);
  }

  /** シミュレーションの参加者と表示を合わせる（増えた参加者の表示を作る） */
  sync(sim: Simulation, playerId: number): void {
    for (const e of sim.entities.values()) {
      if (e.id === playerId || this.views.has(e.id) || !ACTOR_KINDS.has(e.kind)) continue;
      const kind = (e.kind === 'holo' ? 'pilot' : e.kind) as ActorKind;
      const tpl = this.templates.get(kind === 'pilot' ? e.character : kind) ?? this.templates.get('grunt')!;
      const v = new ActorView(e.id, kind, e.character, e.team, e.team === this.playerTeam, e.name, tpl, this.tagLayer, !!this.opts.td);
      v.holo = e.kind === 'holo';
      v.prev.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
      v.cur.copy(v.prev);
      v.bodyYaw = e.lastCmd.yaw;
      this.views.set(e.id, v);
      this.group.add(v.outer);
    }
  }

  /** 1ティックごと：位置を記録し、射撃などの出来事に合わせて動かす */
  afterTick(sim: Simulation): void {
    for (const [id, v] of this.views) {
      const e = sim.entities.get(id);
      if (!e) continue;
      v.prev.copy(v.cur);
      v.cur.set(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
      if (e.movement.events.some((x) => x.type === 'respawn')) v.prev.copy(v.cur);
      if (!e.dead && e.downed <= 0) {
        const w = activeSlot(e.arsenal).id;
        const slot = activeSlot(e.arsenal);
        const key = `${w}|${customKey(slot.custom)}`;
        // 爆弾兵（クモ型のロボット）は銃を持たない
        if (key !== v.weaponKey && v.kind !== 'assault') v.setWeapon(key, this.weaponFor(w, slot.custom));
      }
      for (const ev of e.arsenal.events) {
        if (ev.type === 'shot' && sim.time - v.lastShootAnim > 0.18) {
          v.lastShootAnim = sim.time;
          v.view.playOnce('Shoot');
        }
      }
      if (e.abilityEvents.some((x) => x.type === 'abilityUsed')) v.view.playOnce('Ability');
    }
    for (const ev of sim.events) {
      if (ev.type === 'playerRespawn') {
        const v = this.views.get(ev.entityId);
        if (v) {
          v.prev.set(ev.pos.x, ev.pos.y, ev.pos.z);
          v.cur.copy(v.prev);
          v.bodyYaw = ev.yaw;
        }
      }
      if (ev.type === 'playerDamaged') {
        const v = this.views.get(ev.entityId);
        if (v) v.hit = Math.min(1, v.hit + 0.6);
      }
    }
  }

  /** 銃口の位置（表示上） */
  muzzleOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(id);
    if (!v) return null;
    return v.view.muzzleWorld(out);
  }

  update(dt: number, alpha: number, sim: Simulation, camera: THREE.Camera, width: number, height: number): void {
    const camPos = camera.getWorldPosition(this.camPos);
    camera.updateMatrixWorld();
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj);
    for (const [id, v] of this.views) {
      const e = sim.entities.get(id);
      this.sphere.center.set(v.cur.x, v.cur.y + 1, v.cur.z);
      this.sphere.radius = 1.6;
      const visible = this.frustum.intersectsSphere(this.sphere);
      v.tick(dt, e, alpha, visible, this.sphere.center.distanceTo(camPos));
      // 取り除かれた歩兵は、消え終わったら片付ける
      if (!e && v.gone) {
        v.dispose();
        this.views.delete(id);
        continue;
      }
      // 敵：ソナーで見えている間は壁越しの影
      // スレットスコープ：のぞいている間、見えている（間に壁のない）敵も同じ赤い影で浮かび上がらせる
      if (e && !v.ally) {
        const sonar = !e.dead && e.revealed > 0 && e.revealDelay <= 0;
        const threat = this.threatScope && !e.dead && visible && this.inSight(id, sim, camPos, v.cur, dt);
        v.setGhost(sonar || threat);
      }
      this.updateTag(v, e, sim, camPos, camera, dt, width, height);
    }
  }

  private updateTag(v: ActorView, e: Entity | undefined, sim: Simulation, camPos: THREE.Vector3, camera: THREE.Camera, dt: number, width: number, height: number) {
    // 味方のホロパイロットには名札を出さない（敵には、本物と同じ名札が見える）
    let show = !!e && !e.dead && v.deadTime < 0 && !(v.holo && v.ally);
    const p = this.tmp.set(v.outer.position.x, v.outer.position.y + v.headY, v.outer.position.z);
    const dist = p.distanceTo(camPos);
    if (show && e) {
      if (v.ally) show = dist < (v.td ? 400 : 120);
      else {
        // 敵は、見えているときだけ（壁越しには出さない。ソナーで見えている間は出す）
        v.losTimer -= dt;
        if (v.losTimer <= 0) {
          v.losTimer = 0.15;
          const to = p.clone().sub(camPos);
          const L = to.length();
          v.los = !sim.world.raycast(camPos, to.divideScalar(L), L - 0.6) && !sim.smokeBlocks(camPos, p);
        }
        const revealed = e.revealed > 0 && e.revealDelay <= 0;
        show = (v.los && dist < (v.kind !== 'pilot' ? (v.td ? 45 : 30) : 55) && !isCloaked(e.ability) && !isPhased(e.ability)) || revealed;
      }
    }
    if (show) {
      p.project(camera);
      if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) show = false;
    }
    if (show !== v.tagVisible) {
      v.tagVisible = show;
      v.tag.style.display = show ? 'flex' : 'none';
    }
    if (!show) return;
    if (v.td && e) v.updateTdTag(e);
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    v.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    v.tag.style.opacity = v.td && v.ally ? '1' : String(Math.max(0.35, Math.min(1, 1.25 - dist / 90)));
  }

  /** 全部の名札を隠す（メニューを開いたときなど） */
  setTagsVisible(on: boolean): void {
    this.tagLayer.style.display = on ? '' : 'none';
  }

  dispose(): void {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.tagLayer.remove();
    this.group.removeFromParent();
  }
}
