const MAX_PDF_BYTES = 10 * 1024 * 1024;

type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
};

type PdfLoader = (data: Uint8Array) => Promise<PdfDocument>;

const loadPdf: PdfLoader = async (data) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  return pdfjs.getDocument({ data }).promise;
};

function text(item: unknown): string {
  return typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string'
    ? item.str
    : '';
}

export async function extractPdfText(file: File, loader: PdfLoader = loadPdf): Promise<string> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file.');
  }
  if (file.size > MAX_PDF_BYTES) {
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

  const pages: string[] = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    pages.push(content.items.map(text).filter(Boolean).join(' '));
  }
  const result = pages.filter(Boolean).join('\n\n').trim();
  if (!result) throw new Error('This PDF has no selectable text. Upload a text-based PDF.');
  return result;
}
