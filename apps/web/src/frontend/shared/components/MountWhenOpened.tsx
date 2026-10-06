import React, { Suspense, useState } from 'react';

/**
 * Renders a lazily loaded panel from the first time it opens, and keeps it
 * mounted after it closes.
 *
 * Panels such as the admin console and the credential manager render nothing
 * while closed, yet a static import put their code in every first page load.
 * With this the code is fetched on the first open, and because the panel then
 * stays mounted its own state survives closing exactly as it did before.
 */
export function MountWhenOpened({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [opened, setOpened] = useState(open);
  // Adjusting state while rendering, as React documents for state derived from props.
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}
