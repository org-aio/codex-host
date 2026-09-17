// Closed utterances are executable intent; broad keyword detection is only advice.
export function normalizePhrase(text) {
  if (typeof text !== 'string' || text.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(text)) return null;
  return text.normalize('NFKC').trim().replace(/^(?:(?:请|帮我|麻烦|把)\s*)+/, '').replace(/[。.!！]+$/, '').trim();
}
const phrases = {
  'git.status': /^(?:git status|git状态|查看git状态|查看 Git 状态|代码状态|工作区状态)$/i,
  'git.branch': /^(?:git branch --show-current|当前分支|查看当前分支)$/i,
  'git.log': /^(?:git log|提交记录|查看提交记录|最近提交)$/i,
  'git.diff': /^(?:git diff|查看改动|查看代码改动|查看差异)$/i,
  run: /^(?:(?:项目)?跑起来(?:看看)?|(?:启动|运行)(?:一下)?(?:项目|应用|服务)|(?:项目|应用|服务)启动(?:一下)?|(?:start|run)(?: the)? (?:app|project|server))$/i,
  build: /^(?:(?:构建|编译|打包)(?:一下)?(?:项目)?|项目(?:构建|编译|打包)|build(?: the)?(?: project|app)?)$/i,
  test: /^(?:(?:跑|运行|执行)(?:一下)?(?:测试)|(?:run )?(?:the )?tests?)$/i,
  check: /^(?:(?:跑|运行|执行)(?:一下)?(?:检查)|(?:run )?checks?)$/i,
  lint: /^(?:(?:跑|运行|执行)(?:一下)?)?lint$/i,
  typecheck: /^(?:(?:跑|运行|执行)(?:一下)?)?(?:类型检查|typecheck)$/i,
};
export const phraseIntent = text => Object.entries(phrases).find(([, pattern]) => pattern.test(text))?.[0];
