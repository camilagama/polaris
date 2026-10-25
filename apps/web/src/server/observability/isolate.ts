/**
 * Which isolate served a request, and how many invocations it had served by then (CPU-1d). The CPU time of a request
 * in the Workers Logs (`cpu_time_ms`) does not say whether the isolate was new; the request log carries `isolate.seq`
 * and the `requestId` that ties it to that time: `seq` 1 is the cold request. The id is random, made by the isolate,
 * and says nothing about the person.
 */
export interface IsolateInvocation {
  readonly id: string;
  readonly seq: number;
}

let isolateId: string | undefined;
let invocations = 0;

/** Counts one invocation of this isolate (a request, a cron tick, a queue batch) and says which one it is. */
export function countIsolateInvocation(): IsolateInvocation {
  // a Worker may not make random values at the top level of its module, so the id comes with the first invocation
  isolateId ??= crypto.randomUUID();
  invocations += 1;
  return { id: isolateId, seq: invocations };
}
