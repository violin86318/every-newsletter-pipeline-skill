# Every Newsletter Pipeline Skill

This repository is a portable Agent/OpenClaw skill for maintaining the Every.to Newsletter Chinese archive.

It discovers new public articles from `https://every.to/newsletter`, generates two Chinese drafts for each new article, writes Markdown into the website repository, commits the content, and pushes to GitHub. Once the website repository receives the push, GitHub Actions rebuilds the Astro site and deploys it to Cloudflare Pages.

## What This Skill Controls

```text
Every.to newsletter
  -> this skill fetches new public articles
  -> this skill generates Chinese rewrite + sprout note
  -> this skill writes content into every-to-newsletter
  -> this skill commits and pushes to GitHub
  -> GitHub Actions deploys the website
  -> https://every.beyondmotion.net updates
```

Website repository:

```text
https://github.com/violin86318/every-to-newsletter
```

Production site:

```text
https://every.beyondmotion.net
```

## Give This To Another Agent

You can give another computer/OpenClaw this instruction:

```text
Use this skill repository:
https://github.com/violin86318/every-newsletter-pipeline-skill

Install it as the every-newsletter-pipeline skill, clone the website repository
https://github.com/violin86318/every-to-newsletter, configure OPENAI_API_KEY and GitHub push access, then schedule the daily command:
npm run every:run -- --limit 3 --processor openai

Run the daily command from the website repository root. When it pushes new Markdown to GitHub, GitHub Actions will rebuild and deploy https://every.beyondmotion.net automatically.
```

## Install The Skill

Recommended entity location:

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/violin86318/every-newsletter-pipeline-skill.git ~/.agents/skills/every-newsletter-pipeline
```

If OpenClaw uses a separate skills directory, keep this entity copy in `~/.agents/skills` and create an absolute symlink:

```bash
mkdir -p /path/to/openclaw/skills
ln -s ~/.agents/skills/every-newsletter-pipeline /path/to/openclaw/skills/every-newsletter-pipeline
```

Do not copy multiple physical copies into different Agent skill folders. Use symlinks so updates are not split across machines.

## Install The Website Repository

The skill writes into the website repository, so the machine running the daily job also needs a clone of the website repo:

```bash
git clone https://github.com/violin86318/every-to-newsletter.git ~/every-to-newsletter
cd ~/every-to-newsletter
npm install
```

Make sure this machine can push to GitHub:

```bash
git status
git push origin main
```

If there is nothing to push, Git may say everything is up to date. That is fine.

## Environment Variables

For fully automatic generation, set:

```bash
export OPENAI_API_KEY="..."
```

Optional:

```bash
export EVERY_NEWSLETTER_MODEL="gpt-5.4-mini"
export EVERY_NEWSLETTER_SKILL_DIR="$HOME/.agents/skills/every-newsletter-pipeline"
```

GitHub Actions deployment uses Cloudflare secrets in the website repository. The daily runner does not need Cloudflare credentials; it only needs to push generated content to GitHub.

## Daily Command

Run from the website repository root:

```bash
cd ~/every-to-newsletter
npm run every:run -- --limit 3 --processor openai
```

This command does the full update:

1. Check Every.to newsletter for recent articles.
2. Skip already processed URLs.
3. Fetch full public article body and images.
4. Generate `rewrite_zh` and `sprout_note`.
5. Write `content/articles/{yyyy-mm-dd}-{slug}.md`.
6. Rebuild `data/articles.json`.
7. Commit and push to `origin main`.
8. Let GitHub Actions update Cloudflare Pages.

## Beijing 09:00 Cron

Use this on the machine that has the website repo, the skill, `OPENAI_API_KEY`, and GitHub push access:

```cron
0 9 * * * cd /Users/YOUR_USER/every-to-newsletter && /usr/bin/env OPENAI_API_KEY=YOUR_KEY npm run every:run -- --limit 3 --processor openai
```

If you prefer loading environment variables from your shell profile, keep the cron command simpler:

```cron
0 9 * * * cd /Users/YOUR_USER/every-to-newsletter && npm run every:run -- --limit 3 --processor openai
```

## Manual Commands

Check latest Every.to list:

```bash
npm run every:check -- --limit 5
```

Generate prompt packets without using an API key:

```bash
npm run every:process -- --limit 1 --processor prompt
```

Capture source text only for debugging extraction:

```bash
npm run every:process -- --limit 1 --processor none --retry-skipped
```

Commit and push existing generated files:

```bash
npm run every:publish
```

## Content Format

Generated articles are Markdown files in the website repo:

```text
content/articles/{yyyy-mm-dd}-{slug}.md
```

The article body uses markers:

```markdown
<!-- REWRITE_START -->
Chinese rewrite
<!-- REWRITE_END -->

<!-- SPROUT_START -->
Material sprout note
<!-- SPROUT_END -->
```

The website renders these as two separate tabs.

## Updating This Skill

On another computer:

```bash
cd ~/.agents/skills/every-newsletter-pipeline
git pull
```

If OpenClaw uses a symlink to this directory, no additional copy step is needed.
