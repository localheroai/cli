const pathQueues = new Map<string, Promise<unknown>>();

export async function runSerializedByPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  pathQueues.set(path, current);
  return current;
}

export function resetPathSerializer(): void {
  pathQueues.clear();
}
