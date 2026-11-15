/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TriggerEndpointCard } from './TriggerEndpointCard';

describe('TriggerEndpointCard', () => {
  it('renders HTTP API endpoint call details and curl command', () => {
    render(
      <TriggerEndpointCard
        workflowId="sample-cities-postgres"
        triggerId="api_trigger"
        kind="http"
        requiredFields={['city']}
      />,
    );

    expect(screen.getByText('API Endpoint Call')).toBeTruthy();
    expect(screen.getByText('POST')).toBeTruthy();
    expect(
      screen.getByText('/api/triggers/sample-cities-postgres/api_trigger'),
    ).toBeTruthy();
    expect(screen.getByText(/cURL Command/i)).toBeTruthy();
    expect(
      screen.getByText(/curl -X POST.*sample-cities-postgres\/api_trigger/),
    ).toBeTruthy();
  });
});
