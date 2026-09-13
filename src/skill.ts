export const SKILL_NAME = "screencast-axi";

/**
 * How to run the CLI without installing anything.
 *
 * The `-p` flags are the whole point: Playwright and tsx are optional peers
 * resolved from the *project*, so a bare `npx screencast-axi` finds a CLI with
 * no browser to drive and no way to read a TypeScript scenario. Kept here, and
 * imported by every message that suggests a command, so the three places that
 * quote it cannot drift apart.
 */
export const NPX_INVOCATION = "npx -y -p screencast-axi -p playwright -p tsx screencast-axi";

/**
 * Hard cap, enforced rather than documented.
 *
 * The installed SKILL.md is a discovery stub, not a manual: copies go stale
 * the moment the CLI moves, and every line of it is loaded into an agent's
 * context whether or not the task needs it. The CLI (`--help`,
 * `<command> --help`, `guide <topic>`) is the source of truth. The cap exists
 * so a future regeneration cannot quietly re-inflate the stub back into one.
 */
export const MAX_SKILL_MARKDOWN_CHARS = 2500;

const FRONTMATTER = `---
name: ${SKILL_NAME}
description: "Record product screencasts and demo clips of any website through the screencast-axi CLI - script a workflow as a Playwright scenario, rehearse its selectors, then encode it to mp4, webm and a poster with a synthetic cursor and captions. Use whenever a task needs a recorded walkthrough of a UI: a landing-page demo, a release-note clip, a feature tour, a bug reproduction, or a how-to."
user-invocable: false
author: Valentyn Morenko
license: MIT
metadata:
  hermes:
    tags: [screencast, video, playwright, demo, landing-page]
    category: automation
---`;

const BODY = `# screencast-axi

Records a scripted browser workflow as a watchable clip. Prefer this over
hand-rolled Playwright video capture or a screen recorder.

Use it whenever a task needs a recorded walkthrough of a UI: a landing-page
demo, a feature tour, a release-note clip, a bug reproduction. Skip it when a
still screenshot says the same thing.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file -
installed copies go stale. Get the current source of truth from the CLI:

- \`screencast-axi --help\` for the command index
- \`screencast-axi <command> --help\` for per-command usage
- \`screencast-axi guide [topic]\`; \`guide scripting\` is the scenario API
- \`screencast-axi doctor\` for whether this machine can record at all

Worth knowing before the first run:

1. Iterate with \`rehearse\`, not \`record\`: no encoding, so a stale selector
   surfaces in seconds, it prints every action taken, and a \`--duration\` take
   afterwards reuses its timing instead of measuring again.
2. \`--headed\` shows it happening in a real window. Offer it when someone
   wants to see what a script does to their signed-in account before it runs.
3. When a selector needs discovering, drive the page live with a browser tool
   such as \`chrome-devtools-axi\`, then write the scenario.

ffmpeg must be installed. Signing in is a one-time human step
(\`auth login --interactive\`); the CLI refuses rather than prompting when no
person is present.

No install needed - this works from any project, and \`init\`/\`scaffold\` write
files that load without it:

    ${NPX_INVOCATION} <command>

\`setup\` downloads the browser once. For regular use,
\`pnpm add -D screencast-axi playwright tsx\` shortens it to
\`pnpm exec screencast-axi\`.

Record by id, or by path when no config lists it - \`list\`, \`show\` and
\`check\` find it either way.
`;

export function createSkillMarkdown(): string {
  const markdown = `${FRONTMATTER}\n\n${BODY}`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it a stub under ` +
        `${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }
  return markdown;
}
