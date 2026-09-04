import { describe, expect, test } from 'bun:test';
import { CompileArtifactCache } from './artifact-cache.ts';

const artifact = (byte: number, synctex?: string) => ({
  pdf: new Uint8Array([byte, byte + 1]),
  diagnostics: [],
  ...(synctex === undefined ? {} : { synctex }),
});

describe('CompileArtifactCache', () => {
  test('keeps a PDF and its matching SyncTeX data together and isolated from mutation', () => {
    const cache = new CompileArtifactCache(2, 1_000);
    const original = artifact(1, 'matching map');
    cache.set('with-synctex', original);

    original.pdf[0] = 99;
    const first = cache.get('with-synctex');
    expect(first?.pdf).toEqual(new Uint8Array([1, 2]));
    expect(first?.synctex).toBe('matching map');

    if (first) first.pdf[0] = 88;
    expect(cache.get('with-synctex')?.pdf).toEqual(new Uint8Array([1, 2]));
  });

  test('evicts least-recently-used entries to stay within both bounds', () => {
    const cache = new CompileArtifactCache(2, 7);
    cache.set('first', artifact(1));
    cache.set('second', artifact(2));
    cache.get('first');
    cache.set('third', artifact(3));

    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('first')).toBeDefined();
    expect(cache.get('third')).toBeDefined();
    expect(cache.entryCount).toBe(2);
    expect(cache.byteSize).toBeLessThanOrEqual(7);

    cache.set('oversized', artifact(4, 'far too large'));
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.byteSize).toBeLessThanOrEqual(7);
  });
});
