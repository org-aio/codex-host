import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { processArguments } from './process.mjs';

const exec = promisify(execFile);

export async function command(binary, args, options = {}) {
  try {
    const { stdout } = await exec(...processArguments(binary, args, { timeout: 30000, maxBuffer: 24 * 1024 * 1024, ...options }));
    return stdout;
  } catch (error) {
    const failure = new Error(`Command failed (${typeof error.code === 'number' ? `exit ${error.code}` : error.code || 'timeout'}).`);
    failure.code = error.code;
    throw failure;
  }
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON file: ${path}`);
  }
}

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function withLock(directory, operation) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'sync.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(join(lock, 'owner.json'), {});
    let alive = true;
    if (owner.pid) {
      try { process.kill(owner.pid, 0); } catch (failure) { alive = failure.code !== 'ESRCH'; }
    } else { alive = Date.now() - (await stat(lock)).mtimeMs < 120000; }
    if (alive) throw Object.assign(new Error('Another model sync is running.'), { code: 'ELOCKED' });
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  try {
    await atomicWrite(join(lock, 'owner.json'), { pid: process.pid });
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
