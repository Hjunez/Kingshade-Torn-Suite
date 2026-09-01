/**
 * @template T
 * @returns {{ promise: Promise<T>, resolve: (value: T) => void, reject: (reason?: unknown) => void }}
 */
export function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {
    throw new Error('Deferred promise resolved before initialization.');
  };
  /** @type {(reason?: unknown) => void} */
  let reject = () => {
    throw new Error('Deferred promise rejected before initialization.');
  };

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

export async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
