/**
 * 効果音（Web Audio API で合成。音声ファイルは使わない）。
 * 射撃・グレネード・格闘・足音・アビリティ・被弾の音を作る。
 * 音楽：タイトル・メニューの曲だけは音声ファイル（mp3）を読み込み、くり返し流す（music()。試合が始まると止める）
 */
import type { WeaponId } from '../config';

interface ShotVoice {
  /** 破裂音（ノイズ）の帯域・長さ */
  crackFreq: number;
  crackQ: number;
  crackLen: number;
  /** 低音のドンという音 */
  thumpFreq: number;
  thumpLen: number;
  /** 余韻 */
  tailLen: number;
  gain: number;
}

/** 音楽の大きさ（効果音に対して。全体の音量にかける） */
const MUSIC_LEVEL = 0.4;
/** 音楽が始まるとき・止まるときに、だんだん大きく・小さくする時間（秒） */
const MUSIC_FADE_IN = 1.5;
const MUSIC_FADE_OUT = 0.8;

const VOICES: Record<WeaponId, ShotVoice> = {
  ar: { crackFreq: 2200, crackQ: 0.9, crackLen: 0.09, thumpFreq: 120, thumpLen: 0.12, tailLen: 0.35, gain: 0.55 },
  lmg: { crackFreq: 1500, crackQ: 0.8, crackLen: 0.1, thumpFreq: 90, thumpLen: 0.14, tailLen: 0.4, gain: 0.6 },
  smg: { crackFreq: 3000, crackQ: 1.1, crackLen: 0.06, thumpFreq: 160, thumpLen: 0.07, tailLen: 0.22, gain: 0.45 },
  shotgun: { crackFreq: 900, crackQ: 0.6, crackLen: 0.2, thumpFreq: 70, thumpLen: 0.28, tailLen: 0.7, gain: 0.85 },
  sniper: { crackFreq: 1800, crackQ: 0.7, crackLen: 0.14, thumpFreq: 60, thumpLen: 0.3, tailLen: 1.2, gain: 0.9 },
  pistol: { crackFreq: 2600, crackQ: 1.0, crackLen: 0.07, thumpFreq: 140, thumpLen: 0.09, tailLen: 0.3, gain: 0.5 },
  // トライデント：AR より硬く短い音（3 発が速く続く）
  burst: { crackFreq: 2500, crackQ: 1.0, crackLen: 0.075, thumpFreq: 130, thumpLen: 0.1, tailLen: 0.3, gain: 0.55 },
  // ニードル：細く高い音
  psmg: { crackFreq: 3400, crackQ: 1.3, crackLen: 0.055, thumpFreq: 180, thumpLen: 0.06, tailLen: 0.2, gain: 0.42 },
  // サイクロン：低くうなる短い音（速く連なる）
  spinlmg: { crackFreq: 1300, crackQ: 0.9, crackLen: 0.06, thumpFreq: 80, thumpLen: 0.08, tailLen: 0.25, gain: 0.48 },
  // テンペスト：ショットガンより軽く短い
  autosg: { crackFreq: 1100, crackQ: 0.7, crackLen: 0.14, thumpFreq: 85, thumpLen: 0.18, tailLen: 0.45, gain: 0.72 },
  // ファルコン：狙撃銃より軽く、余韻は短め
  marksman: { crackFreq: 2000, crackQ: 0.8, crackLen: 0.11, thumpFreq: 75, thumpLen: 0.2, tailLen: 0.8, gain: 0.75 },
  // ガベル：太く重い一発
  revolver: { crackFreq: 1600, crackQ: 0.7, crackLen: 0.12, thumpFreq: 70, thumpLen: 0.22, tailLen: 0.7, gain: 0.8 },
};

export class Sfx {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  noise: AudioBuffer | null = null;
  volume = 0.6;
  /** 音の出口（3D の音を作る間だけ、位置付きの出口に差し替える） */
  private out: AudioNode | null = null;
  /** 同時に鳴らす 3D の音の数（多すぎると重いので数える） */
  private live3d = 0;
  /** 音楽：ファイルの場所・読み込んだ音・いま鳴らしている音・流したいか */
  private musicUrl: string | null = null;
  private musicBuf: AudioBuffer | null = null;
  private musicLoading = false;
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicFade: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicWant = false;

  /** 全体の音量（0〜1）。音楽にも効く */
  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
    if (this.musicBus) this.musicBus.gain.value = v * MUSIC_LEVEL;
  }

  /** 音楽のファイル（読み込みは、音を出せるようになってから） */
  setMusic(url: string): void {
    this.musicUrl = url;
  }

  /**
   * 音楽を流す・止める。流すときは最初から、だんだん大きく。止めるときはだんだん小さくして止める。
   * 音を出せるようになる前（タイトルで何も操作していないとき）に流そうとしたら、出せるようになった時に流し始める
   */
  music(on: boolean): void {
    this.musicWant = on;
    this.syncMusic();
  }

  private syncMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (this.musicWant) {
      if (this.musicSrc) return;
      if (!this.musicBuf) {
        this.loadMusic();
        return;
      }
      if (ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(0, t);
      fade.gain.linearRampToValueAtTime(1, t + MUSIC_FADE_IN);
      const src = ctx.createBufferSource();
      src.buffer = this.musicBuf;
      src.loop = true;
      src.connect(fade).connect(this.musicBus);
      src.start(t);
      this.musicSrc = src;
      this.musicFade = fade;
    } else if (this.musicSrc && this.musicFade) {
      const t = ctx.currentTime;
      const g = this.musicFade.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + MUSIC_FADE_OUT);
      this.musicSrc.stop(t + MUSIC_FADE_OUT + 0.05);
      this.musicSrc = null;
      this.musicFade = null;
    }
  }

  private loadMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.musicUrl || this.musicLoading) return;
    this.musicLoading = true;
    fetch(this.musicUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => {
        this.musicBuf = buf;
        this.syncMusic();
      })
      .catch((err) => {
        // 音楽がなくてもゲームは遊べる
        console.warn('音楽を読み込めなかった', err);
      });
  }

  /** 聞く人（カメラ）の位置と向き。3D の音の左右・距離に使う */
  setListener(pos: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t);
      l.forwardY.setValueAtTime(fwd.y, t);
      l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  /**
   * 3D の音：pos の位置で鳴らす（方向で左右、距離で大きさが変わり、遠いと高い音が削れる）。
   * fn の中で鳴らした音が、その位置から聞こえる
   */
  private at(pos: { x: number; y: number; z: number }, dist: number, fn: () => void, maxDist = 140): void {
    if (!this.ready() || dist > maxDist) return;
    if (this.live3d > 48) return; // 混みすぎ
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = dist < 30 ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 6;
    p.rolloffFactor = 1.15;
    p.maxDistance = maxDist;
    const t = ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(pos.x, t);
      p.positionY.setValueAtTime(pos.y, t);
      p.positionZ.setValueAtTime(pos.z, t);
    } else p.setPosition(pos.x, pos.y, pos.z);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000 / (1 + dist / 18);
    lp.connect(p).connect(this.master);
    this.out = lp;
    try {
      fn();
    } finally {
      this.out = null;
    }
    this.live3d++;
    setTimeout(() => {
      lp.disconnect();
      p.disconnect();
      this.live3d--;
    }, 2600);
  }

  /** ほかの人の射撃（3D） */
  shotAt(id: WeaponId, pos: { x: number; y: number; z: number }, dist: number, suppressed = false): void {
    // サプレッサーの音は遠くまで届かない
    this.at(pos, dist, () => this.shot(id, suppressed, true), suppressed ? 40 : 160);
  }

  /** ほかの人の回転式の銃身（3D） */
  spinAt(up: boolean, pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => this.spin(up, true), 45);
  }

  /** ほかの人の足音（3D）。heavy は走り */
  footstepAt(pos: { x: number; y: number; z: number }, dist: number, vol: number, heavy: boolean, onWall = false): void {
    if (vol <= 0) return;
    this.at(pos, dist, () => this.footstep(vol * 1.4, heavy, onWall), 28);
  }

  /** ほかの人の着地・ジャンプ（3D） */
  landingAt(pos: { x: number; y: number; z: number }, dist: number, vol: number, impact: number): void {
    this.at(pos, dist, () => this.landing(vol * 1.2, impact), 30);
  }

  /** 爆発（3D） */
  explosionAt(pos: { x: number; y: number; z: number }, dist: number, scale = 1): void {
    if (!this.ready()) return;
    this.at(pos, dist, () => this.explosion(Math.min(dist, 20) / scale), 200);
  }

  // --- グレネードの種類ごとの音（3D） ---

  /** 刺さる・張り付く音。自分に刺さったときは、近くで大きく警告する */
  grenadeStick(pos: { x: number; y: number; z: number }, dist: number, kind: string, onMe: boolean): void {
    if (!this.ready()) return;
    const play = () => {
      const t = this.ctx!.currentTime;
      if (kind === 'satchel') {
        // ぺたっと張り付き、ピッと鳴る
        this.noiseBurst(t, 500, 0.9, 0.08, 0.35, 'lowpass');
        this.tone(t + 0.08, 1900, 1900, 0.07, 0.12, 'square');
      } else {
        // 金属が刺さる
        this.click(t, 3800, 0.35, 0.025);
        this.tone(t, 5200, 2600, 0.12, 0.12, 'triangle');
        this.noiseBurst(t, 1400, 1.2, 0.07, 0.25, 'bandpass');
      }
    };
    if (onMe) {
      play();
      const t = this.ctx.currentTime;
      this.tone(t + 0.1, 1200, 1200, 0.08, 0.2, 'square');
      this.tone(t + 0.22, 1200, 1200, 0.08, 0.2, 'square');
    } else this.at(pos, dist, play, 50);
  }

  /** 効き始める音：煙が噴き出す・燃え上がる・渦がうなる */
  grenadeActivate(pos: { x: number; y: number; z: number }, dist: number, kind: string): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      if (kind === 'smoke') {
        this.click(t, 1800, 0.25, 0.03);
        this.noiseBurst(t, 3000, 0.4, 2.6, 0.4, 'highpass');
        this.noiseBurst(t, 700, 0.5, 1.6, 0.3, 'lowpass');
      } else if (kind === 'firestar') {
        this.noiseBurst(t, 900, 0.5, 0.5, 0.55, 'lowpass');
        this.tone(t, 140, 60, 0.4, 0.4, 'sawtooth');
        this.noiseBurst(t + 0.05, 2400, 0.6, 1.2, 0.2, 'bandpass');
      } else if (kind === 'gravity') {
        // 低いうなりが高くなっていく（引き寄せている間）
        this.tone(t, 55, 190, 1.9, 0.45, 'sawtooth');
        this.tone(t, 110, 380, 1.9, 0.18, 'sine');
        this.noiseBurst(t, 600, 1.5, 1.8, 0.25, 'bandpass');
      }
    }, 90);
  }

  /** ファイアスターが燃えている音（ぱちぱち）。燃えている間、ときどき呼ぶ */
  fireCrackleAt(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      for (let i = 0; i < 3; i++) this.click(t + Math.random() * 0.2, 1500 + Math.random() * 2500, 0.12, 0.015);
      this.noiseBurst(t, 500, 0.5, 0.35, 0.18, 'lowpass');
    }, 40);
  }

  /** アークの放電（はじける高い音と、低いうなり） */
  arcBlast(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.noiseBurst(t, 6000, 0.4, 0.5, 0.7, 'highpass');
      this.tone(t, 2400, 180, 0.35, 0.35, 'sawtooth');
      this.tone(t, 90, 60, 0.6, 0.6, 'square');
      for (let i = 0; i < 5; i++) this.click(t + 0.03 + Math.random() * 0.35, 4000 + Math.random() * 3000, 0.2, 0.02);
    }, 160);
  }

  /** グラビティスターの爆発（吸い込んでから、低く弾ける） */
  gravityBlast(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.tone(t, 380, 40, 0.7, 0.9, 'sine');
      this.noiseBurst(t, 1200, 0.5, 0.5, 0.8, 'lowpass');
      this.tone(t, 900, 120, 0.25, 0.25, 'triangle');
    }, 180);
  }

  /** 電撃を受けた（自分） */
  shocked(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 5000, 0.5, 0.6, 0.35, 'highpass');
    this.tone(t, 60, 55, 1.2, 0.25, 'square');
    this.tone(t, 1200, 400, 0.4, 0.12, 'sawtooth');
  }

  /** サッチェルの起爆スイッチ */
  detonatorClick(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.click(t, 2200, 0.3, 0.025);
    this.tone(t + 0.03, 2600, 2600, 0.06, 0.12, 'square');
  }

  /** ほかの人のアビリティ（3D） */
  abilityAt(kind: string, pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      if (kind === 'grapple') this.grappleFire();
      else if (kind === 'cloak') this.cloak(true);
      else if (kind === 'shield') this.shieldUp();
      else if (kind === 'sonar') this.sonarPing();
      else if (kind === 'overdrive') this.overdrive(true);
      else if (kind === 'phase') this.phase('start');
    }, 60);
  }

  /** 倒れたときの音（3D） */
  deathAt(pos: { x: number; y: number; z: number }, dist: number, pilot: boolean): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.tone(t, pilot ? 420 : 300, 90, pilot ? 0.45 : 0.3, 0.25, 'sawtooth');
      this.noiseBurst(t, 3000, 0.6, 0.4, 0.15, 'highpass');
    }, 80);
  }

  /** ブラウザの決まりで、クリックなどの操作のあとでないと音を出せない */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      // 音楽は効果音の圧縮を通さずに出す（効果音が鳴っても音楽の大きさが揺れないように）
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.volume * MUSIC_LEVEL;
      this.musicBus.connect(this.ctx.destination);
      // 音を出せるようになったら、待っていた音楽を流し始める
      this.ctx.addEventListener('statechange', () => this.syncMusic());
      const len = this.ctx.sampleRate * 1.5;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume().catch(() => undefined);
    this.syncMusic();
  }

  private ready(): this is { ctx: AudioContext; master: GainNode; noise: AudioBuffer } {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private noiseBurst(t: number, freq: number, q: number, len: number, gain: number, type: BiquadFilterType = 'bandpass') {
    if (!this.ready()) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.out ?? this.master);
    src.start(t, Math.random() * 0.5, len + 0.05);
  }

  /** だんだん大きくなってから消える音（周波数が f0 → f1 へ動く）。attack は大きくなるまでの割合 */
  private swell(t: number, f0: number, f1: number, len: number, gain: number, type: OscillatorType = 'sine', attack = 0.7) {
    if (!this.ready()) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + len * attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out ?? this.master);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  /** だんだん大きくなる雑音（フィルターの周波数が f0 → f1 へ動く） */
  private noiseSwell(t: number, f0: number, f1: number, q: number, len: number, gain: number, type: BiquadFilterType = 'bandpass', attack = 0.75) {
    if (!this.ready()) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + len * attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.out ?? this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.05);
  }

  private tone(t: number, f0: number, f1: number, len: number, gain: number, type: OscillatorType = 'sine') {
    if (!this.ready()) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out ?? this.master);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  shot(id: WeaponId, suppressed = false, remote = false): void {
    if (!this.ready()) return;
    const v = VOICES[id];
    const t = this.ctx.currentTime;
    const k = (0.92 + Math.random() * 0.16) * (remote ? 0.94 : 1);
    if (suppressed) {
      // サプレッサー：高い破裂音を消し、こもった「プシュッ」という音と機関部の音だけにする
      this.noiseBurst(t, 900 * k, 0.7, v.crackLen * 1.6, v.gain * 0.35, 'lowpass');
      this.tone(t, v.thumpFreq * 1.4, v.thumpFreq * 0.45, v.thumpLen * 0.7, v.gain * 0.35);
      this.click(t + 0.012, 2600 * k, 0.12, 0.025);
    } else {
      this.noiseBurst(t, v.crackFreq * k, v.crackQ, v.crackLen, v.gain);
      this.tone(t, v.thumpFreq * 2.2, v.thumpFreq * 0.5, v.thumpLen, v.gain * 0.9);
      this.noiseBurst(t + 0.01, 500, 0.5, v.tailLen, v.gain * 0.22, 'lowpass');
    }
    if (id === 'shotgun' && !remote) this.pump(t + 0.32);
    if (id === 'sniper' && !remote) this.bolt(t + 0.35);
    if (id === 'revolver' && !remote) this.click(t + 0.2, 2400, 0.14, 0.03); // 次の弾へシリンダーが回る
  }

  /** 回転式の銃身：回り始め（上がっていくうなり）・止まる（下がっていくうなり） */
  spin(up: boolean, remote = false): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const g = remote ? 0.1 : 0.16;
    if (up) {
      this.tone(t, 120, 520, 1.1, g, 'sawtooth');
      this.tone(t, 240, 1040, 1.1, g * 0.4, 'triangle');
      this.click(t, 900, 0.1, 0.04);
    } else {
      this.tone(t, 520, 90, 1.4, g * 0.8, 'sawtooth');
      this.tone(t, 1040, 180, 1.4, g * 0.3, 'triangle');
    }
  }

  private click(t: number, freq: number, gain = 0.3, len = 0.03) {
    this.noiseBurst(t, freq, 4, len, gain, 'bandpass');
    this.tone(t, freq * 0.6, freq * 0.3, len, gain * 0.4, 'square');
  }

  private pump(t: number) {
    this.click(t, 1200, 0.25, 0.05);
    this.click(t + 0.12, 1600, 0.3, 0.05);
  }

  private bolt(t: number) {
    this.click(t, 1800, 0.22, 0.04);
    this.click(t + 0.18, 1400, 0.22, 0.05);
    this.click(t + 0.32, 2200, 0.26, 0.04);
  }

  dryFire(): void {
    if (!this.ready()) return;
    this.click(this.ctx.currentTime, 2600, 0.2, 0.02);
  }

  reloadStart(perShell: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (perShell) this.click(t + 0.05, 900, 0.15);
    else {
      this.click(t + 0.12, 1100, 0.22); // 弾倉を外す
      this.noiseBurst(t + 0.2, 700, 1, 0.12, 0.08);
    }
  }

  reloadShell(): void {
    if (!this.ready()) return;
    this.click(this.ctx.currentTime, 1900, 0.22, 0.04);
  }

  reloadEnd(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.click(t, 1500, 0.3);
    this.click(t + 0.09, 2400, 0.2);
  }

  swap(): void {
    if (!this.ready()) return;
    this.noiseBurst(this.ctx.currentTime, 1200, 1.5, 0.1, 0.08);
  }

  hit(head: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (head) {
      this.tone(t, 2400, 2200, 0.06, 0.22, 'triangle');
      this.tone(t + 0.04, 3200, 3000, 0.07, 0.18, 'triangle');
    } else {
      this.tone(t, 1700, 1500, 0.05, 0.18, 'triangle');
    }
  }

  kill(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 880, 880, 0.12, 0.2, 'triangle');
    this.tone(t + 0.07, 1320, 1320, 0.18, 0.2, 'triangle');
  }

  refill(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 600, 900, 0.12, 0.15, 'sine');
    this.tone(t + 0.08, 900, 1300, 0.14, 0.12, 'sine');
  }

  /** グレネードのピンを抜く */
  grenadeCook(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.click(t, 2400, 0.22, 0.03);
    this.tone(t + 0.04, 3200, 2800, 0.08, 0.08, 'triangle');
  }

  grenadeThrow(): void {
    if (!this.ready()) return;
    this.noiseBurst(this.ctx.currentTime, 900, 0.8, 0.22, 0.14, 'bandpass');
  }

  grenadeEmpty(): void {
    if (!this.ready()) return;
    this.tone(this.ctx.currentTime, 300, 220, 0.12, 0.12, 'square');
  }

  /** 跳ねる音。dist は聞く人からの距離（m） */
  grenadeBounce(dist: number, speed: number): void {
    if (!this.ready()) return;
    const v = Math.min(1, speed / 12) * this.distGain(dist, 30);
    if (v < 0.01) return;
    const t = this.ctx.currentTime;
    this.tone(t, 2600 + Math.random() * 600, 1800, 0.06, 0.25 * v, 'triangle');
    this.click(t, 3200, 0.2 * v, 0.02);
  }

  /** 爆発。遠いほど小さく、高い音が削れる */
  explosion(dist: number): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const g = this.distGain(dist, 120);
    const far = Math.min(1, dist / 60);
    this.tone(t, 110, 30, 0.9, 1.2 * g, 'sine');
    this.noiseBurst(t, 1600 * (1 - far * 0.7), 0.5, 0.35, 0.9 * g, 'lowpass');
    this.noiseBurst(t + 0.02, 400, 0.6, 1.6, 0.45 * g, 'lowpass');
    if (dist < 12) this.noiseBurst(t, 5000, 0.4, 0.12, 0.25 * g, 'highpass');
  }

  meleeSwing(): void {
    if (!this.ready()) return;
    this.noiseBurst(this.ctx.currentTime, 1400, 1.2, 0.16, 0.12, 'bandpass');
  }

  meleeHit(kind: 'target' | 'world' | 'actor'): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + 0.05;
    if (kind === 'target') {
      this.tone(t, 180, 60, 0.18, 0.7, 'sine');
      this.noiseBurst(t, 900, 0.7, 0.12, 0.45, 'lowpass');
      this.click(t, 1800, 0.25, 0.04);
    } else {
      this.tone(t, 260, 120, 0.1, 0.35, 'triangle');
      this.noiseBurst(t, 2200, 1, 0.08, 0.3, 'bandpass');
    }
  }

  // ---------------------------------------------------------------------------
  // 足音・着地
  // ---------------------------------------------------------------------------

  /** 足音。vol はキャラクターのパッシブ（パールは小さい）、heavy は走り・壁走り */
  footstep(vol: number, heavy: boolean, onWall = false): void {
    if (!this.ready() || vol <= 0) return;
    const t = this.ctx.currentTime;
    const g = (heavy ? 0.16 : 0.1) * vol;
    this.noiseBurst(t, onWall ? 1400 : 700 + Math.random() * 300, 1.4, 0.06, g, 'bandpass');
    this.tone(t, onWall ? 160 : 110, 60, 0.07, g * 0.9, 'sine');
  }

  landing(vol: number, impact: number): void {
    if (!this.ready() || vol <= 0) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, impact / 16) * vol;
    this.tone(t, 140, 45, 0.16, 0.45 * k, 'sine');
    this.noiseBurst(t, 600, 0.8, 0.12, 0.3 * k, 'lowpass');
  }

  // ---------------------------------------------------------------------------
  // アビリティ
  // ---------------------------------------------------------------------------

  abilityNotReady(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 330, 300, 0.07, 0.1, 'square');
    this.tone(t + 0.08, 250, 230, 0.08, 0.1, 'square');
  }

  /** クールダウンが終わった合図 */
  abilityReady(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1046, 1046, 0.08, 0.08, 'triangle');
    this.tone(t + 0.06, 1568, 1568, 0.12, 0.08, 'triangle');
  }

  /** ワイヤーを撃ち出す */
  grappleFire(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.click(t, 2000, 0.3, 0.04);
    this.tone(t, 1800, 400, 0.25, 0.12, 'sawtooth');
    this.noiseBurst(t, 3000, 2, 0.2, 0.08, 'bandpass');
  }

  /** ワイヤーが刺さる（target は的を引き寄せたとき） */
  grappleHit(target: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + 0.08;
    this.click(t, target ? 900 : 1500, 0.35, 0.05);
    this.tone(t, target ? 220 : 320, 120, 0.15, 0.2, 'triangle');
    if (target) this.noiseBurst(t + 0.05, 500, 0.8, 0.3, 0.18, 'lowpass');
  }

  grappleMiss(): void {
    if (!this.ready()) return;
    this.tone(this.ctx.currentTime + 0.1, 600, 300, 0.2, 0.08, 'triangle');
  }

  cloak(on: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (on) {
      this.tone(t, 300, 1400, 0.4, 0.12, 'sine');
      this.noiseBurst(t, 5000, 0.6, 0.4, 0.07, 'highpass');
    } else {
      this.tone(t, 1200, 280, 0.3, 0.12, 'sine');
      this.noiseBurst(t, 3000, 0.6, 0.2, 0.06, 'highpass');
    }
  }

  shieldUp(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 90, 180, 0.35, 0.4, 'sawtooth');
    this.tone(t + 0.05, 440, 660, 0.4, 0.1, 'triangle');
    this.noiseBurst(t, 800, 0.6, 0.35, 0.2, 'lowpass');
  }

  /** 盾に弾が当たった音（dist は聞く人からの距離） */
  shieldHit(dist: number): void {
    if (!this.ready()) return;
    const g = this.distGain(dist, 50);
    if (g < 0.01) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1300 + Math.random() * 300, 900, 0.09, 0.14 * g, 'triangle');
    this.noiseBurst(t, 4000, 2, 0.05, 0.08 * g);
  }

  sonarPing(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1760, 1700, 0.9, 0.2, 'sine');
    this.tone(t, 880, 870, 1.2, 0.12, 'sine');
    this.tone(t + 0.3, 1760, 1720, 0.5, 0.06, 'sine');
  }

  /** ソナーで敵を見つけた */
  sonarReveal(n: number): void {
    if (!this.ready() || n <= 0) return;
    const t = this.ctx.currentTime + 0.35;
    for (let i = 0; i < Math.min(4, n); i++) this.tone(t + i * 0.07, 2093, 2000, 0.06, 0.08, 'square');
  }

  inject(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.click(t + 0.05, 2600, 0.25, 0.03);
    this.noiseBurst(t + 0.08, 6000, 1, 0.25, 0.1, 'highpass'); // シュッ
  }

  overdrive(on: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (on) {
      this.tone(t, 60, 120, 0.6, 0.5, 'sine'); // 心臓の鼓動
      this.tone(t + 0.15, 70, 130, 0.4, 0.35, 'sine');
      this.tone(t, 400, 1200, 0.5, 0.1, 'sawtooth');
    } else {
      this.tone(t, 900, 300, 0.4, 0.1, 'sawtooth');
    }
  }

  phase(kind: 'windup' | 'start' | 'end'): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (kind === 'windup') {
      this.tone(t, 200, 900, 0.5, 0.14, 'sawtooth');
      this.noiseBurst(t, 2500, 3, 0.5, 0.08);
    } else if (kind === 'start') {
      this.tone(t, 1200, 150, 0.6, 0.25, 'sine');
      this.noiseBurst(t, 800, 0.5, 0.8, 0.25, 'lowpass');
    } else {
      this.tone(t, 150, 1200, 0.35, 0.2, 'sine');
      this.click(t + 0.3, 1800, 0.25, 0.04);
    }
  }

  // ---------------------------------------------------------------------------
  // タレット・被弾
  // ---------------------------------------------------------------------------

  turretShot(dist: number): void {
    if (!this.ready()) return;
    const g = this.distGain(dist, 90);
    if (g < 0.01) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 2600, 1.2, 0.05, 0.35 * g);
    this.tone(t, 300, 120, 0.06, 0.25 * g, 'square');
  }

  /** 弾がそばをかすめる */
  bulletWhiz(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 3500, 4, 0.08, 0.08, 'bandpass');
  }

  hurt(amount: number): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, amount / 20);
    this.tone(t, 220, 90, 0.12, 0.3 * (0.4 + k), 'sine');
    this.noiseBurst(t, 1200, 0.8, 0.08, 0.22 * (0.4 + k), 'lowpass');
  }

  death(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 300, 40, 1.2, 0.5, 'sawtooth');
    this.noiseBurst(t, 500, 0.5, 1.0, 0.3, 'lowpass');
  }

  respawnChime(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 523, 523, 0.12, 0.12, 'triangle');
    this.tone(t + 0.1, 784, 784, 0.12, 0.12, 'triangle');
    this.tone(t + 0.2, 1046, 1046, 0.2, 0.12, 'triangle');
  }

  /** タイムアタック：カウントダウン（GO は高い音） */
  countdownBeep(go: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (go) {
      this.tone(t, 1046, 1046, 0.35, 0.2, 'square');
      this.tone(t, 1568, 1568, 0.35, 0.08, 'triangle');
    } else this.tone(t, 523, 523, 0.14, 0.18, 'square');
  }

  /** タイムアタック：チェックポイントを通った（速いときは明るく） */
  checkpointChime(faster: boolean | null): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const base = faster === false ? 587 : 784;
    this.tone(t, base, base, 0.1, 0.14, 'triangle');
    this.tone(t + 0.08, base * 1.5, base * 1.5, 0.16, 0.14, 'triangle');
  }

  /** タイムアタック：ゴール（記録更新のときは長く） */
  finishFanfare(record: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const notes = record ? [523, 659, 784, 1046, 1318] : [523, 659, 784];
    notes.forEach((f, i) => this.tone(t + i * 0.11, f, f, i === notes.length - 1 ? 0.6 : 0.14, 0.16, 'triangle'));
  }

  /** タイムアタック：コースから落ちて戻った */
  fallReset(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 660, 330, 0.25, 0.14, 'sawtooth');
  }

  // ---------------------------------------------------------------------------
  // 消耗戦
  // ---------------------------------------------------------------------------

  /** 敵パイロットを倒した（倒したときの音より高く、長い） */
  pilotKill(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 880, 880, 0.1, 0.22, 'triangle');
    this.tone(t + 0.06, 1320, 1320, 0.12, 0.22, 'triangle');
    this.tone(t + 0.12, 1760, 1760, 0.25, 0.2, 'triangle');
  }

  /** 得点の小さな音（歩兵・アシスト） */
  scoreTick(): void {
    if (!this.ready()) return;
    this.tone(this.ctx.currentTime, 1175, 1175, 0.08, 0.1, 'triangle');
  }

  /** 試合開始のホーン */
  matchStart(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    for (const [f, d] of [
      [196, 0],
      [262, 0.0],
      [392, 0.0],
    ])
      this.tone(t + d, f, f, 0.9, 0.12, 'sawtooth');
    this.noiseBurst(t, 300, 0.5, 0.9, 0.12, 'lowpass');
  }

  /** 試合終了（勝ち・負け・引き分け） */
  matchEnd(win: boolean | null): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const notes = win === true ? [523, 659, 784, 1046] : win === false ? [440, 349, 294, 220] : [440, 440, 523];
    notes.forEach((f, i) => this.tone(t + i * 0.16, f, f, i === notes.length - 1 ? 0.9 : 0.18, 0.16, win === false ? 'sawtooth' : 'triangle'));
  }

  /** 残り時間が少ない・得点の区切りの知らせ */
  alertBeep(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 988, 988, 0.12, 0.13, 'square');
    this.tone(t + 0.16, 988, 988, 0.12, 0.13, 'square');
  }

  /** 狙われていることを知らせる短い警告音（蘭丸のパッシブ） */
  aimedWarning(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1975, 1975, 0.05, 0.08, 'square');
    this.tone(t + 0.09, 1975, 1975, 0.05, 0.08, 'square');
  }

  // ---------------------------------------------------------------------------
  // タワーディフェンス
  // ---------------------------------------------------------------------------

  /** 機銃タレットの射撃（3D） */
  mgTurretAt(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.noiseBurst(t, 1900, 1.0, 0.06, 0.32, 'bandpass');
      this.tone(t, 180, 70, 0.07, 0.3, 'square');
    }, 110);
  }

  /** ロケットの発射（3D）。boss は低く重い */
  rocketLaunchAt(pos: { x: number; y: number; z: number }, dist: number, boss: boolean): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.noiseBurst(t, boss ? 700 : 1100, 0.6, 0.55, 0.35, 'bandpass');
      this.tone(t, boss ? 140 : 220, boss ? 60 : 90, 0.3, 0.22, 'sawtooth');
    }, 160);
  }

  /** 大型兵器の足音（3D。遠くまで響く） */
  bossStepAt(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.tone(t, 70, 32, 0.45, 0.6, 'sine');
      this.noiseBurst(t, 260, 0.6, 0.35, 0.35, 'lowpass');
      this.noiseBurst(t + 0.05, 2400, 2, 0.08, 0.06, 'bandpass'); // 金属のきしみ
    }, 220);
  }

  /** ドローンの短い電子音（現れた・近づいた。3D） */
  droneBeepAt(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.tone(t, 1400, 1700, 0.08, 0.1, 'square');
      this.tone(t + 0.1, 1400, 1700, 0.08, 0.1, 'square');
    }, 70);
  }

  /** 修理の光（3D。小さく） */
  repairAt(pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      this.tone(t, 880, 1320, 0.18, 0.05, 'sine');
    }, 26);
  }

  /** 設置物の音（3D）。kind：置いた・ふくらむ・割れた・展開・作動・跳んだ・バリケードがせり上がる・壊れた */
  deviceAt(
    kind:
      | 'decoyInflate'
      | 'decoyPop'
      | 'trapDeploy'
      | 'trapArm'
      | 'trapTrigger'
      | 'jumpPad'
      | 'barricadeUp'
      | 'barricadeBreak'
      | 'padDeploy'
      | 'podFall'
      | 'podImpact'
      | 'podOpen'
      | 'podLift'
      | 'mortarDeploy'
      | 'mortarLaunch'
      | 'mortarWhistle',
    pos: { x: number; y: number; z: number },
    dist: number,
  ): void {
    const far = kind === 'podFall' || kind === 'podImpact' || kind === 'podLift' || kind === 'mortarLaunch';
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      switch (kind) {
        case 'podFall':
          // 空気を裂いて落ちてくる：高い風切り音が低くなりながら大きくなる
          this.noiseSwell(t, 3600, 700, 1.4, 1.45, 0.5, 'bandpass', 0.85);
          this.swell(t, 1500, 420, 1.45, 0.07, 'sawtooth', 0.85);
          this.noiseSwell(t + 0.9, 500, 160, 0.8, 0.6, 0.45, 'lowpass', 0.8); // 逆噴射のうなり
          break;
        case 'podImpact':
          // 地面に打ち込まれる重い音と、金属の響き
          this.tone(t, 64, 26, 0.75, 0.75, 'sine');
          this.noiseBurst(t, 380, 0.7, 0.6, 0.65, 'lowpass');
          this.noiseBurst(t, 2400, 2.5, 0.25, 0.22, 'bandpass');
          this.tone(t + 0.02, 420, 300, 0.5, 0.06, 'triangle');
          this.noiseBurst(t + 0.12, 900, 0.8, 0.9, 0.18, 'lowpass'); // 土が落ちる
          break;
        case 'podOpen':
          // ガコン、プシューッ（扉の留め金が外れて、油圧で倒れる）
          this.noiseBurst(t, 1800, 2, 0.06, 0.4, 'bandpass');
          this.noiseBurst(t + 0.05, 5200, 0.6, 0.55, 0.2, 'highpass');
          this.tone(t + 0.08, 180, 90, 0.35, 0.18, 'sawtooth');
          this.noiseBurst(t + 0.5, 1100, 1.5, 0.12, 0.35, 'bandpass');
          break;
        case 'podLift':
          // 噴射して空へ戻っていく
          this.noiseSwell(t, 300, 900, 0.7, 2.3, 0.5, 'lowpass', 0.3);
          this.swell(t, 80, 160, 2.3, 0.12, 'sawtooth', 0.3);
          break;
        case 'mortarDeploy':
          // ガシャン（底板を地面に据える）、カチッ（砲身を締める）
          this.noiseBurst(t, 700, 0.9, 0.18, 0.35, 'lowpass');
          this.tone(t, 150, 90, 0.18, 0.2, 'square');
          this.noiseBurst(t + 0.28, 2800, 2.5, 0.04, 0.25, 'bandpass');
          this.tone(t + 0.3, 1200, 1100, 0.05, 0.08, 'square');
          break;
        case 'mortarLaunch':
          // ドン（砲身の中で装薬が燃える、こもった低い発射音）と、砲弾が上がっていく風の音
          this.tone(t, 95, 38, 0.4, 0.8, 'sine');
          this.noiseBurst(t, 520, 0.8, 0.32, 0.7, 'lowpass');
          this.noiseBurst(t + 0.01, 1500, 1.4, 0.12, 0.3, 'bandpass');
          this.noiseSwell(t + 0.05, 1200, 3000, 0.9, 0.5, 0.08, 'bandpass', 0.2);
          break;
        case 'mortarWhistle':
          // ヒュルルル…（落ちてくる砲弾の、だんだん低くなる笛のような音）
          this.swell(t, 2300, 900, 1.35, 0.09, 'sine', 0.95);
          this.noiseSwell(t, 3000, 1200, 1.35, 1.35, 0.18, 'bandpass', 0.9);
          break;
        case 'decoyInflate':
          // シューッと空気が入る
          this.noiseBurst(t, 3200, 0.8, 0.75, 0.16, 'highpass');
          this.tone(t + 0.05, 160, 300, 0.6, 0.05, 'triangle');
          break;
        case 'decoyPop':
          this.noiseBurst(t, 1800, 0.7, 0.12, 0.55, 'bandpass');
          this.tone(t, 900, 120, 0.12, 0.25, 'square');
          this.noiseBurst(t + 0.06, 4200, 0.6, 0.5, 0.1, 'highpass');
          break;
        case 'trapDeploy':
          // カシャッ、カシャッ（左右の機雷が飛ぶ・脚が開く）
          this.noiseBurst(t, 2600, 2, 0.05, 0.25, 'bandpass');
          this.noiseBurst(t + 0.32, 3000, 2, 0.04, 0.22, 'bandpass');
          this.noiseBurst(t + 0.4, 3000, 2, 0.04, 0.22, 'bandpass');
          this.tone(t + 0.6, 400, 900, 0.25, 0.06, 'sawtooth');
          break;
        case 'trapArm':
          this.tone(t, 1600, 1600, 0.06, 0.08, 'square');
          this.tone(t + 0.09, 2100, 2100, 0.1, 0.08, 'square');
          break;
        case 'trapTrigger':
          for (let i = 0; i < 4; i++) this.tone(t + i * 0.05, 2400, 2400, 0.035, 0.12, 'square');
          break;
        case 'jumpPad':
          this.tone(t, 120, 520, 0.28, 0.32, 'sine');
          this.noiseBurst(t, 900, 0.7, 0.35, 0.3, 'lowpass');
          this.tone(t + 0.04, 600, 1500, 0.22, 0.06, 'triangle');
          break;
        case 'padDeploy':
          this.noiseBurst(t, 700, 0.7, 0.15, 0.3, 'lowpass');
          this.tone(t + 0.1, 440, 880, 0.2, 0.08, 'triangle');
          break;
        case 'barricadeUp':
          // 重い板がせり上がる
          this.noiseBurst(t, 420, 0.8, 0.5, 0.3, 'lowpass');
          this.tone(t, 70, 110, 0.5, 0.25, 'sawtooth');
          this.noiseBurst(t + 0.55, 1500, 1.5, 0.08, 0.3, 'bandpass');
          break;
        case 'barricadeBreak':
          this.noiseBurst(t, 1100, 0.6, 0.5, 0.45, 'lowpass');
          this.tone(t, 300, 60, 0.5, 0.25, 'sawtooth');
          this.noiseBurst(t + 0.08, 3500, 1.2, 0.3, 0.15, 'bandpass');
          break;
      }
    }, kind === 'trapArm' || kind === 'trapTrigger' ? 40 : far ? 220 : kind === 'mortarWhistle' ? 60 : 80);
  }

  /** タレットを強化した（上がっていく電子音） */
  upgrade(level: number): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const base = level >= 3 ? 660 : 520;
    this.tone(t, base, base * 1.5, 0.18, 0.12, 'triangle');
    this.tone(t + 0.12, base * 1.25, base * 1.9, 0.18, 0.12, 'triangle');
    this.tone(t + 0.24, base * 2, base * 2, 0.3, 0.1, 'sine');
    this.noiseBurst(t, 5000, 0.8, 0.4, 0.05, 'highpass');
  }

  /** アーマーを付けた（充電の音）・割れた */
  armor(on: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (on) {
      this.tone(t, 300, 1200, 0.4, 0.1, 'sawtooth');
      this.tone(t + 0.36, 1200, 1200, 0.18, 0.08, 'sine');
    } else {
      this.noiseBurst(t, 4800, 1.2, 0.25, 0.3, 'bandpass');
      this.tone(t, 1500, 400, 0.2, 0.12, 'square');
    }
  }

  /** メニューで買った */
  purchase(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 880, 880, 0.06, 0.1, 'square');
    this.tone(t + 0.07, 1320, 1320, 0.1, 0.1, 'triangle');
  }

  /** ブーストの準備ができた（上がっていく 3 音） */
  boostReady(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 660, 660, 0.09, 0.1, 'triangle');
    this.tone(t + 0.08, 880, 880, 0.09, 0.1, 'triangle');
    this.tone(t + 0.16, 1320, 1320, 0.2, 0.1, 'sine');
  }

  /** ブーストを使った（3D。自分なら dist 0） */
  boostAt(kind: string, pos: { x: number; y: number; z: number }, dist: number): void {
    this.at(pos, dist, () => {
      const t = this.ctx!.currentTime;
      switch (kind) {
        case 'maphack':
          // 電子音の走査
          for (let i = 0; i < 3; i++) this.tone(t + i * 0.12, 1200 + i * 300, 1600 + i * 300, 0.1, 0.07, 'square');
          this.tone(t + 0.36, 440, 2200, 0.5, 0.05, 'sine');
          break;
        case 'holopilot':
          // ホログラムが立ち上がる、ゆらぐ音
          this.tone(t, 300, 900, 0.45, 0.1, 'sawtooth');
          this.tone(t + 0.05, 310, 920, 0.45, 0.08, 'sawtooth');
          this.noiseBurst(t, 5200, 0.8, 0.4, 0.06, 'highpass');
          break;
        case 'phaserewind':
          // 吸い込まれて戻る
          this.tone(t, 1400, 180, 0.5, 0.12, 'sine');
          this.noiseBurst(t, 2200, 0.7, 0.5, 0.14, 'bandpass');
          break;
        case 'hardcover':
          this.tone(t, 160, 480, 0.35, 0.16, 'square');
          this.noiseBurst(t + 0.05, 3000, 0.8, 0.3, 0.08, 'highpass');
          break;
        case 'tickThrow':
          this.noiseBurst(t, 1800, 1.5, 0.08, 0.15, 'bandpass');
          break;
        case 'tickLand':
          // カチカチ（脚が開く）
          for (let i = 0; i < 3; i++) this.noiseBurst(t + i * 0.05, 4200, 3, 0.02, 0.12, 'bandpass');
          this.tone(t + 0.15, 1800, 1800, 0.05, 0.06, 'square');
          break;
        case 'tickBreak':
          // 撃たれて壊れた：金属が割れる音と、火花
          this.noiseBurst(t, 2400, 1.2, 0.18, 0.3, 'bandpass');
          this.tone(t, 900, 140, 0.25, 0.1, 'square');
          this.noiseBurst(t + 0.04, 6000, 0.8, 0.25, 0.12, 'highpass');
          break;
        case 'diceroll':
          for (let i = 0; i < 4; i++) this.noiseBurst(t + i * 0.06, 2600, 2.5, 0.03, 0.14, 'bandpass');
          break;
      }
    }, 70);
  }

  /** タレットを置いた */
  turretPlace(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 600, 0.7, 0.15, 0.3, 'lowpass');
    this.tone(t, 180, 120, 0.12, 0.3, 'square');
    this.tone(t + 0.14, 660, 660, 0.08, 0.12, 'triangle');
    this.tone(t + 0.22, 990, 990, 0.14, 0.12, 'triangle');
  }

  /** タレットを売った・壊された */
  turretGone(destroyed: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    if (destroyed) {
      this.tone(t, 520, 130, 0.5, 0.2, 'sawtooth');
      this.noiseBurst(t, 900, 0.6, 0.4, 0.2, 'lowpass');
    } else {
      this.tone(t, 990, 660, 0.12, 0.12, 'triangle');
      this.tone(t + 0.1, 660, 440, 0.16, 0.1, 'triangle');
    }
  }

  /** クレジット（チャリン） */
  credits(big: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1568, 1568, 0.06, 0.08, 'triangle');
    this.tone(t + 0.05, 2093, 2093, big ? 0.25 : 0.1, 0.08, 'triangle');
  }

  /** ウェーブ開始の警報（ボスのときは長く低い） */
  waveStart(boss: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const n = boss ? 3 : 2;
    for (let i = 0; i < n; i++) {
      this.tone(t + i * 0.55, boss ? 330 : 440, boss ? 220 : 330, 0.5, 0.16, 'sawtooth');
      this.tone(t + i * 0.55, boss ? 165 : 220, boss ? 110 : 165, 0.5, 0.12, 'square');
    }
  }

  /** ウェーブを守りきった */
  waveClear(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    [659, 784, 988, 1318].forEach((f, i) => this.tone(t + i * 0.09, f, f, i === 3 ? 0.5 : 0.12, 0.14, 'triangle'));
  }

  /** コアが攻撃されている */
  coreAlarm(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(t + i * 0.22, 1046, 784, 0.18, 0.13, 'square');
  }

  /** 降下ポッドが防壁の上・要塞の中へ降りてくる（2つの音の警告。要塞の中のときは高く速く） */
  podWarning(inner: boolean): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const f = inner ? 880 : 740;
    for (let i = 0; i < 2; i++) {
      this.tone(t + i * 0.26, f, f, 0.11, 0.1, 'square');
      this.tone(t + i * 0.26 + 0.12, f * 0.75, f * 0.75, 0.11, 0.1, 'square');
    }
  }

  /** ダウンした（自分） */
  downed(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 440, 110, 0.9, 0.35, 'sawtooth');
    this.noiseBurst(t, 400, 0.5, 0.6, 0.25, 'lowpass');
  }

  /** 蘇生の進み（押している間、少しずつ高くなる） */
  reviveTick(k: number): void {
    if (!this.ready()) return;
    const f = 520 + k * 600;
    this.tone(this.ctx.currentTime, f, f, 0.05, 0.07, 'sine');
  }

  /** 蘇生した・された */
  revived(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    [523, 784, 1046, 1568].forEach((f, i) => this.tone(t + i * 0.07, f, f, 0.18, 0.12, 'sine'));
  }

  /** 準備完了 */
  readyChime(): void {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone(t, 784, 784, 0.08, 0.12, 'triangle');
    this.tone(t + 0.08, 1175, 1175, 0.18, 0.12, 'triangle');
  }

  /** メニューのカーソルの小さな音 */
  uiTick(): void {
    if (!this.ready()) return;
    this.tone(this.ctx.currentTime, 1320, 1320, 0.03, 0.06, 'square');
  }

  private distGain(dist: number, maxDist: number): number {
    if (dist >= maxDist) return 0;
    return 1 / (1 + (dist / 8) ** 1.6) * (1 - dist / maxDist);
  }
}
