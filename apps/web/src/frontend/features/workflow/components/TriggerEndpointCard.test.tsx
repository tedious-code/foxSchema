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
  it('renders a webhook endpoint and a curl command for it', () => {
    render(<TriggerEndpointCard workflowId="orders" triggerId="webhook" />);

    expect(screen.getByText('Webhook endpoint')).toBeTruthy();
    expect(screen.getByText('POST')).toBeTruthy();
    expect(screen.getByText('/api/triggers/orders/webhook')).toBeTruthy();
    expect(screen.getByText(/cURL Command/i)).toBeTruthy();
    expect(screen.getByText(/curl -X POST.*orders\/webhook/)).toBeTruthy();
  });

  it('uses the vanity path when the webhook has one', () => {
    render(<TriggerEndpointCard workflowId="orders" triggerId="webhook" path="stripe/events" />);

    expect(screen.getByText('/api/hooks/stripe/events')).toBeTruthy();
  });
});
