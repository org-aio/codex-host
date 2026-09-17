import { join } from 'node:path';
import { read, entries, safeName } from './model.mjs';

export async function jvm(directory, files, out) {
  if (files.has('project.yaml') && (files.has('kotlin') || files.has('amper'))) {
    const cli = files.has('kotlin') ? 'kotlin' : 'amper';
    out.stack('Kotlin Toolchain'); out.keywords(cli, 'java');
    for (const action of ['build', 'test']) out.command(action, `./${cli} ${action}`, 'project.yaml', 'convention');
    out.command('inspect', `./${cli} show modules`, 'project.yaml', 'convention');
    if (/^product:\s*(?:jvm|js|android|ios|linux|macos|windows)\/app\b/m.test(await read(directory, 'module.yaml'))) out.command('run', `./${cli} run`, 'module.yaml', 'convention');
    if (/^\s*-\s*\.\/apps\/\*\s*$/m.test(await read(directory, 'project.yaml'))) {
      for (const item of (await entries(join(directory, 'apps'))).filter(item => item.isDirectory() && safeName(item.name)).slice(0, 24)) {
        const source = `apps/${item.name}/module.yaml`;
        if (/^product:\s*(?:jvm|js|android|ios|linux|macos|windows)\/app\b/m.test(await read(directory, source))) out.command('run', `./${cli} run -m ${item.name}`, source, 'convention');
      }
    }
  }
  const builds = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].filter(name => files.has(name));
  if (builds.length) {
    out.stack('JVM/Gradle'); out.keywords('gradle', 'gradlew');
    const cli = files.has('gradlew') ? './gradlew' : 'gradle';
    const source = builds[0];
    out.command('inspect', `${cli} tasks`, source, 'convention');
    const body = (await Promise.all(builds.map(file => read(directory, file)))).join('\n');
    if (/(?:kotlin|java|application|org\.springframework\.boot)/.test(body)) {
      for (const action of ['build', 'test']) out.command(action, `${cli} ${action}`, source, 'convention');
    }
    if (/org\.springframework\.boot/.test(body)) out.command('run', `${cli} bootRun`, source, 'convention');
    else if (/\bapplication\b/.test(body)) out.command('run', `${cli} run`, source, 'convention');
  }
  if (files.has('pom.xml')) {
    out.stack('JVM/Maven'); out.keywords('mvn', 'mvnw');
    const cli = files.has('mvnw') ? './mvnw' : 'mvn';
    out.command('build', `${cli} package`, 'pom.xml', 'convention');
    out.command('test', `${cli} test`, 'pom.xml', 'convention');
    if ((await read(directory, 'pom.xml')).includes('spring-boot-maven-plugin')) out.command('run', `${cli} spring-boot:run`, 'pom.xml', 'convention');
  }
}
