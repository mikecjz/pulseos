export function readEnvFile(path: string): Record<string, string>
export function launchEnv(
  base: Record<string, string | undefined>,
  fromFile?: Record<string, string>,
  defaults?: Record<string, string>,
): Record<string, string>
