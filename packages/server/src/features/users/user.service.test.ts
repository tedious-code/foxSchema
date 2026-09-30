import { describe, it, expect, beforeAll } from 'vitest';

process.env.APP_DB_PATH = ':memory:';

import { AuthModule } from '../auth/auth.service';
import { UserModule } from './user.service';

const auth = new AuthModule();
const users = new UserModule();

let userId: string;

beforeAll(async () => {
  userId = (await auth.createUser('pref@example.com', 'correct-horse-9', 'viewer')).id;
});

describe('UserModule preferences', () => {
  it('defaults to empty prefs with onboarding incomplete', async () => {
    const p = await users.getPreferences(userId);
    expect(p).toEqual({
      role: undefined,
      primaryDatabase: undefined,
      primaryGoal: undefined,
      theme: undefined,
      onboardingCompleted: false,
    });
  });

  it('writes the full onboarding answer in one update', async () => {
    const p = await users.updatePreferences(userId, {
      role: 'DBA',
      primaryDatabase: 'DB2',
      primaryGoal: 'COMPARE_SCHEMAS',
      onboardingCompleted: true,
    });
    expect(p).toMatchObject({ role: 'DBA', primaryDatabase: 'DB2', primaryGoal: 'COMPARE_SCHEMAS', onboardingCompleted: true });
  });

  it('persists across reads', async () => {
    expect((await users.getPreferences(userId)).role).toBe('DBA');
    expect((await users.getPreferences(userId)).onboardingCompleted).toBe(true);
  });

  it('partial update preserves other fields', async () => {
    const p = await users.updatePreferences(userId, { theme: 'dark' });
    expect(p.theme).toBe('dark');
    expect(p.role).toBe('DBA'); // unchanged
    expect(p.primaryDatabase).toBe('DB2');
    expect(p.primaryGoal).toBe('COMPARE_SCHEMAS');
    expect(p.onboardingCompleted).toBe(true); // unchanged
  });

  it('theme-only save does not wipe survey answers after a concurrent-style write', async () => {
    // Simulate appearance sync that only sends theme — survey columns must stay.
    await users.updatePreferences(userId, {
      theme: JSON.stringify({ themeMode: 'dark', tone: 'slate' }),
    });
    const p = await users.getPreferences(userId);
    expect(p.role).toBe('DBA');
    expect(p.primaryDatabase).toBe('DB2');
    expect(p.primaryGoal).toBe('COMPARE_SCHEMAS');
    expect(p.theme).toContain('themeMode');
  });
});
