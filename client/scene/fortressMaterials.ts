/**
 * 軍事要塞（Blender で作ったマップ）のマテリアル。名前（F で始まる）を見て置き換える。
 * 晴れた昼の自然光で見える質感：コンクリートの型枠の継ぎ目と雨のしみ、舗装の目地と油じみ、草原のむら、
 * 車両の塗装の汚れ（下ほど泥）、岩のざらつき。模様はテクスチャを使わず、世界の座標から計算する。
 */
import * as THREE from 'three';

const NOISE_GLSL = /* glsl */ `
  float frHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float frNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(frHash(i), frHash(i + vec2(1, 0)), u.x), mix(frHash(i + vec2(0, 1)), frHash(i + vec2(1, 1)), u.x), u.y);
  }
  float frFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * frNoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

function addWorldPos(shader: { vertexShader: string; fragmentShader: string }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);',
    );
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n${NOISE_GLSL}`);
}

/** 面の向きに合わせた 2D の座標（壁は横と高さ、床は x と z） */
const PLANE_UV = /* glsl */ `
  vec3 an = abs(vWNormal);
  vec2 puv = an.y > 0.7 ? vWPos.xz : (an.x > an.z ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y));
`;

export function makeFortressMaterials(): { byName: Map<string, THREE.Material>; envUsers: THREE.MeshStandardMaterial[] } {
  const byName = new Map<string, THREE.Material>();
  const envUsers: THREE.MeshStandardMaterial[] = [];
  const reg = (name: string, m: THREE.Material) => {
    m.name = name;
    byName.set(name, m);
    if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) envUsers.push(m as THREE.MeshStandardMaterial);
    return m;
  };

  // --- コンクリート：型枠の継ぎ目（縦 4.5m・横 2.4m）、雨のしみ（縦の筋）、足元の泥はね ---
  const concrete = (color: string, rough: number, panel = true) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.0, envMapIntensity: 0.35 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          ${PLANE_UV}
          float wall = step(an.y, 0.7);
          float streak = frFbm(vec2(puv.x * 0.9, vWPos.y * 0.07 + puv.x * 0.02));
          float grain = frFbm(puv * 1.6);
          float big = frFbm(puv * 0.05 + 3.7);
          vec3 c = diffuseColor.rgb * (0.84 + 0.18 * grain + 0.12 * big);
          // 雨のしみ（壁だけ。上の縁から下へ）
          c *= mix(1.0, 0.8 + 0.25 * streak, wall);
          // 型枠の継ぎ目（壁だけ）
          ${panel ? 'vec2 pf = abs(fract(vec2(puv.x / 4.5, vWPos.y / 2.4)) - 0.5); float seam = 1.0 - smoothstep(0.485, 0.496, max(pf.x, pf.y * 0.999)); c *= mix(1.0, mix(0.72, 1.0, seam), wall);' : ''}
          // 足元の泥はね・苔
          float foot = (1.0 - smoothstep(0.0, 1.1, vWPos.y)) * wall;
          c = mix(c, c * vec3(0.72, 0.68, 0.6), foot * (0.5 + 0.5 * grain));
          diffuseColor.rgb = c;`,
        )
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor *= 0.9 + 0.2 * grain;`);
    };
    return m;
  };
  reg('FConcrete', concrete('#b4b2aa', 0.88));
  reg('FConcreteDark', concrete('#85837d', 0.9));
  reg('FConcreteLight', concrete('#cfccc3', 0.85));
  reg('FConcreteInner', concrete('#8e8c86', 0.92));

  // --- 歩く所のコンクリート（防壁の上・屋上）：3m の板の目地と、すり減り ---
  const walk = new THREE.MeshStandardMaterial({ color: '#a3a19a', roughness: 0.9, envMapIntensity: 0.3 });
  walk.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 wp = vWPos.xz;
      vec2 wt = abs(fract(wp / 3.0) - 0.5);
      float wseam = 1.0 - smoothstep(0.482, 0.494, max(wt.x, wt.y));
      float wg = frFbm(wp * 0.8);
      diffuseColor.rgb *= (0.82 + 0.22 * wg) * mix(0.75, 1.0, wseam);`,
    );
  };
  reg('FWalk', walk);

  // --- 舗装（要塞の中の地面）：6m の大きな板・目地・油じみ・タイヤの跡・補修のあと ---
  const pave = new THREE.MeshStandardMaterial({ color: '#8b8983', roughness: 0.88, envMapIntensity: 0.3 });
  pave.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 pp = vWPos.xz;
        vec2 cell = floor(pp / 6.0);
        vec2 pt = abs(fract(pp / 6.0) - 0.5);
        float pseam = 1.0 - smoothstep(0.488, 0.497, max(pt.x, pt.y));
        float tone = 0.9 + 0.12 * frHash(cell);
        float pg = frFbm(pp * 0.9);
        float stain = smoothstep(0.62, 0.8, frFbm(pp * 0.12 + 11.0));
        float patch2 = step(0.86, frHash(cell + 7.3));
        float tyre = smoothstep(0.55, 0.75, frNoise(vec2(pp.x * 0.9, pp.y * 0.04))) * smoothstep(0.4, 0.8, frFbm(pp * 0.05 + 2.0));
        vec3 c = diffuseColor.rgb * tone * (0.84 + 0.2 * pg);
        c *= mix(0.62, 1.0, pseam);
        c = mix(c, c * 0.62, stain * 0.7);
        c = mix(c, c * 0.84, patch2);
        c = mix(c, c * 0.78, tyre * 0.6);
        diffuseColor.rgb = c;`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, stain * 0.6);`);
  };
  reg('FPavement', pave);

  // --- アスファルト（坂道） ---
  const asphalt = new THREE.MeshStandardMaterial({ color: '#57575c', roughness: 0.82, envMapIntensity: 0.35 });
  asphalt.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 ap = vWPos.xz;
      diffuseColor.rgb *= 0.82 + 0.14 * frNoise(ap * 8.0) + 0.12 * frFbm(ap * 0.3);`,
    );
  };
  reg('FAsphalt', asphalt);

  // --- 草原：濃い緑と黄緑のむら、乾いた所・土の出た所、細かい草の筋 ---
  const grass = (base: string, dry: number) => {
    const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.96, envMapIntensity: 0.2 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec2 gp = vWPos.xz;
          float g1 = frFbm(gp * 0.035);
          float g2 = frFbm(gp * 0.21 + 5.0);
          float blade = frNoise(gp * 7.0) * 0.5 + frNoise(gp * 23.0) * 0.5;
          vec3 lush = diffuseColor.rgb;
          vec3 dryc = vec3(0.62, 0.6, 0.36);
          vec3 soil = vec3(0.45, 0.38, 0.28);
          vec3 c = mix(lush, dryc, smoothstep(0.45, 0.75, g1) * ${dry.toFixed(2)} + 0.15 * g2);
          c = mix(c, soil, smoothstep(0.66, 0.8, g2) * 0.55);
          c *= 0.78 + 0.32 * blade;
          diffuseColor.rgb = c;`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.95;');
    };
    return m;
  };
  reg('FGrass', grass('#6a8a3a', 0.6));
  reg('FGrassDry', grass('#8a8a4c', 0.9));

  // --- 土の道 ---
  const dirt = new THREE.MeshStandardMaterial({ color: '#8f7a58', roughness: 0.97, envMapIntensity: 0.2 });
  dirt.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 dp = vWPos.xz;
      diffuseColor.rgb *= 0.8 + 0.18 * frFbm(dp * 0.6) + 0.1 * frNoise(dp * 9.0);`,
    );
  };
  reg('FDirt', dirt);

  // --- 岩：灰色に茶色が混ざる、ざらざら ---
  const rock = (color: string) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, flatShading: true, envMapIntensity: 0.3 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float rk = frFbm(vWPos.xz * 0.7 + vWPos.y * 0.9);
        float rl = frFbm(vec2(vWPos.x + vWPos.z, vWPos.y) * 2.3);
        vec3 c = diffuseColor.rgb * (0.75 + 0.35 * rk);
        c = mix(c, c * vec3(1.08, 0.98, 0.86), smoothstep(0.4, 0.7, rl));
        // 上を向いた面は少し苔で緑に
        c = mix(c, vec3(0.42, 0.48, 0.3), smoothstep(0.75, 0.95, vWNormal.y) * 0.35);
        diffuseColor.rgb = c;`,
      );
    };
    return m;
  };
  reg('FRock', rock('#857f75'));

  // --- 塗装（車両・コンテナ）：下ほど泥、まだらの退色 ---
  const paint = (color: string, rough: number, metal: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.6 });
    m.onBeforeCompile = (shader) => {
      addWorldPos(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float pf = frFbm(vWPos.xz * 1.3 + vWPos.y * 1.7);
        float mud = 1.0 - smoothstep(0.15, 1.3, vWPos.y);
        vec3 c = diffuseColor.rgb * (0.86 + 0.2 * pf);
        c = mix(c, vec3(0.42, 0.36, 0.26), clamp(mud, 0.0, 1.0) * 0.55);
        diffuseColor.rgb = c;`,
      );
    };
    return m;
  };
  reg('FOlive', paint('#56623a', 0.62, 0.15));
  reg('FOliveDark', paint('#3b4327', 0.66, 0.15));
  reg('FTan', paint('#b1a079', 0.66, 0.1));
  reg('FTanDark', paint('#8e7f5a', 0.7, 0.1));
  reg('FCanvas', paint('#6e6d45', 0.95, 0.0));
  reg('FSandbag', paint('#ad9c71', 0.97, 0.0));
  reg('FRust', paint('#7d4c2f', 0.8, 0.3));

  const std = (name: string, color: string, rough: number, metal: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    reg(name, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.8, ...extra }));
  std('FMetal', '#9399a0', 0.38, 0.85);
  std('FMetalDark', '#41444a', 0.5, 0.7);
  std('FGrating', '#62666d', 0.5, 0.8);
  std('FGlass', '#1f2f3c', 0.06, 0.7, { envMapIntensity: 1.6 });
  std('FRubber', '#1c1c1d', 0.9, 0.0);
  std('FTank', '#d2d0c8', 0.45, 0.35);
  std('FNavy', '#2b3b5e', 0.8, 0.0);
  std('FMarkYellow', '#dcb22c', 0.65, 0.0);
  std('FMarkWhite', '#e2e2da', 0.65, 0.0);
  std('FHazardBlack', '#1f1f21', 0.65, 0.0);
  std('FWood', '#8f6c45', 0.86, 0.0);
  std('FWoodDark', '#5f462c', 0.88, 0.0);
  std('FTree', '#3c5a2f', 0.9, 0.0, { flatShading: true });
  std('FSnow', '#f1f4f8', 0.7, 0.0, { flatShading: true });
  reg('FMountain', rock('#707a88'));

  // --- 光るもの（昼なので控えめ） ---
  const glow = (name: string, hex: string, k: number) => reg(name, new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false }));
  glow('FLightWarm', '#ffe9bf', 1.3);
  glow('FLightRed', '#ff3030', 2.6);
  glow('FLightCyan', '#54d8ff', 2.4);
  return { byName, envUsers };
}

/** 晴れた昼の空（青のグラデーションと、地平線のもや、太陽） */
export function makeDaySky(sunDir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sunDir: { value: sunDir.clone().normalize() } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 top = vec3(0.16, 0.38, 0.82);
        vec3 mid = vec3(0.36, 0.6, 0.94);
        vec3 horizon = vec3(0.76, 0.85, 0.95);
        vec3 below = vec3(0.6, 0.66, 0.62);
        vec3 col;
        if (y < 0.0) col = mix(horizon, below, smoothstep(0.0, -0.2, y));
        else if (y < 0.12) col = mix(horizon, mid, smoothstep(0.0, 0.12, y));
        else col = mix(mid, top, smoothstep(0.12, 0.75, y));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += vec3(1.0, 0.95, 0.82) * (pow(s, 900.0) * 6.0 + pow(s, 60.0) * 0.4 + pow(s, 6.0) * 0.12);
        gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
