/**
 * Agent Ops Watcher
 *
 * Polls groups/main/shared/agent-ops/ for spec files written by the Orchestrator.
 * Executes create/modify/delete operations on specialist agents.
 * Self-modifications (targeting orchestrator/main) require owner approval.
 *
 * Spec format: Markdown with YAML frontmatter (operation, agent, optional model).
 * Results: .APPLIED.md on success, .FAILED.md on failure.
 * Self-mods: .PENDING_APPROVAL.md → owner approves → .APPROVED.md → applied.
 */

import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, DATA_DIR, TIMEZONE } from './config.js';
import {
  createTask,
  deleteRegisteredGroup,
  deleteTask,
  getAllRegisteredGroups,
  getRegisteredGroup,
  getTasksForGroup,
  initDatabase,
  setRegisteredGroup,
  updateTask,
} from './db.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const PROJECT_ROOT = process.cwd();
const AGENT_OPS_DIR = path.join(GROUPS_DIR, 'main', 'shared', 'agent-ops');
const SHARED_DIR = path.join(GROUPS_DIR, 'main', 'shared');
const LOG_FILE = path.join(SHARED_DIR, 'log', 'agent-ops.log');
const POLL_INTERVAL = 60_000;
const MAX_CLAUDE_MD_LINES = 150;

// Model aliases → full model IDs
const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-6',
  'opus-4-6': 'claude-opus-4-6',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
};

// Agents that require owner approval before modifications
const SELF_MOD_NAMES = new Set(['orchestrator', 'main']);

function log(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // ignore log write failures
  }
}

// --- Frontmatter parsing ---

interface SpecFrontmatter {
  operation: 'create' | 'modify' | 'delete';
  agent: string;
  model?: string;
}

function parseFrontmatter(content: string): { frontmatter: SpecFrontmatter; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];
  const fm: Record<string, string> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  if (!fm.operation || !fm.agent) return null;
  if (!['create', 'modify', 'delete'].includes(fm.operation)) return null;

  return {
    frontmatter: {
      operation: fm.operation as SpecFrontmatter['operation'],
      agent: fm.agent,
      model: fm.model,
    },
    body,
  };
}

// --- Body section parsing ---

function parseSection(body: string, heading: string): string | null {
  const regex = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const match = body.match(regex);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  // Find next top-level ## heading that's NOT inside a code block
  let inCodeBlock = false;
  let end = -1;
  const lines = rest.split('\n');
  let pos = 0;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    } else if (!inCodeBlock && line.startsWith('## ')) {
      end = pos;
      break;
    }
    pos += line.length + 1; // +1 for newline
  }

  const section = end === -1 ? rest : rest.slice(0, end);
  return section.trim() || null;
}

function parseCodeBlock(text: string): string | null {
  const match = text.match(/```[\w]*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function parseYamlList(text: string): Record<string, string>[] {
  // Parse simple YAML-ish list items from a section
  const items: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && trimmed.includes(':')) {
      // New item starting with dash, e.g. "- id: task-foo"
      if (current) items.push(current);
      current = {};
      const rest = trimmed.slice(2);
      const colonIdx = rest.indexOf(':');
      if (colonIdx !== -1) {
        current[rest.slice(0, colonIdx).trim()] = rest.slice(colonIdx + 1).trim();
      }
    } else if (current && trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      current[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 1).trim();
    }
  }
  if (current) items.push(current);
  return items;
}

// --- Validation ---

function validateMountsIsolation(agentName: string, mounts: { hostPath: string }[]): string | null {
  // Check that no mount points to another agent's task/result/knowledge dirs
  for (const mount of mounts) {
    const hp = mount.hostPath;
    // Check if mount targets any shared/{tasks,results,knowledge}/{other-agent}
    for (const subdir of ['tasks', 'results', 'knowledge']) {
      const sharedSubdir = path.join(SHARED_DIR, subdir);
      if (hp.startsWith(sharedSubdir + '/')) {
        const relative = hp.slice(sharedSubdir.length + 1).split('/')[0];
        if (relative && relative !== agentName) {
          return `Mount "${hp}" crosses into agent "${relative}" ${subdir} directory`;
        }
      }
    }
  }
  return null;
}

// --- Compute next cron run ---

function computeNextCronRun(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toISOString() ?? new Date().toISOString();
}

// --- Resolve model ID ---

function resolveModel(model: string | undefined): string {
  if (!model) return 'claude-sonnet-4-6'; // default for new agents
  const lower = model.toLowerCase().trim();
  return MODEL_MAP[lower] || model; // pass through if not recognized
}

// --- CREATE operation ---

function handleCreate(agentName: string, body: string, model: string | undefined): void {
  const folder = `${agentName}-specialist`;
  const jid = `agent:${folder}`;

  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid folder name: ${folder}`);
  }

  // Check if agent already exists
  if (getRegisteredGroup(jid)) {
    throw new Error(`Agent "${agentName}" already exists (JID: ${jid})`);
  }

  // Parse CLAUDE.md content
  const claudeMdSection = parseSection(body, 'CLAUDE\\.md');
  if (!claudeMdSection) throw new Error('Missing ## CLAUDE.md section');
  const claudeMdContent = parseCodeBlock(claudeMdSection) || claudeMdSection;
  const lineCount = claudeMdContent.split('\n').length;
  if (lineCount > MAX_CLAUDE_MD_LINES) {
    throw new Error(`CLAUDE.md is ${lineCount} lines (max ${MAX_CLAUDE_MD_LINES})`);
  }

  // Parse mounts (optional)
  const mountsSection = parseSection(body, 'Mounts');
  const customMounts: { hostPath: string; containerPath: string; readonly: boolean }[] = [];
  if (mountsSection) {
    const mountItems = parseYamlList(mountsSection);
    for (const item of mountItems) {
      if (item.hostPath || item.host) {
        customMounts.push({
          hostPath: item.hostPath || item.host,
          containerPath: item.containerPath || item.container || path.basename(item.hostPath || item.host),
          readonly: item.readonly === 'true' || item.readonly === 'yes',
        });
      }
    }
  }

  // Build standard mounts for the agent
  const standardMounts = [
    { hostPath: path.join(SHARED_DIR, 'tasks', agentName), containerPath: 'tasks', readonly: false },
    { hostPath: path.join(SHARED_DIR, 'results', agentName), containerPath: 'results', readonly: false },
    { hostPath: path.join(SHARED_DIR, 'knowledge', agentName), containerPath: 'knowledge', readonly: false },
    { hostPath: SHARED_DIR, containerPath: 'shared', readonly: true },
  ];

  const allMounts = [...standardMounts, ...customMounts];

  // Validate mount isolation
  const isolationError = validateMountsIsolation(agentName, allMounts);
  if (isolationError) throw new Error(isolationError);

  // Create shared directory structure
  for (const sub of [
    `tasks/${agentName}/inbox`,
    `tasks/${agentName}/active`,
    `tasks/${agentName}/archive`,
    `results/${agentName}/inbox`,
    `results/${agentName}/archive`,
    `knowledge/${agentName}`,
    `knowledge/${agentName}/archive`,
  ]) {
    fs.mkdirSync(path.join(SHARED_DIR, sub), { recursive: true });
  }

  // Create group folder + CLAUDE.md
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMdContent);

  // Register group in database
  const group: RegisteredGroup = {
    name: `${agentName.charAt(0).toUpperCase() + agentName.slice(1)} Specialist`,
    folder,
    trigger: '@andy',
    added_at: new Date().toISOString(),
    containerConfig: {
      additionalMounts: allMounts,
      timeout: 600000,
    },
    requiresTrigger: false,
  };
  setRegisteredGroup(jid, group);

  // Write settings.json with env vars
  const envSection = parseSection(body, 'API Keys|Env|Environment');
  const envVars: Record<string, string> = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    CLAUDE_CODE_USE_MODEL: resolveModel(model),
  };

  if (envSection) {
    const envItems = parseYamlList(envSection);
    // Read requested keys from .env
    const keyNames = envItems.map(item => Object.values(item)[0] || Object.keys(item)[0]).filter(Boolean);
    if (keyNames.length > 0) {
      const envValues = readEnvFile(keyNames);
      Object.assign(envVars, envValues);
    }
  }

  const settingsDir = path.join(DATA_DIR, 'sessions', folder, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ env: envVars }, null, 2),
  );

  // Parse and create scheduled tasks
  const tasksSection = parseSection(body, 'Scheduled Tasks|Tasks');
  if (tasksSection) {
    const taskItems = parseYamlList(tasksSection);
    for (const item of taskItems) {
      const taskId = item.id || `task-${agentName}-${Date.now()}`;
      const cron = item.cron || item.schedule;
      const prompt = item.prompt || item.description || '';
      if (!cron || !prompt) continue;

      createTask({
        id: taskId,
        group_folder: folder,
        chat_jid: jid,
        prompt,
        schedule_type: 'cron',
        schedule_value: cron,
        context_mode: (item.context_mode as 'group' | 'isolated') || 'group',
        next_run: computeNextCronRun(cron),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      log(`  Created task: ${taskId} (${cron})`);
    }
  }

  log(`  Agent "${agentName}" created → folder: ${folder}, JID: ${jid}`);
}

// --- MODIFY operation ---

function handleModify(agentName: string, body: string, model: string | undefined): void {
  // Resolve folder/JID — handle both "reddit" and "reddit-specialist"
  let folder = agentName;
  let jid = `agent:${folder}`;
  let group = getRegisteredGroup(jid);

  if (!group && !folder.endsWith('-specialist')) {
    folder = `${agentName}-specialist`;
    jid = `agent:${folder}`;
    group = getRegisteredGroup(jid);
  }

  // Handle orchestrator/main
  if (SELF_MOD_NAMES.has(agentName.toLowerCase())) {
    folder = 'main';
    jid = findOrchestratorJid();
    group = jid ? getRegisteredGroup(jid) : undefined;
  }

  if (!group) throw new Error(`Agent "${agentName}" not found`);

  // Update CLAUDE.md if provided
  const claudeMdSection = parseSection(body, 'CLAUDE\\.md');
  if (claudeMdSection) {
    const claudeMdContent = parseCodeBlock(claudeMdSection) || claudeMdSection;
    const lineCount = claudeMdContent.split('\n').length;
    if (lineCount > MAX_CLAUDE_MD_LINES) {
      throw new Error(`CLAUDE.md is ${lineCount} lines (max ${MAX_CLAUDE_MD_LINES})`);
    }
    const claudeMdPath = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, claudeMdContent);
    log(`  Updated CLAUDE.md for ${folder}`);
  }

  // Append to CLAUDE.md if provided
  const appendSection = parseSection(body, 'Append to CLAUDE\\.md');
  if (appendSection) {
    const appendContent = parseCodeBlock(appendSection) || appendSection;
    const claudeMdPath = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
    const combined = existing.trimEnd() + '\n\n' + appendContent + '\n';
    const lineCount = combined.split('\n').length;
    if (lineCount > MAX_CLAUDE_MD_LINES) {
      throw new Error(`CLAUDE.md would be ${lineCount} lines after append (max ${MAX_CLAUDE_MD_LINES})`);
    }
    fs.writeFileSync(claudeMdPath, combined);
    log(`  Appended to CLAUDE.md for ${folder}`);
  }

  // Update model in settings.json
  if (model) {
    const settingsPath = path.join(DATA_DIR, 'sessions', folder, '.claude', 'settings.json');
    let settings: { env: Record<string, string> } = { env: {} };
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
    settings.env.CLAUDE_CODE_USE_MODEL = resolveModel(model);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log(`  Updated model to ${resolveModel(model)} for ${folder}`);
  }

  // Inject env vars
  const envSection = parseSection(body, 'API Keys|Env|Environment');
  if (envSection) {
    const settingsPath = path.join(DATA_DIR, 'sessions', folder, '.claude', 'settings.json');
    let settings: { env: Record<string, string> } = { env: {} };
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
    const envItems = parseYamlList(envSection);
    for (const item of envItems) {
      // Items can be "KEY: VALUE" directly or "key: ENV_KEY_NAME" pointing to .env
      for (const [k, v] of Object.entries(item)) {
        if (v.startsWith('$')) {
          // Read from .env
          const envKey = v.slice(1);
          const vals = readEnvFile([envKey]);
          if (vals[envKey]) settings.env[envKey] = vals[envKey];
        } else {
          settings.env[k] = v;
        }
      }
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log(`  Updated env vars for ${folder}`);
  }

  // Update mounts
  const mountsSection = parseSection(body, 'Mounts');
  if (mountsSection && group) {
    const mountItems = parseYamlList(mountsSection);
    const newMounts: { hostPath: string; containerPath: string; readonly: boolean }[] = [];
    for (const item of mountItems) {
      if (item.hostPath || item.host) {
        newMounts.push({
          hostPath: item.hostPath || item.host,
          containerPath: item.containerPath || item.container || path.basename(item.hostPath || item.host),
          readonly: item.readonly === 'true' || item.readonly === 'yes',
        });
      }
    }
    const isolationError = validateMountsIsolation(
      agentName === 'main' || agentName === 'orchestrator' ? 'main' : agentName,
      newMounts,
    );
    if (isolationError) throw new Error(isolationError);

    const existingMounts = group.containerConfig?.additionalMounts || [];
    const updatedGroup: RegisteredGroup = {
      ...group,
      containerConfig: {
        ...group.containerConfig,
        additionalMounts: [...existingMounts, ...newMounts],
      },
    };
    setRegisteredGroup(jid, updatedGroup);
    log(`  Updated mounts for ${folder}`);
  }

  // Add/update scheduled tasks
  const tasksSection = parseSection(body, 'Scheduled Tasks|Tasks');
  if (tasksSection) {
    const taskItems = parseYamlList(tasksSection);
    const existingTasks = getTasksForGroup(folder);
    const existingIds = new Set(existingTasks.map(t => t.id));

    for (const item of taskItems) {
      const taskId = item.id || `task-${agentName}-${Date.now()}`;
      const cron = item.cron || item.schedule;
      const prompt = item.prompt || item.description || '';
      if (!cron || !prompt) continue;

      if (existingIds.has(taskId)) {
        // Update existing task
        updateTask(taskId, {
          prompt,
          schedule_value: cron,
          next_run: computeNextCronRun(cron),
          status: 'active',
        });
        log(`  Updated task: ${taskId}`);
      } else {
        // Create new task
        createTask({
          id: taskId,
          group_folder: folder,
          chat_jid: jid,
          prompt,
          schedule_type: 'cron',
          schedule_value: cron,
          context_mode: (item.context_mode as 'group' | 'isolated') || 'group',
          next_run: computeNextCronRun(cron),
          status: 'active',
          created_at: new Date().toISOString(),
        });
        log(`  Created task: ${taskId}`);
      }
    }
  }

  log(`  Agent "${agentName}" modified`);
}

// Helper to find orchestrator JID
function findOrchestratorJid(): string {
  const groups = getAllRegisteredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'main') return jid;
  }
  return '';
}

// --- DELETE operation ---

function handleDelete(agentName: string): void {
  let folder = agentName;
  let jid = `agent:${folder}`;
  let group = getRegisteredGroup(jid);

  if (!group && !folder.endsWith('-specialist')) {
    folder = `${agentName}-specialist`;
    jid = `agent:${folder}`;
    group = getRegisteredGroup(jid);
  }

  if (!group) throw new Error(`Agent "${agentName}" not found`);

  // Delete all scheduled tasks for this group
  const tasks = getTasksForGroup(folder);
  for (const task of tasks) {
    deleteTask(task.id);
    log(`  Deleted task: ${task.id}`);
  }

  // Delete group registration from database
  deleteRegisteredGroup(jid);

  // Remove group folder (CLAUDE.md, logs) but NOT shared data
  const groupDir = path.join(GROUPS_DIR, folder);
  if (fs.existsSync(groupDir)) {
    fs.rmSync(groupDir, { recursive: true });
  }

  // Remove settings
  const settingsDir = path.join(DATA_DIR, 'sessions', folder);
  if (fs.existsSync(settingsDir)) {
    fs.rmSync(settingsDir, { recursive: true });
  }

  // Archive shared data (move inbox/active to archive, keep archive)
  for (const subdir of ['tasks', 'results']) {
    const agentDir = path.join(SHARED_DIR, subdir, agentName);
    if (!fs.existsSync(agentDir)) continue;
    for (const sub of ['inbox', 'active']) {
      const src = path.join(agentDir, sub);
      if (!fs.existsSync(src)) continue;
      const files = fs.readdirSync(src);
      const archiveDir = path.join(agentDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const file of files) {
        fs.renameSync(path.join(src, file), path.join(archiveDir, file));
      }
    }
  }

  log(`  Agent "${agentName}" deleted (archives preserved in shared/)`);
}

// --- File processing ---

function renameSpec(filePath: string, suffix: string, appendText?: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, '.md');
  // Strip any existing status suffix
  const cleanBase = base.replace(/\.(APPLIED|FAILED|PENDING_APPROVAL|APPROVED)$/, '');
  const newPath = path.join(dir, `${cleanBase}.${suffix}.md`);

  if (appendText) {
    const content = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, content + '\n\n---\n\n' + appendText);
  }

  fs.renameSync(filePath, newPath);
}

function processSpecFile(filePath: string): void {
  const filename = path.basename(filePath);
  log(`Processing: ${filename}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    renameSpec(filePath, 'FAILED', '**Error:** Invalid spec format. Missing or malformed YAML frontmatter.\nExpected: `operation`, `agent` fields.');
    log(`  FAILED: Invalid frontmatter in ${filename}`);
    return;
  }

  const { frontmatter, body } = parsed;
  const { operation, agent, model } = frontmatter;

  // Self-modification check
  if (SELF_MOD_NAMES.has(agent.toLowerCase()) && operation !== 'delete') {
    renameSpec(filePath, 'PENDING_APPROVAL',
      `**Pending owner approval.** This spec targets the Orchestrator. Waiting for rename to .APPROVED.md.`);
    log(`  PENDING_APPROVAL: Self-modification detected for "${agent}"`);
    return;
  }

  // Block deletion of orchestrator
  if (SELF_MOD_NAMES.has(agent.toLowerCase()) && operation === 'delete') {
    renameSpec(filePath, 'FAILED', '**Error:** Cannot delete the Orchestrator.');
    log(`  FAILED: Cannot delete orchestrator`);
    return;
  }

  try {
    switch (operation) {
      case 'create':
        handleCreate(agent, body, model);
        break;
      case 'modify':
        handleModify(agent, body, model);
        break;
      case 'delete':
        handleDelete(agent);
        break;
    }
    renameSpec(filePath, 'APPLIED');
    log(`  APPLIED: ${operation} ${agent}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    renameSpec(filePath, 'FAILED', `**Error:** ${msg}`);
    log(`  FAILED: ${operation} ${agent} — ${msg}`);
  }
}

function processApprovedFile(filePath: string): void {
  const filename = path.basename(filePath);
  log(`Processing approved: ${filename}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  // Strip the appended approval notice to re-parse original frontmatter
  const cleanContent = content.split('\n---\n\n**Pending owner approval')[0];
  const parsed = parseFrontmatter(cleanContent);

  if (!parsed) {
    renameSpec(filePath, 'FAILED', '**Error:** Could not re-parse spec after approval.');
    return;
  }

  const { frontmatter, body } = parsed;

  try {
    switch (frontmatter.operation) {
      case 'create':
        handleCreate(frontmatter.agent, body, frontmatter.model);
        break;
      case 'modify':
        handleModify(frontmatter.agent, body, frontmatter.model);
        break;
    }
    renameSpec(filePath, 'APPLIED');
    log(`  APPLIED (approved): ${frontmatter.operation} ${frontmatter.agent}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    renameSpec(filePath, 'FAILED', `**Error:** ${msg}`);
    log(`  FAILED (approved): ${frontmatter.operation} ${frontmatter.agent} — ${msg}`);
  }
}

// --- Main poll loop ---

function poll(): void {
  if (!fs.existsSync(AGENT_OPS_DIR)) {
    fs.mkdirSync(AGENT_OPS_DIR, { recursive: true });
  }

  const files = fs.readdirSync(AGENT_OPS_DIR);

  for (const file of files) {
    const filePath = path.join(AGENT_OPS_DIR, file);

    // Skip non-markdown files
    if (!file.endsWith('.md')) continue;

    // Skip already processed files
    if (
      file.includes('.APPLIED.') ||
      file.includes('.FAILED.') ||
      file.includes('.PENDING_APPROVAL.')
    ) {
      continue;
    }

    // Handle approved self-modifications
    if (file.includes('.APPROVED.')) {
      processApprovedFile(filePath);
      continue;
    }

    // Process new spec files (create-*, modify-*, delete-*)
    if (file.startsWith('create-') || file.startsWith('modify-') || file.startsWith('delete-')) {
      processSpecFile(filePath);
    }
  }
}

// --- Entry point ---

function main(): void {
  log('Agent Ops Watcher started');
  initDatabase();

  // Initial poll
  poll();

  // Poll every 60 seconds
  setInterval(() => {
    try {
      poll();
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, POLL_INTERVAL);
}

main();
