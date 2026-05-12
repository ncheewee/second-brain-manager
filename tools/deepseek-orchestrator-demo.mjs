#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(repoRoot, '.agent-runs', `deepseek-orchestrator-${stamp}`);

const rawArgs = process.argv.slice(2);
const allowWrites = rawArgs.includes('--allow-writes');
const task = rawArgs.filter(arg => arg !== '--allow-writes').join(' ').trim()
  || 'Inspect the coherence merge flow and identify one small risk or improvement opportunity. Do not edit files.';

const openRouterModel = (process.env.DEEPSEEK_ORCHESTRATOR_MODEL || 'deepseek/deepseek-v4-pro')
  .replace(/^openrouter\//, '');
const maxTokens = Number(process.env.DEEPSEEK_ORCHESTRATOR_MAX_TOKENS || 900);

async function findAcpxCli() {
  if (process.env.ACPX_CLI) return process.env.ACPX_CLI;

  const depsDir = `${process.env.HOME}/.openclaw/plugin-runtime-deps`;
  const entries = await readdir(depsDir).catch(() => []);
  for (const entry of entries.sort().reverse()) {
    const candidate = join(depsDir, entry, 'node_modules/acpx/dist/cli.js');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next OpenClaw runtime dependency folder.
    }
  }

  throw new Error('Could not find acpx. Set ACPX_CLI=/absolute/path/to/acpx/dist/cli.js and retry.');
}

async function getOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  const authPath = `${process.env.HOME}/.openclaw/agents/main/agent/auth-profiles.json`;
  const modelsPath = `${process.env.HOME}/.openclaw/agents/main/agent/models.json`;

  const auth = await readJson(authPath).catch(() => null);
  const authKey = auth?.profiles?.['openrouter:default']?.key;
  if (authKey) return authKey;

  const models = await readJson(modelsPath).catch(() => null);
  const providers = Array.isArray(models) ? models[0]?.providers : models?.providers;
  const modelKey = providers?.openrouter?.apiKey;
  if (modelKey && !/^[A-Z0-9_]+$/.test(modelKey)) return modelKey;

  throw new Error('OpenRouter key not found. Set OPENROUTER_API_KEY and retry.');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function callDeepSeek(apiKey, messages, label) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/ncheewee/second-brain-manager',
      'X-Title': 'Second Brain ACP Orchestrator Demo'
    },
    body: JSON.stringify({
      model: openRouterModel,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} DeepSeek call failed ${response.status}: ${text.slice(0, 800)}`);
  }

  const json = JSON.parse(text);
  return json.choices?.[0]?.message?.content?.trim() || '';
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`DeepSeek did not return a JSON object: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function runAcpx(acpxCli, agent, prompt, timeoutSeconds = 240) {
  return new Promise((resolveRun, reject) => {
    const permissionFlag = allowWrites ? '--approve-all' : '--approve-reads';
    const args = [
      acpxCli,
      '--cwd', repoRoot,
      permissionFlag,
      '--non-interactive-permissions', allowWrites ? 'deny' : 'fail',
      '--timeout', String(timeoutSeconds),
      '--format', 'quiet',
      agent,
      'exec',
      prompt
    ];
    const child = spawn(process.execPath, args, { cwd: repoRoot });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      const result = { agent, code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) resolveRun(result);
      else reject(Object.assign(new Error(`${agent} ACP exited ${code}`), { result }));
    });
  });
}

await mkdir(runDir, { recursive: true });
const acpxCli = await findAcpxCli();
const apiKey = await getOpenRouterKey();

const safetyLine = allowWrites
  ? 'This run may edit files if the user task explicitly requires it. Keep changes minimal and scoped.'
  : 'This run is read-only. Tell both agents not to edit files.';

const planText = await callDeepSeek(apiKey, [
  {
    role: 'system',
    content: [
      'You are a lean orchestrator for a Codex builder and Claude reviewer.',
      'Return JSON only.',
      'Do not include markdown.',
      'Create compact prompts. Keep token use low.'
    ].join(' ')
  },
  {
    role: 'user',
    content: [
      `Repo: ${repoRoot}`,
      `User task: ${task}`,
      safetyLine,
      '',
      'Return this JSON shape:',
      '{"codex_prompt":"...","claude_prompt":"...","synthesis_focus":"..."}',
      '',
      'Codex should do the primary repo inspection or implementation.',
      'Claude should review Codex output against the repo.'
    ].join('\n')
  }
], 'planning');

const plan = extractJsonObject(planText);
const codexPrompt = [
  'You are Codex acting as the builder/inspector sub-agent in a DeepSeek-orchestrated ACP demo.',
  allowWrites ? 'You may edit files only if the task requires it.' : 'Do not edit files.',
  plan.codex_prompt
].join('\n\n');

const codex = await runAcpx(acpxCli, 'codex', codexPrompt);

const claudePrompt = [
  'You are Claude acting as the reviewer sub-agent in a DeepSeek-orchestrated ACP demo.',
  'Review Codex output against the repository. Be concise and concrete.',
  allowWrites ? 'If files changed, review the diff.' : 'Do not edit files.',
  '',
  plan.claude_prompt,
  '',
  'Codex output:',
  codex.stdout
].join('\n');

const claude = await runAcpx(acpxCli, 'claude', claudePrompt);

const synthesis = await callDeepSeek(apiKey, [
  {
    role: 'system',
    content: 'You are the DeepSeek orchestrator. Synthesize the two sub-agent outputs into a concise final report. No markdown table.'
  },
  {
    role: 'user',
    content: [
      `Original task: ${task}`,
      `Synthesis focus: ${plan.synthesis_focus || 'final verdict'}`,
      '',
      'Codex output:',
      codex.stdout,
      '',
      'Claude review:',
      claude.stdout,
      '',
      'Return: outcome, what each agent contributed, verdict, next recommended action.'
    ].join('\n')
  }
], 'synthesis');

const report = {
  runDir,
  repoRoot,
  acpxCli,
  model: openRouterModel,
  maxTokens,
  allowWrites,
  task,
  plan,
  codex,
  claude,
  synthesis
};

await writeFile(join(runDir, 'run.json'), JSON.stringify(report, null, 2));
await writeFile(join(runDir, 'report.md'), [
  '# DeepSeek ACP Orchestrator Demo',
  '',
  `Run dir: ${runDir}`,
  `Model: ${openRouterModel}`,
  `Allow writes: ${allowWrites ? 'yes' : 'no'}`,
  '',
  '## Task',
  '',
  task,
  '',
  '## DeepSeek Plan',
  '',
  '```json',
  JSON.stringify(plan, null, 2),
  '```',
  '',
  '## Codex Result',
  '',
  '```text',
  codex.stdout,
  '```',
  '',
  '## Claude Review',
  '',
  '```text',
  claude.stdout,
  '```',
  '',
  '## DeepSeek Synthesis',
  '',
  synthesis,
  ''
].join('\n'));

console.log(`DeepSeek ACP orchestrator demo complete: ${runDir}`);
console.log('');
console.log(synthesis);
