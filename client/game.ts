/**
 * ゲーム本体（描画側）。ゲームロジック（shared/simulation）を固定 60Hz で進め、
 * 画面はモニターの更新に合わせて描く。両者の間はカメラで補間する。
 */
import { type CustomWeaponDef, type WeaponCustom, customKey, magnification, slotDef } from '../shared/weaponCustom';
import { SightHud, makeLaserDot } from './weapons/sightHud';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { type CharacterId, type GrenadeId, type WeaponId, abilityNum, cameraConfig, charactersConfig, grenadeNum, movementConfig, weaponsConfig } from '../config';
import { LEVELS, type LevelId } from '../shared/levels';
import { type Vec3, clone, copy, lenH } from '../shared/math';
import { type Entity, type SimEvent, Simulation, TICK_DT } from '../shared/simulation';
import { type Arsenal, type WeaponEvent, activeSlot, currentSpread } from '../shared/weapons';
import type { PlayerMovement } from '../shared/movement';
import { type Assets, loadAssets, loadTdAssets } from './assets';
import { Sfx } from './audio';
import { FpsCamera } from './fpsCamera';
import { Hud } from './hud';
import { InputManager } from './input';
import { LevelView, makeSky } from './scene/levelView';
import { makeDaySky } from './scene/fortressMaterials';
import { LIGHTING, type LightingPreset, MapView } from './scene/mapView';
import { NavDebugView } from './scene/navDebugView';
import { TargetView } from './scene/targetView';
import { WeaponHud } from './weaponHud';
import { ShotEffects } from './weapons/effects';
import { Viewmodel } from './weapons/viewmodel';
import { GrenadeView } from './weapons/grenadeView';
import { blastSpec, gStat, grenadeFuse, grenadePhys, predictPath, targetColliders, throwOrigin, throwVelocity } from '../shared/grenades';
import type { AbilityEvent } from '../shared/abilities';
import type { MoveEvent } from '../shared/movement';
import { AmmoDropViews, GrappleRope, ShieldViews, SonarWaves } from './abilities/abilityFx';
import { ScreenFx } from './scene/screenFx';
import { VitalsHud } from './vitalsHud';
import { TimeAttackController } from './timeAttack/controller';
import { AutoQuality, QUALITY, type QualityLevel, type QualitySetting, loadQualitySetting, saveQualitySetting } from './quality';
import { AttritionController, type AttritionSetup } from './attrition/controller';
import { TdController, type TdSetup } from './td/controller';

const MAX_TICKS_PER_FRAME = 6;

/** 弾道や火花の色（武器ごと） */
const TRACER_COLORS: Record<WeaponId, THREE.Color> = {
  ar: new THREE.Color('#7fe3ff'),
  lmg: new THREE.Color('#ffb070'),
  smg: new THREE.Color('#ff8ae6'),
  shotgun: new THREE.Color('#ffd08a'),
  sniper: new THREE.Color('#c0a8ff'),
  pistol: new THREE.Color('#8affc0'),
  burst: new THREE.Color('#c8ff7a'),
  psmg: new THREE.Color('#ff8a90'),
  spinlmg: new THREE.Color('#ffe070'),
  autosg: new THREE.Color('#8aa8ff'),
  marksman: new THREE.Color('#fff0c8'),
  revolver: new THREE.Color('#ffa0bc'),
};
const WORLD_SPARK = new THREE.Color('#ffb45c');
const TURRET_TRACER = new THREE.Color('#ff3050');
const SHIELD_SPARK = new THREE.Color('#ffa04a');
const TARGET_SPARK = new THREE.Color('#ff5a8a');
/** アークの電撃を受けた体に走る火花・グラビティスターに吸われる体の光 */
const SHOCK_SPARK = new THREE.Color('#8ff0ff');
const PULL_SPARK = new THREE.Color('#c79bff');

const easeInOut = (t: number) => t * t * (3 - 2 * t);
const damp = (cur: number, target: number, rate: number, dt: number) => target + (cur - target) * Math.exp(-rate * dt);

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly input: InputManager;
  sim: Simulation;
  player: Entity;
  levelId: LevelId;
  readonly sfx = new Sfx();
  private readonly scene = new THREE.Scene();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly fpsCam: FpsCamera;
  private sky: THREE.Mesh;
  private skyStyle = 'neon';
  private readonly hud: Hud;
  private readonly weaponHud: WeaponHud;
  private readonly effects = new ShotEffects();
  private viewmodel: Viewmodel | null = null;
  private targetView: TargetView | null = null;
  private grenadeView: GrenadeView | null = null;
  private readonly vitals: VitalsHud;
  private levelView: LevelView | null = null;
  private mapView: MapView | null = null;
  /** ステージごとに作り直すもの（地形の見た目・的・弾薬補給所） */
  private readonly levelGroup = new THREE.Group();
  private readonly lightRig: { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight; fill: THREE.DirectionalLight };
  private loadingLevel: Promise<void> | null = null;
  private navView: NavDebugView | null = null;
  /** ボット用の経路を表示する（確認用） */
  navVisible = false;
  private readonly rope = new GrappleRope();
  private readonly shieldViews = new ShieldViews();
  private readonly sonar = new SonarWaves();
  private ammoDropViews: AmmoDropViews | null = null;
  private readonly screenFx = new ScreenFx();
  private assets: Assets | null = null;
  // 画面効果の効き具合（なめらかに変える）
  private fx = { phase: 0, windup: 0, overdrive: 0, cloak: 0, hurt: 0, shock: 0 };
  // 足音
  private stepDist = 0;
  private wasAimed = false;
  private prevPos: Vec3;
  private acc = 0;
  private lastTime = 0;
  private width = 1;
  private height = 1;
  paused = true;
  /** 確認用：演出（弾道・火花など）だけをゆっくり動かす倍率 */
  fxTimeScale = 1;
  /** 画質の設定（自動・高・中・低）と、いま使っている段階 */
  qualitySetting: QualitySetting = loadQualitySetting();
  quality: QualityLevel = 'medium';
  /** 画質が変わったときに呼ぶ（調整パネルの表示を合わせる） */
  onQualityChange: ((level: QualityLevel) => void) | null = null;
  private readonly autoQuality = new AutoQuality(() => this.lowerQuality());
  /** タイムアタック（コースのあるステージのときだけ） */
  ta: TimeAttackController | null = null;
  /** タイムアタックのリザルトから「メニューへ」を選んだとき（main.ts が一時停止画面を開く） */
  onOpenMenu: (() => void) | null = null;
  private frameCount = 0;
  loadout: [WeaponId, WeaponId] = ['ar', 'shotgun'];
  /** 武器のカスタマイズ（メイン・サブ） */
  custom: [WeaponCustom?, WeaponCustom?] = [];
  /** グレネードの種類（ロードアウトで選ぶ） */
  grenade: GrenadeId = 'frag';
  character: CharacterId = 'meia';
  /** 消耗戦（試合中だけ） */
  at: AttritionController | null = null;
  private atSetup: AttritionSetup | null = null;
  /** タワーディフェンス（試合中だけ） */
  td: TdController | null = null;
  private tdSetup: TdSetup | null = null;
  /** リザルトを出したとき（消耗戦・タイムアタック。main.ts がつなぐ） */
  onResult: (() => void) | null = null;
  /** タイムアタックのリザルトの「もう一度」 */
  onRetry: (() => void) | null = null;
  onAttritionMenu: (() => void) | null = null;
  onAttritionRestart: (() => void) | null = null;
  /** メニューの後ろで、マップの上をゆっくり回るカメラ（タイトル・メインメニュー） */
  menuOrbit = false;
  private orbitT = 0;
  /** 倒されたときに視点が下がる量 */
  private deathDrop = 0;

  constructor(
    private readonly container: HTMLElement,
    levelId: LevelId = 'neon',
  ) {
    // --- ゲームロジック ---
    this.levelId = levelId;
    const level = LEVELS[levelId].build();
    this.sim = new Simulation(level, movementConfig, weaponsConfig, charactersConfig);
    this.player = this.sim.spawnPlayer('あなた', this.loadout, this.character, { custom: this.custom, grenade: this.grenade });
    this.prevPos = clone(this.player.movement.pos);

    // --- 描画 ---
    // 画面の描画は後処理（ブルーム）を通すので、キャンバス自体のなめらか処理（antialias）は使わない。
    // なめらかにするときは、後処理の描き込み先で MSAA を使う（画質「高」）
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.quality = this.qualitySetting === 'auto' ? 'medium' : this.qualitySetting;
    this.renderer.setPixelRatio(this.pixelRatioFor(this.quality));
    this.renderer.shadowMap.enabled = QUALITY[this.quality].shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 太陽は動かないので、影は数フレームごとに描き直す（下の frame で needsUpdate にする）
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.fpsCam = new FpsCamera(cameraConfig, movementConfig);
    this.input = new InputManager(this.renderer.domElement);
    this.input.yaw = level.spawnYaw;

    this.sky = makeSky();
    this.skyStyle = 'dusk';
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2('#3b1d52', 0.0085);
    this.lightRig = this.setupLights();
    this.setupEnvironment();
    this.scene.add(this.levelGroup);
    this.applyLighting(LIGHTING[level.style ?? 'testroom']);
    this.scene.add(this.effects.group);
    this.scene.add(this.rope.group, this.shieldViews.group, this.sonar.group);

    this.composer = new EffectComposer(
      this.renderer,
      // ステンシル：味方の輪郭を、体の外側だけに描くのに使う
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: QUALITY[this.quality].msaa, stencilBuffer: true }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.fpsCam.camera));
    // しきい値を 1 より上にして、発光する線（明るさ 1 を超える色）だけを光らせる
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 1.0);
    this.composer.addPass(this.bloom);
    this.bloom.enabled = QUALITY[this.quality].bloom;
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.screenFx.pass); // 色を反転するなどの効果は、画面に出す色で計算する

    this.hud = new Hud(movementConfig);
    this.weaponHud = new WeaponHud(weaponsConfig);
    this.vitals = new VitalsHud(document.getElementById('hud')!, charactersConfig);
    this.vitals.onAbilityReady = () => this.sfx.abilityReady();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private setupLights() {
    const hemi = new THREE.HemisphereLight('#9a74e0', '#1a1028', 0.75);
    this.scene.add(hemi);

    // 夕日（低い角度から。影を落とす）
    const sun = new THREE.DirectionalLight('#ffb38a', 1.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // 反対側からの青い補助光（ネオンの照り返し）
    const fill = new THREE.DirectionalLight('#4fd1ff', 0.45);
    fill.position.set(60, 30, 70);
    this.scene.add(fill);
    return { hemi, sun, fill };
  }

  /** ステージに合わせて、照明・霧・明るさを変える */
  private applyLighting(p: LightingPreset) {
    const { hemi, sun, fill } = this.lightRig;
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemi;
    sun.color.set(p.sunColor);
    sun.intensity = p.sun;
    sun.position.set(...p.sunPos);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -p.shadowExtent;
    sc.right = sc.top = p.shadowExtent;
    sc.near = 1;
    sc.far = 400;
    sc.updateProjectionMatrix();
    // 影の解像度（画質の設定から）
    const size = QUALITY[this.quality].shadowSize;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    fill.intensity = p.fill;
    (this.scene.fog as THREE.FogExp2).color.set(p.fogColor);
    (this.scene.fog as THREE.FogExp2).density = p.fogDensity;
    this.renderer.toneMappingExposure = p.exposure * (this.exposureMul ?? 1);
  }

  /** 空の色を周囲の映り込みにも使う（床がうっすら空の色を反射する） */
  private setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky());
    const rt = pmrem.fromScene(envScene, 0.02);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.4;
    pmrem.dispose();
  }

  /** Blender で作ったモデルを読み込み、武器・的・弾薬補給所を置く */
  private placeAssets(assets: Assets) {
    this.assets = assets;
    this.viewmodel = new Viewmodel(assets.weapons, this.scene.environment, activeSlot(this.player.arsenal).id, assets.grenades);
    this.viewmodel.setArms(assets.fpArms[this.character], assets.syringe);
    this.viewmodel.setParts(assets.weaponParts);
    this.scene.add(this.laserDot);
    this.ammoDropViews = new AmmoDropViews(assets.ammoDrop);
    this.scene.add(this.ammoDropViews.group);
    this.grenadeView = new GrenadeView(assets.grenades);
    this.scene.add(this.grenadeView.group);
    this.viewmodel.resize(this.width, this.height);
    const vmPass = new RenderPass(this.viewmodel.scene, this.viewmodel.camera);
    vmPass.clear = false;
    vmPass.clearDepth = true; // 武器は常に一番手前に描く
    this.composer.insertPass(vmPass, 1);

  }

  /**
   * ステージに属する見た目（地形・的・弾薬補給所）を作り直す。
   * 地形の見た目のモデルが同じ（ネオン都市 ⇄ タイムアタック・消耗戦）なら、地形は作り直さずに使い回す
   * （読み込みと映り込みの撮影・シェーダーの準備に時間とメモリがかかるため）
   */
  private async buildLevelObjects(): Promise<boolean> {
    const level = this.sim.level;
    const keepMap = !!this.mapView && !!level.visual && this.mapView.level.visual === level.visual;
    // 前のステージのものを片付ける
    this.levelView?.dispose();
    if (!keepMap) this.mapView?.dispose();
    this.navView?.dispose();
    this.navView = null;
    this.levelView = null;
    if (!keepMap) this.mapView = null;
    this.targetView = null;
    this.ta?.dispose();
    this.ta = null;
    for (const c of [...this.levelGroup.children]) if (!keepMap || c !== this.mapView?.group) c.removeFromParent();

    this.applyLighting(LIGHTING[level.style ?? 'testroom']);
    this.setSkyStyle(level.style ?? 'testroom');
    this.levelView = new LevelView(level);
    this.levelGroup.add(this.levelView.group);
    if (level.visual && !keepMap) {
      this.mapView = await MapView.load(level);
      this.levelGroup.add(this.mapView.group);
    }
    const assets = this.assets;
    if (assets) {
      this.targetView = new TargetView(assets.target, this.sim.targets, assets.turret, assets.drone);
      this.levelGroup.add(this.targetView.group);
      if (level.course) this.ta = new TimeAttackController(this.taHost(assets));
      for (const st of level.ammoStations ?? []) {
        const crate = assets.ammoStation.clone(true);
        crate.position.set(st.x, st.y, st.z);
        crate.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
        });
        this.levelGroup.add(crate);
      }
    }
    if (this.navVisible) this.setNavVisible(true);
    this.mapView?.setPointLights(QUALITY[this.quality].pointLights);
    this.renderer.shadowMap.needsUpdate = true;
    // 周りの景色を映り込みに使う（地形ができてから1回だけ撮る）
    if (this.mapView && !keepMap) {
      this.sky.position.set(0, 0, 0);
      this.mapView.captureEnvironment(this.renderer, this.scene);
    }
    return keepMap;
  }

  /** 空と、見える遠さをステージに合わせる（軍事要塞は昼の青空・遠くの山まで見える） */
  private setSkyStyle(style: string) {
    const day = style === 'fortress';
    const want = day ? 'day' : 'dusk';
    const cam = this.fpsCam.camera;
    cam.far = day ? 3400 : 2000;
    cam.updateProjectionMatrix();
    if (this.skyStyle === want) return;
    this.skyStyle = want;
    const old = this.sky;
    const p = LIGHTING.fortress.sunPos;
    this.sky = day ? makeDaySky(new THREE.Vector3(p[0], p[1], p[2])) : makeSky();
    this.scene.add(this.sky);
    old.removeFromParent();
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
  }

  /** 光のにじみ（ブルーム）の強さ */
  setBloom(v: number): void {
    this.bloom.strength = v;
  }

  /** 画面の明るさ（ステージごとの基準に掛ける） */
  exposureMul = 1;
  setExposureMul(v: number): void {
    this.exposureMul = v;
    this.renderer.toneMappingExposure = LIGHTING[this.sim.level.style ?? 'testroom'].exposure * v;
  }

  /** ボット用の経路の表示を切り替える（はじめて表示するときに経路を作る） */
  setNavVisible(on: boolean): void {
    this.navVisible = on;
    if (on && !this.navView) {
      this.navView = new NavDebugView(this.sim.level, movementConfig);
      this.levelGroup.add(this.navView.group);
    }
    if (this.navView) this.navView.group.visible = on;
  }

  /** ステージを変える（キャラクターと装備はそのまま） */
  async setLevel(id: LevelId): Promise<void> {
    if (this.loadingLevel) await this.loadingLevel;
    const run = async () => {
      if (this.at) {
        this.at.dispose();
        this.at = null;
      }
      if (this.td) {
        this.td.dispose();
        this.td = null;
      }
      this.levelId = id;
      this.sim = new Simulation(LEVELS[id].build(), movementConfig, weaponsConfig, charactersConfig);
      this.player = this.sim.spawnPlayer('あなた', this.loadout, this.character, { custom: this.custom, grenade: this.grenade });
      this.prevPos = clone(this.player.movement.pos);
      this.input.yaw = this.sim.level.spawnYaw;
      this.input.pitch = 0;
      this.input.resetRecoil();
      this.ammoDropViews?.clear();
      this.grenadeView?.afterTick(this.sim.grenades, this.sim);
      this.rope.release();
      const keptMap = await this.buildLevelObjects();
      if (!keptMap) await this.precompile();
    };
    this.loadingLevel = run();
    await this.loadingLevel;
    this.loadingLevel = null;
  }

  resize(): void {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    // 後処理の描き込み先も、いまの解像度に合わせる（composer は作ったときの解像度の比を覚えているので、毎回渡す）
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.width, this.height);
    // ブルームは画面より小さい解像度で計算する（UnrealBloomPass は渡した大きさの半分で計算するので 2 倍して渡す）
    const bs = QUALITY[this.quality].bloomScale;
    this.bloom.setSize(Math.max(2, Math.round(this.width * pr * bs * 2)), Math.max(2, Math.round(this.height * pr * bs * 2)));
    this.fpsCam.resize(this.width, this.height);
    this.viewmodel?.resize(this.width, this.height);
  }

  /** モデルを読み込み、シェーダーを先にまとめて準備しておく（始めた瞬間に物が遅れて表示されるのを防ぐ） */
  async warmup(): Promise<Assets> {
    const assets = await loadAssets();
    this.placeAssets(assets);
    await this.buildLevelObjects();
    this.fpsCam.update(0, this.prevPos, this.player.movement.pos, 1, this.player.movement, this.input.yaw, this.input.pitch);
    await this.precompile();
    return assets;
  }

  /**
   * 使うシェーダーを先にまとめて作っておく（試合の途中で初めて画面に出た物のシェーダーを作ると、その瞬間に画面が止まる）。
   * 画面は後処理の描き込み先（色の変換・トーンマッピングなし）に描くので、同じ描き込み先を指定して作る
   * （指定しないと画面に直接描く用の別のシェーダーができてしまい、準備が役に立たない）。
   * extra：まだ場面にない物（試合中に出てくるキャラクター・タレットなど）。
   * 準備に使った物は、隠したまま場面に残しておく：使う物がすべて消えるとシェーダーも捨てられ、次に出たときにまた作ることになるため
   */
  private shaderKeeper: THREE.Group | null = null;
  private vmPartsKeeper: THREE.Object3D | null = null;
  private async precompile(extra: THREE.Object3D[] = []): Promise<void> {
    const c = this.fpsCam.camera;
    const g = new THREE.Group();
    g.name = 'ShaderKeeper';
    // 爆発・盾・ソナーの波は、起きたときに作るので、ここで1つずつ作っておく
    const objs = [...extra, ...(this.grenadeView?.warmObjects() ?? []), ...this.shieldViews.warmObjects(), ...this.sonar.warmObjects()];
    for (const o of objs) g.add(o);
    this.scene.add(g);
    // 一人称の武器：サイト・アタッチメントの部品も、武器の場面の明かりで作っておく（隠して残す）
    if (this.viewmodel && this.assets && !this.vmPartsKeeper) {
      this.vmPartsKeeper = this.assets.weaponParts.clone(true);
      this.vmPartsKeeper.position.set(0, -50, 0);
      this.viewmodel.scene.add(this.vmPartsKeeper);
    }
    if (this.vmPartsKeeper) this.vmPartsKeeper.visible = true;
    const mats = new Set<THREE.Material>();
    const prevTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(this.composer.readBuffer);
      for (const m of this.renderer.compile(this.scene, c)) mats.add(m);
      if (this.viewmodel) for (const m of this.renderer.compile(this.viewmodel.scene, this.viewmodel.camera)) mats.add(m);
      // 後処理の効果（フェイズ・被弾など、ふだんは切ってある物）も作っておく
      // 後処理と同じ形（位置と uv だけの三角形。法線があると別のシェーダーになる）
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
      tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
      const quad = new THREE.Mesh(tri);
      const qs = new THREE.Scene();
      qs.add(quad);
      for (const pass of this.composer.passes) {
        const pm = (pass as unknown as { material?: THREE.Material }).material;
        if (!pm) continue;
        quad.material = pm;
        // 画面へ描くか中間へ描くかは、どの効果が入っているかで変わるので両方
        for (const tgt of [null, this.composer.readBuffer]) {
          this.renderer.setRenderTarget(tgt);
          for (const m of this.renderer.compile(qs, c)) mats.add(m);
        }
      }
      quad.geometry.dispose();
    } catch {
      /* 準備に失敗しても、描画時に通常どおり準備される */
    }
    this.renderer.setRenderTarget(prevTarget);
    if (this.vmPartsKeeper) this.vmPartsKeeper.visible = false;
    // 隠して残す（前の準備で残した物は外す。同じシェーダーは新しい方が使い続ける）
    g.visible = false;
    this.shaderKeeper?.removeFromParent();
    this.shaderKeeper = g;
    // シェーダーができあがるのを待つ（ブラウザが並行して作れるときは、待つ間も画面は止まらない）
    const props = this.renderer.properties;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        for (const m of mats) {
          const p = props.get(m) as { currentProgram?: { isReady(): boolean } };
          if (!p.currentProgram || p.currentProgram.isReady()) mats.delete(m);
        }
        if (mats.size === 0 || performance.now() - t0 > 10000) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
  }

  /** タイムアタックから見たゲーム（シミュレーションは作り直されるので、その都度いまのものを返す） */
  private taHost(assets: Assets) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    return {
      get sim() {
        return game.sim;
      },
      get player() {
        return game.player;
      },
      get character() {
        return game.character;
      },
      input: this.input,
      sfx: this.sfx,
      assets,
      group: this.levelGroup,
      camera: this.fpsCam.camera,
      size: () => ({ width: this.width, height: this.height }),
      resetWorld: () => this.resetWorld(),
      openMenu: () => this.onOpenMenu?.(),
      onResult: () => this.onResult?.(),
      onRetry: () => this.onRetry?.(),
    };
  }

  /** 同じステージで、シミュレーション（プレイヤー・的）を作り直す（タイムアタックのやり直し） */
  private resetWorld(): void {
    this.stopAttrition();
    const level = this.sim.level;
    this.sim = new Simulation(level, movementConfig, weaponsConfig, charactersConfig);
    this.player = this.sim.spawnPlayer('あなた', this.loadout, this.character, { custom: this.custom, grenade: this.grenade });
    this.prevPos = clone(this.player.movement.pos);
    this.input.yaw = level.spawnYaw;
    this.input.pitch = 0;
    this.input.resetRecoil();
    this.acc = 0;
    this.ammoDropViews?.clear();
    this.grenadeView?.afterTick(this.sim.grenades, this.sim);
    this.rope.release();
    if (this.assets) {
      this.targetView?.group.removeFromParent();
      this.targetView = new TargetView(this.assets.target, this.sim.targets, this.assets.turret, this.assets.drone);
      this.levelGroup.add(this.targetView.group);
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** 消耗戦を始める（ネオン都市。ボットの経路データを作るので少し時間がかかる） */
  async startAttrition(setup: AttritionSetup): Promise<void> {
    if (this.levelId !== 'neon') await this.setLevel('neon');
    this.stopAttrition();
    this.atSetup = setup;
    this.character = setup.character;
    this.loadout = setup.loadout;
    this.custom = setup.custom ?? [];
    this.grenade = setup.grenade ?? this.grenade;
    const assets = this.assets!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    const level = { ...this.sim.level, targets: [] };
    this.at = new AttritionController(
      {
        assets,
        sfx: this.sfx,
        effects: this.effects,
        weaponHud: this.weaponHud,
        sonar: this.sonar,
        group: this.levelGroup,
        camera: this.fpsCam.camera,
        size: () => ({ width: this.width, height: this.height }),
        tabHeld: () => this.input.isDown('Tab'),
        restart: () => game.onAttritionRestart?.(),
        toMenu: () => game.onAttritionMenu?.(),
        onResult: () => game.onResult?.(),
        explode: (pos, radius) => {
          const g = this.sim.world.raycast({ x: pos.x, y: pos.y + 0.2, z: pos.z }, { x: 0, y: -1, z: 0 }, radius * 0.6 + 1);
          this.grenadeView?.explode(pos, radius, g ? g.point.y : null);
        },
        shake: (k) => this.fpsCam.addShake(Math.min(1, k)),
      },
      level,
      setup,
    );
    this.sim = this.at.sim;
    this.player = this.at.match.player!;
    this.afterNewSim(this.player.movement.spawnYaw);
    if (this.assets) this.viewmodel?.setArms(this.assets.fpArms[this.character], this.assets.syringe);
    this.hud.setHelpVisible(false);
    this.applyPendingQuality();
    await this.precompile(this.at.warmObjects());
    this.autoQuality.reset(); // 読み込み中の遅いフレームで画質を下げないように、測り直す
  }

  /** 同じ設定で消耗戦をやり直す */
  async restartAttrition(): Promise<void> {
    if (this.atSetup) await this.startAttrition({ ...this.atSetup, seed: undefined });
  }

  /** 消耗戦を終える（練習用のネオン都市に戻す） */
  stopAttrition(): void {
    if (!this.at) return;
    this.at.dispose();
    this.at = null;
    // 消耗戦で外した的を戻す
    this.sim = new Simulation(LEVELS[this.levelId].build(), movementConfig, weaponsConfig, charactersConfig);
    this.player = this.sim.spawnPlayer('あなた', this.loadout, this.character, { custom: this.custom, grenade: this.grenade });
    this.afterNewSim(this.sim.level.spawnYaw);
    this.hud.setHelpVisible(true);
  }

  /** タワーディフェンスを始める（軍事要塞。モデルと経路データの準備に少し時間がかかる） */
  async startTd(setup: TdSetup): Promise<void> {
    if (this.levelId !== 'fortress') await this.setLevel('fortress');
    this.stopAttrition();
    this.stopTd();
    const tdAssets = await loadTdAssets();
    this.tdSetup = setup;
    this.character = setup.character;
    this.loadout = setup.loadout;
    this.custom = setup.custom ?? [];
    this.grenade = setup.grenade ?? this.grenade;
    const assets = this.assets!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    const level = { ...this.sim.level, targets: [] };
    this.td = new TdController(
      {
        assets,
        tdAssets,
        sfx: this.sfx,
        effects: this.effects,
        weaponHud: this.weaponHud,
        sonar: this.sonar,
        input: this.input,
        group: this.levelGroup,
        camera: this.fpsCam.camera,
        size: () => ({ width: this.width, height: this.height }),
        tabHeld: () => this.input.isDown('Tab'),
        restart: () => game.onAttritionRestart?.(),
        toMenu: () => game.onAttritionMenu?.(),
        onResult: () => game.onResult?.(),
        explode: (pos, radius) => {
          const g = this.sim.world.raycast({ x: pos.x, y: pos.y + 0.2, z: pos.z }, { x: 0, y: -1, z: 0 }, radius * 0.6 + 1);
          this.grenadeView?.explode(pos, radius, g ? g.point.y : null);
        },
        shake: (k) => this.fpsCam.addShake(Math.min(1, k)),
      },
      level,
      setup,
    );
    this.sim = this.td.sim;
    this.player = this.td.match.player!;
    this.afterNewSim(this.player.movement.spawnYaw);
    this.viewmodel?.setArms(assets.fpArms[this.character], assets.syringe);
    this.hud.setHelpVisible(false);
    this.applyPendingQuality();
    await this.warmTdShaders(tdAssets);
    this.autoQuality.reset();
  }

  /** タワーディフェンスのモデル（敵・タレット・ボス）とキャラクターのシェーダーを先に準備する（初めて出た瞬間に止まらないように） */
  private async warmTdShaders(tdAssets: Awaited<ReturnType<typeof loadTdAssets>>) {
    const extra: THREE.Object3D[] = [];
    for (const m of [tdAssets.mg, tdAssets.rocket, tdAssets.slow, tdAssets.repair, tdAssets.drone, tdAssets.boss, tdAssets.core]) {
      if (!m) continue;
      const o = m.clone(true);
      o.traverse((x) => {
        if ((x as THREE.Mesh).isMesh) x.castShadow = x.receiveShadow = true;
      });
      extra.push(o);
    }
    await this.precompile([...extra, ...this.td!.views.warmObjects(), ...this.td!.td.warmObjects()]);
  }

  /** 同じ設定でタワーディフェンスをやり直す */
  async restartTd(): Promise<void> {
    if (this.tdSetup) await this.startTd({ ...this.tdSetup, seed: undefined });
  }

  /** タワーディフェンスを終える */
  stopTd(): void {
    if (!this.td) return;
    this.td.dispose();
    this.td = null;
    this.sim = new Simulation(LEVELS[this.levelId].build(), movementConfig, weaponsConfig, charactersConfig);
    this.player = this.sim.spawnPlayer('あなた', this.loadout, this.character, { custom: this.custom, grenade: this.grenade });
    this.afterNewSim(this.sim.level.spawnYaw);
    this.hud.setHelpVisible(true);
  }

  /** いまの試合をやり直す（消耗戦・タワーディフェンス） */
  async restartMatch(): Promise<void> {
    if (this.td) await this.restartTd();
    else await this.restartAttrition();
  }

  /** シミュレーションを作り直したあとの、表示の付け直し */
  private afterNewSim(yaw: number) {
    this.prevPos = clone(this.player.movement.pos);
    this.input.yaw = yaw;
    this.input.pitch = 0;
    this.input.resetRecoil();
    this.acc = 0;
    this.deathDrop = 0;
    this.ammoDropViews?.clear();
    this.grenadeView?.afterTick(this.sim.grenades, this.sim);
    this.rope.release();
    if (this.assets) {
      this.targetView?.group.removeFromParent();
      this.targetView = new TargetView(this.assets.target, this.sim.targets, this.assets.turret, this.assets.drone);
      this.levelGroup.add(this.targetView.group);
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  start(): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  respawn(): void {
    this.sim.respawn(this.player.id);
    this.input.yaw = this.sim.level.spawnYaw;
    this.input.pitch = 0;
    this.input.resetRecoil();
    copy(this.prevPos, this.player.movement.pos);
    this.afterTick();
  }

  /** キャラクターを変える */
  setCharacter(id: CharacterId): void {
    this.character = id;
    this.sim.setCharacter(this.player.id, id);
    if (this.assets) this.viewmodel?.setArms(this.assets.fpArms[id], this.assets.syringe);
    this.rope.release();
    // タイムアタックの記録はキャラクターごとなので、スタートからやり直す
    this.ta?.onCharacterChanged();
  }

  /** 装備を変える（メイン・サブ） */
  setLoadout(primary: WeaponId, secondary: WeaponId, custom: [WeaponCustom?, WeaponCustom?] = []): void {
    this.loadout = [primary, secondary];
    this.custom = custom;
    this.sim.setLoadout(this.player.id, this.loadout, custom);
    this.input.resetRecoil();
  }

  /** グレネードの種類を変える */
  setGrenade(kind: GrenadeId): void {
    this.grenade = kind;
    this.sim.setGrenade(this.player.id, kind);
  }

  toggleHelp(): void {
    this.hud.toggleHelp();
  }

  /** 倍率を切り替えられるスコープの、いまの段（0 から） */
  zoomIndex = 0;
  private customShown = '';
  /** レーザーサイトが当たっている所の赤い点 */
  private readonly laserDot = makeLaserDot();
  private readonly sightHud = new SightHud(document.getElementById('hud')!);

  /** サイト・アタッチメントの画面の演出（照準・スレットスコープ・レーザーの点） */
  private updateSightFx(w: CustomWeaponDef, a: Arsenal, m: PlayerMovement) {
    const scoped = w.SCOPE && a.ads > 0.92;
    const busy = a.swapTimer > 0 || a.cooking || this.paused || this.player.dead;
    this.sightHud.update(w, a.ads, scoped, busy, w.ZOOMS.length > 1 ? magnification(w.ZOOMS[this.zoomIndex]) : 0);
    // スレットスコープ：のぞいている間、見えている敵を浮かび上がらせる
    const views = (this.at ?? this.td)?.views;
    if (views) views.threatScope = w.THREAT && a.ads > 0.85 && !busy;
    // レーザーサイト：腰だめの間、狙っている所に赤い点
    const showLaser = w.LASER && a.ads < 0.5 && !busy && m.state !== 'mantle' && !this.menuOrbit;
    this.laserDot.visible = false;
    if (showLaser) {
      const cam = this.fpsCam.camera;
      const o = cam.getWorldPosition(this.tmpV);
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const hit = this.sim.world.raycast({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, 80);
      if (hit) {
        this.laserDot.visible = true;
        this.laserDot.position.set(hit.point.x - d.x * 0.03, hit.point.y - d.y * 0.03, hit.point.z - d.z * 0.03);
        const s = 0.05 + hit.t * 0.0035;
        this.laserDot.scale.setScalar(s);
      }
    }
  }
  private readonly tmpV = new THREE.Vector3();

  private frame(now: number) {
    // 最初のフレームなどで時刻が前後することがあるので、0〜0.1秒に収める
    const rawDt = Math.max(0, Math.min(1, (now - this.lastTime) / 1000)); // 実際にかかった時間（画質の自動調整用）
    const dt = Math.min(0.1, rawDt);
    this.lastTime = now;
    const a = this.player.arsenal;
    const w = slotDef(weaponsConfig, activeSlot(a));

    if (!this.paused) {
      if (this.input.consumeRespawn() && !this.player.dead) {
        if (this.ta) this.ta.toCheckpoint();
        else if (!this.at && !this.td) this.respawn();
      }
      if (this.input.consumeHelpToggle()) this.hud.toggleHelp();
      if (this.input.consumePress('KeyM')) (this.at ?? this.td)?.minimap.toggleLarge();
      this.input.update(dt, weaponsConfig.COMMON.RECOIL_RECOVERY);
      this.acc += dt;
      let n = 0;
      while (this.acc >= TICK_DT && n < MAX_TICKS_PER_FRAME) {
        copy(this.prevPos, this.player.movement.pos);
        let cmd = this.input.buildCommand(this.sim.tick + 1);
        if (this.ta) cmd = this.ta.filterCommand(cmd);
        if (this.td) cmd = this.td.filterCommand(cmd);
        if (this.at) this.at.step(cmd);
        else if (this.td) this.td.step(cmd);
        else this.sim.step(new Map([[this.player.id, cmd]]));
        this.afterTick();
        this.ta?.afterTick();
        this.at?.afterTick(this.fpsCam.camera.position);
        this.td?.afterTick(this.fpsCam.camera.position);
        if (this.ta && this.player.movement.events.some((e) => e.type === 'respawn')) copy(this.prevPos, this.player.movement.pos);
        this.acc -= TICK_DT;
        n++;
      }
      if (n === MAX_TICKS_PER_FRAME) this.acc = 0; // 処理が追いつかないときは追いかけない
    }

    const alpha = this.paused ? 1 : this.acc / TICK_DT;
    const m = this.player.movement;
    // 消耗戦で倒されている間：視点を下げ、倒した相手の方を向く
    if (this.td) {
      const want = this.td.viewDrop;
      this.deathDrop = damp(this.deathDrop, want, want > this.deathDrop ? 4 : 12, dt);
    } else if (this.at) {
      this.deathDrop = damp(this.deathDrop, this.player.dead ? 1.05 : 0, this.player.dead ? 4 : 30, dt);
      const look = !this.paused ? this.at.deathLook(this.input.yaw, this.input.pitch, dt) : null;
      if (look) {
        this.input.yaw = look.yaw;
        this.input.pitch = look.pitch;
      }
    } else this.deathDrop = 0;
    // 倍率を切り替えられるスコープ：のぞいている間はホイールで倍率を変える
    this.input.zoomWheel = w.ZOOMS.length > 1 && a.ads > 0.5 && !this.paused;
    const zs = this.input.consumeZoomSteps();
    if (zs && w.ZOOMS.length > 1) {
      const next = Math.max(0, Math.min(w.ZOOMS.length - 1, this.zoomIndex + zs));
      if (next !== this.zoomIndex) {
        this.zoomIndex = next;
        this.sfx.swap();
      }
    }
    this.zoomIndex = Math.min(this.zoomIndex, Math.max(0, w.ZOOMS.length - 1));
    const zoomFov = w.ZOOMS.length > 1 ? w.ZOOMS[this.zoomIndex] : w.ADS_FOV_MUL;
    // エイム中は視野角を狭め（ズーム）、マウス感度もそれに合わせて下げる
    const adsK = easeInOut(a.ads);
    const adsFovMul = 1 + (zoomFov - 1) * adsK;
    const baseHalf = (cameraConfig.FOV * Math.PI) / 360;
    this.input.sensitivityScale = Math.tan(baseHalf * adsFovMul) / Math.tan(baseHalf);
    if (this.deathDrop > 0.001) {
      const dp = { x: this.prevPos.x, y: this.prevPos.y - this.deathDrop, z: this.prevPos.z };
      const dc = { x: m.pos.x, y: m.pos.y - this.deathDrop, z: m.pos.z };
      this.fpsCam.update(dt, dp, dc, alpha, m, this.input.yaw, this.input.pitch, adsFovMul);
    } else this.fpsCam.update(dt, this.prevPos, m.pos, alpha, m, this.input.yaw, this.input.pitch, adsFovMul);
    if (this.menuOrbit) this.orbitCamera(dt);
    else if (this.spectateId !== null) this.spectateCamera(dt, alpha);
    this.sky.position.copy(this.fpsCam.camera.position);
    // 3D の音の聞く位置
    if (this.frameCount % 2 === 0) {
      const cam = this.fpsCam.camera;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      this.sfx.setListener(cam.position, f);
    }

    const look = this.input.consumeLookDelta();
    // 武器のカスタマイズが変わったら、一人称の武器の見た目に入れる
    const ck = a.slots.map((sl) => `${sl.id}:${customKey(sl.custom)}`).join('/');
    if (this.viewmodel && ck !== this.customShown) {
      this.customShown = ck;
      for (const sl of a.slots) this.viewmodel.setCustom(sl.id, sl.custom);
    }
    this.updateSightFx(w, a, m);
    if (this.viewmodel) {
      this.viewmodel.setGrenadeKind(a.grenadeKind);
      const bob = this.fpsCam.bob;
      const sprinting = this.player.lastCmd.sprintHeld && m.state === 'ground' && lenH(m.vel) > movementConfig.WALK_SPEED * 1.1;
      const reloadTotal = w.RELOAD_PER_SHELL ? w.RELOAD_START_DELAY + w.RELOAD_TIME : w.RELOAD_TIME;
      this.viewmodel.update(dt, {
        weapon: activeSlot(a).id,
        ads: a.ads,
        reload: a.reloading ? Math.min(1, Math.max(0, 1 - a.reloadTimer / reloadTotal)) : -1,
        perShellReload: w.RELOAD_PER_SHELL,
        swap: a.swapTimer > 0 ? 1 - a.swapTimer / w.SWAP_TIME : 1,
        sprint: sprinting,
        firing: a.sinceShot < 0.35,
        slide: m.state === 'slide',
        bobPhase: bob.phase,
        bobAmount: bob.amount,
        roll: this.fpsCam.rollRad,
        lookDeltaYaw: look.yaw,
        lookDeltaPitch: look.pitch,
        dip: this.fpsCam.dipAmount,
        scoped: !!w.SCOPE && a.ads > 0.92,
        cooking: a.cooking,
        cloak: this.fx.cloak,
        phase: this.player.ability.phase + this.player.ability.phaseWindup,
        spin: a.spin,
      });
    }
    this.updateAbilityFx(dt);
    this.updateFootsteps(dt);
    this.updateGrenadePreview();
    this.grenadeView?.update(dt * this.fxTimeScale, alpha, this.fpsCam.camera);
    this.targetView?.update(dt, alpha, this.sim.targets, this.fpsCam.camera, (id, from) => {
      const e = this.sim.entities.get(id);
      if (!e) return null;
      if (id !== this.player.id) return new THREE.Vector3(e.movement.pos.x, e.movement.pos.y + e.movement.height * 0.6, e.movement.pos.z);
      // 自分に向かうレーザーは胸のあたりへ。目の前で太く見えないよう、手前 1.5m で止める
      const chest = this.fpsCam.camera.position.clone().add(new THREE.Vector3(0, -0.45, 0));
      const d = chest.sub(from);
      return from.add(d.multiplyScalar(Math.max(0, 1 - 1.5 / Math.max(1.5, d.length()))));
    });
    this.ammoDropViews?.update(dt, this.sim.ammoDrops);
    this.ta?.update(dt, this.input.isDown('KeyR'), !this.paused);
    this.at?.update(dt, alpha, this.fpsCam.camera.position, this.paused);
    this.td?.update(dt, alpha, this.fpsCam.camera.position, this.paused);
    const down = (this.at || this.td) && (this.player.dead || this.player.downed > 0);
    if (this.viewmodel) this.viewmodel.scene.visible = !this.menuOrbit && this.spectateId === null && !down;
    this.levelView?.update(dt);
    this.mapView?.update(dt);
    this.effects.update(dt * this.fxTimeScale);

    this.hud.update(dt, m, this.fpsCam.displaySpeed, this.fpsCam.speedFactor());
    this.vitals.update(dt, this.player, this.input.yaw);
    this.vitals.setBoost(this.at ? this.at.boostInfo() : null);
    this.weaponHud.update(dt * this.fxTimeScale, a, currentSpread(a, m, weaponsConfig), this.fpsCam.camera, this.width, this.height);
    // 影は数フレームごとに描き直す
    this.frameCount++;
    const q = QUALITY[this.quality];
    if (q.shadows && this.frameCount % q.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    if (!this.paused && this.qualitySetting === 'auto') this.autoQuality.sample(rawDt);
    // 一時停止中（メニューの後ろ）は、描く回数を 1/3 にする
    if (this.paused && !this.menuOrbit && this.frameCount % 3 !== 0) return;
    this.composer.render(dt);
  }

  /** 確認用：ほかの参加者を後ろから見るカメラ（コンソールから game.spectateId = 番号） */
  spectateId: number | null = null;
  private specYaw = 0;
  private specWall = 0;
  private spectateCamera(dt: number, alpha: number) {
    const e = this.sim.entities.get(this.spectateId!);
    if (!e) return;
    const v = this.at?.views.get(e.id) ?? this.td?.views.get(e.id);
    const p = v ? v.outer.position : new THREE.Vector3(e.movement.pos.x, e.movement.pos.y, e.movement.pos.z);
    let d = e.lastCmd.yaw - this.specYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.specYaw += d * Math.min(1, dt * 4);
    const cam = this.fpsCam.camera;
    const back = new THREE.Vector3(Math.sin(this.specYaw), 0, Math.cos(this.specYaw));
    // 壁走り中は壁から離れた側へカメラを振り出す（壁にめり込んで何も見えなくならないように）
    const wr = e.movement.state === 'wallrun' ? 1 : 0;
    this.specWall += (wr - this.specWall) * Math.min(1, dt * 3);
    const n = e.movement.wallNormal;
    const out = this.specWall * 3.2;
    cam.position.set(p.x + back.x * 3.4 * (1 - this.specWall * 0.3) + n.x * out, p.y + 2.3 - this.specWall * 0.8, p.z + back.z * 3.4 * (1 - this.specWall * 0.3) + n.z * out);
    cam.lookAt(p.x - back.x * 4, p.y + 1.2, p.z - back.z * 4);
    void alpha;
  }

  /** タイトル・メインメニューの後ろ：マップの上をゆっくり回る */
  private orbitCamera(dt: number) {
    this.orbitT += dt * 0.045;
    const cam = this.fpsCam.camera;
    const cx = -4,
      cz = -8;
    const r = 78;
    const t = this.orbitT;
    cam.position.set(cx + Math.cos(t) * r, 34 + Math.sin(t * 0.7) * 6, cz + Math.sin(t) * r * 0.82);
    cam.lookAt(cx, 6, cz);
    if (Math.abs(cam.fov - 60) > 0.01) {
      cam.fov = 60;
      cam.updateProjectionMatrix();
    }
  }

  /** 画質を変える（自動・高・中・低） */
  setQuality(setting: QualitySetting): void {
    this.qualitySetting = setting;
    saveQualitySetting(setting);
    this.autoQuality.reset();
    this.renderScale = 1;
    this.pendingQuality = null;
    this.applyQuality(setting === 'auto' ? 'medium' : setting);
  }

  /** 「自動」のとき、同じ画質のまま解像度だけを下げる割合（1 → 0.85 → 0.7） */
  renderScale = 1;
  /** 「自動」で、次の試合の読み込みのときに下げる画質 */
  private pendingQuality: QualityLevel | null = null;

  private pixelRatioFor(level: QualityLevel): number {
    return Math.min(window.devicePixelRatio, QUALITY[level].pixelRatio) * this.renderScale;
  }

  /**
   * 「自動」のとき、1段下げる。試合の途中では解像度だけを下げる（すぐに変えられて、画面が止まらない）。
   * 影・ブルームの有無を変えるとシェーダーをすべて作り直すことになり、その間画面が止まるので、
   * 解像度を下げきっても遅いときは、次の試合の読み込みのときに画質を1つ下げる。もう下げられなければ false
   */
  private lowerQuality(): boolean {
    if (this.renderScale > 0.71) {
      this.renderScale = Math.round((this.renderScale - 0.15) * 100) / 100;
      this.renderer.setPixelRatio(this.pixelRatioFor(this.quality));
      this.resize();
      this.onQualityChange?.(this.quality);
      return true;
    }
    if (!this.pendingQuality) this.pendingQuality = this.quality === 'high' ? 'medium' : this.quality === 'medium' ? 'low' : null;
    return false;
  }

  /** 試合の読み込みのとき：「自動」で下げることになっていた画質にする */
  private applyPendingQuality(): void {
    const next = this.pendingQuality;
    this.pendingQuality = null;
    if (!next || this.qualitySetting !== 'auto' || next === this.quality) return;
    this.renderScale = 1;
    this.applyQuality(next);
  }

  private applyQuality(level: QualityLevel): void {
    const prev = QUALITY[this.quality];
    this.quality = level;
    const q = QUALITY[level];
    this.renderer.setPixelRatio(this.pixelRatioFor(level));
    // MSAA のサンプル数を変えたら、描き込み先を作り直す
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples !== q.msaa) {
        rt.samples = q.msaa;
        rt.dispose();
      }
    }
    this.bloom.enabled = q.bloom;
    if (prev.shadows !== q.shadows) {
      this.renderer.shadowMap.enabled = q.shadows;
      // 影の有無はシェーダーの作りが変わるので、マテリアルを作り直す
      this.scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
      });
    }
    const sun = this.lightRig.sun;
    if (sun.shadow.mapSize.x !== q.shadowSize) {
      sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.mapView?.setPointLights(q.pointLights);
    this.resize();
    this.onQualityChange?.(level);
  }

  private afterTick() {
    const ev = this.player.movement.events;
    if (ev.length) {
      this.fpsCam.onEvents(ev);
      this.hud.onEvents(ev);
      for (const e of ev) this.onMoveEvent(e);
      // スタート地点に戻ったときは補間しない
      if (ev.some((e) => e.type === 'respawn')) copy(this.prevPos, this.player.movement.pos);
    }
    for (const e of this.player.arsenal.events) this.onWeaponEvent(e);
    for (const e of this.player.abilityEvents) this.onAbilityEvent(e);
    for (const e of this.sim.events) this.onSimEvent(e);
    // 狙われた瞬間に警告音（蘭丸のパッシブ）
    const aimed = this.player.aimedAt && charactersConfig[this.player.character].ABILITY.TYPE === 'phase';
    if (aimed && !this.wasAimed) this.sfx.aimedWarning();
    this.wasAimed = aimed;
    this.targetView?.afterTick(this.sim.targets);
    this.grenadeView?.afterTick(this.sim.grenades, this.sim);
    this.grenadeAmbient();
  }

  /** グレネードが効いている間の音と火花：燃える音、電撃を受けた体に走る火花、渦に吸われる体の光 */
  private grenadeAmbient() {
    const tick = this.sim.tick;
    const eye = this.sim.eyeOf(this.player);
    const distTo = (p: Vec3) => Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    if (tick % 15 === 0) {
      for (const g of this.sim.grenades) if (g.kind === 'firestar' && g.active !== undefined && g.active > 0.2) this.sfx.fireCrackleAt(g.pos, distTo(g.pos));
    }
    if (tick % 5 !== 0) return;
    for (const e of this.sim.entities.values()) {
      if (e.dead || e.id === this.player.id || (e.shock <= 0 && e.pulled <= 0)) continue;
      const m = e.movement;
      if (distTo(m.pos) > 45) continue;
      const p = new THREE.Vector3(m.pos.x + (Math.random() - 0.5) * 0.5, m.pos.y + m.height * (0.3 + Math.random() * 0.6), m.pos.z + (Math.random() - 0.5) * 0.5);
      const n = new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
      if (e.shock > 0) this.effects.impact(p, n, SHOCK_SPARK, 0.55);
      if (e.pulled > 0) this.effects.impact(p, n, PULL_SPARK, 0.45);
    }
  }

  private onSimEvent(e: SimEvent) {
    const eye = this.sim.eyeOf(this.player);
    const distTo = (p: Vec3) => Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    switch (e.type) {
      case 'ammoRefill':
        if (e.entityId === this.player.id) {
          this.sfx.refill();
          this.hud.logText('弾薬を補給', 'refill');
        }
        break;
      case 'grenadeSpawn':
        this.grenadeView?.spawn(e.grenade.id, e.grenade.pos, e.grenade.fuse, e.grenade.kind);
        break;
      case 'grenadeStick':
        this.sfx.grenadeStick(e.pos, distTo(e.pos), e.kind, e.entityId === this.player.id);
        break;
      case 'grenadeActivate':
        this.sfx.grenadeActivate(e.pos, distTo(e.pos), e.kind);
        break;
      case 'shocked':
        if (e.entityId === this.player.id) {
          this.fx.shock = 1;
          this.sfx.shocked();
        }
        break;
      case 'grenadeBounce':
        this.sfx.grenadeBounce(distTo(e.pos), e.speed);
        break;
      case 'explosion': {
        const d = distTo(e.pos);
        const ground = this.sim.world.raycast({ x: e.pos.x, y: e.pos.y + 0.2, z: e.pos.z }, { x: 0, y: -1, z: 0 }, 1.5);
        this.grenadeView?.explode(e.pos, e.radius, ground ? ground.point.y : null, e.kind);
        if (e.kind === 'arc') this.sfx.arcBlast(e.pos, d);
        else if (e.kind === 'gravity') this.sfx.gravityBlast(e.pos, d);
        else if (this.at || this.td) this.sfx.explosionAt(e.pos, d, e.kind === 'satchel' ? 1.3 : 1);
        else this.sfx.explosion(d);
        this.fpsCam.addShake(Math.max(0, (e.kind === 'arc' ? 0.6 : e.kind === 'satchel' ? 1.25 : 1) - d / (e.radius * 4)));
        if (e.ownerId === this.player.id) {
          const killed = new Set(e.hits.filter((h) => h.killed).map((h) => h.targetId));
          for (const h of e.hits) {
            const t = this.sim.targets.find((x) => x.id === h.targetId);
            if (!t) continue;
            this.targetView?.onHit(h.targetId);
            this.weaponHud.damageNumber(new THREE.Vector3(t.pos.x, t.pos.y + 1.3, t.pos.z), h.damage, false);
            this.weaponHud.hit(false, killed.has(h.targetId));
          }
          if (e.hits.length) this.sfx.hit(false);
        }
        break;
      }
      case 'playerDamaged':
        if (e.entityId === this.player.id) {
          this.vitals.damage(e.amount, e.from, this.player.movement.pos);
          this.sfx.hurt(e.amount);
          this.fx.hurt = Math.min(1, this.fx.hurt + 0.2 + e.amount / 40);
          if (e.source !== 'hazard') this.fpsCam.addShake(Math.min(0.35, 0.08 + e.amount / 60));
        }
        break;
      case 'playerDied':
        if (e.entityId === this.player.id) {
          this.sfx.death();
          if (!this.at && !this.td) this.hud.logText('倒されました', 'empty');
          this.rope.release();
        }
        break;
      case 'playerRespawn':
        if (e.entityId === this.player.id) {
          this.input.yaw = e.yaw;
          this.input.pitch = 0;
          this.input.resetRecoil();
          copy(this.prevPos, this.player.movement.pos);
          this.sfx.respawnChime();
        }
        break;
      case 'turretShot': {
        const from = this.targetView?.muzzleOf(e.targetId) ?? new THREE.Vector3(e.from.x, e.from.y, e.from.z);
        const to = new THREE.Vector3(e.to.x, e.to.y, e.to.z);
        this.targetView?.onTurretShot(e.targetId);
        this.effects.tracer(from, to, TURRET_TRACER);
        this.sfx.turretShot(distTo(e.from));
        if (e.hit === 'shield' && e.shieldId !== undefined) {
          this.shieldViews.hit(e.shieldId, e.to);
          const dir = from.clone().sub(to).normalize();
          this.effects.impact(to, dir, SHIELD_SPARK, 0.7);
          this.sfx.shieldHit(distTo(e.to));
        } else if (e.hit === 'world') {
          this.effects.impact(to, from.clone().sub(to).normalize(), WORLD_SPARK, 0.5);
        } else if (e.hit === 'none' && distTo(e.to) < 30) {
          this.sfx.bulletWhiz();
        }
        break;
      }
      case 'ammoDropSpawn': {
        const g = this.sim.world.raycast({ x: e.drop.pos.x, y: e.drop.pos.y + 0.5, z: e.drop.pos.z }, { x: 0, y: -1, z: 0 }, 4);
        this.ammoDropViews?.spawn(e.drop, g ? g.point.y : e.drop.pos.y - 0.3);
        break;
      }
      case 'ammoDropPickup':
        this.ammoDropViews?.remove(e.dropId);
        if (e.entityId === this.player.id) {
          this.sfx.refill();
          this.hud.logText('弾薬パックを拾った', 'refill');
        }
        break;
      case 'ammoDropExpire':
        this.ammoDropViews?.remove(e.dropId);
        break;
      case 'blastKill':
        if (e.ownerId === this.player.id) {
          this.sfx.kill();
          this.hud.logText('グレネードで撃破', 'kill');
        }
        break;
    }
  }

  /** グレネードを構えている間、軌道の予測線を出す */
  private updateGrenadePreview() {
    const gv = this.grenadeView;
    if (!gv) return;
    const a = this.player.arsenal;
    if (!a.cooking) {
      gv.hidePreview();
      return;
    }
    const c = weaponsConfig.COMMON;
    const kind = a.grenadeKind;
    const eye = this.sim.eyeOf(this.player);
    const origin = throwOrigin(eye, this.input.yaw, this.input.pitch);
    const vel = throwVelocity(this.input.yaw, this.input.pitch, this.player.movement.vel, c, gStat(kind, 'THROW_SPEED', c));
    const path = predictPath(origin, vel, Math.min(4, grenadeFuse(kind, c)), this.sim.world, targetColliders(this.sim.targets), grenadePhys(kind, c), TICK_DT);
    // 効く範囲：煙・炎・渦はその広さ、ほかは爆風
    const g = this.sim.gcfg;
    const radius =
      kind === 'smoke' ? grenadeNum(g.smoke, 'SMOKE_RADIUS', 6.5) : kind === 'firestar' ? grenadeNum(g.firestar, 'FIRE_RADIUS', 2.6) : kind === 'gravity' ? grenadeNum(g.gravity, 'PULL_RADIUS', 7) : blastSpec(kind, c).radius;
    gv.setPreviewKind(kind);
    gv.showPreview(path.points, path.landing, path.end, radius, path.stuck ? path.stuck.normal : null);
  }

  private onMoveEvent(e: MoveEvent) {
    const vol = this.sim.footstepVolumeOf(this.player);
    switch (e.type) {
      case 'land':
        this.sfx.landing(vol, e.impactSpeed);
        this.stepDist = 0;
        break;
      case 'jump':
      case 'doubleJump':
      case 'wallJump':
        this.sfx.footstep(vol * 0.8, true);
        break;
      case 'grappleEnd':
        this.rope.release();
        break;
    }
  }

  private onAbilityEvent(e: AbilityEvent) {
    const def = charactersConfig[this.player.character];
    switch (e.type) {
      case 'abilityUsed':
        this.viewmodel?.onAbility(def.ABILITY.TYPE);
        break;
      case 'abilityNotReady':
        this.sfx.abilityNotReady();
        break;
      case 'grappleStart':
        this.rope.fire(e.point, 'world');
        this.sfx.grappleFire();
        this.sfx.grappleHit(false);
        break;
      case 'grappleTarget':
        this.rope.fire(e.point, 'target');
        this.sfx.grappleFire();
        this.sfx.grappleHit(true);
        this.targetView?.onHit(e.targetId);
        this.hud.logText('的を引き寄せた', 'melee');
        break;
      case 'grappleMiss':
        this.rope.fire(e.point, 'miss');
        this.sfx.grappleFire();
        this.sfx.grappleMiss();
        this.hud.logText('ワイヤーが届かない', 'empty');
        break;
      case 'cloakStart':
        this.sfx.cloak(true);
        break;
      case 'cloakEnd':
        this.sfx.cloak(false);
        if (e.broken) this.hud.logText('迷彩が解けた', 'empty');
        break;
      case 'shieldStart':
        this.sfx.shieldUp();
        break;
      case 'sonarPulse': {
        const ground = this.sim.world.raycast(e.origin, { x: 0, y: -1, z: 0 }, 4);
        this.sonar.spawn(e.origin, e.radius, abilityNum(def.ABILITY, 'WAVE_SPEED', 60), ground ? ground.point.y : this.player.movement.pos.y);
        this.sfx.sonarPing();
        this.sfx.sonarReveal(e.revealed.length);
        this.hud.logText(e.revealed.length ? `${e.revealed.length} 体を発見` : '反応なし', 'refill');
        break;
      }
      case 'injectStart':
        this.sfx.inject();
        break;
      case 'overdriveStart':
        this.sfx.overdrive(true);
        this.hud.logText('オーバードライブ', 'melee');
        break;
      case 'overdriveEnd':
        this.sfx.overdrive(false);
        break;
      case 'phaseWindup':
        this.sfx.phase('windup');
        break;
      case 'phaseStart':
        this.sfx.phase('start');
        break;
      case 'phaseEnd':
        this.sfx.phase('end');
        break;
    }
  }

  /** アビリティの見た目と画面効果を毎フレーム更新する */
  private updateAbilityFx(dt: number) {
    const ab = this.player.ability;
    const def = charactersConfig[this.player.character];
    const cam = this.fpsCam.camera;
    // ワイヤーは左手のあたりから出す
    const hand = cam.localToWorld(new THREE.Vector3(-0.14, -0.16, -0.5));
    const g = this.player.movement.grapple;
    this.rope.update(dt * this.fxTimeScale, hand, g ? new THREE.Vector3(g.point.x, g.point.y, g.point.z) : null);
    this.shieldViews.update(dt, this.sim.shields, (sh) => sh.duration ?? abilityNum(charactersConfig.miranda.ABILITY, 'DURATION', 8));
    this.sonar.update(dt * this.fxTimeScale);

    const windupTotal = abilityNum(def.ABILITY, 'WINDUP', 0.5);
    const f = this.fx;
    f.phase = damp(f.phase, ab.phase > 0 ? 1 : 0, ab.phase > 0 ? 14 : 8, dt);
    f.windup = ab.phaseWindup > 0 ? 1 - ab.phaseWindup / windupTotal : damp(f.windup, 0, 12, dt);
    f.overdrive = damp(f.overdrive, ab.overdrive > 0 ? 1 : ab.inject > 0 ? 0.4 : 0, 6, dt);
    f.cloak = damp(f.cloak, ab.cloak > 0 ? 1 : 0, ab.cloak > 0 ? 6 : 10, dt);
    f.hurt = Math.max(0, f.hurt - dt * 1.6);
    // 電撃：受けている間は強く、残りが少なくなると弱まる
    f.shock = damp(f.shock, this.player.shock > 0 ? Math.min(1, this.player.shock / 1.2) : 0, 10, dt);
    if (this.player.dead) f.hurt = Math.max(f.hurt, 0.8);
    this.screenFx.set(f, dt, this.width / this.height);
  }

  /** 足音（地面と壁を走っているとき） */
  private updateFootsteps(dt: number) {
    if (this.paused || this.player.dead) return;
    const m = this.player.movement;
    const onWall = m.state === 'wallrun';
    if (m.state !== 'ground' && !onWall) return;
    const speed = lenH(m.vel);
    if (speed < 1) {
      this.stepDist = 0;
      return;
    }
    this.stepDist += speed * dt;
    const stride = onWall ? 2.0 : speed > movementConfig.WALK_SPEED * 1.1 ? 2.2 : 1.6;
    if (this.stepDist >= stride) {
      this.stepDist -= stride;
      this.sfx.footstep(this.sim.footstepVolumeOf(this.player), speed > movementConfig.WALK_SPEED * 1.1, onWall);
    }
  }

  /** 銃口が見えている位置（世界座標）。武器の表示上の銃口から、カメラの前 1m ほどの点を求める */
  private muzzleWorld(): THREE.Vector3 {
    const cam = this.fpsCam.camera;
    if (!this.viewmodel) return cam.getWorldPosition(new THREE.Vector3());
    const ndc = this.viewmodel.muzzleNdc(new THREE.Vector2());
    const p = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(cam);
    const origin = cam.getWorldPosition(new THREE.Vector3());
    return origin.clone().add(p.sub(origin).normalize().multiplyScalar(0.9));
  }

  private onWeaponEvent(e: WeaponEvent) {
    const a = this.player.arsenal;
    switch (e.type) {
      case 'shot': {
        const w = slotDef(weaponsConfig, a.slots.find((s) => s.id === e.weapon) ?? activeSlot(a));
        this.viewmodel?.onShot(e.weapon);
        this.sfx.shot(e.weapon, e.suppressed);
        // 反動（エイム中は少し小さい）
        const k = (1 - 0.35 * a.ads) * (0.85 + Math.random() * 0.3);
        this.input.addRecoil(w.RECOIL_PITCH * k, (Math.random() * 2 - 1) * w.RECOIL_YAW);
        const scoped = !!w.SCOPE && a.ads > 0.92;
        const from = scoped ? new THREE.Vector3(e.origin.x, e.origin.y - 0.08, e.origin.z) : this.muzzleWorld();
        this.effects.muzzleFlash(from, w.PELLETS > 1 ? 1.5 : 1);
        // 当たった的ごとにダメージをまとめる（ショットガンの粒を1つの数字に）
        const perTarget = new Map<number, { dmg: number; head: boolean; point: THREE.Vector3 }>();
        e.hits.forEach((h, i) => {
          const to = new THREE.Vector3(h.point.x, h.point.y, h.point.z);
          // ショットガンの光跡は数本だけにして、うるさくならないようにする
          if (w.PELLETS === 1 || i % 3 === 0) this.effects.tracer(from, to, TRACER_COLORS[e.weapon]);
          const n = new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z);
          if (h.kind === 'world') {
            this.effects.impact(to, n, WORLD_SPARK, w.PELLETS > 1 ? 0.6 : 1);
            this.effects.decal(to, n);
          } else if (h.kind === 'actor') {
            // 敵に当たった（ダメージの数字と当たりの印は attrition/controller.ts が出す）
            this.effects.impact(to, n, TARGET_SPARK, 0.8);
          } else if (h.kind === 'shield') {
            this.effects.impact(to, n, SHIELD_SPARK, 0.7);
            if (h.shieldId !== undefined) this.shieldViews.hit(h.shieldId, h.point);
          } else if (h.kind === 'target' && h.targetId !== undefined) {
            this.effects.impact(to, n, TARGET_SPARK, 0.8);
            const acc = perTarget.get(h.targetId) ?? { dmg: 0, head: false, point: to };
            acc.dmg += h.damage ?? 0;
            acc.head ||= !!h.head;
            perTarget.set(h.targetId, acc);
          }
        });
        const killed = new Set(this.player.arsenal.events.filter((x) => x.type === 'targetKilled').map((x) => (x as { targetId: number }).targetId));
        for (const [id, d] of perTarget) {
          this.targetView?.onHit(id);
          this.weaponHud.damageNumber(d.point, d.dmg, d.head);
          this.weaponHud.hit(d.head, killed.has(id));
          this.sfx.hit(d.head);
        }
        break;
      }
      case 'targetKilled':
        this.sfx.kill();
        this.hud.logText(`撃破 ${e.ttk.toFixed(2)}秒`, 'kill');
        break;
      case 'dryFire':
        this.sfx.dryFire();
        break;
      case 'spinUp':
        this.sfx.spin(true);
        break;
      case 'spinDown':
        this.sfx.spin(false);
        break;
      case 'reloadStart':
        this.sfx.reloadStart(e.perShell);
        break;
      case 'reloadShell':
        this.sfx.reloadShell();
        this.viewmodel?.onShellLoaded();
        break;
      case 'reloadEnd':
        this.sfx.reloadEnd();
        break;
      case 'swap':
        this.sfx.swap();
        this.input.resetRecoil();
        break;
      case 'grenadeCook':
        this.sfx.grenadeCook();
        break;
      case 'grenadeThrow':
        this.sfx.grenadeThrow();
        this.viewmodel?.onThrow();
        break;
      case 'grenadeDetonate':
        this.sfx.detonatorClick();
        this.viewmodel?.onDetonate();
        break;
      case 'grenadeEmpty':
        this.sfx.grenadeEmpty();
        this.hud.logText('グレネードがない', 'empty');
        break;
      case 'grenadeRegen':
        this.hud.logText(`グレネード回復（${e.count}）`, 'refill');
        break;
      case 'melee': {
        this.sfx.meleeSwing();
        this.viewmodel?.onMelee(!!e.hit);
        this.fpsCam.addShake(e.hit ? 0.35 : 0.1);
        if (e.hit) {
          this.sfx.meleeHit(e.hit.kind);
          const p = new THREE.Vector3(e.hit.point.x, e.hit.point.y, e.hit.point.z);
          const n = new THREE.Vector3(e.hit.normal.x, e.hit.normal.y, e.hit.normal.z);
          this.effects.impact(p, n, e.hit.kind === 'target' ? TARGET_SPARK : WORLD_SPARK, 0.9);
          if (e.hit.kind === 'target' && e.hit.targetId !== undefined) {
            const killed = this.player.arsenal.events.some((x) => x.type === 'targetKilled' && x.targetId === e.hit!.targetId);
            this.targetView?.onHit(e.hit.targetId);
            this.weaponHud.damageNumber(p, e.hit.damage ?? 0, false);
            this.weaponHud.hit(false, killed);
          }
        }
        if (e.lunge) this.hud.logText('踏み込み格闘', 'melee');
        break;
      }
    }
  }
}
