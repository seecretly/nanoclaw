/**
 * Register Marketing Agent Swarm
 *
 * Registers specialist groups, writes settings, and creates scheduled tasks.
 * Run with: npx tsx setup/register-swarm.ts
 */
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { createTask, initDatabase, setRegisteredGroup } from '../src/db.js';
import { readEnvFile } from '../src/env.js';
import { TIMEZONE } from '../src/config.js';

initDatabase();

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ORCHESTRATOR_JID = '393661210977@s.whatsapp.net';

// Read marketing API keys from .env
const marketingKeys = readEnvFile([
  'APIFY_API_TOKEN',
  'EXA_API_KEY',
  'APOLLO_API_KEY',
  'INSTANTLY_API_KEY',
]);

console.log('Marketing API keys found:', Object.keys(marketingKeys).join(', '));

// ── Agent definitions ──────────────────────────────────────────────

interface AgentDef {
  jid: string;
  name: string;
  folder: string;
  apiKeys: string[];
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
}

const agents: AgentDef[] = [
  {
    jid: 'agent:reddit-specialist',
    name: 'Reddit Specialist',
    folder: 'reddit-specialist',
    apiKeys: ['APIFY_API_TOKEN', 'EXA_API_KEY'],
    mounts: [
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/tasks/reddit`, containerPath: 'tasks', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/results/reddit`, containerPath: 'results', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/knowledge/reddit`, containerPath: 'knowledge', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared`, containerPath: 'shared', readonly: true },
    ],
  },
  {
    jid: 'agent:twitter-specialist',
    name: 'Twitter Specialist',
    folder: 'twitter-specialist',
    apiKeys: ['APIFY_API_TOKEN', 'EXA_API_KEY'],
    mounts: [
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/tasks/twitter`, containerPath: 'tasks', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/results/twitter`, containerPath: 'results', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/knowledge/twitter`, containerPath: 'knowledge', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared`, containerPath: 'shared', readonly: true },
    ],
  },
  {
    jid: 'agent:content-specialist',
    name: 'Content Specialist',
    folder: 'content-specialist',
    apiKeys: ['EXA_API_KEY'],
    mounts: [
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/tasks/content`, containerPath: 'tasks', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/results/content`, containerPath: 'results', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared/knowledge/content`, containerPath: 'knowledge', readonly: false },
      { hostPath: `${PROJECT_ROOT}/groups/main/shared`, containerPath: 'shared', readonly: true },
    ],
  },
];

// ── Register groups ────────────────────────────────────────────────

for (const agent of agents) {
  // Create group folder (CLAUDE.md should already exist)
  const groupDir = path.join(PROJECT_ROOT, 'groups', agent.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Register in database
  setRegisteredGroup(agent.jid, {
    name: agent.name,
    folder: agent.folder,
    trigger: '@andy',
    added_at: new Date().toISOString(),
    containerConfig: {
      additionalMounts: agent.mounts,
      timeout: 600000, // 10 min
    },
    requiresTrigger: false,
  });

  console.log(`Registered group: ${agent.name} (${agent.jid})`);

  // Write settings.json with marketing API keys
  const settingsDir = path.join(DATA_DIR, 'sessions', agent.folder, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');

  const env: Record<string, string> = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  };
  for (const key of agent.apiKeys) {
    if (marketingKeys[key]) {
      env[key] = marketingKeys[key];
    }
  }

  // Always overwrite settings to ensure API keys are current
  fs.writeFileSync(settingsFile, JSON.stringify({ env }, null, 2) + '\n');
  console.log(`  Settings: ${settingsFile} (${agent.apiKeys.length} API keys)`);
}

// ── Update Orchestrator settings ───────────────────────────────────

const orchSettingsDir = path.join(DATA_DIR, 'sessions', 'main', '.claude');
const orchSettingsFile = path.join(orchSettingsDir, 'settings.json');

let orchSettings: { env: Record<string, string> } = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

if (fs.existsSync(orchSettingsFile)) {
  try {
    orchSettings = JSON.parse(fs.readFileSync(orchSettingsFile, 'utf-8'));
  } catch { /* use defaults */ }
}

// Add marketing keys to orchestrator
if (marketingKeys.APIFY_API_TOKEN) orchSettings.env.APIFY_API_TOKEN = marketingKeys.APIFY_API_TOKEN;
if (marketingKeys.EXA_API_KEY) orchSettings.env.EXA_API_KEY = marketingKeys.EXA_API_KEY;

fs.writeFileSync(orchSettingsFile, JSON.stringify(orchSettings, null, 2) + '\n');
console.log(`Updated Orchestrator settings with marketing API keys`);

// ── Helper: calculate next cron run ────────────────────────────────

function nextCronRun(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toISOString();
}

// ── Create scheduled tasks ─────────────────────────────────────────

interface TaskDef {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_value: string;
}

const now = new Date().toISOString();

const tasks: TaskDef[] = [
  // Orchestrator tasks
  {
    id: 'task-orch-heartbeat',
    group_folder: 'main',
    chat_jid: ORCHESTRATOR_JID,
    prompt: `[HEARTBEAT] Check shared/results/*/inbox/ for files that need user approval. For each file found:
1. Read the file content
2. Summarize what it is (Reddit comment draft, Twitter tweet, outreach email, etc.)
3. Present it to the user with enough context to approve or reject
4. Ask the user to approve or reject

Also check shared/tasks/*/inbox/ — if any tasks have been sitting unclaimed for >4 hours, note this.

If nothing is pending, stay silent (wrap output in <internal> tags).`,
    schedule_value: '*/30 * * * *',
  },
  {
    id: 'task-orch-strategy-am',
    group_folder: 'main',
    chat_jid: ORCHESTRATOR_JID,
    prompt: `[DEEP STRATEGY SCAN - MORNING]
1. Read shared/client-brief.md for current client context
2. Research growth tactics being shared on Twitter, Reddit, Hacker News, and Indie Hackers using web search and Exa
3. Look for specific tactics founders are sharing that worked for them
4. Reverse-engineer 1-2 promising tactics into plays adapted for this client
5. Write structured proposals (using the STRATEGY format from your instructions) and present to the user
6. Check shared/knowledge/winning-signals.md for what's already working
7. If proposals are approved, write self-contained task files to the appropriate specialist inbox (shared/tasks/{agent}/inbox/)
8. Log activity to shared/log/orchestrator-week-*.md`,
    schedule_value: '0 10 * * *',
  },
  {
    id: 'task-orch-strategy-pm',
    group_folder: 'main',
    chat_jid: ORCHESTRATOR_JID,
    prompt: `[DEEP STRATEGY SCAN - EVENING]
1. Read shared/client-brief.md for current client context
2. Review today's specialist results in shared/results/*/inbox/
3. Research any new growth tactics found since morning scan
4. Follow up on morning proposals — check if tasks were created and picked up
5. Evaluate performance signals from specialist knowledge files
6. Present any new findings or strategy adjustments to the user
7. Log activity to shared/log/orchestrator-week-*.md`,
    schedule_value: '0 18 * * *',
  },
  {
    id: 'task-orch-weekly',
    group_folder: 'main',
    chat_jid: ORCHESTRATOR_JID,
    prompt: `[WEEKLY PERFORMANCE REPORT]
1. Read shared/client-brief.md for client context
2. Review shared/knowledge/winning-signals.md
3. Read all specialist knowledge files for performance data
4. Review this week's log (shared/log/orchestrator-week-*.md)
5. Compile weekly report:
   - Rank strategies by observed performance
   - Recommend: scale up / maintain / pause / kill for each active strategy
   - Propose 2-3 new experiments for next week
   - Summarize key metrics and trends
6. Present report to the user
7. Create new weekly log file for next week
8. Update winning-signals.md with latest data`,
    schedule_value: '0 9 * * 0',
  },

  // Reddit specialist tasks
  {
    id: 'task-reddit-scan',
    group_folder: 'reddit-specialist',
    chat_jid: 'agent:reddit-specialist',
    prompt: `[HEARTBEAT] Run your standard heartbeat workflow:
1. Check /workspace/extra/tasks/inbox/ for new task files
2. Claim new tasks (rename to .CLAIMED.md, move to active/)
3. For each active task, follow its instructions to scan subreddits and draft comments
4. Write all drafts to /workspace/extra/results/inbox/ using the result file format
5. If no tasks, do autonomous scanning of target subreddits from client-brief.md
6. Update /workspace/extra/knowledge/subreddit-map.md and account-tracker.md
7. Move completed tasks to archive/ (rename to .DONE.md)
8. Keep all knowledge files under 100 lines`,
    schedule_value: '0 8-23/2 * * *',
  },

  // Twitter specialist tasks
  {
    id: 'task-twitter-scan',
    group_folder: 'twitter-specialist',
    chat_jid: 'agent:twitter-specialist',
    prompt: `[HEARTBEAT] Run your standard heartbeat workflow:
1. Check /workspace/extra/tasks/inbox/ for new task files
2. Claim new tasks (rename to .CLAIMED.md, move to active/)
3. For each active task, follow its instructions to scan for churn signals and draft content
4. Write all drafts to /workspace/extra/results/inbox/ using the result file format
5. If no tasks, do autonomous churn signal scanning based on client-brief.md competitor list
6. Draft next batch of build-in-public content following the content mix ratios
7. Update /workspace/extra/knowledge/engagement-tracker.md
8. Move completed tasks to archive/ (rename to .DONE.md)
9. Keep all knowledge files under 100 lines`,
    schedule_value: '0 8-23/2 * * *',
  },

  // Content specialist tasks
  {
    id: 'task-content-weekly',
    group_folder: 'content-specialist',
    chat_jid: 'agent:content-specialist',
    prompt: `[HEARTBEAT] Run your standard heartbeat workflow:
1. Check /workspace/extra/tasks/inbox/ for new task files
2. Claim new tasks (rename to .CLAIMED.md, move to active/)
3. Run keyword opportunity scan using Exa and web search
4. Plan SEO pages for the week (max 10 pages/day)
5. Generate SEO pages and write to /workspace/extra/results/published/
6. If outreach tasks exist, draft emails/pitches to /workspace/extra/results/inbox/
7. Update /workspace/extra/knowledge/keyword-tracker.md
8. Move completed tasks to archive/ (rename to .DONE.md)
9. Keep all knowledge files under 100 lines`,
    schedule_value: '0 9 * * 1',
  },
];

for (const task of tasks) {
  try {
    createTask({
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      schedule_type: 'cron',
      schedule_value: task.schedule_value,
      context_mode: 'group',
      next_run: nextCronRun(task.schedule_value),
      status: 'active',
      created_at: now,
    });
    console.log(`Created task: ${task.id} (${task.schedule_value})`);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      console.log(`Task already exists: ${task.id} (skipping)`);
    } else {
      throw err;
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────

console.log('\n=== Swarm Registration Complete ===');
console.log(`Agents: ${agents.length} specialists + 1 orchestrator`);
console.log(`Tasks: ${tasks.length} scheduled`);
console.log(`\nNext steps:`);
console.log(`  1. Fill in shared/client-brief.md with client details`);
console.log(`  2. Rebuild: npm run build`);
console.log(`  3. Restart: launchctl kickstart -k gui/$(id -u)/com.nanoclaw`);
console.log(`  4. Send a message to test the Orchestrator`);
