import { defineCommand } from 'citty';
import { installBundledSkill, listBundledSkills } from '../../lib/bundled-skills.ts';
import { isJson, printError, printJson, printText } from '../../lib/output.ts';

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Install a bundled Owletto starter skill into skills/<id>',
  },
  args: {
    skillId: {
      type: 'positional',
      description: 'Bundled skill ID to install',
      required: true,
    },
    dir: {
      type: 'string',
      description: 'Target directory (defaults to current working directory)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite an existing skills/<id> directory',
    },
  },
  run({ args }) {
    try {
      const { skill, destinationDir } = installBundledSkill(args.skillId, args.dir || process.cwd(), {
        force: args.force,
      });

      if (isJson()) {
        printJson({
          skill: { id: skill.id, name: skill.name, description: skill.description },
          destinationDir,
        });
        return;
      }

      printText(`Installed \"${skill.name}\"`);
      printText(`→ ${destinationDir}`);
      printText('');
      printText('Next steps:');
      printText('1. Point your agent or workspace at that local skills/ directory.');
      if (skill.id === 'owletto' || skill.id === 'owletto-openclaw') {
        printText('2. Run `owletto init` to configure MCP/auth for your client.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isJson()) {
        printJson({ error: message, available: listBundledSkills().map((skill) => skill.id) });
        process.exitCode = 1;
        return;
      }

      printError(message);
      printText(`Available starter skills: ${listBundledSkills().map((skill) => skill.id).join(', ')}`);
      process.exitCode = 1;
    }
  },
});
