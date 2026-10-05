export async function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("IDE request cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}
