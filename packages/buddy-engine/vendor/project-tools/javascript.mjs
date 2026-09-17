import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { read, safeName, entries } from './model.mjs';

async function packageManager(directory, files, pkg) {
  for (let depth = 0; depth < 6; depth++) {
    const declared = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(pkg.packageManager || '')?.[1];
    const lock = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']].find(([name]) => files.has(name));
    if (declared || lock) return declared || lock[1];
    const currentEntries = await entries(directory);
    if (currentEntries.some(item => item.name === '.git') || directory === homedir() || dirname(directory) === directory) break;
    directory = dirname(directory);
    files = new Set((await entries(directory)).filter(item => item.isFile()).map(item => item.name));
    try { pkg = JSON.parse(await read(directory, 'package.json')); } catch { pkg = {}; }
  }
  return 'npm';
}

const scriptAction = name => {
  if (/^(?:dev|start|serve|run|preview)(?::|$)/.test(name)) return 'run';
  if (/^(?:build|compile|bundle)(?::|$)/.test(name)) return 'build';
  if (/^test(?::|$)/.test(name)) return 'test';
  if (/^(?:lint|typecheck|check)(?::|$)/.test(name)) return 'check';
};
export async function javascript(directory, files, out) {
  if (!files.has('package.json')) return;
  const pkg = JSON.parse(await read(directory, 'package.json'));
  const manager = await packageManager(directory, files, pkg);
  out.stack('JavaScript/TypeScript'); out.keywords(manager, 'node');
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const cli of ['vite', 'next', 'nuxt', 'astro', 'eslint', 'vitest', 'playwright', 'webpack', 'turbo', 'nx']) {
    if (dependencies[cli] || dependencies[`@${cli}/test`]) out.keywords(cli);
  }
  if (dependencies.typescript) out.keywords('tsc');
  for (const name of Object.keys(pkg.scripts || {})) {
    const action = scriptAction(name);
    if (action && safeName(name)) {
      out.keywords(name);
      // Script bodies may contain secrets or shell code; only expose the invocation.
      out.command(action, `${manager} run ${name}`, 'package.json');
    }
  }
}
