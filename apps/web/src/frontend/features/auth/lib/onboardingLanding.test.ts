import { describe, expect, it } from 'vitest';
import { landingForGoal } from './onboardingLanding';

describe('landingForGoal', () => {
  it('opens the screen each first-task answer names', () => {
    expect(landingForGoal('COMPARE_SCHEMAS')).toEqual({ view: 'sync', syncPane: 'compare' });
    expect(landingForGoal('GENERATE_SQL')).toEqual({ view: 'sync', syncPane: 'compare' });
    expect(landingForGoal('RUN_SQL')).toEqual({ view: 'sqlEditor' });
    expect(landingForGoal('EXPLORE_DATABASE')).toEqual({ view: 'sqlEditor' });
    expect(landingForGoal('AUTOMATE_WORKFLOWS')).toEqual({ view: 'workflow' });
    expect(landingForGoal('CREATE_DOCUMENTATION')).toEqual({ view: 'sync', syncPane: 'browse' });
  });

  it('leaves the default workspace alone when the step was skipped', () => {
    expect(landingForGoal(undefined)).toBeNull();
    expect(landingForGoal('SOMETHING_NEW')).toBeNull();
  });
});
