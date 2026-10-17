/**
 * タイムアタックの記録（ブラウザに保存。キャラクターごと）。
 * ベスト記録のときは、ゴーストの走り（位置・向き・動き）も一緒に保存する。
 */
import type { CharacterId } from '../../config';
import type { TimeAttackResult } from '../../shared/timeAttack';

export interface BestRecord {
  total: number;
  time: number;
  penalty: number;
  missed: number;
  splits: number[];
  /** 記録した日時（ミリ秒） */
  date: number;
  /** ゴーストの走り（Float32Array を base64 にしたもの） */
  ghost?: string;
  ghostInterval?: number;
}

const key = (courseId: string, character: CharacterId) => `vr.ta.${courseId}.${character}`;

export function loadBest(courseId: string, character: CharacterId): BestRecord | null {
  try {
    const raw = localStorage.getItem(key(courseId, character));
    if (!raw) return null;
    const r = JSON.parse(raw) as BestRecord;
    if (typeof r.total !== 'number' || !Array.isArray(r.splits)) return null;
    return r;
  } catch {
    return null;
  }
}

/** ベストを更新したら保存して true を返す */
export function saveIfBest(result: TimeAttackResult, character: CharacterId, ghost: number[], ghostInterval: number): boolean {
  const prev = loadBest(result.courseId, character);
  if (prev && prev.total <= result.total) return false;
  const rec: BestRecord = {
    total: result.total,
    time: result.time,
    penalty: result.penalty,
    missed: result.missed,
    splits: result.splits,
    date: Date.now(),
    ghost: encodeGhost(ghost),
    ghostInterval,
  };
  try {
    localStorage.setItem(key(result.courseId, character), JSON.stringify(rec));
  } catch {
    // 容量が足りないときは、ゴーストなしで保存する
    try {
      delete rec.ghost;
      localStorage.setItem(key(result.courseId, character), JSON.stringify(rec));
    } catch {
      return false;
    }
  }
  return true;
}

export function clearBest(courseId: string, character: CharacterId): void {
  try {
    localStorage.removeItem(key(courseId, character));
  } catch {
    /* 保存できない環境 */
  }
}

export function encodeGhost(frames: number[]): string {
  const f = new Float32Array(frames);
  const bytes = new Uint8Array(f.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeGhost(b64: string): Float32Array | null {
  try {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

const GHOST_KEY = 'vr.ta.ghost';
export function loadGhostEnabled(): boolean {
  try {
    return localStorage.getItem(GHOST_KEY) !== '0';
  } catch {
    return true;
  }
}
export function saveGhostEnabled(on: boolean): void {
  try {
    localStorage.setItem(GHOST_KEY, on ? '1' : '0');
  } catch {
    /* 保存できない環境 */
  }
}
