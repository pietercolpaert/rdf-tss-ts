/** Computes the matrix profile and the contextual matrix profile off the main thread. */
import { computeProfiles } from './matrixprofile.js';

export interface ProfileJob {
  id: number;
  values: Float64Array;
  m: number;
  of: Int32Array;
  count: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProfileJob>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, values, m, of, count } = event.data;
  try {
    const result = computeProfiles(values, m, { of, count }, { onProgress: (progress) => scope.postMessage({ id, progress }) });
    scope.postMessage({ id, result }, [result.profile.buffer, result.index.buffer, result.cmp.buffer, result.cmpWindows.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: (error as Error).message });
  }
};
