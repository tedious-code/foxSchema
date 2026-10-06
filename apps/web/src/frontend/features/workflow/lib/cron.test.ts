import { describe, expect, it } from 'vitest';
import { loadCronTools } from './cron';

describe('cron tools, loaded on demand', () => {
  it('describes an expression and steps through its fire times in a timezone', async () => {
    const cron = await loadCronTools();
    expect(cron.describe('0 * * * *')).toMatch(/every hour/i);
    const runs = cron.nextRuns('0 * * * *', 'UTC', 3)!;
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.getUTCMinutes() === 0)).toBe(true);
  });

  it('says an expression is invalid rather than guessing', async () => {
    const cron = await loadCronTools();
    expect(cron.describe('not a cron')).toBe('Invalid cron expression');
    expect(cron.nextRuns('not a cron', 'UTC')).toBeNull();
  });
});
