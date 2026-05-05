#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NEWSLETTER_URL = "https://every.to/newsletter";
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = process.env.EVERY_NEWSLETTER_MODEL || "gpt-5.4-mini";

const LOCKED_SIGNALS = [
  "Create a free account to continue reading",
  "Sign in to continue reading",
  "Subscribe to continue reading",
  "Unlock this article",
  "Become a subscriber",
  "This post is for paying subscribers",
  "Continue reading with a free account",
];

const GENERIC_LINK_TEXT = new Set([
  "Every",
  "Newsletter",
  "Home",
  "Login",
  "Sign In",
  "Subscribe",
  "Read More",
  "Start Here",
]);

const NON_ARTICLE_SECTIONS = new Set([
  "about",
  "careers",
  "cdn-cgi",
  "columnists",
  "consulting",
  "events",
  "faq",
  "login",
  "newsletter",
  "podcast",
  "search",
  "store",
  "studio",
  "subscribe",
  "team",
]);

function parseArgs(argv) {
  const args = {
    command: argv[0] || "check",
    root: process.cwd(),
    limit: 10,
    processor: process.env.EVERY_NEWSLETTER_PROCESSOR || "prompt",
    model: DEFAULT_MODEL,
    dryRun: false,
    retrySkipped: false,
    push: true,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = path.resolve(argv[++index]);
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === "--processor") args.processor = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--retry-skipped") args.retrySkipped = true;
    else if (arg === "--no-push") args.push = false;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 10;
  return args;
}

function printHelp() {
  console.log(`Every.to Newsletter pipeline

Usage:
  every-newsletter.mjs check [--limit 10] [--root .]
  every-newsletter.mjs process [--limit 3] [--processor prompt|openai|none]
  every-newsletter.mjs publish [--no-push]
  every-newsletter.mjs run [--limit 3] [--processor prompt|openai|none]
  every-newsletter.mjs index

Defaults:
  source: ${NEWSLETTER_URL}
  processor: prompt
  model: ${DEFAULT_MODEL}
`);
}

async function ensureRepoDirs(root) {
  await fs.mkdir(path.join(root, "content", "articles"), { recursive: true });
  await fs.mkdir(path.join(root, "content"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "processing", "pending"), { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}`);
  }
  return response.text();
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function extractAttr(tag, name) {
  const pattern = new RegExp(`${name}=["']([^"']*)["']`, "i");
  return decodeEntities(tag.match(pattern)?.[1] || "").trim();
}

function normalizeAssetUrl(src, base = NEWSLETTER_URL) {
  try {
    return new URL(src, base).toString();
  } catch {
    return "";
  }
}

function extractArticleImages(html) {
  const images = [];
  const seen = new Set();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = normalizeAssetUrl(extractAttr(tag, "src"));
    if (!src || seen.has(src)) continue;
    const isCover = src.includes("/uploads/post/cover/") && src.includes("full_page_cover");
    const isInline = src.includes("/uploads/editor/posts/");
    const isAd = src.includes("/uploads/editor/advertisements/");
    const isThumbnail = src.includes("/thumbnail_");
    if ((!isCover && !isInline) || isAd || isThumbnail) continue;
    seen.add(src);
    images.push({
      url: src,
      alt: extractAttr(tag, "alt"),
    });
  }
  return images;
}

function imagesToMarkdown(images = []) {
  if (!images.length) return "";
  return images
    .map((image, index) => {
      const alt = image.alt || `Original article image ${index + 1}`;
      return `![${alt}](${image.url})`;
    })
    .join("\n\n");
}

function extractBalancedDiv(html, startIndex) {
  const openStart = html.lastIndexOf("<div", startIndex);
  if (openStart < 0) return "";

  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = openStart;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(openStart, tagPattern.lastIndex);
  }
  return "";
}

function decodeJsonishAttribute(value) {
  if (!value) return "";
  return decodeEntities(value)
    .replace(/&amp;/g, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
}

function tagContentToMarkdown(html) {
  return stripTags(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function imageTagToMarkdown(tag) {
  const src = normalizeAssetUrl(extractAttr(tag, "src"));
  if (!src) return "";
  const alt = extractAttr(tag, "alt") || "Original article image";
  return `\n\n![${alt}](${src})\n\n`;
}

function htmlToPromptMarkdown(html) {
  let markdown = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");

  markdown = markdown.replace(
    /<div\b[^>]*class=["'][^"']*quill-block-image[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    (block) => {
      const dataSource = decodeJsonishAttribute(extractAttr(block, "data-source"));
      const url = dataSource.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
      const caption = dataSource.match(/"caption"\s*:\s*"([^"]*)"/)?.[1] || "";
      if (url) {
        const alt = tagContentToMarkdown(caption) || "Original article image";
        return `\n\n![${alt}](${normalizeAssetUrl(url)})\n\n`;
      }
      const image = block.match(/<img\b[^>]*>/i)?.[0];
      return image ? imageTagToMarkdown(image) : "\n\n";
    },
  );

  return decodeEntities(
    markdown
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => `\n\n# ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => `\n\n## ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => `\n\n### ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, content) => `\n\n#### ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => `\n\n> ${tagContentToMarkdown(content).replace(/\n/g, "\n> ")}\n\n`)
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
        const label = tagContentToMarkdown(content);
        return label ? `[${label}](${decodeEntities(href)})` : "";
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, content) => `**${tagContentToMarkdown(content)}**`)
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, content) => `*${tagContentToMarkdown(content)}*`)
      .replace(/<img\b[^>]*>/gi, (tag) => imageTagToMarkdown(tag))
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${tagContentToMarkdown(content)}`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return "";
}

function normalizeUrl(href, base = NEWSLETTER_URL) {
  try {
    const url = new URL(href, base);
    if (url.hostname !== "every.to") return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isLikelyArticleUrl(url) {
  if (!url) return false;
  const parsed = new URL(url);
  const pathName = parsed.pathname.toLowerCase();
  if (pathName === "/" || pathName === "/newsletter") return false;
  const firstSegment = pathName.split("/").filter(Boolean)[0];
  if (firstSegment?.startsWith("@")) return false;
  if (NON_ARTICLE_SECTIONS.has(firstSegment)) return false;
  if (pathName.includes("/account") || pathName.includes("/login")) return false;
  if (pathName.includes("/about") || pathName.includes("/authors")) return false;
  if (pathName.includes("/privacy") || pathName.includes("/terms")) return false;
  return pathName.split("/").filter(Boolean).length >= 1;
}

function cleanTitle(value) {
  return stripTags(value)
    .replace(/\b([A-Z])\s+([a-z]{2,})/g, (_, letter, rest) =>
      letter === "I" && !/^sn[’']?t\b/.test(rest) ? `${letter} ${rest}` : `${letter}${rest}`,
    )
    .replace(/\bI\s+sn([’']t)\b/g, "Isn$1")
    .replace(/^Every\s*-\s*/i, "")
    .replace(/\s*\|\s*Every.*$/i, "")
    .replace(/\s+-\s+Every.*$/i, "")
    .trim();
}

function extractNewsletterItems(html, limit) {
  const candidates = new Map();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const url = normalizeUrl(match[1]);
    if (!isLikelyArticleUrl(url)) continue;
    const title = cleanTitle(match[2]);
    if (title.length < 8 || GENERIC_LINK_TEXT.has(title)) continue;
    if (!candidates.has(url)) {
      candidates.set(url, {
        title,
        url,
        source: "newsletter",
      });
    }
  }

  return [...candidates.values()].slice(0, limit);
}

function pickHtmlContainer(html) {
  const articleBodyIndex = html.search(/itemprop=["']articleBody["']/i);
  if (articleBodyIndex >= 0) {
    const articleBody = extractBalancedDiv(html, articleBodyIndex);
    if (articleBody) return articleBody;
  }
  const postBodyIndex = html.search(/<div\b[^>]*class=["'][^"']*post-body-content/i);
  if (postBodyIndex >= 0) {
    const postBody = extractBalancedDiv(html, postBodyIndex);
    if (postBody) return postBody;
  }
  const article = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
  if (article?.[0]) return article[0];
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (main?.[0]) return main[0];
  const body = html.match(/<body\b[^>]*>[\s\S]*?<\/body>/i);
  return body?.[0] || html;
}

function removeBoilerplate(html) {
  return html
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<button\b[\s\S]*?<\/button>/gi, " ");
}

function excerptFrom(text) {
  return text
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .trim();
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "article";
}

function datePrefix(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(date.valueOf())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function yamlString(value) {
  if (value === null || value === undefined) return '""';
  return JSON.stringify(String(value));
}

function toFrontmatter(data) {
  const lines = [
    "---",
    `title: ${yamlString(data.title)}`,
    `slug: ${yamlString(data.slug)}`,
    `author: ${yamlString(data.author)}`,
    `date: ${yamlString(data.date)}`,
    `source_url: ${yamlString(data.sourceUrl)}`,
    `status: ${yamlString(data.status)}`,
    `hash: ${yamlString(data.hash)}`,
    `excerpt: ${yamlString(data.excerpt)}`,
    `image: ${yamlString(data.image)}`,
  ];
  if (data.images?.length) {
    lines.push("images:");
    for (const image of data.images) {
      lines.push(`  - url: ${yamlString(image.url)}`);
      lines.push(`    alt: ${yamlString(image.alt || "")}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function isLocked(html, text) {
  const combined = `${html}\n${text}`;
  return LOCKED_SIGNALS.find((signal) => combined.includes(signal)) || "";
}

async function extractArticle(url, fallbackTitle = "") {
  const html = await fetchText(url);
  const title =
    cleanTitle(extractMeta(html, "og:title")) ||
    cleanTitle(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") ||
    cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") ||
    fallbackTitle;
  const author =
    extractMeta(html, "author") ||
    extractMeta(html, "article:author") ||
    cleanTitle(html.match(/rel=["']author["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") ||
    "Every";
  const date =
    extractMeta(html, "article:published_time") ||
    html.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i)?.[1] ||
    new Date().toISOString();
  const image = extractMeta(html, "og:image");
  const container = removeBoilerplate(pickHtmlContainer(html));
  const text = stripTags(container);
  const inlineImages = extractArticleImages(container);
  const coverImages = extractArticleImages(html).filter((item) => item.url.includes("/uploads/post/cover/"));
  const images = [...coverImages, ...inlineImages].filter(
    (imageItem, index, list) => list.findIndex((other) => other.url === imageItem.url) === index,
  );
  const lockSignal = isLocked(html, text);
  const hash = sha256(text);

  return {
    url,
    title,
    author,
    date,
    image,
    images,
    text,
    sourceMarkdown: htmlToPromptMarkdown(container),
    hash,
    excerpt: excerptFrom(text),
    locked: Boolean(lockSignal),
    lockSignal,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

async function readPrompt(name) {
  return fs.readFile(path.join(SKILL_DIR, "references", "prompts", name), "utf8");
}

function articlePromptPayload(article) {
  return `Title: ${article.title}
Author: ${article.author}
Date: ${article.date}
URL: ${article.url}

Images:

${article.images?.length ? article.images.map((image, index) => `${index + 1}. ${image.alt || "Original article image"}\n   ${image.url}`).join("\n") : "No article images found."}

Article:

${article.sourceMarkdown || article.text}`;
}

function assertDraftQuality(drafts) {
  for (const [name, value] of Object.entries(drafts)) {
    if (!value || value.trim().length < 200) {
      throw new Error(`${name} draft is too short; refusing to write low-quality article`);
    }
  }
}

async function callOpenAI({ systemPrompt, userPrompt, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --processor openai");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  if (json.output_text) return json.output_text.trim();
  const chunks = [];
  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("OpenAI response did not include text output");
  return text;
}

async function writePromptPacket(root, article) {
  const rewritePrompt = await readPrompt("rewrite-zh.md");
  const sproutPrompt = await readPrompt("material-sprout.md");
  const slug = `${datePrefix(article.date)}-${slugify(article.title)}`;
  const packetDir = path.join(root, "processing", "pending", slug);
  await fs.mkdir(packetDir, { recursive: true });
  await writeJson(path.join(packetDir, "metadata.json"), {
    title: article.title,
    author: article.author,
    date: article.date,
    sourceUrl: article.url,
    slug,
    hash: article.hash,
    images: article.images || [],
  });
  await fs.writeFile(path.join(packetDir, "source.md"), articlePromptPayload(article));
  await fs.writeFile(
    path.join(packetDir, "rewrite.prompt.md"),
    `${rewritePrompt}\n\n---\n\n${articlePromptPayload(article)}\n`,
  );
  await fs.writeFile(
    path.join(packetDir, "material-sprout.prompt.md"),
    `${sproutPrompt}\n\n---\n\n${articlePromptPayload(article)}\n`,
  );
  return packetDir;
}

async function processWithOpenAI(article, model) {
  const rewritePrompt = await readPrompt("rewrite-zh.md");
  const sproutPrompt = await readPrompt("material-sprout.md");
  const payload = articlePromptPayload(article);
  const [rewrite, sprout] = await Promise.all([
    callOpenAI({
      model,
      systemPrompt: rewritePrompt,
      userPrompt: payload,
    }),
    callOpenAI({
      model,
      systemPrompt: sproutPrompt,
      userPrompt: payload,
    }),
  ]);
  const drafts = { rewrite, sprout };
  assertDraftQuality(drafts);
  return drafts;
}

async function writeArticle(root, article, drafts, status = "processed") {
  const slug = `${datePrefix(article.date)}-${slugify(article.title)}`;
  const filePath = path.join(root, "content", "articles", `${slug}.md`);
  const frontmatter = toFrontmatter({
    title: article.title,
    slug,
    author: article.author,
    date: article.date,
    sourceUrl: article.url,
    status,
    hash: article.hash,
    excerpt: article.excerpt,
    image: article.image,
    images: article.images || [],
  });
  const body = `${frontmatter}

<!-- REWRITE_START -->
${drafts.rewrite || "_待生成_"}
<!-- REWRITE_END -->

<!-- SPROUT_START -->
${drafts.sprout || "_待生成_"}
<!-- SPROUT_END -->
`;
  await fs.writeFile(filePath, body);
  return filePath;
}

async function discover(limit) {
  const html = await fetchText(NEWSLETTER_URL);
  const items = extractNewsletterItems(html, limit);
  if (items.length === 0) throw new Error("No newsletter items found");
  return items;
}

async function processedUrls(root) {
  const articleDir = path.join(root, "content", "articles");
  const urls = new Set();
  try {
    const entries = await fs.readdir(articleDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(articleDir, entry.name), "utf8");
      const match = raw.match(/^source_url:\s*["']?(.+?)["']?\s*$/m);
      if (match?.[1]) urls.add(match[1].replace(/^["']|["']$/g, ""));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return urls;
}

async function rebuildIndex(root) {
  const script = path.join(root, "scripts", "build-index.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error("Failed to rebuild article index");
}

async function recordSkipped(root, article, reason) {
  const skippedPath = path.join(root, "content", "skipped.json");
  const skipped = await readJson(skippedPath, []);
  const next = skipped.filter((item) => item.sourceUrl !== article.url);
  next.push({
    title: article.title,
    sourceUrl: article.url,
    reason,
    signal: article.lockSignal || "",
    checkedAt: new Date().toISOString(),
    hash: article.hash || "",
  });
  await writeJson(skippedPath, next);
}

async function commandCheck(args) {
  await ensureRepoDirs(args.root);
  const items = await discover(args.limit);
  await writeJson(path.join(args.root, "data", "check-results.json"), {
    source: NEWSLETTER_URL,
    checkedAt: new Date().toISOString(),
    items,
  });
  for (const item of items) console.log(`${item.title}\n  ${item.url}`);
  console.log(`Wrote data/check-results.json with ${items.length} item(s)`);
  return items;
}

async function commandProcess(args) {
  await ensureRepoDirs(args.root);
  const items = await discover(args.limit);
  const doneUrls = await processedUrls(args.root);
  const skippedPath = path.join(args.root, "content", "skipped.json");
  const skipped = await readJson(skippedPath, []);
  const skippedUrls = new Set(skipped.map((item) => item.sourceUrl));
  const results = [];

  for (const item of items) {
    if (doneUrls.has(item.url)) {
      console.log(`Already processed: ${item.title}`);
      continue;
    }
    if (!args.retrySkipped && skippedUrls.has(item.url)) {
      console.log(`Already skipped: ${item.title}`);
      continue;
    }

    console.log(`Fetching: ${item.title}`);
    const article = await extractArticle(item.url, item.title);
    if (article.locked && article.wordCount < 900) {
      console.log(`Skipped locked article: ${article.title}`);
      if (!args.dryRun) await recordSkipped(args.root, article, "locked");
      results.push({ status: "skipped", title: article.title, url: article.url });
      continue;
    }
    if (article.wordCount < 300) {
      console.log(`Skipped low-content article: ${article.title}`);
      if (!args.dryRun) await recordSkipped(args.root, article, "low_content");
      results.push({ status: "skipped", title: article.title, url: article.url });
      continue;
    }

    if (args.processor === "prompt") {
      const packetDir = await writePromptPacket(args.root, article);
      console.log(`Prompt packet: ${path.relative(args.root, packetDir)}`);
      results.push({ status: "prompt", title: article.title, url: article.url });
    } else if (args.processor === "openai") {
      const drafts = await processWithOpenAI(article, args.model);
      const filePath = await writeArticle(args.root, article, drafts, "processed");
      console.log(`Article written: ${path.relative(args.root, filePath)}`);
      results.push({ status: "processed", title: article.title, url: article.url });
    } else if (args.processor === "none") {
      const filePath = await writeArticle(
        args.root,
        article,
        {
          rewrite: `<!-- Source text captured for debugging. -->\n\n${article.text}`,
          sprout: "_Not generated. Re-run with --processor prompt or --processor openai._",
        },
        "captured",
      );
      console.log(`Captured article: ${path.relative(args.root, filePath)}`);
      results.push({ status: "captured", title: article.title, url: article.url });
    } else {
      throw new Error(`Unsupported processor: ${args.processor}`);
    }
  }

  if (!args.dryRun) await rebuildIndex(args.root);
  return results;
}

function runGit(args, commandArgs) {
  const result = spawnSync("git", commandArgs, {
    cwd: args.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}

async function commandPublish(args) {
  const status = runGit(args, ["status", "--short"]);
  if (status.status !== 0) {
    console.log("Initializing git repository");
    const init = runGit(args, ["init", "-b", "main"]);
    if (init.status !== 0) throw new Error(init.stderr || "git init failed");
  }

  runGit(args, ["add", "-A"]);
  const staged = runGit(args, ["diff", "--cached", "--quiet"]);
  if (staged.status === 0) {
    console.log("No content changes to publish");
    return;
  }

  const commit = runGit(args, ["commit", "-m", `Update Every.to newsletter ${new Date().toISOString().slice(0, 10)}`]);
  if (commit.status !== 0) throw new Error(commit.stderr || "git commit failed");
  console.log(commit.stdout.trim());

  const remote = runGit(args, ["remote", "get-url", "origin"]);
  if (args.push && remote.status === 0) {
    const push = runGit(args, ["push", "origin", "main"]);
    if (push.status !== 0) throw new Error(push.stderr || "git push failed");
    console.log(push.stdout.trim() || "Pushed to origin main");
  } else if (args.push) {
    console.log("No origin remote configured; committed locally only");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "check") await commandCheck(args);
  else if (args.command === "process") await commandProcess(args);
  else if (args.command === "publish") await commandPublish(args);
  else if (args.command === "index") await rebuildIndex(args.root);
  else if (args.command === "run") {
    await commandProcess(args);
    await commandPublish(args);
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
