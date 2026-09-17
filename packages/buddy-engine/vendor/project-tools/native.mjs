import { parse } from 'smol-toml';
import { read, entries } from './model.mjs';

export async function native(directory, files, out) {
  if (files.has('Cargo.toml')) {
    out.stack('Rust'); out.keywords('cargo', 'rustc');
    for (const action of ['build', 'test', 'check']) out.command(action, `cargo ${action}`, 'Cargo.toml', 'convention');
    let pkg = {}; try { pkg = parse(await read(directory, 'Cargo.toml')); } catch { /* Keep general Cargo commands. */ }
    if (pkg.bin?.length || await read(directory, 'src/main.rs')) out.command('run', 'cargo run', 'Cargo.toml', 'convention');
  }
  if (files.has('go.mod')) {
    out.stack('Go'); out.keywords('go');
    for (const action of ['build', 'test']) out.command(action, `go ${action} ./...`, 'go.mod', 'convention');
    if (/package\s+main\b/.test(await read(directory, 'main.go'))) out.command('run', 'go run .', 'main.go');
  }
  if ([...files].some(name => /\.(?:csproj|fsproj|sln|slnx)$/.test(name))) {
    out.stack('.NET'); out.keywords('dotnet');
    const projects = [...files].filter(name => /\.(?:csproj|fsproj)$/.test(name));
    const solutions = [...files].filter(name => /\.(?:sln|slnx)$/.test(name));
    if (projects.length === 1 || solutions.length === 1) {
      for (const action of ['build', 'test']) out.command(action, `dotnet ${action}`, projects[0] || solutions[0], 'convention');
      if (projects.length === 1 && /(?:Microsoft\.NET\.Sdk\.Web|<OutputType>\s*(?:Exe|WinExe))/.test(await read(directory, projects[0]))) out.command('run', 'dotnet run', projects[0], 'convention');
    }
  }
  if (files.has('pubspec.yaml')) {
    const body = await read(directory, 'pubspec.yaml');
    const cli = /sdk:\s*flutter/.test(body) ? 'flutter' : 'dart';
    out.stack(cli === 'flutter' ? 'Flutter/Dart' : 'Dart'); out.keywords(cli);
    out.command('test', `${cli} test`, 'pubspec.yaml', 'convention');
    out.command('check', `${cli} analyze`, 'pubspec.yaml', 'convention');
    if (cli === 'flutter') out.command('run', 'flutter run', 'pubspec.yaml', 'convention');
    else if ((await entries(`${directory}/bin`)).some(item => item.isFile() && item.name.endsWith('.dart'))) out.command('run', 'dart run', 'pubspec.yaml', 'convention');
  }
}
