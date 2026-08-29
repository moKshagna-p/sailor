import { expect, test } from 'bun:test';
import { docxToPositionedPages } from '../apps/web/lib/docx-resume.ts';

const wordFile = () =>
  new File(['PK'], 'resume.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

test('DOCX browser layout becomes positioned points without changing text', async () => {
  const pages = await docxToPositionedPages(wordFile(), async () => [
    {
      widthPx: 816,
      heightPx: 1056,
      backgroundPng: 'cG5n',
      runs: [
        {
          text: 'Senior R&D Engineer',
          xPx: 48,
          yPx: 96,
          widthPx: 240,
          heightPx: 16,
          fontSizePx: 16,
          fontFamily: 'Arial, sans-serif',
          fontWeight: '700',
          fontStyle: 'italic',
          color: 'rgb(17, 34, 51)',
        },
      ],
    },
  ]);

  expect(pages[0]).toEqual({
    width: 612,
    height: 792,
    backgroundPng: 'cG5n',
    runs: [
      {
        text: 'Senior R&D Engineer',
        x: 36,
        y: 72,
        width: 180,
        height: 12,
        fontSize: 12,
        fontFamily: 'sans',
        bold: true,
        italic: true,
        color: '112233',
      },
    ],
  });
});

test('DOCX import validates file type, size, parse errors, and editable text', async () => {
  const unused = async () => {
    throw new Error('renderer should not run');
  };
  await expect(docxToPositionedPages(new File(['x'], 'resume.txt'), unused)).rejects.toThrow(
    'Choose a DOCX file',
  );
  await expect(
    docxToPositionedPages(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.docx'), unused),
  ).rejects.toThrow('10 MB or smaller');

  await expect(docxToPositionedPages(wordFile(), unused)).rejects.toThrow(
    'Could not read this Word document',
  );
  await expect(
    docxToPositionedPages(wordFile(), async () => [
      { widthPx: 816, heightPx: 1056, backgroundPng: 'cG5n', runs: [] },
    ]),
  ).rejects.toThrow('no editable text');
});
