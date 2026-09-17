import { spawn } from 'node:child_process';
import { dirname, delimiter } from 'node:path';

export const environmentPath = env => Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';

export function processArguments(binary, args, options = {}) {
  const environment = options.env || process.env;
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = dirname(process.execPath) + delimiter + environmentPath(environment);
  // JS 入口始终交给当前 Node，避免 Windows 将它当作原生可执行文件。
  const script = /\.[cm]?js$/i.test(binary);
  return [script ? process.execPath : binary, script ? [binary, ...args] : args, { ...options, env }];
}

export const spawnCommand = (binary, args, options) => spawn(...processArguments(binary, args, options));
