import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../config';
import type { LevelBuilder } from '../shared/level';
import { lenH, v3 } from '../shared/math';
import { charsCfg, driver, flatLevel, weaponsCfg } from './helpers';

const cc = charsCfg();
const wc = weaponsCfg();

function make(character: CharacterId, extra?: (b: LevelBuilder) => void) {
  const d = driver(flatLevel(extra), undefined, undefined, character);
  d.run(20, {});
  return d;
}
const useAbility = (d: ReturnType<typeof driver>, inp: Record<string, unknown> = {}) => d.run(1, { abilityPressed: true, ...inp });

describe('キャラクター共通', () => {
  it('アビリティはクールダウン中は使えず、クールダウン後に使える', () => {
    const d = make('pearl');
    useAbility(d);
    expect(d.events).toContain('ab:cloakStart');
    d.run(10, {});
    useAbility(d);
    expect(d.events).toContain('ab:abilityNotReady');
    d.run(Math.ceil(cc.pearl.ABILITY.COOLDOWN * 60), {});
    useAbility(d);
    expect(d.events.filter((e) => e === 'ab:cloakStart').length).toBe(2);
  });

  it('体力はダメージを受けて5秒たつと回復し始める。0 になると倒れて、少しして復活する', () => {
    const d = make('pearl');
    d.sim.damagePlayer(d.p, 40, v3(), 'hazard');
    expect(d.p.health).toBe(60);
    d.run(Math.floor(cc.COMMON.REGEN_DELAY * 60) - 5, {});
    expect(d.p.health).toBe(60);
    d.run(65, {});
    expect(d.p.health).toBeGreaterThan(60 + cc.COMMON.REGEN_RATE * 0.8);
    d.sim.damagePlayer(d.p, 200, v3(), 'hazard');
    expect(d.p.dead).toBe(true);
    d.run(Math.ceil(cc.COMMON.RESPAWN_TIME * 60) + 2, {});
    expect(d.p.dead).toBe(false);
    expect(d.p.health).toBe(100);
    expect(d.events).toContain('sim:playerRespawn');
  });

  it('ダメージ床の上ではダメージを受ける', () => {
    const d = driver(
      (() => {
        const l = flatLevel();
        l.hazards = [{ min: v3(-2, 0, -2), max: v3(2, 1, 2), dps: 20 }];
        return l;
      })(),
      undefined,
      undefined,
      'pearl',
    );
    d.run(80, {});
    expect(d.p.health).toBeLessThan(100 - 20 * 0.9);
  });
});

describe('メイア：ワイヤーフック', () => {
  it('狙った壁へ引き寄せられ、近づくと離れる。2段ジャンプが回復する', () => {
    const d = make('meia', (b) => b.boxRange(-3, 0, -22, 3, 12, -20, 'wall'));
    d.run(1, { pitch: 0.25 });
    useAbility(d, { pitch: 0.25 });
    expect(d.events).toContain('ab:grappleStart');
    expect(d.p.movement.grapple).not.toBeNull();
    const t = d.until(150, {}, () => d.p.movement.grapple === null);
    expect(t).toBeGreaterThan(0);
    // 壁の近くまで移動し、地面から高く上がっている
    expect(d.p.movement.pos.z).toBeLessThan(-15);
    expect(d.p.movement.pos.y).toBeGreaterThan(3);
    expect(d.p.movement.doubleJumpReady).toBe(true);
  });

  it('ジャンプで途中で切り離せ、勢いが残る', () => {
    const d = make('meia', (b) => b.boxRange(-3, 0, -32, 3, 12, -30, 'wall'));
    useAbility(d, { pitch: 0.2 });
    d.run(25, {});
    d.run(1, { jumpHeld: true });
    expect(d.events).toContain('grappleEnd');
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(10);
  });

  it('的に当てると、的を引き寄せてよろめかせる', () => {
    const d = make('meia', (b) => b.target(0, 0, -12, 0));
    const before = d.sim.targets[0].pos.z;
    useAbility(d, { pitch: Math.atan2(0.9 - 1.66, 12) });
    expect(d.events).toContain('ab:grappleTarget');
    expect(d.sim.targets[0].pos.z).toBeGreaterThan(before + 3);
    expect(d.sim.targets[0].stagger).toBeGreaterThan(0);
  });

  it('パッシブ：壁走りの時間が 30% 長い', () => {
    const run = (ch: CharacterId) => {
      const d = driver(flatLevel((b) => b.boxRange(1.0, 0, -120, 2.0, 30, 5, 'wall'), v3(0.45, 12, 0)), undefined, undefined, ch);
      d.p.movement.vel = v3(0, 0, -8);
      d.run(2, { moveForward: 1 });
      return d.until(600, { moveForward: 1 }, () => d.p.movement.state !== 'wallrun');
    };
    expect(run('meia') / run('pearl')).toBeCloseTo(1.3, 1);
  });
});

describe('パール：光学迷彩', () => {
  it('5秒間透明になり、撃つと解除される', () => {
    const d = make('pearl');
    useAbility(d);
    expect(d.p.ability.cloak).toBeGreaterThan(4.9);
    d.run(30, {});
    d.run(1, { fireHeld: true, pitch: 0.3 });
    expect(d.p.ability.cloak).toBe(0);
    expect(d.events).toContain('ab:cloakEnd');
  });

  it('透明の間は、タレットは近づかないと気づかない', () => {
    const d = make('pearl', (b) => b.turret(0, 0, -20, 0));
    useAbility(d);
    d.run(120, {});
    expect(d.p.health).toBe(100);
    expect(d.events).not.toContain('sim:turretShot');
  });

  it('パッシブ：足音が小さい', () => {
    const d = make('pearl');
    expect(d.sim.footstepVolumeOf(d.p)).toBeCloseTo(0.35);
    const m = make('meia');
    expect(m.sim.footstepVolumeOf(m.p)).toBe(1);
  });
});

describe('ミランダ：シールドウォール', () => {
  it('前方に壁を出し、タレットの弾を防ぐ。8秒で消える', () => {
    const d = make('miranda', (b) => b.turret(0, 0, -20, 0));
    useAbility(d);
    expect(d.sim.shields.length).toBe(1);
    d.run(240, {});
    expect(d.events).toContain('sim:turretShot');
    expect(d.p.health).toBe(100); // すべてシールドで止まった
    expect(d.sim.shields[0].hits).toBeGreaterThan(3);
    d.run(Math.ceil(cc.miranda.ABILITY.DURATION as number) * 60, {});
    expect(d.sim.shields.length).toBe(0);
  });

  it('自分の弾はシールドを通り抜ける', () => {
    const d = make('miranda', (b) => b.target(0, 0, -8, 0));
    useAbility(d);
    d.run(20, { adsHeld: true, pitch: Math.atan2(0.78 - 1.66, 8) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: Math.atan2(0.78 - 1.66, 8) });
    expect(d.sim.targets[0].health).toBeLessThan(100);
  });

  it('パッシブ：回復が早い（3秒で始まり、2倍の速さ）', () => {
    const d = make('miranda');
    d.sim.damagePlayer(d.p, 50, v3(), 'hazard');
    d.run(3 * 60 + 60, {});
    expect(d.p.health).toBeGreaterThan(50 + cc.COMMON.REGEN_RATE * 2 * 0.9);
  });
});

describe('ソラ：パルスソナー', () => {
  it('40m 以内の的を壁越しに表示する（波が届いてから3秒）', () => {
    const d = make('sora', (b) => {
      b.target(0, 0, -10, 0);
      b.target(0, 0, -60, 0);
      b.boxRange(-5, 0, -6, 5, 5, -5, 'wall');
    });
    useAbility(d);
    const near = d.sim.targets[0];
    const far = d.sim.targets[1];
    expect(near.revealed).toBeGreaterThan(2.9);
    expect(far.revealed).toBe(0);
    d.run(Math.ceil((3 + 10 / (cc.sora.ABILITY.WAVE_SPEED as number)) * 60) + 2, {});
    expect(near.revealed).toBe(0);
  });

  it('パッシブ：倒した的が弾薬を落とし、拾うと弾倉が満タンになる', () => {
    const d = make('sora', (b) => b.target(0, 0, -4, 0));
    d.run(1, { meleePressed: true });
    d.run(1, {});
    expect(d.sim.ammoDrops.length).toBe(0); // 4m は格闘が届かない…ので撃つ
    d.run(30, { adsHeld: true, pitch: Math.atan2(0.78 - 1.66, 4) });
    d.run(40, { adsHeld: true, fireHeld: true, pitch: Math.atan2(0.78 - 1.66, 4) });
    expect(d.sim.ammoDrops.length).toBe(1);
    const ammoBefore = d.p.arsenal.slots[0].ammo;
    expect(ammoBefore).toBeLessThan(wc.ar.MAG_SIZE);
    d.run(120, { moveForward: 1 });
    expect(d.events).toContain('sim:ammoDropPickup');
    expect(d.p.arsenal.slots[0].ammo).toBe(wc.ar.MAG_SIZE);
  });
});

describe('アレックス：オーバードライブ', () => {
  it('注射の動作のあと6秒間、移動速度が上がる', () => {
    const d = make('alex');
    d.run(60, { moveForward: 1, sprintHeld: true });
    const base = lenH(d.p.movement.vel);
    expect(base).toBeCloseTo(8 * 1.1, 1); // パッシブ +10%
    useAbility(d, { moveForward: 1, sprintHeld: true });
    d.run(60, { moveForward: 1, sprintHeld: true });
    expect(d.events).toContain('ab:overdriveStart');
    expect(lenH(d.p.movement.vel)).toBeCloseTo(8 * 1.1 * 1.3, 1);
    d.run(6 * 60, { moveForward: 1, sprintHeld: true });
    expect(d.events).toContain('ab:overdriveEnd');
    expect(lenH(d.p.movement.vel)).toBeCloseTo(8 * 1.1, 1);
  });

  it('注射の動作中は撃てない', () => {
    const d = make('alex');
    useAbility(d);
    d.run(15, { fireHeld: true, pitch: 0.3 });
    expect(d.events).not.toContain('shot');
  });

  it('発動中はダメージを受けた直後でも回復し、速さは2倍', () => {
    const d = make('alex');
    useAbility(d);
    d.run(30, {});
    d.sim.damagePlayer(d.p, 50, v3(), 'hazard');
    d.run(60, {});
    expect(d.p.health).toBeGreaterThan(50 + cc.COMMON.REGEN_RATE * 2 * 0.9);
  });
});

describe('蘭丸：フェイズシフト', () => {
  it('0.5秒の準備のあと3秒間、ダメージを受けず、速く動ける', () => {
    const d = make('ranmaru');
    useAbility(d);
    expect(d.events).toContain('ab:phaseWindup');
    d.run(Math.ceil(0.5 * 60) + 1, {});
    expect(d.events).toContain('ab:phaseStart');
    expect(d.sim.damagePlayer(d.p, 50, v3(), 'hazard')).toBe(false);
    expect(d.p.health).toBe(100);
    d.run(60, { moveForward: 1, sprintHeld: true });
    expect(lenH(d.p.movement.vel)).toBeCloseTo(8 * 1.3, 1);
    d.run(2 * 60 + 5, {});
    expect(d.events).toContain('ab:phaseEnd');
    expect(d.sim.damagePlayer(d.p, 10, v3(), 'hazard')).toBe(true);
  });

  it('位相中は撃てず、タレットにも狙われない', () => {
    const d = make('ranmaru', (b) => b.turret(0, 0, -15, 0));
    useAbility(d);
    d.run(40, { fireHeld: true, pitch: 0.3 });
    expect(d.events).not.toContain('shot');
    expect(d.p.aimedAt).toBe(false);
  });

  it('パッシブ：タレットに狙われると aimedAt が立つ', () => {
    const d = make('ranmaru', (b) => b.turret(0, 0, -15, 0));
    d.run(5, {});
    expect(d.p.aimedAt).toBe(true);
  });
});

describe('訓練用タレット', () => {
  it('見えているプレイヤーを狙い、少しして撃ってくる', () => {
    // 狙い始めてから TURRET_LOCK_TIME が過ぎるまでは撃たない（準備の時間を入れずに作る）
    const d = driver(flatLevel((b) => b.turret(0, 0, -15, 0)), undefined, undefined, 'pearl');
    d.run(Math.ceil(wc.COMMON.TURRET_LOCK_TIME * 60) - 5, {});
    expect(d.events).not.toContain('sim:turretShot');
    d.run(60, {});
    expect(d.events).toContain('sim:turretShot');
    expect(d.p.health).toBeLessThan(100);
    expect(d.events).toContain('sim:playerDamaged');
  });

  it('壁に隠れていると撃たれない', () => {
    const d = make('pearl', (b) => {
      b.turret(0, 0, -15, 0);
      b.boxRange(-4, 0, -6, 4, 4, -5, 'wall');
    });
    d.run(180, {});
    expect(d.events).not.toContain('sim:turretShot');
  });

  it('撃って壊せる', () => {
    const d = make('pearl', (b) => b.turret(0, 0, -10, 0));
    d.sim.setLoadout(d.p.id, ['sniper', 'ar']);
    d.run(30, { adsHeld: true, pitch: Math.atan2(0.75 - 1.66, 10) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: Math.atan2(0.75 - 1.66, 10) });
    d.run(70, { adsHeld: true, pitch: Math.atan2(0.75 - 1.66, 10) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: Math.atan2(0.75 - 1.66, 10) });
    expect(d.sim.targets[0].alive).toBe(false);
  });
});
