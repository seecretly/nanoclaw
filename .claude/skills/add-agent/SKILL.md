---
name: add-agent
description: Add a new specialist agent to the marketing swarm from a setup spec
---

# Add Agent to Marketing Swarm

Provisions a new specialist agent from a setup spec prepared by the Orchestrator.

## Usage

```
/add-agent <agent-name>
```

## How It Works

The Orchestrator prepares everything needed in `groups/main/shared/new-agents/{name}/setup-spec.md`. This skill reads that spec and provisions the agent.

## Steps

### 1. Read Setup Spec

Read `groups/main/shared/new-agents/{args}/setup-spec.md`. If args is empty, ask the user which agent to add by listing directories in `groups/main/shared/new-agents/`.

The spec should contain these sections:
```markdown
# Agent: {name}

## Identity
agent_name: {display-name}
folder: {folder-name}
jid: agent:{folder-name}

## CLAUDE.md
{full CLAUDE.md content, must be under 150 lines}

## Mounts
{list of mount paths and permissions}

## API Keys
{list of required API keys from .env}

## Scheduled Tasks
{list of cron expressions and prompts}
```

### 2. Create Group Folder

```bash
mkdir -p groups/{folder}/logs
```

### 3. Write CLAUDE.md

Write the CLAUDE.md content from the spec to `groups/{folder}/CLAUDE.md`. Verify it's under 150 lines.

### 4. Create Shared Directories

```bash
mkdir -p groups/main/shared/tasks/{folder}/{inbox,active,archive}
mkdir -p groups/main/shared/results/{folder}/{inbox,archive}
mkdir -p groups/main/shared/knowledge/{folder}/{archive}
```

### 5. Register Group

Run the registration script with the spec parameters:

```bash
npx tsx -e "
import { initDatabase, setRegisteredGroup, createTask } from './src/db.js';
import { readEnvFile } from './src/env.js';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

initDatabase();
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROJECT_ROOT = process.cwd();

// Register group
setRegisteredGroup('{jid}', {
  name: '{agent_name}',
  folder: '{folder}',
  trigger: '@andy',
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      // ... mounts from spec
    ],
    timeout: 600000,
  },
  requiresTrigger: false,
});

// Write settings.json
const keys = readEnvFile([/* api keys from spec */]);
const settingsDir = path.join('data/sessions/{folder}/.claude');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    ...keys,
  },
}, null, 2));

// Create scheduled tasks
// ... from spec

console.log('Agent registered successfully');
"
```

Adapt the script based on the actual spec content.

### 6. Rebuild and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 7. Verify

Create a test task in the agent's inbox:

```bash
echo "# Test Task\nDate: $(date +%Y-%m-%d)\n\n## Objective\nConfirm you can read this file and write a result.\n\n## Output\nWrite a confirmation to results/inbox/" > groups/main/shared/tasks/{folder}/inbox/$(date +%Y-%m-%d)-test-task.md
```

Check logs after the agent's next heartbeat to verify it picked up the task.

## Troubleshooting

- **Agent not running tasks**: Check `store/messages.db` → `scheduled_tasks` table for the agent's tasks. Verify `status = 'active'` and `next_run` is in the past or near future.
- **Mount errors**: Check `logs/nanoclaw.log` for mount validation failures. Ensure paths exist and are under allowed roots in `~/.config/nanoclaw/mount-allowlist.json`.
- **Settings not applied**: Delete `data/sessions/{folder}/.claude/settings.json` and re-run registration. The container-runner only writes defaults if the file doesn't exist.
