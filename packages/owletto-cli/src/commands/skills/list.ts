import { defineCommand } from 'citty';
import { listBundledSkills } from '../../lib/bundled-skills.ts';
import { isJson, printJson, printTable, printText } from '../../lib/output.ts';

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List bundled Owletto starter skills',
  },
  run() {
    const skills = listBundledSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      files: skill.files,
    }));

    if (isJson()) {
      printJson({ skills });
      return;
    }

    if (skills.length === 0) {
      printText('No bundled Owletto starter skills are available.');
      return;
    }

    printText('Bundled Owletto starter skills');
    printTable(
      ['ID', 'Name', 'Description'],
      skills.map((skill) => [skill.id, skill.name, skill.description])
    );
  },
});
