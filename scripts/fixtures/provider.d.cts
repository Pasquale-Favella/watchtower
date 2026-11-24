/** Creates a controlled provider history and child-process environment under the test profile. */
export function prepareProviderFixture(profile: string): { env: Record<string, string> }

/** Chooses the Git executable for a restricted PATH: the `cmd` launcher when installed, else the first match. */
export function selectGitExecutable(candidates: readonly string[]): string | undefined
