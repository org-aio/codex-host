import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][\w.:-]{0,80}$/.test(value);
export const entries = directory => readdir(directory, { withFileTypes: true }).catch(() => []);
export async function read(directory, name) {
  try {
    const file = join(directory, name);
    const stat = await lstat(file);
    return stat.isFile() && stat.size <= 262144 ? await readFile(file, 'utf8') : '';
  } catch { return ''; }
}
export function collector(cwd) {
  const stacks = new Set(), keywords = new Set(), commands = [];
  return {
    stack: name => stacks.add(name),
    keywords: (...values) => values.filter(safeName).forEach(value => keywords.add(value)),
    command(action, command, source, confidence = 'declared') {
      if (!commands.some(item => item.command === command)) commands.push({ action, command, cwd, source, confidence });
    },
    result: () => ({ stacks: [...stacks], keywords: [...keywords], commands }),
  };
}
