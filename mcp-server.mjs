#!/usr/bin/env node
// Devin IDE 側エージェント用 MCP サーバー（stdio）
// パネルが登録した作業キューを提供する。tools:
//   queue_list  実行待ちタスク一覧
//   queue_claim タスクを取得して in-progress にする（実行プロンプト付き）
//   queue_done  結果を記録してキューから外す
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(ROOT, 'work-queue.json');
const STATE = join(ROOT, 'state.json');
const load = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const save = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

const policy = (github) => {
  for (const f of [github.split('/')[1], '_default']) {
    try { return readFileSync(join(ROOT, 'prompts', f + '.md'), 'utf8').trim(); }
    catch { /* next */ }
  }
  return '';
};

const tools = [
  { name: 'queue_list', description: '対応待ちタスク一覧（パネルで「対応」が押された課題）',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'queue_claim', description: '指定keyのタスクを取得（実行指示プロンプトを返す）',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'queue_done', description: 'タスク完了を記録してキューから除去',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string' }, status: { type: 'string', enum: ['done', 'failed', 'needs-review'] },
      note: { type: 'string' } }, required: ['key', 'status'] } },
];

const call = (name, args) => {
  const q = load(QUEUE, { items: [] });
  if (name === 'queue_list') {
    const pend = q.items.filter((i) => i.status === 'pending');
    return pend.length ? pend : 'キューは空です';
  }
  if (name === 'queue_claim') {
    const it = q.items.find((i) => i.key === args.key);
    if (!it) return { error: 'not found: ' + args.key };
    it.status = 'in-progress'; it.claimedAt = new Date().toISOString();
    save(QUEUE, q);
    return {
      task: it,
      instructions:
        `GitHub ${it.type} #${it.number} (${it.repo.github}) に対応してください。\n` +
        `- リポジトリ: ${it.repo.path}\n- タイトル: ${it.title}\n- URL: ${it.url}\n` +
        `ブランチ devin/${it.type}-${it.number} を切り、実装→検証→push→gh pr create（Closes #${it.number}）。\n` +
        `完了したら queue_done({key:"${it.key}",status:"done"}) を呼ぶ。\n\n` +
        `## リポジトリ指針\n${policy(it.repo.github)}`,
    };
  }
  if (name === 'queue_done') {
    const it = q.items.find((i) => i.key === args.key);
    q.items = q.items.filter((i) => i.key !== args.key);
    save(QUEUE, q);
    const st = load(STATE, { deployedAt: null, tasks: {} });
    st.tasks[args.key] = { ...(st.tasks[args.key] ?? {}), status: args.status,
      note: args.note ?? '', finishedAt: new Date().toISOString(), engine: 'ide' };
    save(STATE, st);
    return { ok: true, removed: !!it };
  }
  return { error: 'unknown tool' };
};

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...result }) + '\n');
    if (m.method === 'initialize') {
      reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'issue-queue', version: '1.0.0' } } });
    } else if (m.method === 'tools/list') {
      reply({ result: { tools } });
    } else if (m.method === 'tools/call') {
      reply({ result: { content: [{ type: 'text', text: JSON.stringify(call(m.params.name, m.params.arguments ?? {})) }] } });
    } else if (m.id != null) {
      reply({ result: {} });
    }
  }
});
