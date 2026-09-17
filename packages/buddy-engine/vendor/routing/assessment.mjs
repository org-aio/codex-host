import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { classify } from './intent.mjs';
import { inspectProject } from '../project-tools/index.mjs';

const exec = promisify(execFile);
export async function assess(input, cwd, project) {
  const result = classify(input, project || await inspectProject(cwd));
  if (result.tier !== 'simple' || result.intent !== 'git') return result;
  const advanced = reason => ({ ...result, tier: 'advanced', reason });
  if (!cwd) return advanced('工作目录未知，不能确认 Git 操作难度');
  try {
    const [unmerged, directory] = await Promise.all([
      exec('git', ['ls-files', '--unmerged'], { cwd, timeout: 900, maxBuffer: 1024 * 1024 }),
      exec('git', ['rev-parse', '--absolute-git-dir'], { cwd, timeout: 900 }),
    ]);
    if (unmerged.stdout.trim()) return advanced('工作区存在合并冲突');
    const states = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
    const present = await Promise.all(states.map(name => access(join(directory.stdout.trim(), name)).then(() => true, () => false)));
    if (present.some(Boolean)) return advanced('Git 正在合并、变基、拣选或回退中');
  } catch { return advanced('无法确认 Git 工作区状态'); }
  return result;
}
