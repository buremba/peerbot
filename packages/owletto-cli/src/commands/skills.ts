import { defineCommand } from 'citty';

export default defineCommand({
  meta: {
    name: 'skills',
    description: 'Install bundled Owletto starter skills into a local skills/ directory',
  },
  subCommands: {
    list: () => import('./skills/list.ts').then((m) => m.default),
    add: () => import('./skills/add.ts').then((m) => m.default),
  },
});
