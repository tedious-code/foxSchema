/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { disarmPasswordAutofill } from './passwordAutofill';

describe('disarmPasswordAutofill', () => {
  it('marks the editor textarea so Enter does not unlock saved passwords', () => {
    document.body.innerHTML =
      '<div id="ed"><textarea class="inputarea" autocomplete="off"></textarea></div>';
    disarmPasswordAutofill(document.getElementById('ed'));
    const area = document.querySelector('textarea')!;
    expect(area.getAttribute('autocomplete')).toBe('one-time-code');
    expect(area.getAttribute('data-form-type')).toBe('other');
    expect(area.getAttribute('data-1p-ignore')).toBe('true');
    expect(area.getAttribute('data-lpignore')).toBe('true');
    expect(area.getAttribute('name')).toBe('foxschema-sql-buffer');
  });

  it('does nothing when the editor has not mounted a textarea yet', () => {
    expect(() => disarmPasswordAutofill(null)).not.toThrow();
    expect(() => disarmPasswordAutofill(document.createElement('div'))).not.toThrow();
  });
});
