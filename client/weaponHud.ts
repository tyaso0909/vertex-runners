/**
 * 武器まわりの HUD：照準（ばらつきに合わせて広がる）、ヒットマーカー、ダメージの数字、
 * スコープ、弾数、持っている武器、リロードの案内。
 */
import { slotDef } from '../shared/weaponCustom';
import * as THREE from 'three';
import { WEAPON_CLASS_LABEL, type WeaponId, type WeaponsConfig, classOf, grenadesConfig } from '../config';
import { grenadeCount, grenadeRegenTime } from '../shared/grenades';
import { grenadeSvg } from './ui/grenadeIcons';
import { GRENADE_COLORS } from './weapons/grenadeView';
import type { Arsenal } from '../shared/weapons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const CROSSHAIR_TYPE: Record<WeaponId, string> = {
  ar: 'cross',
  burst: 'cross',
  smg: 'cross',
  psmg: 'cross',
  lmg: 'cross',
  spinlmg: 'cross',
  shotgun: 'circle',
  autosg: 'circle',
  sniper: 'dot',
  marksman: 'cross',
  pistol: 'cross',
  revolver: 'cross',
};

interface DamageNumber {
  el: HTMLElement;
  world: THREE.Vector3;
  age: number;
}

export class WeaponHud {
  private crosshair = $('crosshair');
  private hitmarker = $('hitmarker');
  private scope = $('scope');
  private dmgLayer = $('damage-numbers');
  private slotEls = [$('slot-0'), $('slot-1')];
  private nameEl = $('weapon-name');
  private briefEl = $('weapon-brief');
  private shownWeapon = '';
  private briefTimer = 0;
  private magEl = $('ammo-mag');
  private resEl = $('ammo-res');
  private magBar = $('mag-bar');
  private reloadEl = $('reload-state');
  private hintEl = $('ammo-hint');
  private pipsEl = $('grenade-pips');
  private gIconEl = $('grenade-icon');
  private gItemEl = $('grenade-item');
  private gDetEl = $('grenade-det');
  private lastGKind = '';
  private meleeEl = $('melee-ready');
  private lastPips = '';
  private numbers: DamageNumber[] = [];
  private lastMagKey = '';
  private hitTimer: number | undefined;

  constructor(private readonly cfg: WeaponsConfig) {}

  /** 弾が当たったときの印。head＝ヘッドショット、kill＝撃破 */
  hit(head: boolean, kill: boolean): void {
    const el = this.hitmarker;
    el.classList.remove('show', 'head', 'kill');
    void el.offsetWidth; // アニメーションを最初からやり直す
    el.classList.add('show');
    if (head) el.classList.add('head');
    if (kill) el.classList.add('kill');
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => el.classList.remove('show', 'head', 'kill'), 260);
  }

  damageNumber(world: THREE.Vector3, amount: number, head: boolean): void {
    const el = document.createElement('div');
    el.className = 'dmg' + (head ? ' head' : '');
    el.textContent = String(Math.round(amount));
    this.dmgLayer.appendChild(el);
    this.numbers.push({ el, world: world.clone(), age: 0 });
    if (this.numbers.length > 24) this.numbers.shift()!.el.remove();
  }

  update(dt: number, a: Arsenal, spreadDeg: number, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const slot = a.slots[a.active];
    const w = slotDef(this.cfg, slot);

    // 照準：ばらつきの角度を画面上の大きさに直す
    const px = (Math.tan((spreadDeg * Math.PI) / 180) / Math.tan(((camera.fov / 2) * Math.PI) / 180)) * (height / 2);
    this.crosshair.dataset.type = CROSSHAIR_TYPE[slot.id];
    this.crosshair.style.setProperty('--gap', `${Math.max(3, Math.min(px, height * 0.4)).toFixed(1)}px`);
    const hideCross = a.ads > 0.55 || a.swapTimer > 0 || a.cooking;
    this.crosshair.style.opacity = hideCross ? '0' : '1';

    // スコープ
    const scoped = !!w.SCOPE && a.ads > 0.92;
    this.scope.classList.toggle('show', scoped);

    // 武器の欄
    this.slotEls.forEach((el, i) => {
      el.classList.toggle('active', i === a.active);
      el.querySelector('b')!.textContent = this.cfg[a.slots[i].id].SHORT;
    });
    // 武器名と武器種。持ち替えたとき・出たときは、一言の説明を少しの間出す
    if (slot.id !== this.shownWeapon) {
      this.shownWeapon = slot.id;
      this.nameEl.innerHTML = '';
      this.nameEl.append(w.NAME);
      const cls = document.createElement('small');
      cls.textContent = WEAPON_CLASS_LABEL[classOf(slot.id, this.cfg)].name;
      this.nameEl.append(cls);
      this.briefEl.textContent = w.BRIEF;
      this.briefTimer = 3.2;
    }
    this.briefTimer = Math.max(0, this.briefTimer - dt);
    this.briefEl.classList.toggle('show', this.briefTimer > 0);
    this.magEl.textContent = String(slot.ammo);
    const infinite = !!this.cfg.COMMON.INFINITE_RESERVE;
    this.resEl.textContent = infinite ? '∞' : String(slot.reserve);
    this.resEl.classList.toggle('infinite', infinite);

    // グレネードの種類と所持数（回復中の1つは、たまり具合を表示）
    const c = this.cfg.COMMON;
    const kind = a.grenadeKind;
    if (kind !== this.lastGKind) {
      this.lastGKind = kind;
      this.gIconEl.innerHTML = grenadeSvg(kind);
      this.gItemEl.title = grenadesConfig[kind].NAME;
      this.gItemEl.style.setProperty('--gcol', GRENADE_COLORS[kind]);
    }
    // サッチェルを置いてあれば「起爆」
    this.gItemEl.classList.toggle('armed', kind === 'satchel' && a.satchelsOut > 0);
    this.gDetEl.textContent = a.satchelsOut > 1 ? `起爆 ×${a.satchelsOut}` : '起爆';
    const regen = grenadeRegenTime(kind, c);
    const count = grenadeCount(kind, c);
    const charge = regen > 0 ? a.grenadeRegen / regen : 0;
    const pipsKey = `${a.grenades}:${count}:${Math.round(charge * 20)}`;
    if (pipsKey !== this.lastPips) {
      this.lastPips = pipsKey;
      this.pipsEl.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const pip = document.createElement('i');
        if (i < a.grenades) pip.className = 'on';
        else if (i === a.grenades && charge > 0) {
          pip.className = 'charging';
          pip.style.setProperty('--p', charge.toFixed(2));
        }
        this.pipsEl.appendChild(pip);
      }
    }
    this.meleeEl.classList.toggle('cooldown', a.meleeCooldown > 0);
    const low = slot.ammo <= Math.ceil(w.MAG_SIZE * 0.25);
    this.magEl.classList.toggle('low', low);
    // 弾倉の残りを目盛りで（弾数が多い武器はまとめる）
    const ticks = Math.min(w.MAG_SIZE, 40);
    const filled = Math.ceil((slot.ammo / w.MAG_SIZE) * ticks);
    const key = `${slot.id}:${filled}`;
    if (key !== this.lastMagKey) {
      this.lastMagKey = key;
      this.magBar.innerHTML = '';
      for (let i = 0; i < ticks; i++) {
        const t = document.createElement('i');
        if (i < filled) t.className = 'on';
        this.magBar.appendChild(t);
      }
    }
    // リロード
    if (a.reloading) {
      const total = w.RELOAD_PER_SHELL ? w.RELOAD_TIME : w.RELOAD_TIME;
      const p = w.RELOAD_PER_SHELL ? 1 - Math.max(0, a.reloadTimer) / (total + w.RELOAD_START_DELAY) : 1 - a.reloadTimer / total;
      this.reloadEl.textContent = w.RELOAD_PER_SHELL ? '装填中' : 'リロード中';
      this.reloadEl.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
      this.reloadEl.classList.add('show');
    } else {
      this.reloadEl.classList.remove('show');
    }
    let hint = '';
    if (!a.reloading && slot.ammo === 0 && slot.reserve === 0 && !infinite) hint = '弾切れ ― 弾薬補給所へ';
    else if (!a.reloading && low && (infinite || slot.reserve > 0)) hint = 'R でリロード';
    if (a.cooking) hint = '離して投げる';
    this.hintEl.textContent = hint;
    this.hintEl.classList.toggle('show', !!hint && !scoped);

    // ダメージの数字（当たった場所から浮き上がる）
    const v = new THREE.Vector3();
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.age += dt;
      if (n.age > 0.9) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      v.copy(n.world);
      v.y += n.age * 0.9;
      v.project(camera);
      if (v.z > 1) {
        n.el.style.opacity = '0';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${(1 + Math.max(0, 0.15 - n.age) * 3).toFixed(2)})`;
      n.el.style.opacity = String(Math.min(1, (0.9 - n.age) * 4));
    }
  }
}
