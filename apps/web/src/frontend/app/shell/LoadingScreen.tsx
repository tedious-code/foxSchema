import React from 'react';
import { FoxLogo, FOX_ORANGE } from '@/shared/components/FoxLogo';
import { Wordmark } from '@/shared/components/Brand';

/**
 * Full-screen boot splash shown for the async gap between process start and
 * the first real screen (setup wizard / login / app) — main.tsx renders this
 * synchronously before awaiting resolveApiBase(), so there's
 * never a blank frame while the desktop sidecar spins up or the API base
 * resolves.
 */
export const LoadingScreen: React.FC = () => (
  <div className="h-screen flex items-center justify-center bg-slate-950 relative overflow-hidden">
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(circle at 50% 45%, ${FOX_ORANGE}1a 0%, transparent 60%)`,
      }}
    />
    <div className="relative flex flex-col items-center gap-5">
      <div className="animate-pulse">
        <FoxLogo size={72} />
      </div>
      <Wordmark className="text-3xl font-bold" />
      <div className="flex items-center gap-2 mt-2">
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: FOX_ORANGE, animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: FOX_ORANGE, animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: FOX_ORANGE, animationDelay: '300ms' }} />
      </div>
    </div>
  </div>
);
