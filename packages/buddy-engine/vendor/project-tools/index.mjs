import { collector } from './model.mjs';
import { projectLocations } from './locations.mjs';
import { javascript } from './javascript.mjs';
import { jvm } from './jvm.mjs';
import { native } from './native.mjs';
import { python } from './python.mjs';
import { tasks } from './tasks.mjs';

const detectors = [javascript, jvm, native, python, tasks];

export async function inspectProject(cwd) {
  const empty = { root: null, stacks: [], keywords: [], commands: [] };
  const locations = await projectLocations(cwd);
  if (!locations.length) return empty;
  const reports = await Promise.all(locations.map(async location => {
    const out = collector(location.directory);
    const files = new Set(location.files.filter(item => item.isFile()).map(item => item.name));
    await Promise.allSettled(detectors.map(detect => detect(location.directory, files, out)));
    return out.result();
  }));
  return {
    root: locations[0].directory,
    stacks: [...new Set(reports.flatMap(report => report.stacks))].sort(),
    keywords: [...new Set(reports.flatMap(report => report.keywords))].sort(),
    commands: reports.flatMap(report => report.commands).sort((a, b) => a.cwd.localeCompare(b.cwd) || a.action.localeCompare(b.action) || a.command.localeCompare(b.command)),
  };
}
