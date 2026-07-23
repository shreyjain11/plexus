let counter = 0;

/** Unique-enough id for scene objects. Generated in event handlers (never
 * inside the reducer) so React StrictMode's double-invoked reducers stay pure. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
