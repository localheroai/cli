/**
 * Files a run was configured to read but could not.
 *
 * A skip used to be a line on stdout and nothing more, so a run that failed to
 * read every one of its files still printed "No changed keys need translation"
 * and exited 0 (#779). Callers read this to tell "nothing to do" apart from
 * "could not look", and fail the run rather than reporting success.
 *
 * Module state because the skips happen deep inside per-file loops whose
 * signatures are shared by several commands; threading a result through all of
 * them would be a larger change than the bug warrants. Reset at the start of
 * each run.
 */
const unreadableFiles = new Set<string>();

export function resetUnreadableFiles(): void {
  unreadableFiles.clear();
}

export function recordUnreadableFile(path: string): void {
  unreadableFiles.add(path);
}

export function getUnreadableFiles(): string[] {
  return [...unreadableFiles];
}
