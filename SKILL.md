---
name: every-newsletter-pipeline
description: Discover new public Every.to newsletter articles, skip locked/paywalled pages, generate Chinese rewrite and material-sprout drafts, and publish Markdown content into a GitHub-backed static site. Use for daily Every.to newsletter automation, OpenClaw/Claude Code/server migrations, or maintaining the Every.to Newsletter site.
---

# Every Newsletter Pipeline

Use this skill when the user wants to update the Every.to Newsletter archive or run the daily article-processing pipeline.

## GitHub Repositories

- Skill repository: `https://github.com/violin86318/every-newsletter-pipeline-skill`
- Website repository: `https://github.com/violin86318/every-to-newsletter`
- Production site: `https://every.beyondmotion.net`

When setting this up on another computer, clone the skill repository into `~/.agents/skills/every-newsletter-pipeline`, clone the website repository separately, then run the daily command from the website repository root.

## Core Workflow

1. Work from the target website repository root.
2. Run the CLI in `scripts/every-newsletter.mjs`.
3. Default behavior skips locked/paywalled articles and records them in `content/skipped.json`.
4. Generate two outputs for each public article:
   - `rewrite_zh`: Chinese rewrite / translation based on `references/prompts/rewrite-zh.md`
   - `sprout_note`: material-sprout note based on `references/prompts/material-sprout.md`
5. Commit and push generated content only after checking the produced files.

## Commands

```bash
node ~/.agents/skills/every-newsletter-pipeline/scripts/every-newsletter.mjs check --limit 5
node ~/.agents/skills/every-newsletter-pipeline/scripts/every-newsletter.mjs process --limit 1 --processor prompt
node ~/.agents/skills/every-newsletter-pipeline/scripts/every-newsletter.mjs process --limit 1 --processor deepseek --model deepseek-v4-pro
node ~/.agents/skills/every-newsletter-pipeline/scripts/every-newsletter.mjs publish
node ~/.agents/skills/every-newsletter-pipeline/scripts/every-newsletter.mjs run --limit 3 --processor deepseek --model deepseek-v4-pro
```

If running through the website repository wrapper, use:

```bash
npm run every:check -- --limit 5
npm run every:run -- --limit 3 --processor deepseek --model deepseek-v4-pro
```

## Processor Modes

- `prompt`: writes prompt packets to `processing/pending/{slug}/`. Use this when an Agent will generate the drafts manually or through its own model integration.
- `deepseek`: requires `DEEPSEEK_API_KEY`; calls DeepSeek's OpenAI-compatible chat completions API and writes the article Markdown directly.
- `openai`: backward-compatible alias for `deepseek` in this script. Prefer `deepseek` for new automation.
- `none`: fetches metadata and article text only; useful for debugging extraction.

Do not put LLM API keys into GitHub Actions unless the user explicitly changes that architecture.

## Browser Verification

For local Codex browser checks, use Browser Use / in-app browser only. Initialize `browser-client.mjs` through the Node REPL `js` tool with backend `iab`. Do not use Playwright CLI/package.

The CLI itself is portable and does not require Browser Use; Browser Use is only for validating dynamic pages or investigating extraction failures.

## Migration Notes

This skill is an entity directory under `/Users/wanglingwei/.agents/skills`. Other Agent skill directories should contain absolute symlinks to this directory, not copied files.

Server/OpenClaw/Claude Code runners need:

- Node.js 22+
- Git
- network access to `https://every.to/newsletter`
- optional `DEEPSEEK_API_KEY` for `--processor deepseek`
- GitHub credentials if using `publish`

## Daily Automation

For unattended updates, schedule this from the website repository root:

```bash
npm run every:run -- --limit 3 --processor deepseek --model deepseek-v4-pro
```

This command processes new articles, commits generated Markdown, pushes to GitHub, and lets the website repository's GitHub Actions workflow deploy Cloudflare Pages.
