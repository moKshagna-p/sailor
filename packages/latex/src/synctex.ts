/**
 * A minimal SyncTeX reader for the "edit" direction only: given a point in the
 * compiled PDF, which source file and line produced it?
 *
 * We deliberately do NOT implement the full SyncTeX spec (the "display"
 * direction, visible-vs-invisible boxes, kerns, glue). All we need is to pick
 * the tightest box containing a click and read its `tag,line`. That keeps this
 * file small and, more importantly, legible — a full parser here would be a
 * second compiler nobody could review.
 *
 * ## Format, only the parts we use
 *
 * The decompressed `.synctex.gz` is line-oriented:
 *
 *   Input:<tag>:<path>        maps a numeric tag to a source file
 *   Unit:<n>                  scaled-points-per-unit multiplier (usually 1)
 *   X Offset / Y Offset       added to every horizontal / vertical coordinate
 *   {<page>                   begins a page's records
 *   }<page>                   ends it
 *   [ ( <tag>,<line>:<h>,<v>:<W>,<H>,<D>   a vertical/horizontal box
 *   h g x k v $               non-box records we ignore for hit-testing
 *
 * Coordinates are in scaled points (sp): 65536 sp = 1 TeX pt, 72.27 pt = 1 inch.
 * The box's reference point is its lower-left; `H`+`D` is its full height. The
 * caller converts a PDF point (origin top-left, PDF points) into sp before
 * asking — see `pdfPointToSp`.
 *
 * ## This file runs in the browser too
 *
 * It is reachable as `@sailor/latex/synctex`, a subpath that pulls in nothing but
 * `@sailor/core`. The map is produced by the server, which is where the compiler
 * is, but the hit-testing happens where the clicks are. Keep it free of `node:`
 * imports.
 */

import type { SyncTexBox, SyncTexMap } from '@sailor/core';

const SP_PER_PT = 65536;
/** PDF/PostScript points per inch vs. TeX points per inch. */
const PDF_PT_PER_INCH = 72;
const TEX_PT_PER_INCH = 72.27;

export type { SyncTexBox, SyncTexMap };

export type SourceLocation = { file: string; line: number };

// `[1,3:8799519,8865055:22609920,642672,183080` → tag 1, line 3, then two
// coordinate groups. The leading glyph ([ ( h v etc.) is matched separately.
const BOX_RECORD = /^[[(vhx]\s*(-?\d+),(-?\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/;

/** Parse the decompressed SyncTeX text into something hit-testable. */
export function parseSyncTex(raw: string): SyncTexMap {
  const files = new Map<number, string>();
  const boxes: SyncTexBox[] = [];
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('Input:')) {
      // Input:<tag>:<path> — path may itself contain colons, so split on the
      // first two only.
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;
      const tag = Number(line.slice(firstColon + 1, secondColon));
      const path = line.slice(secondColon + 1);
      if (Number.isInteger(tag) && path) files.set(tag, path);
      continue;
    }
    if (line.startsWith('Unit:')) {
      const value = Number(line.slice(5));
      if (Number.isFinite(value) && value > 0) unit = value;
      continue;
    }
    if (line.startsWith('X Offset:')) {
      xOffset = Number(line.slice(9)) || 0;
      continue;
    }
    if (line.startsWith('Y Offset:')) {
      yOffset = Number(line.slice(9)) || 0;
      continue;
    }
    if (line.startsWith('{')) {
      const value = Number(line.slice(1));
      if (Number.isInteger(value)) page = value;
      continue;
    }

    const match = BOX_RECORD.exec(line);
    if (!match || page === 0) continue;
    const tag = Number(match[1]);
    const sourceLine = Number(match[2]);
    const h = Number(match[3]);
    const v = Number(match[4]);
    const width = Number(match[5]);
    const height = Number(match[6]);
    const depth = Number(match[7]);
    // Only boxes that name a real source file and line are useful to jump to.
    if (!files.has(tag) || sourceLine <= 0) continue;

    // SyncTeX's (h, v) is the box's lower-left in a y-up frame; convert to a
    // y-down (PDF-like) top and full height so hit-testing matches how the
    // browser reports clicks.
    boxes.push({
      page,
      tag,
      line: sourceLine,
      left: h,
      top: v - (height + depth),
      width,
      height: height + depth,
    });
  }

  return {
    files: [...files].map(([tag, path]) => ({ tag, path })),
    boxes,
    unit,
    xOffset,
    yOffset,
  };
}

/**
 * Convert a point in PDF user space (points, origin top-left) to the scaled
 * points SyncTeX boxes live in, applying the map's unit and offsets.
 */
export function pdfPointToSp(
  map: SyncTexMap,
  point: { x: number; y: number },
): { x: number; y: number } {
  const toSp = (pt: number) => (pt * TEX_PT_PER_INCH * SP_PER_PT) / PDF_PT_PER_INCH;
  return {
    x: toSp(point.x) * map.unit + map.xOffset,
    y: toSp(point.y) * map.unit + map.yOffset,
  };
}

/**
 * Find the source line under a point on a page. Returns the tightest box that
 * contains the point; if none contains it (clicks land in margins and gaps all
 * the time), returns the nearest box on that page by centre distance, so a
 * near-miss still lands somewhere sensible rather than nowhere.
 */
export function locateSource(
  map: SyncTexMap,
  query: { page: number; x: number; y: number },
): SourceLocation | null {
  const sp = pdfPointToSp(map, query);
  const onPage = map.boxes.filter((b) => b.page === query.page);
  if (onPage.length === 0) return null;

  let bestContaining: SyncTexBox | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  let nearest: SyncTexBox | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const box of onPage) {
    const contains =
      sp.x >= box.left &&
      sp.x <= box.left + box.width &&
      sp.y >= box.top &&
      sp.y <= box.top + box.height;
    if (contains) {
      const area = box.width * box.height;
      if (area < bestArea) {
        bestArea = area;
        bestContaining = box;
      }
    }

    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const distance = (sp.x - cx) ** 2 + (sp.y - cy) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = box;
    }
  }

  const hit = bestContaining ?? nearest;
  if (!hit) return null;
  const file = map.files.find((f) => f.tag === hit.tag);
  return file ? { file: file.path, line: hit.line } : null;
}
