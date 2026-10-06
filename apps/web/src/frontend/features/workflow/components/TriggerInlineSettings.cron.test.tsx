import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTrigger } from '../lib/triggers';
import { TriggerInlineSettings } from './TriggerInlineSettings';

describe('TriggerInlineSettings · cron', () => {
  it('says the preview is loading, never that the expression is invalid, then shows fire times', async () => {
    render(
      <TriggerInlineSettings trigger={createTrigger('cron', 't1')} credentials={[]} onChange={() => {}} />
    );
    expect(screen.queryByText(/Enter a valid cron expression/)).toBeNull();
    expect(await screen.findByText(/every hour/i)).toBeTruthy();
    expect(screen.queryByText(/Loading the schedule preview/)).toBeNull();
    expect(screen.queryByText(/Enter a valid cron expression/)).toBeNull();
  });
});
