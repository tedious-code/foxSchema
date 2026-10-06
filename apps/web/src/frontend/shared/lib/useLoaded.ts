import { useEffect, useState } from 'react';
import type { Loader } from './loadOnce';

/**
 * A `loadOnce` value for a component that needs it while rendering: null until
 * it has loaded, then the value, with one re-render when it arrives. Starts the
 * load on mount. If the load fails the component keeps getting null, and the
 * next component to mount tries again.
 */
export function useLoaded<T>(loader: Loader<T>): T | null {
  const [value, setValue] = useState<{ current: T } | null>(() => {
    const ready = loader.peek();
    return ready === undefined ? null : { current: ready };
  });
  useEffect(() => {
    if (value) return;
    let live = true;
    loader().then(
      (current) => live && setValue({ current }),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [loader, value]);
  return value?.current ?? null;
}
