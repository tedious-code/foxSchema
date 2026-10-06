/**
 * Memoise an on-demand load, usually a dynamic `import()` of something too big
 * for the first download (sql-formatter, Prettier, faker, lodash, zod).
 *
 * Every caller shares one promise. A failed load is forgotten rather than
 * cached, so a dropped connection is retried by the next caller instead of
 * breaking the feature until the page is reloaded.
 */
export interface Loader<T> {
  (): Promise<T>;
  /** The value once a load has succeeded, for code that cannot wait; else undefined. */
  peek(): T | undefined;
}

export function loadOnce<T>(load: () => Promise<T>): Loader<T> {
  let pending: Promise<T> | null = null;
  let loaded: { value: T } | null = null;
  const get = () => {
    pending ??= load().then(
      (value) => {
        loaded = { value };
        return value;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      }
    );
    return pending;
  };
  return Object.assign(get, { peek: () => loaded?.value });
}
