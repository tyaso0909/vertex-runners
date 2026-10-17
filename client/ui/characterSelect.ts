/**
 * キャラクター選択。6人のカード、選んだキャラクターの説明（アビリティ・パッシブ）、
 * 3D モデルのプレビュー（回転・アニメーションの切り替え）を出す。
 * 開始画面と一時停止画面の両方で同じ部品を使う（表示する場所に付け替える）。
 */
import * as THREE from 'three';
import { CHARACTER_IDS, type CharacterId, type CharactersConfig, type WeaponId } from '../../config';
import type { Assets } from '../assets';
import { CHARACTER_ANIMS, type CharacterAnim, CharacterView } from '../characters/characterView';
import { PORTRAITS } from './portraits';
import type { WeaponCustom } from '../../shared/weaponCustom';
import { applyWeaponMods } from '../weapons/weaponMods';

const ANIM_LABEL: Record<CharacterAnim, string> = {
  Idle: '待機',
  Run: '走り',
  WallRun: '壁走り',
  Slide: 'スライド',
  Jump: 'ジャンプ',
  Shoot: '射撃',
  Ability: 'アビリティ',
  Death: '倒れる',
  Crouch: 'しゃがみ',
};

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export class CharacterSelect {
  readonly el: HTMLElement;
  private readonly cards = new Map<CharacterId, HTMLButtonElement>();
  private readonly nameEl: HTMLElement;
  private readonly roleEl: HTMLElement;
  private readonly abilityEl: HTMLElement;
  private readonly passiveEl: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly animBar: HTMLElement;
  private selected: CharacterId;
  onChange: (id: CharacterId) => void = () => {};

  // 3D プレビュー
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
  private views = new Map<CharacterId, CharacterView>();
  private assets: Assets | null = null;
  private weapon: WeaponId = 'ar';
  private custom: WeaponCustom | null = null;
  private spin = 0.5;
  private spinVel = 0;
  private dragging = false;
  private lastX = 0;
  private autoAnim = 0;
  private anim: CharacterAnim = 'Idle';
  private running = false;
  private last = 0;
  private readonly spot: THREE.Mesh;

  constructor(
    private readonly ccfg: CharactersConfig,
    initial: CharacterId,
  ) {
    this.selected = initial;
    this.el = h('div', 'charsel');
    const grid = h('div', 'charsel-grid', this.el);
    const order = [...CHARACTER_IDS].sort((a, b) => ccfg[a].ORDER - ccfg[b].ORDER);
    for (const id of order) {
      const def = ccfg[id];
      const b = h('button', 'charsel-card', grid);
      b.type = 'button';
      b.style.setProperty('--char', def.COLOR);
      const img = h('img', '', b);
      img.src = PORTRAITS[id];
      img.alt = def.NAME;
      img.draggable = false;
      const cap = h('span', 'cap', b);
      h('b', '', cap, def.NAME);
      h('small', '', cap, def.ROLE);
      b.addEventListener('click', () => this.select(id));
      this.cards.set(id, b);
    }

    const detail = h('div', 'charsel-detail', this.el);
    this.viewport = h('div', 'charsel-view', detail);
    this.animBar = h('div', 'charsel-anims', this.viewport);
    for (const a of CHARACTER_ANIMS) {
      const b = h('button', '', this.animBar, ANIM_LABEL[a]);
      b.type = 'button';
      b.dataset.anim = a;
      b.addEventListener('click', () => this.setAnim(a, true));
    }
    const info = h('div', 'charsel-info', detail);
    const head = h('div', 'charsel-head', info);
    this.nameEl = h('div', 'charsel-name', head);
    this.roleEl = h('div', 'charsel-role', head);
    this.abilityEl = h('div', 'charsel-skill skill-ability', info);
    this.passiveEl = h('div', 'charsel-skill skill-passive', info);

    // プレビューのシーン
    this.scene.add(new THREE.HemisphereLight('#b9a2ff', '#1a1028', 1.2));
    const key = new THREE.DirectionalLight('#ffd8c0', 2.4);
    key.position.set(2, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#4fd1ff', 2.0);
    rim.position.set(-3, 2, -3);
    this.scene.add(rim);
    this.spot = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#2a1850', transparent: true, opacity: 0.85 }),
    );
    this.scene.add(this.spot);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.74, 0.78, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#8a5cff', transparent: true, opacity: 0.8 }),
    );
    ring.position.y = 0.002;
    this.spot.add(ring);
    // 足元が下のボタンに隠れないよう、少し引いて低い所を見る
    this.camera.position.set(0, 1.1, 5.2);
    this.camera.lookAt(0, 0.72, 0);

    this.viewport.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.viewport.setPointerCapture(e.pointerId);
    });
    this.viewport.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.spin += dx * 0.012;
      this.spinVel = dx * 0.6;
    });
    this.viewport.addEventListener('pointerup', () => (this.dragging = false));
    this.viewport.addEventListener('pointercancel', () => (this.dragging = false));

    this.refresh();
  }

  /** モデルの読み込みが終わったら呼ぶ（3D プレビューを始める） */
  setAssets(assets: Assets): void {
    this.assets = assets;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.viewport.prepend(this.renderer.domElement);
    } catch {
      this.renderer = null; // プレビューなしでも選べる
    }
    this.showModel();
    this.start();
  }

  /** 手に持たせる武器（サイト・アタッチメントも付ける） */
  setWeapon(id: WeaponId, custom: WeaponCustom | null = null): void {
    this.weapon = id;
    this.custom = custom;
    for (const v of this.views.values()) v.setWeapon(this.weaponModel(), true);
  }

  private weaponModel(): THREE.Object3D | null {
    if (!this.assets) return null;
    const m = this.assets.weapons[this.weapon].clone(true);
    if (this.custom) applyWeaponMods(m, this.weapon, this.custom, this.assets.weaponParts);
    return m;
  }

  get value(): CharacterId {
    return this.selected;
  }

  select(id: CharacterId, notify = true): void {
    if (id === this.selected && notify) {
      this.setAnim('Ability', true);
      return;
    }
    this.selected = id;
    this.refresh();
    this.showModel();
    this.setAnim('Ability', true);
    if (notify) this.onChange(id);
  }

  /** 画面のどこに出すか（開始画面・一時停止画面） */
  mount(parent: HTMLElement): void {
    if (this.el.parentElement !== parent) parent.appendChild(this.el);
    this.start();
  }

  private refresh() {
    const def = this.ccfg[this.selected];
    for (const [id, b] of this.cards) b.classList.toggle('selected', id === this.selected);
    this.el.style.setProperty('--char', def.COLOR);
    this.nameEl.textContent = def.NAME;
    this.roleEl.textContent = def.ROLE;
    const a = def.ABILITY;
    this.abilityEl.innerHTML = '';
    const at = h('div', 'skill-title', this.abilityEl);
    h('kbd', '', at, 'Q');
    h('b', '', at, a.NAME);
    h('span', 'cd', at, `クールダウン ${a.COOLDOWN}秒`);
    h('p', '', this.abilityEl, a.DESC);
    this.passiveEl.innerHTML = '';
    const pt = h('div', 'skill-title', this.passiveEl);
    h('span', 'tag', pt, 'パッシブ');
    h('b', '', pt, def.PASSIVE.NAME);
    h('p', '', this.passiveEl, def.PASSIVE.DESC);
  }

  private showModel() {
    if (!this.assets) return;
    for (const v of this.views.values()) v.root.visible = false;
    let view = this.views.get(this.selected);
    if (!view) {
      view = new CharacterView(this.assets.characters[this.selected]);
      view.setWeapon(this.weaponModel(), true);
      this.scene.add(view.root);
      this.views.set(this.selected, view);
    }
    view.root.visible = true;
    view.play(this.anim, 0);
  }

  private setAnim(a: CharacterAnim, manual: boolean) {
    const view = this.views.get(this.selected);
    if (manual) this.autoAnim = 6; // しばらく自動で切り替えない
    if (a !== 'Shoot' && a !== 'Ability') this.anim = a;
    view?.play(a);
    for (const b of this.animBar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.anim === this.anim);
  }

  private start() {
    if (this.running || !this.renderer) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      // 画面に出ていないときは止める
      if (!this.el.isConnected || this.el.offsetParent === null) {
        this.running = false;
        return;
      }
      const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
      this.last = now;
      this.render(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private render(dt: number) {
    const r = this.renderer;
    if (!r) return;
    const w = this.viewport.clientWidth;
    const hgt = this.viewport.clientHeight;
    if (w < 2 || hgt < 2) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== hgt) {
      r.setSize(w, hgt, false);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    if (!this.dragging) {
      this.spinVel *= Math.exp(-dt * 3);
      this.spin += (0.35 + this.spinVel * 0.02) * dt;
    }
    // しばらく触っていなければ、待機と走りを交互に見せる
    this.autoAnim -= dt;
    if (this.autoAnim <= 0) {
      this.autoAnim = 4;
      this.setAnim(this.anim === 'Idle' ? 'Run' : 'Idle', false);
    }
    const view = this.views.get(this.selected);
    if (view) {
      view.root.rotation.y = this.spin;
      view.update(dt);
    }
    r.render(this.scene, this.camera);
  }
}
