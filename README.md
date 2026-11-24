# Agent Orchestra

**English** · [繁體中文](README.zh-TW.md)

Use every AI subscription you pay for. Agent Orchestra turns Claude Code into a team lead: Claude breaks a task down, hands the pieces to **Codex**, **Gemini**, **Gemini Flash**, **Claude Opus via Antigravity** and **GitHub Copilot**, checks their work, and picks up anything nobody else can finish. A live dashboard shows who is doing what and how much quota each model has left.

## Features

- **`/team` command for Claude Code**: type `/team <task>` in any project and Claude plans, dispatches and reviews.
- **Automatic handoff when a model runs out of quota**: "out of quota" is not a failure. The task moves to the next model that still has quota, with a note to continue from where the previous one stopped. Claude is the last in line.
- **Wait and resume**: with `--wait`, a task pauses until that model's quota resets, then resumes the same conversation automatically.
- **Live dashboard** (`http://localhost:4747`): one column per model with tasks, tokens, quota status and reset times, plus a timeline of Claude's decisions.
- **Usage check**: `/team usage` shows what each model has left (Codex's official 5-hour and weekly percentages, Copilot credits, tokens per day).
- **Multi-project autopilot** (optional): pick projects on the dashboard. Every 3 hours Claude improves them in rotation until quota runs out, with either "publish when tests pass" or "commit only" per project.
- **Usage guard**: autopilot pauses when Claude's weekly usage reaches a threshold you set, and resumes after the weekly reset.

## Requirements

- macOS or Linux, [Node.js](https://nodejs.org) 18+ (no npm packages needed)
- [Claude Code](https://claude.com/claude-code)
- At least one of these CLIs, signed in to your own account:

| Agent | CLI | Good for |
|---|---|---|
| `codex` | [Codex CLI](https://github.com/openai/codex) (also bundled with the ChatGPT desktop app) | Writing code, running tests, fixing bugs |
| `opus` | Antigravity CLI `agy` (bundled with Google Antigravity / the Gemini desktop app) | Claude Opus on your Google AI plan's "Claude and GPT models" quota, so it doesn't use your Claude subscription |
| `gemini` | `agy` | Long documents, research, code review, second opinions |
| `flash` | `agy` | Fast, cheap chores: summaries, translation, test data |
| `copilot` | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | Backup coder (each call costs AI credits) |

Models you don't have are skipped automatically.

## Install

```bash
git clone https://github.com/Yanzzz42/agent-orchestra.git
cd agent-orchestra
./install.sh
```

The installer copies the `/team` skill to `~/.claude/skills/team` (with the paths filled in) and runs `doctor` to show which CLIs it found. Run `node orchestra/dispatch.mjs doctor` again any time.

## Usage

In Claude Code, inside any project:

```
/team add tests for the parser and fix whatever they find
/team usage
/team dashboard
/team set up autopilot
```

You can also dispatch directly:

```bash
node orchestra/dispatch.mjs codex --write --cwd ~/code/my-app --title "Add tests" "Write unit tests for src/parser.ts and make them pass"
node orchestra/dispatch.mjs flash "Summarize CHANGELOG.md in 5 bullet points" </dev/null
node orchestra/dispatch.mjs usage
```

Tasks are read-only unless you add `--write`. Exit codes: `0` done, `1` failed, `3` waiting for quota reset, `4` handed to Claude.

### Handoff order when a model is out of quota

| From | Next in line |
|---|---|
| codex | opus → gemini → copilot → Claude |
| opus | codex → flash → Claude |
| gemini | opus → flash → Claude |
| flash | opus → gemini → Claude |
| copilot | codex → opus → Claude |

Override per task with `--fallback a,b`, or use `--wait` / `--fallback none` to wait for the reset instead.

## Dashboard

```bash
node orchestra/server.mjs   # http://localhost:4747
```

Keep it running while you work: it also resumes tasks that are waiting for a quota reset. It only listens on `127.0.0.1`.

## Autopilot (optional)

1. Run `/team set up autopilot`. In the Claude desktop app this creates a scheduled task that wakes every 3 hours. Elsewhere, Claude gives you the prompt to run with cron and `claude -p`.
2. On the dashboard, add project folders, choose **commit only** or **publish when tests pass**, and switch each project on.
3. Set the usage guard threshold (default 80% of Claude's weekly limit).

Each project gets a rules file in `autopilot/<project>.md` with its own to-do list that you can edit. The shared safety rules are in [`autopilot/RULES.md`](autopilot/RULES.md). Autopilot skips projects with uncommitted changes, never force-pushes, never touches secrets, and reverts a release if the site's health check fails.

> ⚠️ "Publish when tests pass" ships changes with no human review. Start with **commit only** until you trust it on your project.

## Configuration

Copy `orchestra/config.example.json` to `orchestra/config.json` to change CLI paths, default models or your Copilot credit budget. The environment variables `CODEX_BIN`, `AGY_BIN` and `COPILOT_BIN` take precedence.

The routing rules Claude follows live in [`CLAUDE.md`](CLAUDE.md); edit them to change who gets what.

## How it works

```
orchestra/
  dispatch.mjs   runs a CLI, detects "out of quota", hands off, logs events
  quota.mjs      cooldowns, the wait queue, usage report
  autopilot.mjs  project list, switches, usage guard
  server.mjs     dashboard server (SSE) + resumes waiting tasks
  index.html     the dashboard
  runs/          event log and outputs (local only, git-ignored)
autopilot/       shared rules, per-project template, scheduled-task prompt
skill/team/      the /team skill (installed by install.sh)
```

## Limitations

- Tested on macOS. Linux should work; Windows is not supported.
- The dashboard and Claude's instructions are written in Traditional Chinese. Claude replies in your language.
- Quota detection relies on each CLI's error messages. Codex reports the exact reset time; for the others the time is estimated (default 1 hour) when it isn't given.
- Antigravity's remaining quota can't be queried; check it in Antigravity under **Settings › Models**.
- You are responsible for following each provider's terms of service.

## License

[MIT](LICENSE)
