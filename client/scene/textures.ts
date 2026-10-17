/**
 * 外部画像を使わずに、キャンバスでテクスチャを作る。
 */
import * as THREE from 'three';

/** 床や壁に貼るグリッド。白い線を黒地に描き、マテリアルの色・発光色で着色する */
export function makeGridTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  // 細かい線（1m ごと。テクスチャ1枚＝4m）
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (i * size) / 4;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, size);
    g.moveTo(0, p);
    g.lineTo(size, p);
    g.stroke();
  }
  // 太い線（4m ごと）
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 5;
  g.strokeRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 表面のざらつき（コンクリート風）。色の明暗だけ */
export function makeConcreteTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < size * size; i++) {
    const v = 200 + rnd() * 55;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // しみ
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.05})`;
    g.beginPath();
    g.arc(rnd() * size, rnd() * size, 8 + rnd() * 40, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 遠景のビルの窓（テクスチャ1枚にビルの外壁 32m×64m 分の窓を描く） */
export function makeWindowTexture(): THREE.CanvasTexture {
  const w = 256,
    h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const warm = ['#ffb45c', '#ffd9a0', '#ffe8c8'];
  const neon = ['#4fd1ff', '#ff4fd8', '#8a5cff'];
  const cw = 16,
    ch = 24;
  for (let y = 0; y < h; y += ch) {
    // 階ごとに明かりのつき方を変える（全部消えている階、帯状に光る階）
    const floorRoll = rnd();
    if (floorRoll < 0.06) {
      g.globalAlpha = 0.85;
      g.fillStyle = neon[Math.floor(rnd() * neon.length)];
      g.fillRect(0, y + ch - 5, w, 3);
      continue;
    }
    const density = floorRoll < 0.3 ? 0.05 : 0.26;
    for (let x = 0; x < w; x += cw) {
      if (rnd() < density) {
        const isNeon = rnd() < 0.18;
        g.fillStyle = isNeon ? neon[Math.floor(rnd() * neon.length)] : warm[Math.floor(rnd() * warm.length)];
        g.globalAlpha = 0.35 + rnd() * 0.6;
        g.fillRect(x + 3, y + 5, cw - 6, ch - 10);
      }
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 看板の文字 */
export function makeLabelTexture(text: string, sub: string | undefined, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const font = "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif";
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const mainPx = 96,
    subPx = 44,
    pad = 36;
  g.font = `900 ${mainPx}px ${font}`;
  const mw = g.measureText(text).width;
  g.font = `600 ${subPx}px ${font}`;
  const sw = sub ? g.measureText(sub).width : 0;
  c.width = Math.ceil(Math.max(mw, sw) + pad * 2);
  c.height = Math.ceil(mainPx + (sub ? subPx + 22 : 0) + pad * 2);
  g.textBaseline = 'top';
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillStyle = color;
  g.font = `900 ${mainPx}px ${font}`;
  g.fillText(text, pad, pad);
  if (sub) {
    g.shadowBlur = 10;
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.85;
    g.font = `600 ${subPx}px ${font}`;
    g.fillText(sub, pad, pad + mainPx + 22);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return { texture: t, aspect: c.width / c.height };
}
