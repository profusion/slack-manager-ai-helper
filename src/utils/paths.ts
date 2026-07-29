import path from 'node:path';
import process from 'node:process';

export function expandHome(input: string): string {
  const env: { readonly HOME?: string } = process.env;

  if (input === '~') {
    return env.HOME ?? input;
  }

  if (input.startsWith('~/')) {
    return path.join(env.HOME ?? '~', input.slice(2));
  }

  return input;
}

export function resolveFromConfig(configPath: string, input: string): string {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  return path.resolve(path.dirname(configPath), expanded);
}

export function defaultStatePath(configPath: string): string {
  return path.resolve(path.dirname(configPath), `state-${topicIdFromConfigPath(configPath)}.json`);
}

export function topicIdFromConfigPath(configPath: string): string {
  const basename = path.basename(configPath, path.extname(configPath));
  return basename.endsWith('-config') ? basename.slice(0, -'-config'.length) : basename;
}
