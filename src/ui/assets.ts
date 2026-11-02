// 그림 자산 조회. src/assets/asset-index.json에서 승인된 항목만 돌려준다.

import manifest from '../assets/asset-index.json';

export interface MapAsset {
  path: string;
  width: number;
  height: number;
  bounds: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  attribution: string;
  pixelGrid?: { logicalWidth: number; logicalHeight: number; unitsPerPixel: number };
}

type AssetRaw = {
  id: string;
  kind: string;
  path: string;
  status: string;
  width?: number;
  height?: number;
  employee_id?: string;
  slot?: string;
  bounds?: MapAsset['bounds'];
  attribution?: string;
  pixel_grid?: { logical_width: number; logical_height: number; units_per_pixel: number };
};

const assets = (manifest as { assets: AssetRaw[] }).assets.filter((a) => a.status === 'approved');

export function mapAsset(id: string): MapAsset | null {
  const a = assets.find((x) => x.id === id && x.kind === 'map');
  if (!a || !a.bounds || !a.width || !a.height) return null;
  return { path: a.path, width: a.width, height: a.height, bounds: a.bounds, attribution: a.attribution ?? '',
    pixelGrid: a.pixel_grid ? { logicalWidth: a.pixel_grid.logical_width, logicalHeight: a.pixel_grid.logical_height, unitsPerPixel: a.pixel_grid.units_per_pixel } : undefined };
}

export interface CharacterImage {
  path: string;
  logicalWidth: number;
  logicalHeight: number;
}

export interface CharacterSprite {
  path: string;
  frameWidth: number;
  frameHeight: number;
  rows: readonly string[];
  framesPerRow: number;
  frameMs: number;
}

/** 승인된 동료 그림과 슬롯의 논리 크기. 그림이 없으면 자리표시자를 유지한다. */
export function characterImage(employeeId: string, slot: 'card' | 'portrait' | 'work'): CharacterImage | null {
  const a = assets.find((x) => x.kind === 'character' && x.employee_id === employeeId && x.slot === slot);
  if (!a) return null;
  const spec = manifest.character_slots[slot];
  return { path: a.path, logicalWidth: spec.logical_width, logicalHeight: spec.logical_height };
}

export function characterSprite(employeeId: string): CharacterSprite | null {
  const image = characterImage(employeeId, 'work');
  if (!image) return null;
  const spec = manifest.character_slots.work;
  return { path: image.path, frameWidth: spec.frame_width, frameHeight: spec.frame_height,
    rows: [...spec.rows], framesPerRow: spec.frames_per_row, frameMs: spec.frame_ms };
}
