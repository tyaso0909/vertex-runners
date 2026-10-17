/**
 * 画質の設定（高・中・低と、自動）。
 * 重いのは主に「画面の解像度 × 1画素あたりの計算」「影」「光のにじみ（ブルーム）」「点光源の数」なので、それを段階ごとに変える。
 */
export type QualityLevel = 'high' | 'medium' | 'low';
export type QualitySetting = 'auto' | QualityLevel;

export interface QualityPreset {
  /** 描画の解像度（画面の画素に対する比。上限） */
  pixelRatio: number;
  /** なめらかにする（MSAA）のサンプル数。0 で使わない */
  msaa: number;
  shadows: boolean;
  /** 影を何フレームごとに描き直すか（太陽は動かないので、毎フレームでなくてよい） */
  shadowEvery: number;
  shadowSize: number;
  bloom: boolean;
  /** ブルームを計算する解像度（画面に対する比） */
  bloomScale: number;
  /** マップの点光源を使うか */
  pointLights: boolean;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  high: { pixelRatio: 1.5, msaa: 4, shadows: true, shadowEvery: 2, shadowSize: 2048, bloom: true, bloomScale: 0.5, pointLights: true },
  medium: { pixelRatio: 1, msaa: 0, shadows: true, shadowEvery: 4, shadowSize: 2048, bloom: true, bloomScale: 0.35, pointLights: false },
  low: { pixelRatio: 0.75, msaa: 0, shadows: false, shadowEvery: 0, shadowSize: 1024, bloom: false, bloomScale: 0.25, pointLights: false },
};

export const QUALITY_LABELS: Record<QualitySetting, string> = { auto: '自動', high: '高', medium: '中', low: '低' };

const KEY = 'vr.quality';

export function loadQualitySetting(): QualitySetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'auto' || v === 'high' || v === 'medium' || v === 'low') return v;
  } catch {
    /* 保存できない環境 */
  }
  return 'auto';
}

export function saveQualitySetting(v: QualitySetting): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 保存できない環境 */
  }
}

/**
 * 「自動」のとき：遊んでいる間のフレームレートを測り、遅ければ1段ずつ下げる（上げはしない。行ったり来たりしないように）
 */
export class AutoQuality {
  private times: number[] = [];
  private time = 0;
  private warmup = 1.5;

  constructor(
    private readonly lower: () => boolean,
    private readonly minFps = 50,
  ) {}

  reset(): void {
    this.times = [];
    this.time = 0;
    this.warmup = 1.5;
  }

  /** 遊んでいるフレームごとに、そのフレームにかかった時間（秒）を渡す */
  sample(dt: number): void {
    if (this.warmup > 0) {
      this.warmup -= dt;
      return;
    }
    this.times.push(dt);
    this.time += dt;
    if (this.time < 3) return;
    // 一瞬止まったフレーム（読み込みなど）に引きずられないよう、真ん中の値で決める
    const sorted = [...this.times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.times = [];
    this.time = 0;
    if (median > 1 / this.minFps && this.lower()) this.warmup = 1.5; // 下げた直後は測り直す
  }
}
