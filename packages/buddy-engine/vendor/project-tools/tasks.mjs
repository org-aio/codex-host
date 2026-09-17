import { read, safeName } from './model.mjs';

export async function tasks(directory, files, out) {
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(file => files.has(file));
  if (compose) {
    out.stack('Compose'); out.keywords('docker', 'compose');
    for (const [action, verb] of [['run', 'up'], ['build', 'build'], ['inspect', 'ps']]) out.command(action, `docker compose ${verb}`, compose, 'convention');
  }
  for (const [file, cli] of [['Makefile', 'make'], ['makefile', 'make'], ['justfile', 'just'], ['Justfile', 'just'], ['Taskfile.yml', 'task'], ['Taskfile.yaml', 'task']]) {
    if (!files.has(file)) continue;
    out.stack('Task runner'); out.keywords(cli);
    const body = await read(directory, file);
    const pattern = cli === 'task' ? /^  ([\w.-]+):\s*(?:#.*)?$/gm : /^([\w.-]+)\s*:(?!=)/gm;
    for (const match of body.matchAll(pattern)) {
      const name = match[1];
      const action = /^(?:dev|start|serve|run)$/.test(name) ? 'run' : /^(?:build|compile)$/.test(name) ? 'build' : name === 'test' ? 'test' : /^(?:check|lint)$/.test(name) ? 'check' : null;
      if (action && safeName(name)) { out.keywords(name); out.command(action, `${cli} ${name}`, file); }
    }
  }
}
