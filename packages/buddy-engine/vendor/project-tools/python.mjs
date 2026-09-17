import { parse } from 'smol-toml';
import { read, safeName } from './model.mjs';

export async function python(directory, files, out) {
  if (!['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'manage.py'].some(name => files.has(name))) return;
  out.stack('Python'); out.keywords('python', 'python3');
  const source = files.has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt';
  const body = await read(directory, source);
  let pkg = {}; try { pkg = parse(body); } catch { /* Requirements need no TOML parser. */ }
  const cli = files.has('uv.lock') || pkg.tool?.uv ? 'uv' : files.has('poetry.lock') || pkg.tool?.poetry ? 'poetry' : null;
  const prefix = cli ? `${cli} run ` : '';
  if (cli) out.keywords(cli);
  for (const keyword of ['pytest', 'ruff', 'uvicorn', 'gunicorn', 'django', 'fastapi']) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(body)) out.keywords(keyword);
  }
  for (const name of Object.keys(pkg.project?.scripts || pkg.tool?.poetry?.scripts || {})) {
    if (!safeName(name)) continue;
    out.keywords(name);
    // Entry point names alone do not establish whether they start a service.
    out.command('inspect', `${prefix}${name} --help`, 'pyproject.toml', 'convention');
  }
  if (files.has('manage.py')) out.command('run', `${prefix}python manage.py runserver`, 'manage.py', 'convention');
  if (/\bpytest\b/.test(body)) out.command('test', `${prefix}pytest`, source, 'convention');
  if (/\bruff\b/.test(body)) out.command('check', `${prefix}ruff check .`, source, 'convention');
}
