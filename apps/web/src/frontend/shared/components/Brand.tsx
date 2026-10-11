import React from 'react';
import { FoxLogo, FOX_ORANGE } from './FoxLogo';

/**
 * "Fox Schema" wordmark. "Fox" carries the brand orange; "Schema" is the
 * subdued qualifier — same pairing as the npm scope (@foxschema/*) and the
 * `fox` CLI command, which are unaffected by this display name.
 */
export const Wordmark: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`tracking-tight antialiased ${className ?? ''}`}>
    <span style={{ color: FOX_ORANGE }}>Fox</span>
    <span className="text-slate-400"> Schema</span>
  </span>
);

/**
 * Full brand lockup: orange fox + wordmark, with an optional "Comparison and
 * Sync" sub-label (flanked by short orange rules, matching the logo).
 */
export const Brand: React.FC<{
  logoSize?: number;
  textClassName?: string;
  subtitle?: string | false;
  className?: string;
}> = ({ logoSize = 38, textClassName = 'text-xl font-bold', subtitle = 'Comparison and Sync', className }) => (
  <div className={`flex items-center gap-3 ${className ?? ''}`}>
    <FoxLogo size={logoSize} />
    <div className="flex flex-col leading-none">
      <Wordmark className={textClassName} />
      {subtitle && (
        <span className="mt-1.5 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-400 antialiased">
          <span className="h-px flex-1" style={{ backgroundColor: FOX_ORANGE, opacity: 0.75 }} />
          <span className="whitespace-nowrap">{subtitle}</span>
          <span className="h-px flex-1" style={{ backgroundColor: FOX_ORANGE, opacity: 0.75 }} />
        </span>
      )}
    </div>
  </div>
);
