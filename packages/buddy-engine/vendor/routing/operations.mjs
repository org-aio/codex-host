const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = text => text.trim().replace(/^(?:(?:请|帮我|麻烦|把|将|执行|运行命令)\s*)+/i, '').replace(/[。.!！\s]+$/, '');
const subject = '(?:(?:这个|当前)?(?:项目|应用|服务|前端|后端|前后端))?';
const run = new RegExp(`^(?:${subject}(?:跑起来(?:看看)?|启动(?:一下)?|运行(?:一下)?)|(?:启动|运行)(?:一下)?${subject})(?:看看|并打开浏览器)?$`);
const patterns = [
  ['run', run], ['run', /^(?:start|run)(?: the)? (?:app|project|server)$/i],
  ['build', /^(?:(?:项目|前端|后端)(?:构建|编译|打包)|(?:构建|编译|打包)(?:一下)?(?:项目|前端|后端)?|build(?: the)?(?: project|app)?)$/i],
  ['test', /^(?:(?:跑|运行|执行)(?:一下)?(?:单元|集成|全部|所有)?测试(?:看看)?|(?:run )?(?:the )?tests?)$/i],
  ['check', /^(?:(?:跑|运行|执行)(?:一下)?(?:lint|类型检查|静态检查)|(?:run )?(?:lint|typecheck))$/i],
];
export function operation(text, project = {}) {
  const value = clean(text);
  const commands = project.commands || [];
  const action = patterns.find(([, pattern]) => pattern.test(value))?.[0];
  if (action) return { action, tier: commands.some(item => item.action === action) ? 'simple' : 'standard' };
  if (/^(?:(?:项目|应用|服务|前端|后端))?(?:跑不起来|启动失败|启动报错)(?:看看|帮我看看|排查一下)?[。.!！\s]*$/.test(value)) return { action: 'diagnose', tier: 'standard' };
  // Recognize only discovered invocations and bounded CLI options, never shell programs.
  if (!/[;&|`$<>\r\n]/.test(value)) for (const item of commands) {
    const aliases = [item.command, item.command.replace(/^(pnpm|yarn|bun) run /, '$1 ')];
    const options = '(?: --?(?:[\\w.-]+(?:=[\\w./:@,-]+)?)?(?: [\\w./:@,-]+)?)*';
    if (aliases.some(command => new RegExp(`^${escape(command)}${options}$`, 'i').test(value))) return { action: item.action, tier: 'simple' };
  }
  return null;
}

export function operationIntent(text, project = {}) {
  if (operation(text, project) || /跑起来|跑不起来|启动|构建|编译|打包|跑测试|运行测试/i.test(text)) return true;
  return (project.keywords || []).some(keyword => new RegExp(`(?:^|[^\\w-])${escape(keyword)}(?=$|[^\\w-])`, 'i').test(text));
}
