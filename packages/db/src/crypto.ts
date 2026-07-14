/**
 * AES-256-GCM for provider secrets at rest.
 *
 * This protects against a leaked database dump, which is the realistic threat:
 * a stolen `pg_dump` full of live Anthropic and OpenAI keys is a very bad day.
 * It does NOT protect against an attacker who already has the app's environment,
 * and it is not pretending to — that is what a KMS is for, and where this should
 * go if Sailor ever holds keys for people who are not the operator.
 */
const KEY_ENV = 'SAILOR_ENCRYPTION_KEY';
const IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Generate one with:\n` +
        `  bun -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes, got ${bytes.length}`);
  }

  cachedKey = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return cachedKey;
}

/** Returns `base64(iv).base64(ciphertext)`. The IV is random per encryption. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${Buffer.from(iv).toString('base64')}.${Buffer.from(ciphertext).toString('base64')}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  const [ivPart, dataPart] = stored.split('.');
  if (!ivPart || !dataPart) {
    throw new Error('Stored secret is malformed; expected "base64(iv).base64(ciphertext)"');
  }

  const key = await getKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivPart, 'base64') },
    key,
    Buffer.from(dataPart, 'base64'),
  );
  return new TextDecoder().decode(plaintext);
}
