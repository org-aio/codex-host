import { resolve } from 'node:path';
import { inspectProject } from '../project-tools/index.mjs';
import { command } from '../runtime/index.mjs';
import { normalizePhrase, phraseIntent } from './phrases.mjs';
import { fallback, matched, recipe } from './model.mjs';

const gitCommands = {
  'git.status': ['status', '--short', '--branch'],
  'git.branch': ['branch', '--show-current'],
  'git.log': ['log', '-10', '--oneline'],
  'git.diff': ['diff', '--no-ext-diff', '--no-textconv'],
};
// Tokenize only invocations constructed by our manifest detectors, never user text.
const invocation = value => typeof value === 'string' && /^[a-zA-Z0-9_./:@-]+(?: [a-zA-Z0-9_./:@-]+)*$/.test(value) ? value.split(' ') : null;
export async function resolveDispatch(text, cwd, { project } = {}) {
  const value = normalizePhrase(text);
  if (!value || !cwd) return fallback('not-a-complete-command');
  const directory = resolve(cwd), intent = phraseIntent(value);
  if (gitCommands[intent]) {
    try { await command('git', ['rev-parse', '--git-dir'], { cwd: directory, timeout: 1500 }); }
    catch { return fallback('not-a-git-repository'); }
    return matched(recipe(intent, ['git', '--no-pager', ...gitCommands[intent]], directory, 'builtin', 'inspect'));
  }
  const report = project || await inspectProject(directory);
  const commands = report.commands || [];
  const exact = commands.filter(item => [item.command, item.command.replace(/^(pnpm|yarn|bun) run /, '$1 ')].includes(value));
  let choices = exact.length ? exact : commands.filter(item => item.action === intent);
  if (intent === 'lint' || intent === 'typecheck') choices = commands.filter(item => item.action === 'check' && item.command.split(' ').at(-1) === intent);
  // A phrase without an exact discovered invocation never executes inspect/help conventions.
  if (!exact.length && !intent) return fallback('no-rule');
  choices = choices.filter(item => invocation(item.command));
  if (!choices.length) return fallback('missing-project-entry');
  if (choices.length !== 1) return { route: 'clarify', reason: 'multiple-project-entries', providerRequests: 0, choices: choices.map(item => ({ command: item.command, cwd: item.cwd, source: item.source })) };
  const item = choices[0];
  return matched(recipe(`project.${item.action}`, invocation(item.command), item.cwd, item.source, item.action));
}
