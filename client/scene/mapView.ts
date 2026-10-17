/**
 * Blender で作ったマップ（ネオン都市）の見た目。
 * - マップのモデル（client/assets/maps/<name>.glb）を読み込み、マテリアルの名前を見て
 *   濡れた床・コンクリート・窓明かり・ガラス・ネオンなどの専用の質感に置き換える
 * - 看板・大画面（鯉の映像・企業広告・縦長のネオン）を、配置データ（LevelData.decor）から作る
 * - 照明（点光源）、桜の花びら、外周の高架を走る列車、空を飛ぶ車、空の大きな輪の高架
 * - 周りの景色を映り込み用に1回だけ撮って、床・ガラス・金属に映す
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadGltfFrom } from '../assets';
import type { BoxDef, DecorDef, LevelData } from '../../shared/level';
import neonCityUrl from '../assets/maps/neon_city.glb?url';
import fortressUrl from '../assets/maps/fortress.glb?url';
import { makeFortressMaterials } from './fortressMaterials';

const MAP_URLS: Record<string, string> = { neon_city: neonCityUrl, fortress: fortressUrl };
/** 外周の高架レールの高さ（assets-src/maps/build_map.py の RAIL_Y と同じ） */
const RAIL_Y = 38;

/** 共通の小さな雑音関数（GLSL） */
const NOISE_GLSL = /* glsl */ `
  float vrHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vrNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(vrHash(i), vrHash(i + vec2(1, 0)), u.x), mix(vrHash(i + vec2(0, 1)), vrHash(i + vec2(1, 1)), u.x), u.y);
  }
  float vrFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vrNoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

/** ワールド座標を fragment shader へ渡す（onBeforeCompile 用） */
function addWorldPos(shader: { vertexShader: string; fragmentShader: string }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);',
    );
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n${NOISE_GLSL}`);
}

export interface MapMaterials {
  floor: THREE.MeshStandardMaterial;
  envUsers: THREE.MeshStandardMaterial[];
  all: THREE.Material[];
}

/** マテリアルの名前 → ゲーム用のマテリアル */
function makeMaterials(): { byName: Map<string, THREE.Material>; envUsers: THREE.MeshStandardMaterial[] } {
  const byName = new Map<string, THREE.Material>();
  const envUsers: THREE.MeshStandardMaterial[] = [];

  // --- 濡れた床：タイルの目地と、水たまり（つるつるで周りが映る） ---
  const floor = new THREE.MeshStandardMaterial({ color: '#25242d', roughness: 0.6, metalness: 0.05, envMapIntensity: 1.3 });
  floor.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 fp = vWPos.xz;
        float puddle = smoothstep(0.52, 0.6, vrFbm(fp * 0.11 + 3.1));
        vec2 tile = abs(fract(fp / 2.0) - 0.5);
        float seam = 1.0 - smoothstep(0.47, 0.49, max(tile.x, tile.y));
        float grime = vrFbm(fp * 0.6);
        diffuseColor.rgb *= (0.78 + 0.35 * grime) * mix(0.82, 1.0, seam);
        diffuseColor.rgb *= mix(1.0, 0.7, puddle);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor * (0.75 + 0.5 * grime), 0.035, puddle);`,
      );
  };
  byName.set('Floor', floor);
  envUsers.push(floor);

  // --- 道路のアスファルト：細かいざらつきと、大きな水たまり ---
  const asphalt = new THREE.MeshStandardMaterial({ color: '#1b1a21', roughness: 0.7, metalness: 0.05, envMapIntensity: 1.4 });
  asphalt.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 ap = vWPos.xz;
        float puddle = smoothstep(0.5, 0.58, vrFbm(ap * 0.08 + 7.3));
        float grit = vrNoise(ap * 9.0);
        float apatch = vrFbm(ap * 0.35);
        diffuseColor.rgb *= (0.8 + 0.25 * apatch + 0.12 * grit) * mix(1.0, 0.65, puddle);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor * (0.8 + 0.3 * grit), 0.03, puddle);`,
      );
  };
  byName.set('Asphalt', asphalt);
  envUsers.push(asphalt);

  // --- 室内の床：磨いたタイル（水たまりなし）。駐車場の床：コンクリート ---
  const indoorFloor = (color: string, tile: number, rough: number, seamDark: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05, envMapIntensity: 0.9 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 ip = vWPos.xz;
        vec2 it = abs(fract(ip / ${tile.toFixed(2)}) - 0.5);
        float iseam = 1.0 - smoothstep(0.475, 0.49, max(it.x, it.y));
        float igrime = vrFbm(ip * 0.4);
        diffuseColor.rgb *= (0.82 + 0.3 * igrime) * mix(${seamDark.toFixed(2)}, 1.0, iseam);`,
      );
    };
    envUsers.push(m);
    return m;
  };
  byName.set('FloorIn', indoorFloor('#4a4652', 1.0, 0.28, 0.75));
  byName.set('GarageFloor', indoorFloor('#3a3940', 6.0, 0.55, 0.9));
  (byName.get('FloorIn') as THREE.MeshStandardMaterial).emissive = new THREE.Color('#2a2026');
  (byName.get('GarageFloor') as THREE.MeshStandardMaterial).emissive = new THREE.Color('#262e36');

  // --- コンクリートの壁：雨のしみ（縦の筋）と、ざらつき ---
  const concrete = (color: string, rough: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02, envMapIntensity: 0.5 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 cp = vec2(vWPos.x + vWPos.z, vWPos.y);
        float streak = vrFbm(vec2(cp.x * 1.3, cp.y * 0.08));
        float grain = vrFbm(cp * 1.7);
        diffuseColor.rgb *= 0.72 + 0.32 * streak + 0.12 * grain;`,
      );
    };
    envUsers.push(m);
    return m;
  };
  byName.set('Concrete', concrete('#3c3a46', 0.85));
  byName.set('ConcreteDark', concrete('#26242e', 0.8));
  byName.set('Stone', concrete('#4a4752', 0.75));

  const std = (color: string, rough: number, metal: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
    envUsers.push(m);
    return m;
  };
  byName.set('Metal', std('#7c818e', 0.32, 0.85, { envMapIntensity: 1.2 }));
  byName.set('MetalDark', std('#2a2c34', 0.42, 0.7, { envMapIntensity: 1.0 }));
  byName.set('ContainerRed', std('#8c2d32', 0.55, 0.35));
  byName.set('ContainerBlue', std('#26508e', 0.55, 0.35));
  byName.set('ContainerTeal', std('#1f6f6c', 0.55, 0.35));
  byName.set('ContainerOrange', std('#b05a20', 0.55, 0.35));
  byName.set('Wood', std('#6e4b2c', 0.85, 0.0));
  byName.set('Bark', std('#3b2a25', 0.9, 0.0));
  byName.set('Leaf', std('#22553c', 0.75, 0.0, { side: THREE.DoubleSide, emissive: new THREE.Color('#0d3a26'), emissiveIntensity: 0.4 }));
  byName.set('Awning', std('#7d2b5d', 0.7, 0.0));
  byName.set('Screen', std('#05060b', 0.3, 0.2));
  byName.set('Blossom', std('#ffb6e2', 0.75, 0.0, { emissive: new THREE.Color('#ff4fb4'), emissiveIntensity: 0.55 }));
  // 室内の壁と天井（天井の照明パネルで照らされている感じを、少しの自己発光で出す）
  byName.set('Interior', std('#5a5260', 0.85, 0.0, { emissive: new THREE.Color('#3a2a30'), emissiveIntensity: 0.35, envMapIntensity: 0.3 }));
  byName.set('Ceiling', std('#2c2a32', 0.9, 0.0, { emissive: new THREE.Color('#2a2228'), emissiveIntensity: 0.3, envMapIntensity: 0.2 }));
  byName.set('Paint', std('#bdb8ae', 0.6, 0.0));
  byName.set('PaintYellow', std('#c99a22', 0.6, 0.0));
  byName.set('CarRed', std('#8c1d28', 0.28, 0.55, { envMapIntensity: 1.5 }));
  byName.set('CarBlue', std('#1d3f8c', 0.28, 0.55, { envMapIntensity: 1.5 }));
  byName.set('CarWhite', std('#c9ccd4', 0.3, 0.45, { envMapIntensity: 1.5 }));
  byName.set('CarBlack', std('#16171c', 0.25, 0.6, { envMapIntensity: 1.5 }));

  // --- ガラス：半透明で、周りの景色とネオンが映る ---
  const glass = new THREE.MeshStandardMaterial({
    color: '#7fd0ff',
    roughness: 0.04,
    metalness: 0.35,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.8,
  });
  byName.set('Glass', glass);
  envUsers.push(glass);

  // --- 窓：頂点カラーの色で光る。窓の中に枠・十字の桟・天井の明かり・カーテンのむらを描く ---
  const win = new THREE.MeshStandardMaterial({ color: '#0d0e16', roughness: 0.12, metalness: 0.6, envMapIntensity: 1.0, vertexColors: true });
  win.defines = { USE_UV: '' };
  win.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vec3(0.05, 0.05, 0.08);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 wu = vUv;
        // 枠（縁）と十字の桟
        float frame = step(0.06, wu.x) * step(wu.x, 0.94) * step(0.05, wu.y) * step(wu.y, 0.95);
        float mull = 1.0 - (1.0 - smoothstep(0.012, 0.022, abs(wu.x - 0.5))) - (1.0 - smoothstep(0.012, 0.022, abs(wu.y - 0.64)));
        // 部屋の明かり：天井が明るく、下へいくほど暗い。部屋ごとのむら・カーテン
        float id = vrHash(floor(vWPos.xz * 0.4) + floor(vWPos.y / 3.6) * 7.1);
        float ceiling = 0.45 + 0.55 * smoothstep(0.1, 0.95, wu.y);
        float curtain = mix(1.0, 0.35 + 0.65 * smoothstep(0.3, 0.7, abs(fract(wu.x * (1.0 + floor(id * 3.0))) - 0.5) * 2.0), step(0.6, id));
        float inner = 0.6 + 0.4 * vrNoise(wu * 3.0 + id * 10.0);
        totalEmissiveRadiance += vColor.rgb * 1.05 * ceiling * curtain * inner * frame * clamp(mull, 0.0, 1.0);`,
      );
  };
  byName.set('Window', win);
  envUsers.push(win);

  // --- ネオン：明るさ 1 を超える色で、ブルームで光る ---
  const neon = (hex: string, k = 2.4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });
  byName.set('NeonCyan', neon('#4fd1ff'));
  byName.set('NeonPink', neon('#ff4fd8'));
  byName.set('NeonPurple', neon('#8a5cff', 2.8));
  byName.set('NeonAmber', neon('#ffb45c', 2.0));
  byName.set('NeonWhite', neon('#e8f0ff', 1.8));
  byName.set('NeonRed', neon('#ff3040', 3.0));
  byName.set('NeonSoft', neon('#4fd1ff', 1.15));
  byName.set('NeonWarm', neon('#fff0d8', 1.0));
  for (const [name, m] of byName) m.name = name;
  return { byName, envUsers };
}

// ---------------------------------------------------------------------------
// 看板の絵（キャンバスに描く）
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const JP_FONT = `"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif`;
const EN_FONT = `"Rajdhani", "Segoe UI", "Helvetica Neue", sans-serif`;

function glowText(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, font: string, blur = 24) {
  g.font = font;
  g.fillStyle = color;
  g.shadowColor = color;
  for (const b of [blur, blur * 0.5, 0]) {
    g.shadowBlur = b;
    g.fillText(text, x, y);
  }
  g.shadowBlur = 0;
  g.fillStyle = '#ffffff';
  g.globalAlpha = 0.55;
  g.fillText(text, x, y);
  g.globalAlpha = 1;
}

/** 縦書きのネオン看板 */
function verticalNeon(text: string, sub: string, color: string): THREE.CanvasTexture {
  return canvasTexture(256, 1024, (g, w, h) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const chars = [...text];
    const step = Math.min(150, (h * 0.7) / chars.length);
    chars.forEach((ch, i) => glowText(g, ch, w / 2, 90 + step * (i + 0.5), color, `900 ${Math.floor(step * 0.82)}px ${JP_FONT}`, 30));
    const words = sub.split(' ');
    words.forEach((wd, i) => glowText(g, wd, w / 2, h - 170 + i * 52, '#ffffff', `700 44px ${EN_FONT}`, 16));
    // 枠
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.shadowColor = color;
    g.shadowBlur = 18;
    g.strokeRect(14, 14, w - 28, h - 28);
  });
}

/** 横長の小さなネオン */
function smallNeon(text: string, color: string): THREE.CanvasTexture {
  return canvasTexture(1024, 256, (g, w, h) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    glowText(g, text, w / 2, h / 2, color, `900 150px ${JP_FONT}`, 30);
  });
}

/** 企業ロゴの看板 */
function logoBoard(style: string): THREE.CanvasTexture {
  return canvasTexture(1024, 576, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#0b0f24');
    grd.addColorStop(1, '#1b0c2c');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (style === 'arcadia') {
      // 山と朝日
      g.fillStyle = '#ff7ac8';
      g.beginPath();
      g.arc(w * 0.5, h * 0.62, 120, Math.PI, 0);
      g.fill();
      g.fillStyle = '#2a1650';
      g.beginPath();
      g.moveTo(w * 0.15, h * 0.7);
      g.lineTo(w * 0.42, h * 0.32);
      g.lineTo(w * 0.62, h * 0.7);
      g.fill();
      glowText(g, 'ARCADIA', w / 2, h * 0.8, '#bfe9ff', `700 120px ${EN_FONT}`);
      glowText(g, 'HORIZONS ― 地平の向こうへ', w / 2, h * 0.93, '#ff9ad8', `600 44px ${JP_FONT}`, 10);
    } else {
      // 三角のロゴ
      g.strokeStyle = '#4fd1ff';
      g.lineWidth = 14;
      g.shadowColor = '#4fd1ff';
      g.shadowBlur = 24;
      g.beginPath();
      g.moveTo(w / 2, 70);
      g.lineTo(w / 2 + 110, 250);
      g.lineTo(w / 2 - 110, 250);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(w / 2, 140);
      g.lineTo(w / 2 + 55, 230);
      g.lineTo(w / 2 - 55, 230);
      g.closePath();
      g.stroke();
      g.shadowBlur = 0;
      glowText(g, 'KAZE', w / 2, 360, '#e8f6ff', `700 140px ${EN_FONT}`);
      glowText(g, '風重工 INDUSTRIES', w / 2, 470, '#4fd1ff', `600 54px ${JP_FONT}`, 12);
    }
  });
}

/** 大画面のうち、映像の上に重ねる文字 */
function screenOverlay(style: string): THREE.CanvasTexture {
  return canvasTexture(512, 820, (g, w, h) => {
    g.textBaseline = 'middle';
    if (style === 'koi' || style === 'koi2') {
      g.textAlign = 'right';
      const col = style === 'koi' ? '#9fe8ff' : '#ffb0e6';
      const jp = style === 'koi' ? '流れ続ける' : '夜を泳ぐ';
      const en = style === 'koi' ? ['STILL', 'WE', 'FLOW'] : ['SWIM', 'THE', 'NIGHT'];
      [...jp].forEach((ch, i) => glowText(g, ch, w - 40, 90 + i * 74, col, `800 64px ${JP_FONT}`, 16));
      g.textAlign = 'left';
      en.forEach((t, i) => glowText(g, t, 40, h - 200 + i * 56, '#ffffff', `700 54px ${EN_FONT}`, 10));
    } else if (style === 'silver') {
      g.textAlign = 'center';
      glowText(g, '銀界', w / 2, 120, '#ffffff', `900 140px ${JP_FONT}`, 24);
      glowText(g, 'SILVER REACH', w / 2, 230, '#9fd8ff', `700 60px ${EN_FONT}`, 12);
    } else if (style === 'nexus') {
      g.textAlign = 'left';
      glowText(g, 'NEXUS', 40, 110, '#ffffff', `700 110px ${EN_FONT}`, 18);
      ['PEOPLE', 'CITIES', 'TOMORROW'].forEach((t, i) => glowText(g, t, 44, 210 + i * 54, '#8fe3ff', `600 48px ${EN_FONT}`, 8));
      glowText(g, '人と街の、明日へ', 44, h - 80, '#ffb45c', `700 48px ${JP_FONT}`, 10);
    }
  });
}

/** 大画面の映像（シェーダー）。鯉が泳ぐ・夜景が流れる・地図の線が走る */
function screenMaterial(style: string, overlay: THREE.Texture, time: { value: number }): THREE.ShaderMaterial {
  const kind = style === 'koi' ? 0 : style === 'koi2' ? 1 : style === 'silver' ? 2 : 3;
  return new THREE.ShaderMaterial({
    toneMapped: false,
    fog: false,
    uniforms: { uTime: time, uOverlay: { value: overlay }, uKind: { value: kind } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform sampler2D uOverlay; uniform int uKind;
      varying vec2 vUv;
      ${NOISE_GLSL}
      // 鯉（流れる体・ひれ・尾）。画面の中をゆっくり回るように泳ぐ。p は画面の座標
      float koi(vec2 p, float t, float phase, float size) {
        float a = t * 0.25 + phase;
        // 頭の位置（画面の中の楕円の上を回る）と、進む向き
        vec2 headPos = vec2(0.5, 0.5) + vec2(0.24 * cos(a), 0.3 * sin(a * 0.8));
        vec2 vel = normalize(vec2(-0.24 * sin(a), 0.3 * 0.8 * cos(a * 0.8)) + 1e-4);
        vec2 dir = vel;
        vec2 nrm = vec2(-dir.y, dir.x);
        float L = 0.42 * size;
        vec2 q = p - headPos;
        float along = -dot(q, dir) / L;      // 0 = 頭、1 = 尾
        if (along < -0.05 || along > 1.3) return 0.0;
        // 体が後ろへいくほど、曲がりながらゆれる
        float across = dot(q, nrm) / size - 0.06 * sin(along * 5.0 - t * 5.0 + phase * 3.0) * along;
        float body = 0.075 * pow(max(0.0, sin(3.14159 * clamp(along, 0.0, 1.0))), 0.65) * (1.0 - 0.5 * along);
        float tail = along > 0.9 ? (along - 0.9) * 0.6 : 0.0;
        float fin = (abs(along - 0.28) < 0.09) ? 0.06 * (1.0 - abs(along - 0.28) / 0.09) : 0.0;
        float w = max(body, max(tail, fin));
        float d = abs(across) - w;
        float inner = smoothstep(0.01, -0.006, d);
        float halo = smoothstep(0.05, 0.0, d) * 0.35;
        return inner + halo;
      }
      void main() {
        vec2 uv = vUv;
        vec3 col;
        if (uKind <= 1) {
          vec3 deep = uKind == 0 ? mix(vec3(0.02, 0.07, 0.2), vec3(0.06, 0.2, 0.42), uv.y) : mix(vec3(0.16, 0.02, 0.14), vec3(0.36, 0.07, 0.3), uv.y);
          vec3 glow = uKind == 0 ? vec3(0.45, 0.88, 1.0) : vec3(1.0, 0.5, 0.82);
          col = deep;
          // 水のゆらぎ（光の網目）
          float c = vrFbm(uv * vec2(4.0, 6.0) + vec2(uTime * 0.05, uTime * 0.12));
          float c2 = vrFbm(uv * vec2(7.0, 9.0) - vec2(uTime * 0.08, uTime * 0.05));
          col += glow * 0.22 * smoothstep(0.5, 0.75, c) + glow * 0.12 * smoothstep(0.55, 0.8, c2);
          float k = koi(uv, uTime, 0.0, 1.0) + 0.75 * koi(uv, uTime * 0.8, 2.4, 0.6);
          // 鱗の模様
          float scales = 0.75 + 0.25 * sin(uv.x * 140.0) * sin(uv.y * 160.0 - uTime);
          col += glow * k * 1.25 * scales;
          // 泡
          float bub = smoothstep(0.985, 1.0, vrNoise(vec2(uv.x * 40.0, uv.y * 30.0 - uTime * 2.0)));
          col += glow * bub * 0.8;
        } else if (uKind == 2) {
          // 夜景が流れる
          col = mix(vec3(0.05, 0.03, 0.12), vec3(0.25, 0.08, 0.3), uv.y);
          float x = uv.x * 18.0 + uTime * 0.4;
          float hgt = 0.15 + 0.45 * vrNoise(vec2(floor(x), 1.0));
          if (uv.y < hgt) {
            col = vec3(0.04, 0.03, 0.08);
            vec2 wcell = vec2(fract(x * 3.0), fract(uv.y * 40.0));
            float lit = step(0.55, vrHash(floor(vec2(x * 3.0, uv.y * 40.0))));
            col += vec3(1.0, 0.7, 0.4) * lit * step(0.3, wcell.x) * step(0.3, wcell.y) * 0.9;
          }
        } else {
          // 地図の線が光りながら走る
          col = vec3(0.02, 0.04, 0.08);
          vec2 g = abs(fract(uv * vec2(12.0, 20.0)) - 0.5);
          col += vec3(0.1, 0.4, 0.6) * smoothstep(0.47, 0.5, max(g.x, g.y)) * 0.4;
          float n = vrFbm(uv * 4.0);
          float route = smoothstep(0.02, 0.0, abs(n - 0.5 - 0.1 * sin(uTime * 0.3)));
          col += vec3(0.3, 0.9, 1.0) * route * 1.5;
          float pulse = smoothstep(0.03, 0.0, abs(fract(uv.y * 2.0 - uTime * 0.25) - 0.5) - 0.0);
          col += vec3(1.0, 0.5, 0.9) * route * pulse;
        }
        // 走査線と、画面の縁の暗がり
        col *= 0.85 + 0.15 * sin(uv.y * 600.0 + uTime * 10.0);
        vec2 e = abs(uv - 0.5) * 2.0;
        col *= 1.0 - 0.35 * pow(max(e.x, e.y), 6.0);
        vec4 o = texture2D(uOverlay, uv);
        col = mix(col, o.rgb * 1.3, o.a);
        gl_FragColor = vec4(col * 0.95, 1.0);
      }`,
  });
}

/** ホログラム看板（半透明で、走査線が流れる） */
function holoMaterial(style: string, time: { value: number }): THREE.ShaderMaterial {
  const tex = canvasTexture(512, 1024, (g, w) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (style === 'nexus_holo') {
      glowText(g, 'NEXUS', w / 2, 140, '#bff3ff', `700 120px ${EN_FONT}`);
      ['未来は', 'ここに', 'ある'].forEach((t, i) => glowText(g, t, w / 2, 380 + i * 150, '#4fd1ff', `900 120px ${JP_FONT}`));
    } else {
      g.strokeStyle = '#ff9ad8';
      g.lineWidth = 12;
      g.shadowColor = '#ff4fd8';
      g.shadowBlur = 30;
      g.beginPath();
      g.moveTo(w / 2, 90);
      g.lineTo(w / 2 + 120, 300);
      g.lineTo(w / 2 - 120, 300);
      g.closePath();
      g.stroke();
      glowText(g, 'KAZE', w / 2, 430, '#ffe0f4', `700 140px ${EN_FONT}`);
      ['空を', '走れ'].forEach((t, i) => glowText(g, t, w / 2, 640 + i * 160, '#ff4fd8', `900 140px ${JP_FONT}`));
    }
  });
  const col = style === 'nexus_holo' ? new THREE.Color('#4fd1ff') : new THREE.Color('#ff4fd8');
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uTime: time, uTex: { value: tex }, uCol: { value: col } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform sampler2D uTex; uniform vec3 uCol;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        // ときどき横にずれる（ホログラムの乱れ）
        float glitch = step(0.97, fract(sin(floor(uTime * 6.0) * 12.9898) * 43758.5)) * 0.02 * sin(uv.y * 80.0);
        vec4 t = texture2D(uTex, uv + vec2(glitch, 0.0));
        float scan = 0.65 + 0.35 * sin(uv.y * 400.0 - uTime * 8.0);
        float band = smoothstep(0.0, 0.08, abs(fract(uv.y * 0.5 - uTime * 0.15) - 0.5));
        vec3 c = (t.rgb * 1.8 + uCol * 0.08) * scan * (0.75 + 0.25 * band);
        vec2 e = abs(uv - 0.5) * 2.0;
        float edge = smoothstep(0.94, 1.0, max(e.x, e.y));
        c += uCol * edge * 1.5;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// ---------------------------------------------------------------------------

export class MapView {
  readonly group = new THREE.Group();
  private readonly time = { value: 0 };
  private readonly disposables: Array<{ dispose(): void }> = [];
  private envUsers: THREE.MeshStandardMaterial[] = [];
  private petals: THREE.Points | null = null;
  private petalData: Float32Array | null = null;
  private train: THREE.Group | null = null;
  private trainAngle = 0;
  private cars: Array<{ r: number; y: number; a: number; speed: number; tilt: number }> = [];
  /** 空を飛ぶ車（まとめて1回で描く） */
  private carMesh: THREE.InstancedMesh | null = null;
  private readonly carDummy = new THREE.Object3D();
  private lights: THREE.PointLight[] = [];

  private constructor(readonly level: LevelData) {}

  /** マップのモデルを読み込んで作る */
  static async load(level: LevelData): Promise<MapView> {
    const v = new MapView(level);
    const url = MAP_URLS[level.visual ?? ''];
    if (url) {
      const loader = new GLTFLoader();
      // 公開ページ用のビルドでは、圧縮なしのマップを使う（WebAssembly を使う展開器を読み込まない）
      if (import.meta.env.MODE !== 'artifact') loader.setMeshoptDecoder((await import('three/examples/jsm/libs/meshopt_decoder.module.js')).MeshoptDecoder);
      const gltf = await loadGltfFrom(loader, url);
      v.applyMaterials(gltf.scene);
      v.group.add(gltf.scene);
    }
    if (level.style === 'fortress') {
      v.buildFortressSigns();
      return v;
    }
    v.buildSigns();
    v.buildLights();
    v.buildPetals();
    v.buildTrain();
    v.buildSkyTraffic();
    return v;
  }

  private applyMaterials(root: THREE.Object3D) {
    const { byName, envUsers } = this.level.style === 'fortress' ? makeFortressMaterials() : makeMaterials();
    this.envUsers = envUsers;
    for (const m of byName.values()) this.disposables.push(m);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 「Bg_」で始まるものは遠景（マップの外のビル）。同じ質感を使い、影は落とさない・受けない
      const raw = (mesh.material as THREE.Material).name;
      const far = raw.startsWith('Bg_');
      const name = far ? raw.slice(3) : raw;
      const rep = byName.get(name);
      if (rep) mesh.material = rep;
      const geo = mesh.geometry as THREE.BufferGeometry;
      // 窓の色の頂点カラー（書き出しの都合で color_1 になっていることがある）
      if (name === 'Window' && !geo.getAttribute('color') && geo.getAttribute('color_1')) geo.setAttribute('color', geo.getAttribute('color_1'));
      const neon = name.startsWith('Neon') || name.startsWith('FLight') || name.startsWith('FMark') || name === 'FHazardBlack';
      const flat = name === 'FPavement' || name === 'FGrass' || name === 'FDirt' || name === 'FWalk' || name === 'FAsphalt';
      mesh.castShadow = !far && !neon && !flat && name !== 'Glass' && name !== 'Window';
      mesh.receiveShadow = !far && !name.startsWith('Neon') && !name.startsWith('FLight');
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    });
  }

  // --- 看板・大画面 ---
  private buildSigns() {
    const decor = this.level.decor ?? [];
    for (const d of decor) {
      const p = d.params ?? {};
      const style = String(p.style ?? '');
      const w = d.size?.x ?? 4;
      const h = d.size?.y ?? 2;
      let mesh: THREE.Mesh | null = null;
      if (d.type === 'screen') {
        const overlay = screenOverlay(style);
        const mat = screenMaterial(style, overlay, this.time);
        this.disposables.push(overlay, mat);
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      } else if (d.type === 'logo') {
        const tex = logoBoard(style);
        const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6) });
        this.disposables.push(tex, mat);
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      } else if (d.type === 'vneon' || d.type === 'neon') {
        const alt = style.startsWith('v') || style.startsWith('n') ? style.length > 1 : false;
        const text = String((alt ? p.text2 : p.text) ?? '');
        const sub = String((alt ? p.sub2 : p.sub) ?? '');
        const color = String(p.color ?? '#ff4fd8');
        const tex = d.type === 'vneon' ? verticalNeon(text, sub, color) : smallNeon(text, color);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, color: new THREE.Color(2.2, 2.2, 2.2) });
        this.disposables.push(tex, mat);
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      }
      if (!mesh) continue;
      mesh.position.set(d.pos.x, d.pos.y, d.pos.z);
      mesh.rotation.y = (d.yaw * Math.PI) / 180;
      // 看板は向いている方へ少しだけ出す（壁と重ならないように）
      mesh.translateZ(0.02);
      this.group.add(mesh);
    }
    // 壁走りに使うホログラム看板（当たり判定の箱の両面に貼る）
    for (const b of this.level.boxes) {
      if (b.tag !== 'billboard') continue;
      const mat = holoMaterial(String(b.vis?.style ?? 'kaze_holo'), this.time);
      this.disposables.push(mat);
      const thinX = b.size.x < b.size.z;
      const w = thinX ? b.size.z : b.size.x;
      const geo = new THREE.PlaneGeometry(w - 0.3, b.size.y - 0.3);
      for (const s of [-1, 1]) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(b.center.x, b.center.y, b.center.z);
        if (thinX) {
          m.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
          m.position.x += s * (b.size.x / 2 + 0.03);
        } else {
          m.rotation.y = s > 0 ? 0 : Math.PI;
          m.position.z += s * (b.size.z / 2 + 0.03);
        }
        this.group.add(m);
      }
    }
  }

  // --- 軍事要塞：門の看板・旗（紋章）。キャンバスに描く ---
  private buildFortressSigns() {
    for (const d of this.level.decor ?? []) {
      const p = d.params ?? {};
      if (d.type === 'gatesign') {
        const w = d.size?.x ?? 8;
        const h = d.size?.y ?? 1.4;
        const tex = canvasTexture(1024, Math.round((1024 * h) / w), (g, W, H) => {
          g.fillStyle = '#1d2128';
          g.fillRect(0, 0, W, H);
          g.strokeStyle = '#d8b02a';
          g.lineWidth = H * 0.06;
          g.strokeRect(H * 0.05, H * 0.05, W - H * 0.1, H - H * 0.1);
          g.fillStyle = '#e8e6de';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.font = `700 ${Math.round(H * 0.5)}px ${EN_FONT}`;
          g.fillText(String(p.text ?? ''), W / 2, H * 0.42);
          g.fillStyle = '#d8b02a';
          g.font = `600 ${Math.round(H * 0.22)}px ${JP_FONT}`;
          g.fillText(String(p.sub ?? ''), W / 2, H * 0.8);
        });
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
        this.disposables.push(tex, mat);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        m.position.set(d.pos.x, d.pos.y, d.pos.z);
        m.rotation.y = (d.yaw * Math.PI) / 180;
        m.translateZ(0.08);
        this.group.add(m);
      } else if (d.type === 'banner') {
        const w = d.size?.x ?? 4;
        const h = d.size?.y ?? 7;
        const tex = canvasTexture(256, Math.round((256 * h) / w), (g, W, H) => {
          g.fillStyle = '#2b3b5e';
          g.fillRect(0, 0, W, H);
          g.fillStyle = '#22304d';
          g.fillRect(0, 0, W * 0.08, H);
          g.fillRect(W * 0.92, 0, W * 0.08, H);
          // 翼の紋章
          g.save();
          g.translate(W / 2, H * 0.42);
          g.fillStyle = '#dfe3ea';
          for (const sgn of [-1, 1]) {
            for (let k = 0; k < 4; k++) {
              g.beginPath();
              g.moveTo(sgn * 8, -6 + k * 14);
              g.lineTo(sgn * (W * 0.42 - k * 14), -34 + k * 18);
              g.lineTo(sgn * (W * 0.42 - k * 14 - 10), -22 + k * 18);
              g.lineTo(sgn * 8, 6 + k * 14);
              g.fill();
            }
          }
          g.beginPath();
          g.moveTo(0, -40);
          g.lineTo(16, 0);
          g.lineTo(0, 54);
          g.lineTo(-16, 0);
          g.fill();
          g.restore();
          g.fillStyle = '#d8b02a';
          g.fillRect(W * 0.2, H * 0.78, W * 0.6, 4);
        });
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide });
        this.disposables.push(tex, mat);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        m.position.set(d.pos.x, d.pos.y, d.pos.z);
        m.rotation.y = (d.yaw * Math.PI) / 180;
        m.translateZ(0.02);
        this.group.add(m);
      }
    }
  }

  /** 点光源を使うか（画質「低」では使わない） */
  setPointLights(on: boolean): void {
    for (const l of this.lights) l.visible = on;
  }

  // --- 照明 ---
  private buildLights() {
    for (const d of this.level.decor ?? []) {
      if (d.type !== 'light') continue;
      const p = d.params ?? {};
      const l = new THREE.PointLight(String(p.color ?? '#ffffff'), Number(p.intensity ?? 30), Number(p.distance ?? 25), 1.6);
      l.position.set(d.pos.x, d.pos.y, d.pos.z);
      this.group.add(l);
      this.lights.push(l);
    }
  }

  // --- 桜の花びら ---
  private buildPetals() {
    const tree = (this.level.decor ?? []).find((d) => d.type === 'sakura');
    if (!tree) return;
    const N = 260;
    const pos = new Float32Array(N * 3);
    const data = new Float32Array(N * 4); // 揺れの位相・落ちる速さ・回る半径・角度
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 7;
      pos[i * 3] = tree.pos.x + Math.cos(a) * r;
      pos[i * 3 + 1] = tree.pos.y + Math.random() * 8;
      pos[i * 3 + 2] = tree.pos.z + Math.sin(a) * r;
      data[i * 4] = Math.random() * 10;
      data[i * 4 + 1] = 0.35 + Math.random() * 0.5;
      data[i * 4 + 2] = r;
      data[i * 4 + 3] = a;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const tex = canvasTexture(32, 32, (g) => {
      const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, 'rgba(255,230,245,1)');
      grd.addColorStop(0.5, 'rgba(255,150,210,0.8)');
      grd.addColorStop(1, 'rgba(255,120,200,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(16, 16, 15, 9, 0.6, 0, Math.PI * 2);
      g.fill();
    });
    const mat = new THREE.PointsMaterial({
      size: 0.22,
      map: tex,
      transparent: true,
      depthWrite: false,
      color: new THREE.Color(1.6, 1.2, 1.4),
      toneMapped: false,
    });
    this.petals = new THREE.Points(geo, mat);
    this.petals.frustumCulled = false;
    this.petalData = data;
    this.group.add(this.petals);
    this.disposables.push(geo, tex, mat);
  }

  // --- 外周の高架を走る列車 ---
  private buildTrain() {
    if (this.level.style !== 'neon') return;
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: '#d8dde8', roughness: 0.35, metalness: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color('#9fe8ff').multiplyScalar(2.2), toneMapped: false });
    const stripe = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(2.4), toneMapped: false });
    this.disposables.push(body, glow, stripe);
    for (let i = 0; i < 6; i++) {
      const car = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.8, 2.8, 11.4), body);
      m.position.y = 1.6;
      const w = new THREE.Mesh(new THREE.BoxGeometry(2.86, 0.7, 10.2), glow);
      w.position.y = 2.1;
      const s = new THREE.Mesh(new THREE.BoxGeometry(2.88, 0.12, 11.2), stripe);
      s.position.y = 1.2;
      car.add(m, w, s);
      car.userData.index = i;
      g.add(car);
    }
    this.train = g;
    this.group.add(g);
  }

  // --- 空を飛ぶ車と、空の大きな輪の高架 ---
  private buildSkyTraffic() {
    if (this.level.style !== 'neon') return;
    const colors = ['#ff4fd8', '#4fd1ff', '#ffb45c', '#ffffff'];
    const N = 28;
    const geo = new THREE.BoxGeometry(1.2, 0.5, 3.2);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
    this.disposables.push(geo, mat);
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    for (let i = 0; i < N; i++) {
      mesh.setColorAt(i, new THREE.Color(colors[i % colors.length]).multiplyScalar(3));
      const r = 230 + Math.random() * 260;
      this.cars.push({ r, y: 45 + Math.random() * 110, a: Math.random() * Math.PI * 2, speed: (0.03 + Math.random() * 0.05) * (i % 2 ? 1 : -1), tilt: (Math.random() - 0.5) * 0.25 });
    }
    this.carMesh = mesh;
    this.group.add(mesh);
    // 空に浮かぶ輪の高架（遠景）
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#8a5cff').multiplyScalar(1.6), toneMapped: false, fog: false });
    const ringMat2 = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(1.4), toneMapped: false, fog: false });
    this.disposables.push(ringMat, ringMat2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(380, 2.2, 6, 160), ringMat);
    ring.position.set(160, 170, -520);
    ring.rotation.set(Math.PI / 2 - 0.12, 0, 0.1);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(390, 0.9, 4, 160), ringMat2);
    ring2.position.copy(ring.position);
    ring2.rotation.copy(ring.rotation);
    ring2.position.y -= 4;
    this.group.add(ring, ring2);
  }

  /** 周りの景色を1回だけ撮り、床・ガラス・金属・窓に映す */
  captureEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, at = new THREE.Vector3(0, 10, 18)): void {
    const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.5, 2500, rt); // 空（半径 900 の球）まで写るように遠くまで
    cam.position.copy(at);
    scene.add(cam);
    cam.update(renderer, scene);
    scene.remove(cam);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    rt.dispose();
    for (const m of this.envUsers) {
      m.envMap = env;
      m.needsUpdate = true;
    }
    this.disposables.push(env);
  }

  update(dt: number): void {
    this.time.value += dt;
    // 花びら：ゆらゆら回りながら落ち、下まで落ちたら上へ戻す
    if (this.petals && this.petalData) {
      const pos = this.petals.geometry.getAttribute('position') as THREE.BufferAttribute;
      const tree = (this.level.decor ?? []).find((d) => d.type === 'sakura')!;
      const arr = pos.array as Float32Array;
      const n = arr.length / 3;
      for (let i = 0; i < n; i++) {
        const d = this.petalData;
        d[i * 4] += dt;
        d[i * 4 + 3] += dt * 0.15;
        let y = arr[i * 3 + 1] - dt * d[i * 4 + 1];
        if (y < tree.pos.y - 0.2) {
          y = tree.pos.y + 6 + Math.random() * 2;
          d[i * 4 + 2] = Math.random() * 6;
        }
        const r = d[i * 4 + 2] + Math.sin(d[i * 4] * 1.3) * 0.4;
        arr[i * 3] = tree.pos.x + Math.cos(d[i * 4 + 3]) * r;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = tree.pos.z + Math.sin(d[i * 4 + 3]) * r;
      }
      pos.needsUpdate = true;
    }
    // 列車：外周の輪の上を回る
    if (this.train) {
      this.trainAngle += dt * 0.16;
      const R = 128;
      for (const car of this.train.children) {
        const a = this.trainAngle - (car.userData.index as number) * (12 / R);
        car.position.set(Math.cos(a) * R, RAIL_Y, Math.sin(a) * R);
        car.rotation.y = -a;
      }
    }
    if (this.carMesh) {
      const o = this.carDummy;
      this.cars.forEach((c, i) => {
        c.a += c.speed * dt;
        o.position.set(Math.cos(c.a) * c.r, c.y + Math.sin(c.a * 3) * 3, Math.sin(c.a) * c.r);
        o.rotation.set(0, -c.a + (c.speed > 0 ? 0 : Math.PI), c.tilt);
        o.updateMatrix();
        this.carMesh!.setMatrixAt(i, o.matrix);
      });
      this.carMesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}

/** ステージの種類ごとの照明・霧・空の設定 */
export interface LightingPreset {
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sunColor: string;
  sun: number;
  sunPos: [number, number, number];
  fill: number;
  fogColor: string;
  fogDensity: number;
  exposure: number;
  shadowExtent: number;
}

export const LIGHTING: Record<'testroom' | 'neon' | 'fortress', LightingPreset> = {
  testroom: {
    hemiSky: '#9a74e0',
    hemiGround: '#1a1028',
    hemi: 0.75,
    sunColor: '#ffb38a',
    sun: 1.7,
    sunPos: [-55, 45, -80],
    fill: 0.45,
    fogColor: '#3b1d52',
    fogDensity: 0.0085,
    exposure: 1.05,
    shadowExtent: 80,
  },
  neon: {
    hemiSky: '#8a6ad0',
    hemiGround: '#1a0e26',
    hemi: 0.72,
    sunColor: '#ff9e72',
    sun: 1.45,
    sunPos: [-90, 38, -120],
    fill: 0.35,
    fogColor: '#2e1745',
    fogDensity: 0.0042,
    exposure: 1.18,
    shadowExtent: 105,
  },
  // 晴れた昼の高原：高い太陽・青い空の光・薄いもや
  fortress: {
    hemiSky: '#c8d8f0',
    hemiGround: '#7a7258',
    hemi: 0.75,
    sunColor: '#fff0d6',
    sun: 2.8,
    sunPos: [-70, 120, 55],
    fill: 0.25,
    fogColor: '#c3d5ea',
    fogDensity: 0.0007,
    exposure: 0.85,
    // 要塞のまわりの草原まで影を落とす（プレイできる範囲が 264m × 208m）
    shadowExtent: 158,
  },
};

export type { BoxDef, DecorDef };
