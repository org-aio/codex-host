import { operation, operationIntent } from './operations.mjs';

export function detectIntent(text = '', project) {
  const words = text.match(/\bgit\b|\b(?:push|commit|merge|rebase|cherry-pick)\b|推送|提交|代码冲突|合并|变基/gi) || [];
  return { intent: words.length ? 'git' : operationIntent(text, project) ? 'project' : 'general' };
}

export function classify(input, project) {
  const text = Array.isArray(input) ? input.filter(item => item.type === 'text').map(item => item.text || '').join('\n').trim() : '';
  const intent = detectIntent(text, project);
  const result = (tier, reason) => ({ ...intent, tier, reason, assessmentSource: 'local-rules' });
  if (!Array.isArray(input) || input.some(item => item.type !== 'text')) return result('advanced', '包含附件或非文本输入');
  const work = operation(text, project);
  if (work) return { ...result(work.tier, work.tier === 'simple' ? '明确的项目操作，已发现对应 CLI 入口' : '项目操作需要查找入口或初步排查环境'), intent: 'project', action: work.action };
  if (/(?:冲突|架构|重构|跨(?:模块|服务|仓库)|并发|迁移|安全漏洞|数据修复|权限|鉴权|认证|加密|事务|数据库|conflict|architect|refactor|race condition|migration|auth|security|database|transaction)/i.test(text)) {
    return result('advanced', '涉及冲突、系统设计或复杂修改');
  }
  // Keywords identify a specialist; only this closed grammar establishes low difficulty.
  const simple = /^(?:(?:请|帮我|麻烦|把|将)\s*)*(?:(?:查看|检查|显示)(?:一下)?\s*(?:git\s*)?(?:状态|分支|提交记录)|(?:提交|推送)(?:一下)?(?:当前|现有|这些|已暂存|所有)?(?:的)?(?:代码|改动|更改)?(?:并推送|并提交)?|(?:合并)(?:一下)?(?:分支|代码)?\s*[\w./-]*(?:\s*(?:到|至|into)\s*[\w./-]+)?|git\s+(?:status|log|branch|diff)|(?:commit|push)(?:\s+(?:the\s+)?(?:current\s+)?(?:changes|code))?|merge\s+[\w./-]+\s+into\s+[\w./-]+)[。.!！\s]*$/i;
  if (simple.test(text)) return { ...result('simple', '明确的 Git 操作，执行前检查冲突状态'), intent: 'git' };
  const bounded = /^(?:(?:请|帮我)\s*)?(?:(?:修改|调整|修复|更新|补充)(?:一下)?(?:这个|当前|单个|一个)?(?:按钮|文案|样式|README|注释|配置项|单元测试)|(?:fix|update|change) (?:the |a |one )?(?:button|label|readme|comment|css)\b)/i;
  if (bounded.test(text) && !/(?:然后|同时|并且|并[\p{Script=Han}]|\band\b|\bthen\b)/iu.test(text)) return result('standard', '范围明确的局部修改或验证');
  return result('advanced', '开发、分析或尚不能确定范围的任务');
}
