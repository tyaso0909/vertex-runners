/**
 * 体力とアビリティまわりの HUD。
 * - 左下：キャラクターの顔、アビリティのアイコン（Q）とクールダウン、ブーストのゲージ（X。消耗戦）、体力ゲージ（仕様 7.3）。アーマーがあれば体力の上に装甲のゲージ
 * - 画面中央のまわり：ダメージを受けた方向を示す赤い弧
 * - 画面の縁：被弾（赤）、狙われている（紫・蘭丸のパッシブ）、オーバードライブ（青）、光学迷彩（青緑）
 * - 倒されたとき：復活までの残り時間
 */
import type { AbilityType, BoostId, CharacterId, CharactersConfig } from '../config';
import { boostSvg } from './ui/boostIcons';
import type { Entity } from '../shared/simulation';
import { PORTRAITS } from './ui/portraits';

const ICONS: Record<AbilityType, string> = {
  // 24×24 の簡単な線画
  grapple: '<path d="M4 20 L15 9" /><path d="M13 5 l6 0 l0 6" /><circle cx="4" cy="20" r="2" />',
  cloak: '<path d="M12 3 C6 6 5 12 6 21 L12 17 L18 21 C19 12 18 6 12 3Z" /><circle cx="10" cy="10" r="1" /><circle cx="14" cy="10" r="1" />',
  shield: '<path d="M3 7 h18 v10 h-18Z" /><path d="M7 7 v10 M12 7 v10 M17 7 v10" />',
  sonar: '<circle cx="12" cy="12" r="2" /><path d="M7 7 a7 7 0 0 0 0 10 M17 7 a7 7 0 0 1 0 10" /><path d="M4 4 a11.5 11.5 0 0 0 0 16 M20 4 a11.5 11.5 0 0 1 0 16" />',
  overdrive: '<path d="M14 2 L6 13 h5 l-2 9 l8 -12 h-5Z" />',
  phase: '<path d="M12 2 L20 12 L12 22 L4 12Z" /><path d="M12 7 L16 12 L12 17 L8 12Z" />',
};

interface DamageArc {
  el: HTMLElement;
  /** 世界での向き（ダメージの来た方向の角度） */
  worldAngle: number;
  life: number;
}

function el(tag: string, cls: string, parent: HTMLElement, html = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export class VitalsHud {
  private readonly root: HTMLElement;
  private readonly abilityBox: HTMLElement;
  private readonly portrait: HTMLImageElement;
  private readonly abilityIcon: HTMLElement;
  private readonly abilityRing: SVGCircleElement;
  private readonly abilityTime: HTMLElement;
  private readonly abilityName: HTMLElement;
  private readonly abilityActive: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpLag: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly armorBar: HTMLElement;
  private readonly armorFill: HTMLElement;
  private armorShown = 0;
  private readonly boostBox: HTMLElement;
  private readonly boostRing: SVGCircleElement;
  private readonly boostIcon: HTMLElement;
  private readonly boostPct: HTMLElement;
  private readonly boostName: HTMLElement;
  private boostId: BoostId | null = null;
  private boostWasReady = false;
  private boostShown = false;
  private readonly charName: HTMLElement;
  private readonly arcs: HTMLElement;
  private readonly hurt: HTMLElement;
  private readonly aimed: HTMLElement;
  private readonly overdrive: HTMLElement;
  private readonly cloak: HTMLElement;
  private readonly death: HTMLElement;
  private readonly deathTime: HTMLElement;
  private arcList: DamageArc[] = [];
  private hurtK = 0;
  private aimedK = 0;
  private lagHealth = 100;
  private lagHold = 0;
  private wasReady = true;
  private char: CharacterId | null = null;
  onAbilityReady: () => void = () => {};

  constructor(
    hud: HTMLElement,
    private readonly ccfg: CharactersConfig,
  ) {
    // 画面の縁の光（下に重ねる順）
    this.hurt = el('div', 'edge-fx edge-hurt', hud);
    this.aimed = el('div', 'edge-fx edge-aimed', hud);
    this.overdrive = el('div', 'edge-fx edge-overdrive', hud);
    this.cloak = el('div', 'edge-fx edge-cloak', hud);
    this.arcs = el('div', 'damage-arcs', hud);

    this.root = el('div', 'vitals', hud);
    this.portrait = el('img', 'vitals-portrait', this.root) as HTMLImageElement;
    this.abilityBox = el('div', 'ability', this.root);
    const ring = el(
      'div',
      'ability-ring',
      this.abilityBox,
      '<svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="29" /><circle class="fg" cx="32" cy="32" r="29" /></svg>',
    );
    this.abilityRing = ring.querySelector('circle.fg') as SVGCircleElement;
    this.abilityIcon = el('div', 'ability-icon', this.abilityBox);
    this.abilityTime = el('div', 'ability-time', this.abilityBox);
    el('kbd', 'ability-key', this.abilityBox, 'Q');
    this.abilityActive = el('div', 'ability-active', this.abilityBox);

    // ブースト（消耗戦だけ出す）
    this.boostBox = el('div', 'boost hidden', this.root);
    const bring = el(
      'div',
      'boost-ring',
      this.boostBox,
      '<svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="29" /><circle class="fg" cx="32" cy="32" r="29" /></svg>',
    );
    this.boostRing = bring.querySelector('circle.fg') as SVGCircleElement;
    this.boostIcon = el('div', 'boost-icon', this.boostBox);
    this.boostPct = el('div', 'boost-pct', this.boostBox);
    el('kbd', 'boost-key', this.boostBox, 'X');
    this.boostName = el('div', 'boost-name', this.boostBox);

    const right = el('div', 'vitals-main', this.root);
    const top = el('div', 'vitals-top', right);
    this.charName = el('span', 'vitals-char', top);
    this.abilityName = el('span', 'vitals-ability', top);
    this.armorBar = el('div', 'armor-bar hidden', right);
    this.armorFill = el('div', 'armor-fill', this.armorBar);
    for (let i = 1; i < 5; i++) el('i', 'hp-tick', this.armorBar).style.left = `${i * 20}%`;
    const bar = el('div', 'hp-bar', right);
    this.hpLag = el('div', 'hp-lag', bar);
    this.hpFill = el('div', 'hp-fill', bar);
    for (let i = 1; i < 4; i++) el('i', 'hp-tick', bar).style.left = `${i * 25}%`;
    this.hpText = el('div', 'hp-text', right);

    this.death = el('div', 'death hidden', hud);
    el('div', 'death-title', this.death, '倒されました');
    this.deathTime = el('div', 'death-time', this.death);
  }

  private setCharacter(id: CharacterId) {
    this.char = id;
    const def = this.ccfg[id];
    this.root.style.setProperty('--char', def.COLOR);
    this.portrait.src = PORTRAITS[id];
    this.abilityIcon.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[def.ABILITY.TYPE]}</svg>`;
    this.charName.textContent = def.NAME;
    this.abilityName.textContent = def.ABILITY.NAME;
  }

  /** ブーストのゲージ（null なら隠す。消耗戦だけ） */
  setBoost(b: { id: BoostId; name: string; frac: number; ready: boolean } | null): void {
    if (!b) {
      if (this.boostShown) this.boostBox.classList.add('hidden');
      this.boostShown = false;
      return;
    }
    if (!this.boostShown) this.boostBox.classList.remove('hidden');
    this.boostShown = true;
    if (b.id !== this.boostId) {
      this.boostId = b.id;
      this.boostIcon.innerHTML = boostSvg(b.id);
      this.boostName.textContent = b.name;
    }
    const C = 2 * Math.PI * 29;
    this.boostRing.style.strokeDasharray = `${C}`;
    this.boostRing.style.strokeDashoffset = `${C * (1 - b.frac)}`;
    const pct = b.ready ? '' : `${Math.floor(b.frac * 100)}%`;
    if (this.boostPct.textContent !== pct) this.boostPct.textContent = pct;
    this.boostBox.classList.toggle('ready', b.ready);
    if (b.ready && !this.boostWasReady) {
      this.boostBox.classList.remove('flash');
      void this.boostBox.offsetWidth;
      this.boostBox.classList.add('flash');
    }
    this.boostWasReady = b.ready;
  }

  /** ダメージを受けた。from は撃ってきた位置、yaw は今の視線の向き */
  damage(amount: number, from: { x: number; z: number }, me: { x: number; z: number }): void {
    this.hurtK = Math.min(1, this.hurtK + 0.25 + amount / 40);
    this.lagHold = 0.5;
    const dx = from.x - me.x;
    const dz = from.z - me.z;
    if (Math.hypot(dx, dz) < 0.3) return; // 足元からのダメージは方向を出さない
    const worldAngle = Math.atan2(-dx, -dz); // 視線の yaw と同じ決め方
    // 同じ方向からの連続した被弾は1つの弧にまとめる
    const near = this.arcList.find((a) => Math.abs(Math.atan2(Math.sin(a.worldAngle - worldAngle), Math.cos(a.worldAngle - worldAngle))) < 0.35);
    if (near) {
      near.life = 1.6;
      near.worldAngle = worldAngle;
      return;
    }
    const a = el('div', 'damage-arc', this.arcs);
    this.arcList.push({ el: a, worldAngle, life: 1.6 });
  }

  update(dt: number, e: Entity, yaw: number): void {
    if (e.character !== this.char) this.setCharacter(e.character);
    const def = this.ccfg[e.character];
    const ab = e.ability;

    // --- アビリティ ---
    const cd = def.ABILITY.COOLDOWN;
    const ready = ab.cooldown <= 0;
    const frac = ready ? 1 : 1 - ab.cooldown / cd;
    const C = 2 * Math.PI * 29;
    this.abilityRing.style.strokeDasharray = `${C}`;
    this.abilityRing.style.strokeDashoffset = `${C * (1 - frac)}`;
    this.abilityBox.classList.toggle('ready', ready);
    this.abilityTime.textContent = ready ? '' : ab.cooldown >= 10 ? ab.cooldown.toFixed(0) : ab.cooldown.toFixed(1);
    if (ready && !this.wasReady) {
      this.abilityBox.classList.remove('flash');
      void this.abilityBox.offsetWidth; // アニメーションをやり直す
      this.abilityBox.classList.add('flash');
      this.onAbilityReady();
    }
    this.wasReady = ready;
    // 効いている時間（迷彩・オーバードライブ・フェイズ・シールド）
    let active = 0;
    const A = def.ABILITY;
    if (ab.cloak > 0) active = ab.cloak / (A.DURATION as number);
    else if (ab.overdrive > 0) active = ab.overdrive / (A.DURATION as number);
    else if (ab.phase > 0) active = ab.phase / (A.DURATION as number);
    this.abilityActive.style.transform = `scaleX(${active})`;
    this.abilityActive.style.opacity = active > 0 ? '1' : '0';

    // --- 体力 ---
    const hp = Math.max(0, e.health);
    const k = hp / e.maxHealth;
    this.hpFill.style.transform = `scaleX(${k})`;
    this.lagHold -= dt;
    if (this.lagHold <= 0 || hp > this.lagHealth) this.lagHealth += (hp - this.lagHealth) * Math.min(1, dt * 5);
    this.hpLag.style.transform = `scaleX(${Math.max(k, this.lagHealth / e.maxHealth)})`;
    this.hpText.textContent = `${Math.ceil(hp)}`;
    // --- 装甲（アーマー） ---
    const hasArmor = e.maxArmor > 0 && !e.dead;
    this.armorBar.classList.toggle('hidden', !hasArmor);
    if (hasArmor) {
      const a = Math.max(0, e.armor) / e.maxArmor;
      if (a < this.armorShown - 0.001) {
        this.armorBar.classList.remove('hit');
        void this.armorBar.offsetWidth;
        this.armorBar.classList.add('hit');
      }
      this.armorShown = a;
      this.armorFill.style.transform = `scaleX(${a.toFixed(3)})`;
      this.armorBar.classList.toggle('broken', a <= 0);
    } else this.armorShown = 0;
    this.root.classList.toggle('low', k < 0.35 && !e.dead);
    this.root.classList.toggle('regen', hp < e.maxHealth && e.sinceDamage > 0.3 && !e.dead && hp > this.lagHealth - 0.5);

    // --- ダメージの方向 ---
    for (let i = this.arcList.length - 1; i >= 0; i--) {
      const a = this.arcList[i];
      a.life -= dt;
      if (a.life <= 0) {
        a.el.remove();
        this.arcList.splice(i, 1);
        continue;
      }
      // 画面の上＝正面。右回りが正
      const rel = yaw - a.worldAngle;
      a.el.style.transform = `rotate(${rel}rad)`;
      a.el.style.opacity = Math.min(1, a.life / 0.6).toFixed(3);
    }

    // --- 画面の縁 ---
    this.hurtK = Math.max(0, this.hurtK - dt * 1.4);
    const lowPulse = k < 0.35 && !e.dead ? 0.25 + 0.12 * Math.sin(performance.now() / 180) : 0;
    this.hurt.style.opacity = Math.min(1, this.hurtK + lowPulse).toFixed(3);
    const aimedOn = e.aimedAt && def.ABILITY.TYPE === 'phase' && !e.dead;
    this.aimedK += ((aimedOn ? 1 : 0) - this.aimedK) * Math.min(1, dt * 8);
    this.aimed.style.opacity = (this.aimedK * (0.75 + 0.25 * Math.sin(performance.now() / 120))).toFixed(3);
    const od = ab.overdrive > 0 ? 0.55 + 0.35 * Math.max(0, Math.sin(performance.now() / 140)) : ab.inject > 0 ? 0.4 : 0;
    this.overdrive.style.opacity = od.toFixed(3);
    this.cloak.style.opacity = ab.cloak > 0 ? '1' : '0';

    // --- 倒されたとき ---
    this.death.classList.toggle('hidden', !e.dead);
    if (e.dead) this.deathTime.textContent = `復活まで ${Math.max(0, e.respawnTimer).toFixed(1)} 秒`;
  }
}
