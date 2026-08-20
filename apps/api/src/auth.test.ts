import { expect, test } from 'bun:test';
import { auth } from './auth.ts';

test('an OAuth account can be found by issuer and account ID', async () => {
  const adapter = (await auth.$context).internalAdapter;
  const accountId = crypto.randomUUID();
  const { user } = await adapter.createOAuthUser(
    {
      email: `oauth-${crypto.randomUUID()}@sailor.local`,
      emailVerified: true,
      name: 'OAuth test',
    },
    {
      accountId,
      issuer: 'local:oauth:github',
      providerId: 'github',
    },
  );

  try {
    expect(
      await adapter.findAccountByKey({ accountId, issuer: 'local:oauth:github' }),
    ).toMatchObject({
      accountId,
      issuer: 'local:oauth:github',
      userId: user.id,
    });
  } finally {
    await adapter.deleteUser(user.id);
  }
});
