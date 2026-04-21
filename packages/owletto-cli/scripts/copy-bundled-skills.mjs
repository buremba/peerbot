import fs from 'node:fs';
import path from 'node:path';

const SKILLS = ['owletto', 'owletto-openclaw'];

for (const id of SKILLS) {
  const src = path.join('..', '..', 'skills', id);
  const dest = path.join('dist', 'bundled-skills', id);

  if (!fs.existsSync(src)) continue;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}
