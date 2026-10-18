/**
 * 消耗戦の進行（描画側）。ゲームロジックの AttritionMatch を持ち、
 * ほかの参加者の表示・射撃の演出・3D の音・画面表示・リザルト・記録の保存をつなぐ。
 * ブースト（X）：ゲージは画面の左下（vitalsHud）、ティックなどの見た目は boostViews.ts、マップハックはミニマップに出す
 */
import type { WeaponCustom } from '../../shared/weaponCustom';
import * as THREE from 'three';
import { type BoostId, type BotDifficulty, type CharacterId, type GrenadeId, type WeaponId, boostNum, boostsConfig, botsConfig, charactersConfig, movementConfig, weaponsConfig } from '../../config';
import type { BoostEvent } from '../../shared/boosts';
import { boostSvg } from '../ui/boostIcons';
import { BoostViews } from './boostViews';
import { AttritionMatch } from '../../shared/attrition';
import type { InputCommand } from '../../shared/input';
import type { LevelData } from '../../shared/level';
import { type NavGraph, buildNavGraph } from '../../shared/nav';
import { Simulation } from '../../shared/simulation';
import { lenH } from '../../shared/math';
import type { Assets } from '../assets';
import type { Sfx } from '../audio';
import type { ShotEffects } from '../weapons/effects';
import type { WeaponHud } from '../weaponHud';
import type { SonarWaves } from '../abilities/abilityFx';
import { ALLY_COLOR, ActorViews, ENEMY_COLOR } from './actorViews';
import { AttritionHud, type BestAttrition } from './attritionHud';
import { Minimap, type MinimapMarker } from '../ui/minimap';

export interface AttritionHost {
  readonly assets: Assets;
  readonly sfx: Sfx;
  readonly effects: ShotEffects;
  readonly weaponHud: WeaponHud;
  readonly sonar: SonarWaves;
  readonly group: THREE.Group;
  readonly camera: THREE.Camera;
  size(): { width: number; height: number };
  /** Tab を押しているか */
  tabHeld(): boolean;
  /** 同じ設定でもう一度 */
  restart(): void;
  /** メインメニューへ */
  toMenu(): void;
  /** リザルトを出すとき（画面の固定を外す） */
  onResult(): void;
  /** 爆発の火の玉（ティック） */
  explode(pos: { x: number; y: number; z: number }, radius: number): void;
  /** 画面を揺らす（0〜1） */
  shake(k: number): void;
}

export interface AttritionSetup {
  difficulty: BotDifficulty;
  character: CharacterId;
  loadout: [WeaponId, WeaponId];
  /** 武器のカスタマイズ（メイン・サブ） */
  custom?: [WeaponCustom, WeaponCustom];
  /** ブースト（ロードアウトで選んだもの） */
  boost?: BoostId;
  /** グレネードの種類 */
  grenade?: GrenadeId;
  seed?: number;
}

/** 経路データは作るのに時間がかかるので、ステージごとに1度だけ作る */
const navCache = new Map<string, { boxes: number; nav: NavGraph }>();
export function navFor(level: LevelData): NavGraph {
  const c = navCache.get(level.name);
  if (c && c.boxes === level.boxes.length) return c.nav;
  const nav = buildNavGraph(level, movementConfig);
  navCache.set(level.name, { boxes: level.boxes.length, nav });
  return nav;
}

const BEST_KEY = 'vr.attrition.best';
export function loadAttritionBest(): BestAttrition {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null');
    if (v && typeof v.score === 'number') return { score: v.score, kills: v.kills ?? 0, wins: v.wins ?? 0, matches: v.matches ?? 0 };
  } catch {
    /* 保存できない環境 */
  }
  return { score: 0, kills: 0, wins: 0, matches: 0 };
}
function saveAttritionBest(b: BestAttrition) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* 保存できなくても続ける */
  }
}

const TRACER_ALLY = new THREE.Color('#7fd8ff');
const TRACER_ENEMY = new THREE.Color('#ff7a5a');
const WORLD_SPARK = new THREE.Color('#ffb45c');
const ACTOR_SPARK = new THREE.Color('#ff5a8a');
const SHIELD_SPARK = new THREE.Color('#ffa04a');

export class AttritionController {
  readonly match: AttritionMatch;
  readonly views: ActorViews;
  readonly hud: AttritionHud;
  readonly minimap: Minimap;
  private resultShown = false;
  private stepDist = new Map<number, number>();
  private lowTimeWarned = false;
  private readonly tmp = new THREE.Vector3();
  readonly boostViews: BoostViews;
  /** マップハックで最後に映した敵（位置と時刻） */
  private mapHackMarks: { pts: Array<{ x: number; z: number; boss?: boolean }>; time: number } | null = null;

  constructor(
    private readonly host: AttritionHost,
    level: LevelData,
    readonly setup: AttritionSetup,
  ) {
    const sim = new Simulation(level, movementConfig, weaponsConfig, charactersConfig);
    this.match = new AttritionMatch(sim, navFor(level), {
      difficulty: setup.difficulty,
      seed: setup.seed ?? (Date.now() & 0xffff),
      playerCharacter: setup.character,
      playerLoadout: setup.loadout,
      playerCustom: setup.custom,
      playerGrenade: setup.grenade,
      playerBoost: setup.boost,
    });
    const player = this.match.player!;
    this.views = new ActorViews(host.assets, player.team);
    host.group.add(this.views.group);
    this.views.sync(sim, player.id);
    this.hud = new AttritionHud(player.team, player.id, { retry: () => host.restart(), menu: () => host.toMenu() });
    this.hud.show(true);
    this.minimap = new Minimap(level, this.hud.root);
    this.boostViews = new BoostViews(host.assets.tick, this.match.boosts, host.effects, {
      explode: (p, r) => host.explode(p, r),
      shake: (p, k) => host.shake(Math.max(0, k * (1 - host.camera.position.distanceTo(p) / 40))),
    });
    host.group.add(this.boostViews.group);
  }

  /** シェーダーの準備用 */
  warmObjects(): THREE.Object3D[] {
    return [...this.views.warmObjects(), ...this.boostViews.warmObjects()];
  }

  /** 画面の左下のブーストのゲージ */
  boostInfo(): { id: BoostId; name: string; frac: number; ready: boolean } | null {
    const m = this.match;
    const st = m.boosts.states.get(m.player!.id);
    if (!st) return null;
    return { id: st.boost, name: boostsConfig.BOOSTS[st.boost].NAME, frac: m.boosts.fraction(m.player!.id), ready: m.boosts.ready(m.player!.id) };
  }

  get sim(): Simulation {
    return this.match.sim;
  }

  /** 1ティック進める（プレイヤーの入力を渡す） */
  step(cmd: InputCommand): void {
    this.match.step(cmd);
  }

  /** 試合開始前・終了後は動けない（見回すことはできる） */
  get frozen(): boolean {
    return this.match.phase !== 'playing';
  }

  /** ティックの後：ほかの参加者の表示と、出来事の演出 */
  afterTick(listener: THREE.Vector3): void {
    const m = this.match;
    const sim = m.sim;
    const pid = m.player!.id;
    this.views.sync(sim, pid);
    this.views.afterTick(sim);
    this.boostViews.afterTick();
    const h = this.host;
    const dist = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z);

    for (const e of sim.entities.values()) {
      if (e.id === pid) continue;
      const ally = e.team === m.player!.team;
      // 射撃：銃口から曳光弾、当たった所に火花、3D の射撃音
      for (const ev of e.arsenal.events) {
        // サプレッサーを付けた銃声は、ミニマップに映らない
        if (ev.type === 'shot' && !ally && !ev.suppressed) this.minimap.noteShot(e.id, e.movement.pos, sim.time);
        if (ev.type === 'shot') {
          const from = this.views.muzzleOf(e.id, this.tmp.clone()) ?? new THREE.Vector3(ev.origin.x, ev.origin.y, ev.origin.z);
          h.effects.muzzleFlash(from, ev.hits.length > 1 ? 1.2 : 0.8);
          const w = weaponsConfig[ev.weapon];
          ev.hits.forEach((hit, i) => {
            const to = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
            if (hit.kind === 'actor' && hit.actorId === pid) {
              // 自分に当たった弾は、目の前で止める（画面をふさがない）
              const d = to.clone().sub(from);
              to.copy(from).add(d.multiplyScalar(Math.max(0, 1 - 1.2 / Math.max(1.2, d.length()))));
            }
            if (w.PELLETS === 1 || i % 3 === 0) h.effects.tracer(from, to, ally ? TRACER_ALLY : TRACER_ENEMY);
            const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
            if (hit.kind === 'world') h.effects.impact(to, n, WORLD_SPARK, 0.45);
            else if (hit.kind === 'shield') h.effects.impact(to, n, SHIELD_SPARK, 0.6);
            else if (hit.kind === 'actor' && hit.actorId !== pid) h.effects.impact(to, n, ACTOR_SPARK, 0.5);
          });
          const d = dist(ev.origin);
          h.sfx.shotAt(ev.weapon, ev.origin, d, ev.suppressed);
          // そばをかすめた弾
          if (!ally && d > 4 && ev.hits.some((x) => x.kind !== 'actor' || x.actorId !== pid)) {
            const a = new THREE.Vector3(ev.origin.x, ev.origin.y, ev.origin.z);
            const b = new THREE.Vector3(ev.hits[0].point.x, ev.hits[0].point.y, ev.hits[0].point.z);
            const near = new THREE.Line3(a, b).closestPointToPoint(listener, true, new THREE.Vector3()).distanceTo(listener);
            if (near < 1.6) h.sfx.bulletWhiz();
          }
        }
        if (ev.type === 'melee') h.sfx.landingAt(e.movement.pos, dist(e.movement.pos), 0.8, 10);
        if (ev.type === 'spinUp' || ev.type === 'spinDown') h.sfx.spinAt(ev.type === 'spinUp', e.movement.pos, dist(e.movement.pos));
      }
      // アビリティ
      for (const ev of e.abilityEvents) {
        if (ev.type === 'abilityUsed') h.sfx.abilityAt(ev.ability, e.movement.pos, dist(e.movement.pos));
        if (ev.type === 'sonarPulse') {
          const g = sim.world.raycast(ev.origin, { x: 0, y: -1, z: 0 }, 4);
          h.sonar.spawn(ev.origin, ev.radius, 60, g ? g.point.y : e.movement.pos.y);
        }
      }
      // 着地
      for (const ev of e.movement.events) if (ev.type === 'land' && ev.impactSpeed > 6) h.sfx.landingAt(e.movement.pos, dist(e.movement.pos), sim.footstepVolumeOf(e), ev.impactSpeed);
    }

    for (const ev of sim.events) {
      if (ev.type === 'playerDamaged' && ev.attackerId === pid && ev.entityId !== pid) {
        // プレイヤーが与えたダメージ：数字と当たりの印
        const v = sim.entities.get(ev.entityId);
        if (v) {
          const p = new THREE.Vector3(v.movement.pos.x, v.movement.pos.y + v.movement.height + 0.1, v.movement.pos.z);
          const killed = sim.events.some((x) => x.type === 'kill' && x.victimId === v.id);
          h.weaponHud.damageNumber(p, ev.amount, !!ev.head);
          h.weaponHud.hit(!!ev.head, killed);
          if (!killed) h.sfx.hit(!!ev.head);
        }
      }
      if (ev.type === 'kill') {
        const v = this.views.get(ev.victimId);
        if (v && ev.victimKind !== 'holo') {
          h.sfx.deathAt(v.outer.position, dist(v.outer.position), ev.victimKind === 'pilot');
          // 消える前に、チームの色の光の粒がはじける
          const c = v.outer.position.clone().add(new THREE.Vector3(0, 1.1, 0));
          const col = v.ally ? ALLY_COLOR : ENEMY_COLOR;
          h.effects.impact(c, new THREE.Vector3(0, 1, 0), col, ev.victimKind === 'pilot' ? 1.6 : 1.1);
          h.effects.impact(c.add(new THREE.Vector3(0, 0.4, 0)), new THREE.Vector3(0, 1, 0), new THREE.Color('#ffffff'), 0.9);
        }
        if (ev.killerId === pid && ev.victimKind !== 'holo') {
          if (ev.victimKind === 'pilot') h.sfx.pilotKill();
          else h.sfx.kill();
        }
      }
    }

    for (const ev of m.events) {
      switch (ev.type) {
        case 'killfeed':
          this.hud.killfeed(ev.entry, sim);
          break;
        case 'playerScore':
          this.hud.popup(ev.points, ev.reason, ev.victimName);
          if (ev.reason !== 'pilot') h.sfx.scoreTick();
          break;
        case 'phase':
          if (ev.phase === 'playing') {
            this.hud.announce('試合開始', `先に ${m.cfg.SCORE_LIMIT} 点を取ったチームの勝ち`, 'go', 2.2);
            h.sfx.matchStart();
          }
          if (ev.phase === 'ended' && m.result) {
            const r = m.result;
            const win = r.winner < 0 ? null : r.winner === m.player!.team;
            this.hud.announce(win === null ? '引き分け' : win ? '勝利' : '敗北', r.reason === 'score' ? '目標スコアに到達' : '時間切れ', win === null ? 'draw' : win ? 'win' : 'lose', 9);
            h.sfx.matchEnd(win);
          }
          break;
        case 'scoreMilestone': {
          const mine = ev.team === m.player!.team;
          const left = m.cfg.SCORE_LIMIT - ev.score;
          if (left <= 100) {
            this.hud.announce(mine ? '勝利まであと少し' : '敵が勝利に近づいている', `${mine ? '味方' : '敵'}：残り ${left} 点`, mine ? 'ally' : 'enemy', 2.6);
            h.sfx.alertBeep();
          }
          break;
        }
        case 'gruntSquad':
          break;
        case 'boost':
          this.onBoostEvent(ev.ev, dist);
          break;
      }
    }
    if (m.phase === 'playing' && m.timeLeft < 60 && !this.lowTimeWarned) {
      this.lowTimeWarned = true;
      this.hud.announce('残り 1 分', '', 'warn', 2.2);
      h.sfx.alertBeep();
    }
  }

  /** ブーストの出来事：知らせ・音・見た目 */
  private onBoostEvent(ev: BoostEvent, dist: (p: { x: number; y: number; z: number }) => number) {
    const m = this.match;
    const sim = m.sim;
    const me = m.player!;
    const h = this.host;
    const B = boostsConfig.BOOSTS;
    this.boostViews.onEvents([ev]);
    switch (ev.type) {
      case 'boostReady':
        if (ev.pid === me.id) {
          this.hud.notice(`${boostSvg(ev.boost)}ブースト準備完了　<kbd>X</kbd> ${B[ev.boost].NAME}`, 'n-boost');
          h.sfx.boostReady();
        }
        break;
      case 'boostUsed': {
        const kind = ev.rolled ?? ev.boost;
        const e = sim.entities.get(ev.pid);
        const pos = e ? e.movement.pos : me.movement.pos;
        if (ev.pid === me.id) {
          if (ev.rolled) {
            h.sfx.boostAt('diceroll', pos, 0);
            this.hud.notice(`${boostSvg('diceroll')}ダイスロール → ${boostSvg(ev.rolled)}${B[ev.rolled].NAME}`, 'n-boost');
          } else this.hud.notice(`${boostSvg(kind)}${B[kind].NAME}`, 'n-boost');
        }
        if (kind !== 'ticks') h.sfx.boostAt(kind, pos, ev.pid === me.id ? 0 : dist(pos));
        if (kind === 'maphack') {
          if (ev.team === me.team && ev.pid !== me.id) this.hud.notice(`${boostSvg('maphack')}味方のマップハック：敵の位置がミニマップに映る`, 'n-boost');
          if (ev.team !== me.team) this.hud.notice(`${boostSvg('maphack')}敵がマップハックを使った：位置が知られている`, 'n-enemy');
        }
        break;
      }
      case 'mapHackPulse':
        if (ev.team === me.team) {
          const pts: Array<{ x: number; z: number }> = [];
          for (const id of ev.ids) {
            const o = sim.entities.get(id);
            if (o && !o.dead) pts.push({ x: o.movement.pos.x, z: o.movement.pos.z });
          }
          this.mapHackMarks = { pts, time: sim.time };
        }
        break;
      case 'tickThrow':
        h.sfx.boostAt('tickThrow', ev.pos, dist(ev.pos));
        break;
      case 'tickLand':
        h.sfx.boostAt('tickLand', ev.pos, dist(ev.pos));
        break;
      case 'tickExplode':
        h.sfx.explosionAt(ev.pos, dist(ev.pos));
        break;
      case 'tickDestroyed':
        h.sfx.boostAt('tickBreak', ev.pos, dist(ev.pos));
        break;
      case 'holoGone':
        if (ev.shot) h.sfx.boostAt('holopilot', ev.pos, dist(ev.pos) + 6);
        break;
      case 'rewindStart':
        if (ev.pid !== me.id) h.sfx.boostAt('phaserewind', ev.to, dist(ev.to));
        break;
    }
  }

  /** 毎フレーム */
  update(dt: number, alpha: number, listener: THREE.Vector3, paused: boolean): void {
    const m = this.match;
    const { width, height } = this.host.size();
    this.views.update(dt, alpha, m.sim, this.host.camera, width, height);
    this.boostViews.update(dt, alpha);
    this.hud.update(dt, m, this.host.tabHeld() && !paused);
    this.drawMinimap();
    if (!paused) this.updateFootsteps(dt, listener);
    if (m.finished && !this.resultShown) {
      this.resultShown = true;
      this.finishMatch();
    }
  }

  /** ミニマップ：範囲の中の味方、撃った敵（少しの間）、ソナーで見えている敵 */
  private drawMinimap() {
    const m = this.match;
    const sim = m.sim;
    const p = m.player!;
    if (!this.minimap.due(sim.time)) return;
    const marks: MinimapMarker[] = [];
    for (const e of sim.entities.values()) {
      if (e.id === p.id || e.dead) continue;
      const pos = e.movement.pos;
      if (e.team === p.team) {
        if (e.kind !== 'holo' && e.kind !== 'tick') marks.push({ x: pos.x, z: pos.z, kind: e.kind === 'pilot' ? 'ally' : 'allyGrunt', yaw: e.lastCmd.yaw });
      } else if (e.revealed > 0 && e.revealDelay <= 0) marks.push({ x: pos.x, z: pos.z, kind: 'enemy' });
    }
    // マップハック：1.5 秒ごとに映した敵の位置（次に映すまでに薄くなる）
    const mh = this.mapHackMarks;
    if (mh) {
      const pulse = boostNum(boostsConfig.BOOSTS.maphack, 'PULSE', 1.5);
      const age = sim.time - mh.time;
      if (age > pulse * 1.6) this.mapHackMarks = null;
      else for (const q of mh.pts) marks.push({ x: q.x, z: q.z, kind: 'enemy', alpha: Math.max(0.25, 1 - (age / (pulse * 1.6)) ** 2) });
    }
    marks.push(...this.minimap.shotMarkers(sim.time, (id) => !!sim.entities.get(id) && !sim.entities.get(id)!.dead));
    this.minimap.draw(p.movement.pos, p.lastCmd.yaw, marks, [], sim.time);
  }

  /** ほかの参加者の足音（近いものだけ。3D） */
  private updateFootsteps(dt: number, listener: THREE.Vector3) {
    const sim = this.match.sim;
    for (const e of sim.entities.values()) {
      // ティックは足音を鳴らさない（着地の音だけ）
      if (e.id === this.match.player!.id || e.dead || e.kind === 'tick') continue;
      const mv = e.movement;
      const d = Math.hypot(mv.pos.x - listener.x, mv.pos.y - listener.y, mv.pos.z - listener.z);
      if (d > 28 || (mv.state !== 'ground' && mv.state !== 'wallrun')) continue;
      const sp = lenH(mv.vel);
      if (sp < 1) continue;
      const acc = (this.stepDist.get(e.id) ?? 0) + sp * dt;
      const stride = mv.state === 'wallrun' ? 2 : sp > 6 ? 2.2 : 1.6;
      if (acc >= stride) {
        this.stepDist.set(e.id, acc - stride);
        this.host.sfx.footstepAt(mv.pos, d, sim.footstepVolumeOf(e) * (e.kind === 'grunt' ? 0.8 : 1), sp > 6, mv.state === 'wallrun');
      } else this.stepDist.set(e.id, acc);
    }
  }

  private finishMatch() {
    const m = this.match;
    const r = m.result!;
    const me = r.stats.find((s) => s.isPlayer);
    const prev = loadAttritionBest();
    const best: BestAttrition = {
      score: Math.max(prev.score, me?.score ?? 0),
      kills: Math.max(prev.kills, me?.kills ?? 0),
      wins: prev.wins + (r.winner === m.player!.team ? 1 : 0),
      matches: prev.matches + 1,
    };
    saveAttritionBest(best);
    this.host.onResult();
    this.hud.showResult(m, r, best, prev, botsConfig[this.setup.difficulty].NAME);
  }

  get resultVisible(): boolean {
    return this.hud.resultVisible;
  }

  /** 倒されている間のカメラ：倒した相手の方へゆっくり向く */
  deathLook(yaw: number, pitch: number, dt: number): { yaw: number; pitch: number } | null {
    const p = this.match.player!;
    if (!p.dead || p.killedBy < 0) return null;
    const k = this.match.sim.entities.get(p.killedBy);
    if (!k) return null;
    const eye = this.match.sim.eyeOf(p);
    const dx = k.movement.pos.x - eye.x,
      dy = k.movement.pos.y + 1.2 - eye.y,
      dz = k.movement.pos.z - eye.z;
    const wy = Math.atan2(-dx, -dz);
    const wp = Math.atan2(dy, Math.hypot(dx, dz));
    let d = wy - yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const k2 = Math.min(1, dt * 3);
    return { yaw: yaw + d * k2, pitch: pitch + (wp - pitch) * k2 };
  }

  setOverlayVisible(on: boolean): void {
    this.views.setTagsVisible(on);
    this.hud.root.classList.toggle('menu-hidden', !on);
  }

  dispose(): void {
    this.match.dispose();
    this.views.dispose();
    this.boostViews.dispose();
    this.minimap.dispose();
    this.hud.dispose();
  }
}

export { ALLY_COLOR, ENEMY_COLOR };
