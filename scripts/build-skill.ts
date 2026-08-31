import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown, SKILL_NAME } from "../src/skill.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "skills", SKILL_NAME, "SKILL.md");
const markdown = createSkillMarkdown();
const check = process.argv.includes("--check");

if (check) {
  let current: string | null = null;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  if (current !== markdown) {
    console.error(
      `skills/${SKILL_NAME}/SKILL.md is out of date. Run \`pnpm build:skill\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`skills/${SKILL_NAME}/SKILL.md is up to date (${markdown.length} chars)`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown);
  console.log(`wrote skills/${SKILL_NAME}/SKILL.md (${markdown.length} chars)`);
}
