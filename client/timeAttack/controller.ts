/**
 * タイムアタックの進行（描画側）。ゲームロジックの TimeAttackRun を持ち、
 * コースの見た目・ゴースト・画面表示・音・記録の保存をつなぐ。
 */
import * as THREE from 'three';
import { type CharacterId, charactersConfig, timeAttackConfig } from '../../config';
import type { InputCommand } from '../../shared/input';
import type { Entity, Simulation } from '../../shared/simulation';
import { TimeAttackRun } from '../../shared/timeAttack';
import type { Assets } from '../assets';
import type { Sfx } from '../audio';
import type { InputManager } from '../input';
import { CourseView } from './courseView';
import { GhostView } from './ghostView';
import { type BestRecord, decodeGhost, loadBest, loadGhostEnabled, saveGhostEnabled, saveIfBest } from './records';
import { TimeAttackHud } from './taHud';

export interface TimeAttackHost {
  readonly sim: Simulation;
  readonly player: Entity;
  readonly input: InputManager;
  readonly sfx: Sfx;
  readonly character: CharacterId;
  readonly assets: Assets;
  readonly group: THREE.Group;
  readonly camera: THREE.Camera;
  size(): { width: number; height: number };
  /** ステージ・プレイヤー・的を作り直す（スタートからやり直すとき） */
  resetWorld(): void;
  /** メインメニューへ戻る */
  openMenu(): void;
  /** リザルトを出した（画面の固定を外して、ボタンを押せるようにする） */
  onResult(): void;
  /** リザルトの「もう一度」（画面をもう一度固定する） */
  onRetry(): void;
}

export class TimeAttackController {
  run: TimeAttackRun | null = null;
  private best: BestRecord | null = null;
  private readonly course: CourseView;
  private ghost: GhostView;
  private ghostCharacter: CharacterId;
  private readonly hud: TimeAttackHud;
  private hold = 0;
  private holdLatch = false;
  private ghostEnabled = loadGhostEnabled();

  constructor(private readonly host: TimeAttackHost) {
    this.course = new CourseView(host.sim.level);
    host.group.add(this.course.group);
    this.ghostCharacter = host.character;
    this.ghost = new GhostView(host.assets.characters[host.character]);
    host.group.add(this.ghost.group);
    this.hud = new TimeAttackHud({
      retry: () => {
        this.restart();
        this.host.onRetry();
      },
      toggleGhost: () => {
        this.ghostEnabled = !this.ghostEnabled;
        saveGhostEnabled(this.ghostEnabled);
        this.ghost.enabled = this.ghostEnabled;
        return this.ghostEnabled;
      },
      menu: () => this.host.openMenu(),
    });
    this.hud.ghostOn = this.ghostEnabled;
    this.hud.show(true);
    this.begin();
  }

  /** いまのシミュレーションで、新しく走り始める（カウントダウンから） */
  private begin() {
    const h = this.host;
    const course = h.sim.level.course!;
    this.run = new TimeAttackRun(course, h.sim, h.player.id, timeAttackConfig);
    this.best = loadBest(course.id, h.character);
    // ゴーストはキャラクターのモデルで作る（キャラクターが変わったら作り直す）
    if (this.ghostCharacter !== h.character) {
      this.ghost.dispose();
      this.ghost = new GhostView(h.assets.characters[h.character]);
      h.group.add(this.ghost.group);
      this.ghostCharacter = h.character;
    }
    this.ghost.enabled = this.ghostEnabled;
    this.ghost.setFrames(this.best?.ghost ? decodeGhost(this.best.ghost) : null, this.best?.ghostInterval ?? timeAttackConfig.GHOST_INTERVAL_TICKS);
    this.hud.reset(this.run, this.best);
    this.hold = 0;
  }

  /** スタートからやり直す */
  restart(): void {
    this.host.resetWorld();
    this.begin();
  }

  /** キャラクターを変えたとき（記録はキャラクターごとなので、やり直す） */
  onCharacterChanged(): void {
    this.restart();
  }

  filterCommand(cmd: InputCommand): InputCommand {
    return this.run ? this.run.filterCommand(cmd) : cmd;
  }

  /** シミュレーションを1ティック進めた後 */
  afterTick(): void {
    const run = this.run;
    if (!run) return;
    run.step();
    const h = this.host;
    for (const e of run.events) {
      switch (e.type) {
        case 'countdown':
          this.hud.countdown(e.n);
          h.sfx.countdownBeep(false);
          break;
        case 'go':
          this.hud.go();
          h.sfx.countdownBeep(true);
          break;
        case 'checkpoint': {
          const cp = run.course.checkpoints[e.index];
          const goal = e.index === run.course.checkpoints.length - 1;
          const bs = this.best?.splits[e.index];
          if (!goal) {
            this.hud.checkpoint(e.index, cp.name, e.time, this.best, false);
            h.sfx.checkpointChime(bs === undefined ? null : e.time < bs);
          }
          break;
        }
        case 'fallReset': {
          h.input.yaw = e.yaw;
          h.input.pitch = 0;
          h.input.resetRecoil();
          const name = e.checkpoint < 0 ? 'スタート' : run.course.checkpoints[e.checkpoint].name;
          this.hud.fallReset(name);
          h.sfx.fallReset();
          break;
        }
        case 'targetDestroyed':
          this.hud.targetsLeft(e.total - e.destroyed, e.total);
          break;
        case 'finish': {
          const prev = this.best;
          const isNew = saveIfBest(e.result, h.character, run.ghost, timeAttackConfig.GHOST_INTERVAL_TICKS);
          const last = run.course.checkpoints.length - 1;
          this.hud.checkpoint(last, run.course.checkpoints[last].name, e.result.time, prev, true);
          this.hud.showResult(
            e.result,
            prev,
            isNew,
            run.course.name,
            run.course.checkpoints.map((c) => c.name.replace('ゴール：', 'ゴール ')),
            charactersConfig[h.character].NAME,
          );
          h.sfx.finishFanfare(isNew);
          h.onResult();
          if (isNew) this.best = loadBest(run.course.id, h.character);
          break;
        }
      }
    }
  }

  /** T キー：直前のチェックポイントへ戻る（タイマーは止まらない） */
  toCheckpoint(): void {
    const run = this.run;
    if (!run || run.phase !== 'running') return;
    const last = run.lastCheckpoint;
    this.host.sim.teleport(this.host.player.id, new THREE.Vector3(last.pos.x, last.pos.y, last.pos.z));
    this.host.input.yaw = last.yaw;
    this.host.input.pitch = 0;
  }

  /** 毎フレーム。rDown＝R キーを押している */
  update(dt: number, rDown: boolean, playing: boolean): void {
    const run = this.run;
    if (!run) return;
    // R 長押しでやり直し（押しっぱなしで何度もやり直さないよう、離すまで待つ）
    if (rDown && playing && !this.holdLatch) {
      this.hold += dt;
      if (this.hold >= timeAttackConfig.RESTART_HOLD) {
        this.hold = 0;
        this.holdLatch = true;
        this.restart();
        return;
      }
    } else {
      this.hold = 0;
      if (!rDown) this.holdLatch = false;
    }
    const cam = this.host.camera;
    this.course.update(dt, cam, run);
    this.ghost.update(dt, run.phase === 'countdown' ? 0 : run.time, cam);
    const p = this.host.player.movement.pos;
    const { width, height } = this.host.size();
    this.hud.update(dt, run, cam, new THREE.Vector3(p.x, p.y, p.z), this.host.sim.targets, this.hold / timeAttackConfig.RESTART_HOLD, width, height);
  }

  get resultVisible(): boolean {
    return this.hud.resultVisible;
  }

  dispose(): void {
    this.course.dispose();
    this.ghost.dispose();
    this.hud.dispose();
    this.run = null;
  }
}
