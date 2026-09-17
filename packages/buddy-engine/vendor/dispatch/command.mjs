// POSIX only. Quote every token, including cwd; never interpolate a raw prompt.
export const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function shellCommand(plan, text, entry) {
  const label = text.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\\$/, '').slice(0, 256);
  return `# Auto 规则直达，模型：无。常用语：${label}\nexec ${[process.execPath, entry, '--router-run', plan.cwd, ...plan.argv].map(quote).join(' ')}`;
}
