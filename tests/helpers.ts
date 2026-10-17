import {
  type CharacterId,
  DEFAULT_CHARACTERS,
  DEFAULT_MOVEMENT,
  DEFAULT_WEAPONS,
  type CharactersConfig,
  type MovementConfig,
  type WeaponsConfig,
} from '../config';
import { type InputCommand, emptyCommand } from '../shared/input';
import { LevelBuilder, type LevelData } from '../shared/level';
import { type Vec3, v3 } from '../shared/math';
import { type Entity, Simulation } from '../shared/simulation';

export function cfg(overrides: Partial<MovementConfig> = {}): MovementConfig {
  return { ...DEFAULT_MOVEMENT, ...overrides };
}

export function charsCfg(): CharactersConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CHARACTERS)) as CharactersConfig;
}

export function weaponsCfg(): WeaponsConfig {
  return JSON.parse(JSON.stringify(DEFAULT_WEAPONS)) as WeaponsConfig;
}

export function flatLevel(extra?: (b: LevelBuilder) => void, spawn: Vec3 = v3(0, 0.02, 0), spawnYaw = 0): LevelData {
  const b = new LevelBuilder();
  b.boxTop(0, 0, 0, 400, 1, 400, 'floor', { noWallrun: true });
  extra?.(b);
  return { name: 'test', boxes: b.boxes, labels: [], targets: b.targets, ammoStations: b.ammoStations, spawn, spawnYaw, killY: -50 };
}

export interface Driver {
  sim: Simulation;
  p: Entity;
  /** 入力を n ティック続ける。each で毎ティックの入力を変えられる */
  run(n: number, input: Partial<InputCommand> | ((t: number) => Partial<InputCommand>)): void;
  until(max: number, input: Partial<InputCommand> | ((t: number) => Partial<InputCommand>), cond: () => boolean): number;
  events: string[];
}

/**
 * 移動・射撃のテストは、移動に効くパッシブを持たないキャラクター（パール）で行う。
 * キャラクターのテストでは character を指定する。
 */
export function driver(level: LevelData, c: MovementConfig = cfg(), w?: WeaponsConfig, character: CharacterId = 'pearl', ch?: CharactersConfig): Driver {
  const sim = new Simulation(level, c, w ?? weaponsCfg(), ch ?? charsCfg());
  const p = sim.spawnPlayer('tester', undefined, character);
  const events: string[] = [];
  let prevJump = false;
  let prevCrouch = false;
  let prevFire = false;
  const stepOnce = (inp: Partial<InputCommand>) => {
    const cmd: InputCommand = { ...emptyCommand(sim.tick + 1), yaw: level.spawnYaw, ...inp };
    // 押した瞬間の判定を自動で作る
    if (inp.jumpPressed === undefined) cmd.jumpPressed = !!cmd.jumpHeld && !prevJump;
    if (inp.crouchPressed === undefined) cmd.crouchPressed = !!cmd.crouchHeld && !prevCrouch;
    if (inp.firePressed === undefined) cmd.firePressed = !!cmd.fireHeld && !prevFire;
    prevFire = !!cmd.fireHeld;
    prevJump = !!cmd.jumpHeld;
    prevCrouch = !!cmd.crouchHeld;
    sim.step(new Map([[p.id, cmd]]));
    for (const e of p.movement.events) events.push(e.type);
    for (const e of p.arsenal.events) events.push(e.type);
    for (const e of sim.events) events.push('sim:' + e.type);
    for (const e of p.abilityEvents) events.push('ab:' + e.type);
  };
  const d: Driver = {
    sim,
    p,
    events,
    run(n, input) {
      for (let t = 0; t < n; t++) stepOnce(typeof input === 'function' ? input(t) : input);
    },
    until(max, input, cond) {
      for (let t = 0; t < max; t++) {
        stepOnce(typeof input === 'function' ? input(t) : input);
        if (cond()) return t + 1;
      }
      return -1;
    },
  };
  return d;
}
