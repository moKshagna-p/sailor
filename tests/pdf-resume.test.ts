import { expect, test } from 'bun:test';
import { pdfToPositionedPages } from '../apps/web/lib/pdf-resume.ts';

function canvas() {
  return {
    renderContext: {},
    mask: () => {},
    toPng: () => 'cG5n',
  };
}

function loader(items: unknown[]) {
  return async () => ({
    numPages: 1,
    getPage: async () => ({
      getViewport: (scale: number) => ({ width: 612 * scale, height: 792 * scale }),
      getTextContent: async () => ({
        items,
        styles: { f1: { fontFamily: 'Arial, sans-serif' } },
      }),
      render: async () => {},
    }),
  });
}

test('PDF text positions become editable runs without changing text', async () => {
  const pages = await pdfToPositionedPages(
    new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' }),
    loader([
      {
        str: 'Senior R&D Engineer',
        transform: [12, 0, 0, 12, 36, 50],
        width: 120,
        height: 12,
        fontName: 'Arial-Bold',
      },
    ]),
    canvas,
  );

  expect(pages).toHaveLength(1);
  expect(pages[0]?.backgroundPng).toBe('cG5n');
  expect(pages[0]?.runs[0]).toEqual({
    text: 'Senior R&D Engineer',
    x: 36,
    y: 730,
    width: 120,
    height: 12,
    fontSize: 12,
    fontFamily: 'sans',
    bold: true,
    italic: false,
    color: '000000',
  });
});

test('PDF import rejects unsafe or unreadable inputs', async () => {
  const unused = async () => {
    throw new Error('loader should not run');
  };

  await expect(
    pdfToPositionedPages(new File(['plain'], 'resume.txt'), unused, canvas),
  ).rejects.toThrow('Choose a PDF file');
  await expect(
    pdfToPositionedPages(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf'),
      unused,
      canvas,
    ),
  ).rejects.toThrow('10 MB or smaller');

  const password = async () => {
    throw { name: 'PasswordException' };
  };
  await expect(
    pdfToPositionedPages(new File(['%PDF'], 'locked.pdf'), password, canvas),
  ).rejects.toThrow('Remove the PDF password');
});

test('PDF import refuses image-only pages rather than guessing with OCR', async () => {
  await expect(
    pdfToPositionedPages(new File(['%PDF'], 'scan.pdf'), loader([]), canvas),
  ).rejects.toThrow('no selectable text');
});
