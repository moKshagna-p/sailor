import type { PositionedPage, PositionedRun } from './resume-import.ts';
import { MAX_DOCUMENT_BYTES } from './resume-import.ts';

type PdfTextContent = {
  items: unknown[];
  styles: Record<string, { fontFamily?: string }>;
};

type PdfPage = {
  getViewport(scale: number): { width: number; height: number };
  getTextContent(): Promise<PdfTextContent>;
  render(renderContext: unknown, scale: number): Promise<void>;
};

type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
};

export type PdfLoader = (data: Uint8Array) => Promise<PdfDocument>;

type PageCanvas = {
  renderContext: unknown;
  mask(x: number, y: number, width: number, height: number): void;
  toPng(): string;
};

export type PdfCanvasFactory = (width: number, height: number) => PageCanvas;

const loadPdf: PdfLoader = async (data) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  const document = await pdfjs.getDocument({ data, stopAtErrors: true }).promise;

  return {
    numPages: document.numPages,
    async getPage(pageNumber) {
      const page = await document.getPage(pageNumber);
      return {
        getViewport(scale) {
          const viewport = page.getViewport({ scale });
          return { width: viewport.width, height: viewport.height };
        },
        async getTextContent() {
          const content = await page.getTextContent();
          return { items: content.items, styles: content.styles };
        },
        async render(renderContext, scale) {
          if (!(renderContext instanceof CanvasRenderingContext2D)) {
            throw new Error('Could not create a PDF canvas.');
          }
          await page.render({
            canvas: null,
            canvasContext: renderContext,
            viewport: page.getViewport({ scale }),
          }).promise;
        },
      };
    },
  };
};

const createCanvas: PdfCanvasFactory = (width, height) => {
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a PDF canvas.');

  return {
    renderContext: context,
    mask(x, y, runWidth, runHeight) {
      const left = Math.max(0, Math.floor(x * scale));
      const top = Math.max(0, Math.floor(y * scale));
      const sampleX = Math.min(canvas.width - 1, left);
      const sampleY = Math.max(0, Math.min(canvas.height - 1, top - 2));
      const sample = context.getImageData(sampleX, sampleY, 1, 1).data;
      context.fillStyle = `rgb(${sample[0] ?? 255} ${sample[1] ?? 255} ${sample[2] ?? 255})`;
      context.fillRect(left, top, Math.ceil(runWidth * scale), Math.ceil(runHeight * scale * 1.15));
    },
    toPng() {
      const encoded = canvas.toDataURL('image/png');
      return encoded.slice(encoded.indexOf(',') + 1);
    },
  };
};

function textItem(item: unknown): {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
} | null {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('str' in item) ||
    typeof item.str !== 'string' ||
    !('transform' in item) ||
    !Array.isArray(item.transform) ||
    item.transform.length < 6 ||
    !item.transform.every((value) => typeof value === 'number') ||
    !('width' in item) ||
    typeof item.width !== 'number' ||
    !('height' in item) ||
    typeof item.height !== 'number' ||
    !('fontName' in item) ||
    typeof item.fontName !== 'string'
  ) {
    return null;
  }

  return {
    str: item.str,
    transform: item.transform,
    width: item.width,
    height: item.height,
    fontName: item.fontName,
  };
}

function fontFamily(name: string): PositionedRun['fontFamily'] {
  if (/mono|courier|consolas/i.test(name)) return 'mono';
  if (/sans|arial|helvetica|calibri/i.test(name)) return 'sans';
  return 'serif';
}

function toRun(
  item: NonNullable<ReturnType<typeof textItem>>,
  pageHeight: number,
  family: string,
): PositionedRun {
  const font = `${item.fontName} ${family}`;
  const height = item.height || Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0);
  return {
    text: item.str,
    x: item.transform[4] ?? 0,
    y: pageHeight - (item.transform[5] ?? 0) - height,
    width: item.width,
    height,
    fontSize: height,
    fontFamily: fontFamily(font),
    bold: /bold|black|semibold|demi/i.test(font),
    italic: /italic|oblique/i.test(font),
    color: '000000',
  };
}

export async function pdfToPositionedPages(
  file: File,
  loader: PdfLoader = loadPdf,
  canvasFactory: PdfCanvasFactory = createCanvas,
): Promise<PositionedPage[]> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file.');
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error('Choose a PDF that is 10 MB or smaller.');
  }

  let pdf: PdfDocument;
  try {
    pdf = await loader(new Uint8Array(await file.arrayBuffer()));
  } catch (cause) {
    const name = typeof cause === 'object' && cause !== null && 'name' in cause ? cause.name : '';
    if (name === 'PasswordException') throw new Error('Remove the PDF password and try again.');
    throw new Error('Could not read this PDF.', { cause });
  }

  const pages: PositionedPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport(1);
    const content = await page.getTextContent();
    const runs = content.items
      .map(textItem)
      .filter(
        (item): item is Exclude<ReturnType<typeof textItem>, null> =>
          item !== null && item.str.length > 0,
      )
      .map((item) => toRun(item, viewport.height, content.styles[item.fontName]?.fontFamily ?? ''));
    const canvas = canvasFactory(viewport.width, viewport.height);
    await page.render(canvas.renderContext, 2);
    for (const run of runs) canvas.mask(run.x, run.y, run.width, run.height);
    pages.push({
      width: viewport.width,
      height: viewport.height,
      backgroundPng: canvas.toPng(),
      runs,
    });
  }

  if (!pages.some((page) => page.runs.some((run) => run.text.trim().length > 0))) {
    throw new Error('This PDF has no selectable text. Upload a text-based PDF.');
  }
  return pages;
}
