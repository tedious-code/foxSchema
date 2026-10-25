/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shown on every page while an admin has demo mode on, so a visitor knows
 * why saving does nothing before the first refusal tells them.
 */
import React from 'react';
import { Eye } from 'lucide-react';
import { useAuthStore } from '@/platform/authStore';
import { useDemoMode } from '@/shared/lib/useDemoMode';

export const DemoBanner: React.FC = () => {
  const demo = useDemoMode();
  const role = useAuthStore((s) => s.user?.role);
  if (!demo?.on) return null;
  return (
    <div
      data-testid="demo-banner"
      role="status"
      className="bg-sky-950/60 border-b border-sky-500/30 px-6 py-1.5 flex items-center gap-2 text-xs text-sky-100"
    >
      <Eye className="w-3.5 h-3.5 text-sky-300 shrink-0" />
      <span className="font-bold">Demo</span>
      <span className="text-sky-200/90">
        {role === 'demo'
          ? 'Explore the sample databases: browse, compare, and run queries. Nothing here can be saved or changed.'
          : 'Demo mode is on: visitors see this banner, and the sign-in page shows the demo login.'}
      </span>
    </div>
  );
};
