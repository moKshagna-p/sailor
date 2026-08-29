import type { PositionedPage, PositionedRun } from './resume-import.ts';
import { MAX_DOCUMENT_BYTES } from './resume-import.ts';

type RenderedRun = {
  text: string;
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  backgroundColor?: string;
};

type RenderedPage = {
  widthPx: number;
  heightPx: number;
  backgroundPng: string;
  runs: RenderedRun[];
};

export type DocxRenderer = (file: File) => Promise<RenderedPage[]>;

function hexColor(value: string): string {
  const shortHex = value.match(/^#([0-9a-f]{3})$/i)?.[1];
  if (shortHex)
    return Array.from(shortHex, (digit) => `${digit}${digit}`)
      .join('')
      .toUpperCase();
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return hex.toUpperCase();
  const rgb = value.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
  if (!rgb) return '000000';
  return [rgb[1], rgb[2], rgb[3]]
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function family(value: string): PositionedRun['fontFamily'] {
  if (/mono|courier|consolas/i.test(value)) return 'mono';
  if (/sans|arial|helvetica|calibri/i.test(value)) return 'sans';
  return 'serif';
}

function toPoints(value: number): number {
  return Number((value * 0.75).toFixed(2));
}

function toRun(run: RenderedRun): PositionedRun {
  const weight = Number.parseInt(run.fontWeight, 10);
  return {
    text: run.text,
    x: toPoints(run.xPx),
    y: toPoints(run.yPx),
    width: toPoints(run.widthPx),
    height: toPoints(run.heightPx),
    fontSize: toPoints(run.fontSizePx),
    fontFamily: family(run.fontFamily),
    bold: /bold/i.test(run.fontWeight) || (Number.isFinite(weight) && weight >= 600),
    italic: /italic|oblique/i.test(run.fontStyle),
    color: hexColor(run.color),
  };
}

function leafTextRuns(page: HTMLElement): RenderedRun[] {
  const pageRect = page.getBoundingClientRect();
  return Array.from(page.querySelectorAll('span'))
    .filter((element) => element.querySelector('span') === null)
    .flatMap((element) => {
      const text = element.textContent ?? '';
      const rect = element.getBoundingClientRect();
      if (!text || rect.width <= 0 || rect.height <= 0) return [];
      const style = getComputedStyle(element);
      return [
        {
          text,
          xPx: rect.left - pageRect.left,
          yPx: rect.top - pageRect.top,
          widthPx: rect.width,
          heightPx: rect.height,
          fontSizePx: Number.parseFloat(style.fontSize) || rect.height,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          color: style.color,
          backgroundColor: style.backgroundColor,
        },
      ];
    });
}

const renderDocx: DocxRenderer = async (file) => {
  const [{ renderAsync }, { toCanvas }] = await Promise.all([
    import('docx-preview'),
    import('html-to-image'),
  ]);
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  document.body.append(container);

  try {
    await renderAsync(file, container, undefined, {
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
      renderAltChunks: false,
      renderChanges: false,
      experimental: true,
    });

    const pages: RenderedPage[] = [];
    for (const page of container.querySelectorAll<HTMLElement>('section.docx')) {
      const rect = page.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const runs = leafTextRuns(page);
      const canvas = await toCanvas(page, { pixelRatio: 2, backgroundColor: '#fff' });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not capture the Word document.');
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      for (const run of runs) {
        const background = run.backgroundColor;
        context.fillStyle = background && background !== 'rgba(0, 0, 0, 0)' ? background : '#fff';
        context.fillRect(
          run.xPx * scaleX,
          run.yPx * scaleY,
          run.widthPx * scaleX,
          run.heightPx * scaleY * 1.12,
        );
      }
      const dataUrl = canvas.toDataURL('image/png');
      pages.push({
        widthPx: rect.width,
        heightPx: rect.height,
        backgroundPng: dataUrl.slice(dataUrl.indexOf(',') + 1),
        runs,
      });
    }
    return pages;
  } finally {
    container.remove();
  }
};

export async function docxToPositionedPages(
  file: File,
  renderer: DocxRenderer = renderDocx,
): Promise<PositionedPage[]> {
  const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (file.type !== docxType && !file.name.toLowerCase().endsWith('.docx')) {
    throw new Error('Choose a DOCX file.');
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error('Choose a Word document that is 10 MB or smaller.');
  }

  let rendered: RenderedPage[];
  try {
    rendered = await renderer(file);
  } catch (cause) {
    throw new Error('Could not read this Word document.', { cause });
  }

  const pages = rendered.map((page) => ({
    width: toPoints(page.widthPx),
    height: toPoints(page.heightPx),
    backgroundPng: page.backgroundPng,
    runs: page.runs.map(toRun),
  }));
  if (!pages.some((page) => page.runs.some((run) => run.text.trim().length > 0))) {
    throw new Error('This Word document has no editable text.');
  }
  return pages;
}
