import { expect, test } from 'bun:test';
import { extractPdfText } from '../apps/web/lib/pdf-text.ts';

test('extractPdfText preserves page boundaries and rejects image-only PDFs', async () => {
  const load = async () => ({
    numPages: 2,
    getPage: async (page: number) => ({
      getTextContent: async () => ({
        items:
          page === 1 ? [{ str: 'Acme' }, { str: 'Platform Engineer' }] : [{ str: 'Build APIs' }],
      }),
    }),
  });

  const file = new File(['%PDF'], 'role.pdf', { type: 'application/pdf' });
  await expect(extractPdfText(file, load)).resolves.toBe('Acme Platform Engineer\n\nBuild APIs');

  const empty = async () => ({
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
  });
  await expect(extractPdfText(file, empty)).rejects.toThrow('no selectable text');
});

test('extractPdfText rejects files that are not safe PDF inputs', async () => {
  const unused = async () => {
    throw new Error('loader should not run');
  };

  await expect(extractPdfText(new File(['plain'], 'role.txt'), unused)).rejects.toThrow(
    'Choose a PDF file',
  );
  await expect(
    extractPdfText(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf'), unused),
  ).rejects.toThrow('10 MB or smaller');
});
