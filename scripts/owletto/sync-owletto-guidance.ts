import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSkillMemorySection } from '../../packages/openclaw-plugin/src/owletto-guidance.ts';

const SKILL_PATH = resolve(process.cwd(), 'skills/lobu/SKILL.md');
const START_MARKER = '<!-- owletto-memory-guidance:start -->';
const END_MARKER = '<!-- owletto-memory-guidance:end -->';

const skill = readFileSync(SKILL_PATH, 'utf-8');
const startIndex = skill.indexOf(START_MARKER);
const endIndex = skill.indexOf(END_MARKER);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  throw new Error(`Could not find guidance markers in ${SKILL_PATH}`);
}

const generated = renderSkillMemorySection();
const replacement = `${START_MARKER}\n${generated}\n${END_MARKER}`;
const next = `${skill.slice(0, startIndex)}${replacement}${skill.slice(endIndex + END_MARKER.length)}`;

writeFileSync(SKILL_PATH, next);
console.log(`Synced ${SKILL_PATH}`);
