export * from './job.ts';
export * from './latex.ts';
export * from './provider.ts';
export * from './result.ts';
export * from './resume.ts';

/** Collision-resistant id. Sortable by creation time, unlike a bare uuid4. */
export function createId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}_${time}${rand}`;
}
