import { build } from "esbuild";
import { createServer } from "node:http";
import path from "node:path";

// 独立浏览器夹具只验证组件；真实 App Server 另由 verify-live.mjs 验证。
const source = `
import { installBuddyControl } from './packages/renderer-extension/src/buddy/control.ts';
const settings = {enabled:true,privateMode:false,bypass:true,role:'auto',plannerModel:null,executorModel:null};
const decision = {threadId:'fixture',turnId:'turn-fixture',phase:'executing',role:'io',difficulty:'advanced',score:85,reason:'先规划，再执行已确定的只读验证步骤',plannerModel:'gpt-6',executorModel:'deepseek-v4.1-flash',acceptedModel:'deepseek-v4.1-flash',plan:'读取 README.md；检查 Buddy 标记；报告真实结果。',command:null,exitCode:null,updatedAt:'fixture'};
const snapshot={settings,models:[{id:'gpt-6',tier:'夯',eligible:true},{id:'claude-opus',tier:'夯',eligible:true},{id:'deepseek-v4.1-flash',tier:'垃',eligible:true}],decisions:[decision]};
const privateRequests=[];
const privateSessions=new Map();
const client={buddyStatus:async()=>structuredClone(snapshot),buddyModels:async()=>structuredClone(snapshot),buddyConfigure:async(value)=>{snapshot.settings=value;if(!value.privateMode)privateSessions.clear();return structuredClone(snapshot);},buddyCancel:async()=>{decision.phase='cancelled';return structuredClone(snapshot);},buddyPrivate:async(value)=>{
privateRequests.push(value);
if(value.action==='reset')privateSessions.delete(value.sessionId);
const state=privateSessions.get(value.sessionId)??{sessionId:value.sessionId,configured:true,endpoint:'http://127.0.0.1:9999/v1/ (fixture)',model:null,busy:false,messages:[]};
if(value.action==='send'){state.model=value.model;state.messages.push({role:'user',text:value.text},{role:'assistant',text:'模拟离线回复：'+value.text});privateSessions.set(value.sessionId,state);}
return structuredClone(state);
}};
window.buddyFixture={snapshot,client,privateRequests};
installBuddyControl(()=>({anchor:document.querySelector('#composer'),threadId:'fixture',client}),()=> 'zh-CN');
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: path.resolve(import.meta.dirname, "../.."), loader: "ts" },
  bundle: true,
  format: "iife",
  write: false,
});
const script = bundle.outputFiles[0].text;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buddy 路由面板验收</title><style>:root{color-scheme:dark}body{background:#191b20;color:#e5e7ec;font:14px system-ui;margin:0}main{max-width:880px;margin:60px auto;padding:24px}h1{font-size:22px}small{color:#939aaa}article{padding:24px 0 80px}#composer{border:1px solid #50545c;border-radius:16px;padding:20px;color:#a6adba}button{cursor:pointer}</style><main><h1>Codex Buddy</h1><small>界面验收夹具 · 模型与状态为模拟数据</small><article>请规划并执行一个只读验证任务：读取 README.md，确认内容含 Buddy，然后报告结果。</article><div id="composer" role="textbox" aria-label="任务输入框" contenteditable="true">输入下一项任务…</div></main><script>${script}</script></html>`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end(html);
});
server.listen(43871, "127.0.0.1", () => console.log("Buddy preview: http://127.0.0.1:43871"));
