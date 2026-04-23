import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  BenchmarkEntity,
  BenchmarkQuestion,
  BenchmarkRelationshipType,
  BenchmarkScenario,
  BenchmarkSuite,
} from './types';

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message);
  }
}

function validateEntities(scenario: BenchmarkScenario): Map<string, BenchmarkEntity> {
  const refs = new Map<string, BenchmarkEntity>();
  for (const entity of scenario.entities) {
    assertNonEmptyString(
      entity.ref,
      `Scenario ${scenario.id}: entity.ref must be a non-empty string`
    );
    assertNonEmptyString(
      entity.entityType,
      `Scenario ${scenario.id}: entity ${entity.ref} is missing entityType`
    );
    assertNonEmptyString(
      entity.name,
      `Scenario ${scenario.id}: entity ${entity.ref} is missing name`
    );
    if (refs.has(entity.ref)) {
      throw new Error(`Scenario ${scenario.id}: duplicate entity ref '${entity.ref}'`);
    }
    refs.set(entity.ref, entity);
  }
  return refs;
}

function validateRelationshipTypes(
  relationshipTypes: BenchmarkRelationshipType[] | undefined,
  entityTypeSlugs: Set<string>
): Set<string> {
  const relationshipTypeSlugs = new Set<string>();
  for (const relationshipType of relationshipTypes ?? []) {
    assertNonEmptyString(relationshipType.slug, 'relationshipType.slug must be a non-empty string');
    assertNonEmptyString(
      relationshipType.name,
      `Relationship type ${relationshipType.slug} is missing name`
    );
    if (relationshipTypeSlugs.has(relationshipType.slug)) {
      throw new Error(`Duplicate relationship type slug '${relationshipType.slug}'`);
    }
    relationshipTypeSlugs.add(relationshipType.slug);
    for (const rule of relationshipType.rules ?? []) {
      if (!entityTypeSlugs.has(rule.sourceEntityTypeSlug)) {
        throw new Error(
          `Relationship type ${relationshipType.slug}: unknown source entity type '${rule.sourceEntityTypeSlug}'`
        );
      }
      if (!entityTypeSlugs.has(rule.targetEntityTypeSlug)) {
        throw new Error(
          `Relationship type ${relationshipType.slug}: unknown target entity type '${rule.targetEntityTypeSlug}'`
        );
      }
    }
  }
  return relationshipTypeSlugs;
}

function validateSteps(
  scenario: BenchmarkScenario,
  entityRefs: Map<string, BenchmarkEntity>,
  relationshipTypeSlugs: Set<string>
): Set<string> {
  const stepIds = new Set<string>();

  for (const step of scenario.steps) {
    assertNonEmptyString(step.id, `Scenario ${scenario.id}: step.id must be a non-empty string`);
    if (stepIds.has(step.id)) {
      throw new Error(`Scenario ${scenario.id}: duplicate step id '${step.id}'`);
    }
    stepIds.add(step.id);
    assertNonEmptyString(
      step.content,
      `Scenario ${scenario.id}: step ${step.id} is missing content`
    );

    if (step.kind === 'memory') {
      if (step.entityRefs.length === 0) {
        throw new Error(
          `Scenario ${scenario.id}: memory step ${step.id} must reference at least one entity`
        );
      }
      for (const ref of step.entityRefs) {
        if (!entityRefs.has(ref)) {
          throw new Error(
            `Scenario ${scenario.id}: step ${step.id} references unknown entity '${ref}'`
          );
        }
      }
      assertNonEmptyString(
        step.semanticType,
        `Scenario ${scenario.id}: memory step ${step.id} is missing semanticType`
      );
    }

    if (step.kind === 'relationship') {
      if (!entityRefs.has(step.fromRef)) {
        throw new Error(
          `Scenario ${scenario.id}: relationship step ${step.id} references unknown fromRef '${step.fromRef}'`
        );
      }
      if (!entityRefs.has(step.toRef)) {
        throw new Error(
          `Scenario ${scenario.id}: relationship step ${step.id} references unknown toRef '${step.toRef}'`
        );
      }
      if (!relationshipTypeSlugs.has(step.relationshipType)) {
        throw new Error(
          `Scenario ${scenario.id}: relationship step ${step.id} uses unknown relationship type '${step.relationshipType}'`
        );
      }
    }
  }

  for (const step of scenario.steps) {
    if (step.kind === 'memory' && step.supersedes && !stepIds.has(step.supersedes)) {
      throw new Error(
        `Scenario ${scenario.id}: memory step ${step.id} supersedes unknown step '${step.supersedes}'`
      );
    }
  }

  return stepIds;
}

function validateQuestions(scenario: BenchmarkScenario, stepIds: Set<string>): void {
  const questionIds = new Set<string>();
  for (const question of scenario.questions) {
    validateQuestion(scenario, question, stepIds, questionIds);
  }
}

function validateQuestion(
  scenario: BenchmarkScenario,
  question: BenchmarkQuestion,
  stepIds: Set<string>,
  questionIds: Set<string>
): void {
  assertNonEmptyString(
    question.id,
    `Scenario ${scenario.id}: question.id must be a non-empty string`
  );
  if (questionIds.has(question.id)) {
    throw new Error(`Scenario ${scenario.id}: duplicate question id '${question.id}'`);
  }
  questionIds.add(question.id);
  assertNonEmptyString(
    question.prompt,
    `Scenario ${scenario.id}: question ${question.id} is missing prompt`
  );
  if (question.expectedAnswers.length === 0) {
    throw new Error(`Scenario ${scenario.id}: question ${question.id} must define expectedAnswers`);
  }
  for (const stepId of question.expectedSourceStepIds) {
    if (!stepIds.has(stepId)) {
      throw new Error(
        `Scenario ${scenario.id}: question ${question.id} references unknown expected source step '${stepId}'`
      );
    }
  }
}

export function validateBenchmarkSuite(suite: BenchmarkSuite): BenchmarkSuite {
  assertNonEmptyString(suite.id, 'Suite id must be a non-empty string');
  assertNonEmptyString(suite.version, 'Suite version must be a non-empty string');
  if (!Array.isArray(suite.entityTypes) || suite.entityTypes.length === 0) {
    throw new Error('Suite must define at least one entity type');
  }
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length === 0) {
    throw new Error('Suite must define at least one scenario');
  }

  const entityTypeSlugs = new Set<string>();
  for (const entityType of suite.entityTypes) {
    assertNonEmptyString(entityType.slug, 'entityType.slug must be a non-empty string');
    assertNonEmptyString(entityType.name, `Entity type ${entityType.slug} is missing name`);
    if (entityTypeSlugs.has(entityType.slug)) {
      throw new Error(`Duplicate entity type slug '${entityType.slug}'`);
    }
    entityTypeSlugs.add(entityType.slug);
  }

  const relationshipTypeSlugs = validateRelationshipTypes(suite.relationshipTypes, entityTypeSlugs);

  for (const scenario of suite.scenarios) {
    assertNonEmptyString(scenario.id, 'scenario.id must be a non-empty string');
    assertNonEmptyString(scenario.category, `Scenario ${scenario.id} is missing category`);
    const entityRefs = validateEntities(scenario);
    const stepIds = validateSteps(scenario, entityRefs, relationshipTypeSlugs);
    validateQuestions(scenario, stepIds);
  }

  return suite;
}

export function loadBenchmarkSuite(path: string): BenchmarkSuite {
  const absolutePath = resolve(process.cwd(), path);
  const raw = readFileSync(absolutePath, 'utf-8');
  return validateBenchmarkSuite(JSON.parse(raw) as BenchmarkSuite);
}
