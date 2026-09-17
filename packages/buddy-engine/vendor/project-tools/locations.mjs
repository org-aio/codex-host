import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { entries } from './model.mjs';

const manifest = /^(?:package\.json|(?:build|settings)\.gradle(?:\.kts)?|pom\.xml|project\.yaml|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|setup\.py|Pipfile|manage\.py|pubspec\.yaml|(?:docker-)?compose\.ya?ml|[Mm]akefile|[Jj]ustfile|Taskfile\.ya?ml)$|\.(?:csproj|fsproj|sln|slnx)$/;
const containers = new Set(['apps', 'packages', 'services']);
const common = new Set(['frontend', 'backend', 'web', 'server', 'client', 'app', ...containers]);
const ignored = new Set(['node_modules', 'vendor', 'build', 'dist', 'target', 'coverage', 'tmp', 'src']);
const hasManifest = files => files.some(item => item.isFile() && manifest.test(item.name));
const order = (a, b) => Number(common.has(b.name)) - Number(common.has(a.name)) || a.name.localeCompare(b.name);

export async function projectLocations(cwd) {
  if (!cwd) return [];
  let directory = resolve(cwd), files;
  for (let depth = 0; depth < 6; depth++) {
    files = await entries(directory);
    if (hasManifest(files) || files.some(item => item.name === '.git')) break;
    const parent = dirname(directory);
    if (parent === directory || directory === homedir() || depth === 5) return [];
    directory = parent;
  }
  const queue = [{ directory, files, depth: 0 }], locations = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (i === 0 || hasManifest(item.files)) locations.push(item);
    if (item.depth >= 3) continue;
    const children = item.files.filter(child => child.isDirectory() && !child.name.startsWith('.') && !ignored.has(child.name)
      && (item.depth === 0 || containers.has(basename(item.directory)) || common.has(child.name))).sort(order);
    for (const child of children) {
      if (queue.length >= 64) break;
      const path = join(item.directory, child.name);
      queue.push({ directory: path, files: await entries(path), depth: item.depth + 1 });
    }
  }
  return locations;
}
