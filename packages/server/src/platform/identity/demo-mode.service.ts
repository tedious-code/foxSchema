/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demo mode: the install says it is a demo.
 *
 * Off, nothing changes. On, every page shows a demo banner and the sign-in
 * page shows the admin's hint — the published demo login, typically. What a
 * demo account may *do* is the Demo role's business (`demo-access.ts`); this
 * only tells visitors where they are and how to get in.
 */
import { AppSettingsStore } from '../settings/app-settings.service';

export const DEMO_MODE_KEY = 'demo.mode';
export const DEMO_HINT_KEY = 'demo.sign_in_hint';
export const DEMO_HINT_MAX = 300;

export interface DemoModeState {
  on: boolean;
  /** Shown on the sign-in page while demo mode is on. */
  hint: string;
}

export class DemoMode {
  constructor(private settings = new AppSettingsStore()) {}

  async get(): Promise<DemoModeState> {
    const [mode, hint] = await Promise.all([this.settings.get(DEMO_MODE_KEY), this.settings.get(DEMO_HINT_KEY)]);
    return { on: mode === 'on', hint: hint ?? '' };
  }

  /** What anyone may see before signing in: the hint only while demo mode is on. */
  async publicView(): Promise<{ on: boolean; hint?: string }> {
    const state = await this.get();
    return state.on ? { on: true, ...(state.hint ? { hint: state.hint } : {}) } : { on: false };
  }

  async save(input: { on?: unknown; hint?: unknown }): Promise<DemoModeState> {
    if (input.on !== undefined && typeof input.on !== 'boolean') throw new Error('on must be true or false.');
    if (input.hint !== undefined && typeof input.hint !== 'string') throw new Error('hint must be text.');
    const hint = typeof input.hint === 'string' ? input.hint.trim() : undefined;
    if (hint !== undefined && hint.length > DEMO_HINT_MAX) {
      throw new Error(`Keep the hint under ${DEMO_HINT_MAX} characters.`);
    }
    if (typeof input.on === 'boolean') await this.settings.set(DEMO_MODE_KEY, input.on ? 'on' : 'off');
    if (hint !== undefined) await this.settings.set(DEMO_HINT_KEY, hint);
    return this.get();
  }
}
