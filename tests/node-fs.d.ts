/** テストでファイルを読むための最小限の型（@types/node は入れていない） */
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
}
