#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(repoRoot, '.agent-runs', `acp-smoke-${stamp}`);

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

function runAcpx(acpxCli, agent, prompt, timeoutSeconds = 180) {
  return new Promise((resolveRun, reject) => {
    const args = [
      acpxCli,
      '--cwd', repoRoot,
      '--approve-reads',
      '--non-interactive-permissions', 'fail',
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

const codexPrompt = [
  'You are the builder/inspector in an ACP smoke test.',
  'Do not edit files.',
  'Inspect index.html and identify the function that creates a merged coherence memory.',
  'Return JSON only with keys: function_name, what_it_does, evidence.'
].join('\n');

const codex = await runAcpx(acpxCli, 'codex', codexPrompt);

const claudePrompt = [
  'You are the reviewer in an ACP smoke test.',
  'Do not edit files.',
  'Review this Codex result against the repository in the current cwd.',
  'Say whether it is correct, and mention any caveat.',
  '',
  'Codex result:',
  codex.stdout
].join('\n');

const claude = await runAcpx(acpxCli, 'claude', claudePrompt);

const report = {
  runDir,
  repoRoot,
  acpxCli,
  codex,
  claude,
  verdict: 'ACP plumbing works if both agents returned code 0 and Claude confirms the Codex result.'
};

await writeFile(join(runDir, 'run.json'), JSON.stringify(report, null, 2));
await writeFile(join(runDir, 'report.md'), [
  '# ACP Two-Agent Smoke',
  '',
  `Run dir: ${runDir}`,
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
  ''
].join('\n'));

console.log(`ACP smoke complete: ${runDir}`);
console.log('');
console.log('Codex:');
console.log(codex.stdout);
console.log('');
console.log('Claude:');
console.log(claude.stdout);
