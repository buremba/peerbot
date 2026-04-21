import { defineCommand } from 'citty';

export const main = defineCommand({
  meta: {
    name: 'owletto',
    description: 'Unified CLI for Owletto',
  },
  subCommands: {
    start: () => import('./commands/start.ts').then((m) => m.default),
    init: () => import('./commands/init.ts').then((m) => m.default),
    version: () => import('./commands/version.ts').then((m) => m.default),
    org: () => import('./commands/org.ts').then((m) => m.default),
    login: () => import('./commands/openclaw.ts').then((m) => m.login),
    token: () => import('./commands/openclaw.ts').then((m) => m.token),
    health: () => import('./commands/openclaw.ts').then((m) => m.health),
    configure: () => import('./commands/openclaw.ts').then((m) => m.configure),
    dev: () => import('./commands/dev.ts').then((m) => m.default),
    doctor: () => import('./commands/doctor.ts').then((m) => m.default),
    run: () => import('./commands/run.ts').then((m) => m.default),
    seed: () => import('./commands/seed.ts').then((m) => m.default),
    'browser-auth': () => import('./commands/browser-auth.ts').then((m) => m.default),
    skills: () => import('./commands/skills.ts').then((m) => m.default),
  },
});
