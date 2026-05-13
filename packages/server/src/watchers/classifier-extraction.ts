/**
 * Classifier Extraction Module
 *
 * Handles:
 * 1. Creating watcher classifiers from template definitions
 * 2. Extracting values from watcher data using JSONPath
 * 3. Normalizing values using embedding similarity (duplicate detection)
 * 4. LLM-based content classification from watchers (via processExtractedClassifications)
 */

import {
	type DbClient,
	parsePgTextArray,
	pgBigintArray,
	pgTextArray,
} from "../db/client";
import type { Env } from "../index";
import {
	generateEmbeddings,
	isValidEmbedding,
	validateEmbeddingsService,
} from "../utils/embeddings";
import logger from "../utils/logger";
import { cosineSimilarity } from "../utils/vector-math";

// ============================================
// Types
// ============================================

/**
 * Citation config - format is inferred from fields set
 *
 * Inference rules:
 * - ids_field only → IDs-only (no excerpts stored)
 * - excerpts_field only → Full excerpts (current behavior)
 * - ids_field + excerpts_field → Hybrid (merge IDs, store excerpts)
 * - excerpts_field + anchor_key → Anchor (fuzzy match anchor to content)
 */
interface CitationConfig {
	// IDs source (plain array of numbers)
	ids_field?: string; // e.g., "cited_content_ids"

	// Excerpts source (array of objects)
	excerpts_field?: string; // e.g., "top_excerpts" or "citations"
	content_id_key?: string; // Default: "content_id"
	excerpt_key?: string; // Default: "excerpt"

	// Anchor mode (fuzzy match excerpt to content)
	anchor_key?: string; // If set, use this key instead of excerpt_key for matching
	fuzzy_threshold?: number; // Default: 0.8
}

/**
 * Classifier definition from template
 */
interface ClassifierDefinition {
	slug: string;
	name: string;
	source_path: string; // JSONPath like "$.problems_analysis.top_problems[*]"
	value_field: string;
	description_field?: string;
	examples_field?: string;

	// Flexible citation config — format inferred from which fields are set.
	citation_config?: CitationConfig;

	strip_fields?: string[]; // Fields to strip from extracted data
	parent?: {
		slug: string;
		value_field: string;
	};
}

/**
 * Extracted value with metadata
 * Embedding can be provided by workers or generated via embeddings service
 */
interface ExtractedValue {
	value: string;
	description?: string;
	examples?: string[];
	embedding?: number[]; // Worker-provided embedding for similarity matching
	parent?: {
		slug: string;
		value: string;
	};
}

/**
 * Normalization result
 */
interface NormalizationResult {
	value: string;
	action: "auto_merged" | "new";
	originalValue?: string; // Set if auto_merged
	similarity?: number;
}

/**
 * Attribute value with embedding and optional parent reference
 */
interface AttributeValue {
	description: string;
	examples: string[];
	embedding?: number[] | null;
	parent?: Record<string, string>; // { "parent-slug": "parent-value" }
}

type AttributeValues = Record<string, AttributeValue>;

// ============================================
// Helpers
// ============================================

/**
 * Parse a JSONB column value that postgres.js may return as a string.
 * Falls back to the provided default when the value is null/undefined.
 */
function parseJsonb<T>(raw: unknown, fallback: T): T {
	if (raw == null) return fallback;
	if (typeof raw === "string") return JSON.parse(raw) as T;
	return raw as T;
}

// ============================================
// JSONPath Extraction
// ============================================

/**
 * Extract values from data using a simplified JSONPath
 * Supports: $.field, $.field[*], $.field[*].subfield
 *
 * @example
 * extractAtPath(data, "$.problems_analysis.top_problems[*]")
 * // Returns array of all items in top_problems
 */
function extractAtPath(data: any, path: string): any[] {
	if (!data || !path) {
		return [];
	}

	// Remove leading $. if present
	const cleanPath = path.startsWith("$.") ? path.slice(2) : path;

	// Split by [*] to handle array traversal
	const segments = cleanPath.split("[*]");

	function traverse(obj: any, segmentIndex: number): any[] {
		if (segmentIndex >= segments.length) {
			return [obj];
		}

		const segment = segments[segmentIndex]
			.replace(/^\./, "")
			.replace(/\.$/, "");

		// Navigate to the field
		let value = obj;
		if (segment) {
			const keys = segment.split(".");
			for (const key of keys) {
				if (value == null) return [];
				value = value[key];
			}
		}

		// If we have more segments, we expect an array here
		if (segmentIndex < segments.length - 1) {
			if (!Array.isArray(value)) {
				logger.warn(
					`[ClassifierExtraction] Expected array at path segment ${segmentIndex}`,
				);
				return [];
			}
			return value.flatMap((item) => traverse(item, segmentIndex + 1));
		}

		// Last segment - return the value(s)
		if (Array.isArray(value)) {
			return value;
		}
		return value != null ? [value] : [];
	}

	return traverse(data, 0);
}

/**
 * Extract classifier values from watcher data
 */
function extractClassifierValues(
	data: any,
	config: ClassifierDefinition,
): ExtractedValue[] {
	const items = extractAtPath(data, config.source_path);
	const results: ExtractedValue[] = [];
	const seenValues = new Set<string>();

	for (const item of items) {
		if (!item || typeof item !== "object") continue;

		const value = item[config.value_field];
		if (!value || typeof value !== "string") continue;

		// Skip duplicates
		if (seenValues.has(value)) continue;
		seenValues.add(value);

		const result: ExtractedValue = { value };

		if (config.description_field && item[config.description_field]) {
			result.description = String(item[config.description_field]);
		}

		if (config.examples_field && Array.isArray(item[config.examples_field])) {
			result.examples = item[config.examples_field]
				.filter((e: any) => e != null)
				.map((e: any) => String(e))
				.slice(0, 5); // Limit examples
		}

		if (config.parent && item[config.parent.value_field]) {
			result.parent = {
				slug: config.parent.slug,
				value: String(item[config.parent.value_field]),
			};
		}

		// Extract worker-provided embedding if present
		if (item.embedding && Array.isArray(item.embedding)) {
			result.embedding = item.embedding;
		}

		results.push(result);
	}

	return results;
}

// ============================================
// Value Normalization
// ============================================

/**
 * Normalize a new value against existing classifier values
 * Uses embedding similarity to detect duplicates
 *
 * Thresholds:
 * - > 0.95: Auto-merge (use existing value)
 * - <= 0.95: New value
 *
 * Note: newEmbedding should be provided by worker or embeddings service.
 * If not available, similarity matching is skipped and exact string match is used.
 */
function normalizeValue(
	newValue: string,
	existingValues: AttributeValues,
	newEmbedding?: number[],
): NormalizationResult {
	if (!hasValidEmbedding(newEmbedding)) {
		return {
			value: newValue,
			action: existingValues[newValue] ? "auto_merged" : "new",
		};
	}

	let bestMatch: string | null = null;
	let bestSimilarity = 0;

	for (const [existing, config] of Object.entries(existingValues)) {
		if (!hasValidEmbedding(config.embedding)) continue;

		const similarity = cosineSimilarity(newEmbedding, config.embedding);
		if (similarity > bestSimilarity) {
			bestMatch = existing;
			bestSimilarity = similarity;
		}
	}

	if (bestSimilarity > 0.95 && bestMatch) {
		logger.info(
			`[ClassifierExtraction] Auto-merged "${newValue}" -> "${bestMatch}" (similarity: ${bestSimilarity.toFixed(3)})`,
		);
		return {
			value: bestMatch,
			action: "auto_merged",
			originalValue: newValue,
			similarity: bestSimilarity,
		};
	}

	return { value: newValue, action: "new" };
}

function hasValidEmbedding(embedding: unknown): embedding is number[] {
	return Array.isArray(embedding) && embedding.length > 0;
}

function ensureEmbedding(
	config: AttributeValue,
	workerEmbedding?: number[],
): AttributeValue {
	if (hasValidEmbedding(workerEmbedding)) {
		return { ...config, embedding: workerEmbedding };
	}

	if (hasValidEmbedding(config.embedding)) {
		return config;
	}

	// No embedding available — store without embedding, similarity matching
	// will fall back to exact string match for this value.
	return { ...config, embedding: null };
}

// ============================================
// Classifier Creation & Update
// ============================================

/** A value to merge into a classifier's attribute_values map. */
interface MergeCandidate {
	value: string;
	/** Embedding used for duplicate detection; absent → exact string match. */
	embedding?: number[];
	/** Builds the AttributeValue to store when this is a brand-new value. */
	build: () => AttributeValue;
	/**
	 * Called when the value was auto-merged into an existing entry. Mutate the
	 * target if needed and return `true` if a write is now required.
	 */
	onAutoMerge?: (target: AttributeValue) => boolean;
}

/**
 * Merge `candidates` into a copy of `existingValues`, using embedding similarity
 * (or exact match) to dedupe. Returns the updated map and whether anything
 * changed. Shared by the child-extraction and parent-rollup loops.
 */
function mergeValues(
	existingValues: AttributeValues,
	candidates: Iterable<MergeCandidate>,
): { updatedValues: AttributeValues; hasChanges: boolean } {
	const updatedValues: AttributeValues = { ...existingValues };
	let hasChanges = false;

	for (const candidate of candidates) {
		const normalized = normalizeValue(
			candidate.value,
			existingValues,
			candidate.embedding,
		);

		if (normalized.action === "auto_merged") {
			const target = updatedValues[normalized.value];
			if (target && candidate.onAutoMerge?.(target)) hasChanges = true;
			continue;
		}

		if (!updatedValues[normalized.value]) {
			updatedValues[normalized.value] = ensureEmbedding(
				candidate.build(),
				candidate.embedding,
			);
			hasChanges = true;
		}
	}

	return { updatedValues, hasChanges };
}

async function persistAttributeValues(
	sql: DbClient,
	versionId: number,
	updatedValues: AttributeValues,
): Promise<void> {
	await sql`
    UPDATE event_classifier_versions
    SET attribute_values = ${sql.json(updatedValues as any)}
    WHERE id = ${versionId}
  `;
}

/**
 * Create classifiers for an watcher from template definitions
 */
export async function createClassifiersForWatcher(
	sql: DbClient,
	watcherId: number,
	entityId: number,
	classifierDefs: ClassifierDefinition[],
	options: {
		createdBy: string;
		organizationId?: string | null;
	},
): Promise<number[]> {
	const classifierIds: number[] = [];
	const entityIdsLiteral = pgBigintArray([entityId]);

	for (const def of classifierDefs) {
		// Create or update classifier
		const result = await sql`
      INSERT INTO event_classifiers (
        slug,
        name,
        entity_id,
        entity_ids,
        watcher_id,
        organization_id,
        attribute_key,
        status,
        created_by
      )
      VALUES (
        ${def.slug},
        ${def.name},
        ${entityId},
        ${entityIdsLiteral}::bigint[],
        ${watcherId},
        ${options.organizationId ?? null},
        ${def.slug},
        'active',
        ${options.createdBy}
      )
      ON CONFLICT (entity_id, watcher_id, slug) DO UPDATE
      SET name = EXCLUDED.name,
          organization_id = COALESCE(event_classifiers.organization_id, EXCLUDED.organization_id),
          updated_at = NOW()
      RETURNING id
    `;

		const classifierId = result[0].id;
		classifierIds.push(classifierId);

		// Check if version exists
		const existingVersion = await sql`
      SELECT id FROM event_classifier_versions
      WHERE classifier_id = ${classifierId} AND is_current = true
    `;

		if (existingVersion.length === 0) {
			// Create initial version with extraction config
			const extractionConfig = {
				source_path: def.source_path,
				value_field: def.value_field,
				description_field: def.description_field,
				examples_field: def.examples_field,
				citation_config: def.citation_config,
				parent: def.parent,
			};

			// Start with empty attribute_values; we'll populate from extracted_data
			await sql`
        INSERT INTO event_classifier_versions (
          classifier_id, version, is_current,
          attribute_values, min_similarity,
          extraction_config, change_notes, created_by
        )
        VALUES (
          ${classifierId}, 1, true,
          '{}',
          0.7,
          ${sql.json(extractionConfig as any)},
          'Initial version from watcher template',
          ${options.createdBy}
        )
      `;
		}

		logger.info(
			`[ClassifierExtraction] Created/updated classifier "${def.slug}" for watcher ${watcherId}`,
		);
	}

	return classifierIds;
}

/**
 * Update classifier values after watcher extraction
 * Normalizes new values and merges with existing
 * Also populates parent classifier values from child extractions
 */
async function updateClassifierValues(
	sql: DbClient,
	watcherId: number,
	extractedData: any,
	env: Env,
): Promise<void> {
	// Get classifiers for this watcher with extraction config
	const classifiers = await sql`
    SELECT
      cc.id,
      cc.slug,
      ccv.id as version_id,
      ccv.extraction_config,
      ccv.attribute_values
    FROM event_classifiers cc
    JOIN event_classifier_versions ccv ON cc.id = ccv.classifier_id AND ccv.is_current = true
    WHERE cc.watcher_id = ${watcherId}
  `;

	// Build a map of classifiers by slug for parent lookups
	const classifierMap = new Map<string, any>();
	for (const c of classifiers as any[]) {
		classifierMap.set(c.slug, c);
	}

	const missingEmbeddings = new Set<string>();
	const extractionContexts: Array<{
		classifier: any;
		config: ClassifierDefinition;
		extractedValues: ExtractedValue[];
		existingValues: AttributeValues;
	}> = [];

	for (const classifier of classifiers as any[]) {
		// Parse extraction_config if it's a string (postgres.js may return JSONB as string)
		const config = parseJsonb<ClassifierDefinition | null>(
			classifier.extraction_config,
			null,
		);

		// Skip classifiers without source_path — they may get values from parent references.
		if (!config || !config.source_path) continue;

		// Extract new values from watcher data
		const extractedValues = extractClassifierValues(extractedData, config);
		if (extractedValues.length === 0) continue;

		// Get existing values (parse if string)
		const existingValues = parseJsonb<AttributeValues>(
			classifier.attribute_values,
			{},
		);

		for (const extracted of extractedValues) {
			if (
				extracted.embedding !== undefined &&
				!isValidEmbedding(extracted.embedding)
			) {
				throw new Error(
					`Invalid embedding for classifier "${classifier.slug}" value "${extracted.value}". ` +
						"Expected a 768-dim array of numbers.",
				);
			}

			if (extracted.embedding === undefined) {
				missingEmbeddings.add(extracted.value);
			}
		}

		extractionContexts.push({
			classifier,
			config,
			extractedValues,
			existingValues,
		});
	}

	const CLASSIFIER_EMBEDDING_TIMEOUT_MS = 10_000;
	const generatedEmbeddings = new Map<string, number[]>();
	if (missingEmbeddings.size > 0) {
		const valuesToEmbed = [...missingEmbeddings];
		logger.info(
			{ count: valuesToEmbed.length },
			"[ClassifierExtraction] Generating embeddings for new values",
		);
		try {
			await validateEmbeddingsService(env);
			const embeddings = await Promise.race([
				generateEmbeddings(valuesToEmbed, env),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("Embedding generation timed out")),
						CLASSIFIER_EMBEDDING_TIMEOUT_MS,
					),
				),
			]);
			valuesToEmbed.forEach((value, index) => {
				generatedEmbeddings.set(value, embeddings[index]);
			});
		} catch (err) {
			logger.warn(
				{ err, count: missingEmbeddings.size },
				"[ClassifierExtraction] Embedding generation failed — using exact match fallback",
			);
		}
	}

	// Collect parent values from all extractions for the parent-rollup pass.
	const parentValues = new Map<string, Set<string>>();

	for (const {
		classifier,
		extractedValues,
		existingValues,
	} of extractionContexts) {
		const candidates: MergeCandidate[] = extractedValues.map((extracted) => {
			if (extracted.parent) {
				if (!parentValues.has(extracted.parent.slug)) {
					parentValues.set(extracted.parent.slug, new Set());
				}
				parentValues.get(extracted.parent.slug)?.add(extracted.parent.value);
			}

			return {
				value: extracted.value,
				embedding:
					extracted.embedding ?? generatedEmbeddings.get(extracted.value),
				build: (): AttributeValue => ({
					description: extracted.description || `Category: ${extracted.value}`,
					examples: extracted.examples || [],
					...(extracted.parent
						? { parent: { [extracted.parent.slug]: extracted.parent.value } }
						: {}),
				}),
				onAutoMerge: extracted.parent
					? (target: AttributeValue) => {
							if (!target.parent) target.parent = {};
							target.parent[extracted.parent!.slug] = extracted.parent!.value;
							return true;
						}
					: undefined,
			};
		});

		const { updatedValues, hasChanges } = mergeValues(
			existingValues,
			candidates,
		);
		if (hasChanges) {
			await persistAttributeValues(sql, classifier.version_id, updatedValues);
			logger.info(
				{
					slug: classifier.slug,
					valueCount: Object.keys(updatedValues).length,
				},
				"[ClassifierExtraction] Updated classifier with new values",
			);
		}
	}

	// Parent classifiers: roll up values collected from child extractions.
	// Parent values don't carry embeddings — exact string matching only.
	for (const [parentSlug, values] of parentValues) {
		const parentClassifier = classifierMap.get(parentSlug);
		if (!parentClassifier) {
			logger.warn(
				`[ClassifierExtraction] Parent classifier "${parentSlug}" not found`,
			);
			continue;
		}

		const existingValues = parseJsonb<AttributeValues>(
			parentClassifier.attribute_values,
			{},
		);
		const { updatedValues, hasChanges } = mergeValues(
			existingValues,
			[...values].map((value) => ({
				value,
				build: (): AttributeValue => ({
					description: `Category: ${value}`,
					examples: [],
				}),
			})),
		);

		if (hasChanges) {
			await persistAttributeValues(
				sql,
				parentClassifier.version_id,
				updatedValues,
			);
			logger.info(
				{ parentSlug, valueCount: Object.keys(updatedValues).length },
				"[ClassifierExtraction] Updated parent classifier with new values",
			);
		}
	}
}

/**
 * Enable classifiers on entity
 */
export async function enableClassifiersOnEntity(
	sql: DbClient,
	entityId: number,
	classifierSlugs: string[],
): Promise<void> {
	if (classifierSlugs.length === 0) return;

	// Get current enabled classifiers
	const entity = await sql`
    SELECT enabled_classifiers FROM entities WHERE id = ${entityId}
  `;

	if (entity.length === 0) {
		logger.warn(`[ClassifierExtraction] Entity ${entityId} not found`);
		return;
	}

	// Parse PostgreSQL array (may come as string like "{urgency,team_routing}")
	const currentEnabled = parsePgTextArray(entity[0].enabled_classifiers);
	const toAdd = classifierSlugs.filter(
		(slug) => !currentEnabled.includes(slug),
	);

	if (toAdd.length === 0) return;

	// Compute combined array and set directly
	const combined = [...currentEnabled, ...toAdd];
	const arrayLiteral = pgTextArray(combined);

	await sql`
    UPDATE entities
    SET enabled_classifiers = ${arrayLiteral}::text[]
    WHERE id = ${entityId}
  `;

	logger.info(
		`[ClassifierExtraction] Enabled ${toAdd.length} classifier(s) on entity ${entityId}`,
	);
}

// ============================================
// LLM-Based Content Classification
// ============================================

/**
 * Classifier row from database query
 */
interface ClassifierRow {
	id: number;
	slug: string;
	version_id: number;
	extraction_config: ClassifierDefinition | null;
}

/**
 * Citation object from LLM output
 */
interface Citation {
	content_id: number;
	excerpt?: string;
}

/**
 * Inferred citation format based on config fields
 */
type CitationFormat = "ids_only" | "full" | "hybrid" | "anchor" | "none";

/**
 * Infer citation format from config fields
 */
function inferCitationFormat(citationConfig: CitationConfig): CitationFormat {
	const hasIds = !!citationConfig.ids_field;
	const hasExcerpts = !!citationConfig.excerpts_field;
	const hasAnchor = !!citationConfig.anchor_key;

	if (hasIds && hasExcerpts) {
		return "hybrid";
	}
	if (hasExcerpts && hasAnchor) {
		return "anchor";
	}
	if (hasExcerpts) {
		return "full";
	}
	if (hasIds) {
		return "ids_only";
	}
	return "none";
}

/**
 * Extract citations from an item based on citation config and format
 *
 * @param item - Single extracted item (e.g., a problem object)
 * @param citationConfig - Citation configuration
 * @param format - Inferred format
 * @returns Array of citations with content_id and optional excerpt
 */
function extractCitationsFromItem(
	item: any,
	citationConfig: CitationConfig,
	format: CitationFormat,
): Citation[] {
	const contentIdKey = citationConfig.content_id_key || "content_id";
	const excerptKey = citationConfig.excerpt_key || "excerpt";
	const anchorKey = citationConfig.anchor_key || "anchor";

	const citations: Citation[] = [];
	const seenIds = new Set<number>();

	const addCitation = (contentId: number, excerpt?: string) => {
		if (!seenIds.has(contentId)) {
			seenIds.add(contentId);
			citations.push({ content_id: contentId, excerpt });
		}
	};

	const addIdsFromField = (field: string | undefined) => {
		if (!field) return;
		const ids = item[field];
		if (Array.isArray(ids)) {
			for (const id of ids) {
				if (typeof id === "number") addCitation(id);
			}
		}
	};

	const addFromObjectArray = (field: string | undefined, textKey: string) => {
		if (!field) return;
		const arr = item[field];
		if (Array.isArray(arr)) {
			for (const e of arr) {
				if (e && typeof e === "object" && typeof e[contentIdKey] === "number") {
					addCitation(e[contentIdKey], e[textKey]);
				}
			}
		}
	};

	switch (format) {
		case "ids_only":
			addIdsFromField(citationConfig.ids_field);
			break;

		case "full":
			addFromObjectArray(citationConfig.excerpts_field, excerptKey);
			break;

		case "hybrid": {
			addIdsFromField(citationConfig.ids_field);
			const excerptsField = citationConfig.excerpts_field;
			if (excerptsField) {
				const excerpts = item[excerptsField];
				if (Array.isArray(excerpts)) {
					for (const e of excerpts) {
						if (
							e &&
							typeof e === "object" &&
							typeof e[contentIdKey] === "number"
						) {
							const id = e[contentIdKey] as number;
							const excerpt = e[excerptKey] as string | undefined;
							const existing = citations.find((c) => c.content_id === id);
							if (existing && excerpt) {
								existing.excerpt = excerpt;
							} else if (!seenIds.has(id)) {
								addCitation(id, excerpt);
							}
						}
					}
				}
			}
			break;
		}

		case "anchor":
			addFromObjectArray(citationConfig.excerpts_field, anchorKey);
			break;
	}

	return citations;
}

/**
 * Get all fields that should be stripped based on citation config
 */
function getCitationFieldsToStrip(citationConfig: CitationConfig): string[] {
	const fields: string[] = [];
	if (citationConfig.ids_field) fields.push(citationConfig.ids_field);
	if (citationConfig.excerpts_field) fields.push(citationConfig.excerpts_field);
	return fields;
}

/**
 * Process extracted data to create LLM-based classifications with excerpts
 *
 * Supports multiple citation formats (inferred from config):
 * - ids_only: Plain array of content IDs
 * - full: Array of { content_id, excerpt } objects
 * - hybrid: Separate ids_field and excerpts_field (merged)
 * - anchor: Short phrases that get fuzzy-matched to content (future)
 *
 * @param validContentIds - Set of content IDs that are valid for this window (for validation)
 * @returns Cleaned extracted data (without citation fields)
 */
async function processExtractedClassifications(
	sql: DbClient,
	watcherId: number,
	windowId: number,
	extractedData: any,
	classifiers: ClassifierRow[],
	validContentIds: Set<number>,
): Promise<any> {
	// Deep clone to avoid mutating original
	const cleanedData = structuredClone(extractedData);
	let totalClassifications = 0;
	let invalidCitations = 0;

	for (const classifier of classifiers) {
		const config = classifier.extraction_config;
		if (!config) continue;

		const citationConfig = config.citation_config;
		if (!citationConfig) continue;

		const format = inferCitationFormat(citationConfig);
		if (format === "none") continue;

		// Extract items at source_path from ORIGINAL data
		const items = extractAtPath(extractedData, config.source_path);
		logger.debug(
			{ slug: classifier.slug, itemCount: items.length, format },
			"[ClassifierExtraction] Extracted items for LLM classification",
		);

		for (const item of items) {
			if (!item || typeof item !== "object") continue;

			const value = item[config.value_field];
			if (!value || typeof value !== "string") continue;

			// Extract citations using format-aware extraction
			const citations = extractCitationsFromItem(item, citationConfig, format);

			if (citations.length === 0) {
				logger.debug(
					{ slug: classifier.slug, value },
					"[ClassifierExtraction] Skipping item - no citations",
				);
				continue;
			}

			// Create LLM classification for each citation
			for (const citation of citations) {
				// Validate content_id exists in window
				if (!validContentIds.has(citation.content_id)) {
					logger.warn(
						{
							contentId: citation.content_id,
							classifierSlug: classifier.slug,
							value,
						},
						"[ClassifierExtraction] Invalid citation: content_id not in window",
					);
					invalidCitations++;
					continue;
				}

				try {
					// Build excerpts JSONB: { "value": "excerpt" }
					const excerptsJson = citation.excerpt
						? { [value]: citation.excerpt }
						: {};

					await sql`
            INSERT INTO event_classifications (
              event_id, classifier_version_id, watcher_id, window_id,
              values, excerpts, confidences, source, is_manual
            )
            VALUES (
              ${citation.content_id},
              ${classifier.version_id},
              ${watcherId},
              ${windowId},
              ARRAY[${value}]::text[],
              ${sql.json(excerptsJson)},
              '{}',
              'llm',
              false
            )
            ON CONFLICT (event_id, classifier_version_id, source, COALESCE(watcher_id, 0))
            DO UPDATE SET
              values = ARRAY(SELECT DISTINCT unnest(event_classifications.values || EXCLUDED.values)),
              excerpts = event_classifications.excerpts || EXCLUDED.excerpts,
              window_id = EXCLUDED.window_id
          `;
					totalClassifications++;

					// Create parent classification if this classifier has a parent reference
					if (config.parent) {
						const parentValue = item[config.parent.value_field];
						logger.info(
							{
								parentSlug: config.parent.slug,
								valueField: config.parent.value_field,
								parentValue,
								parentValueType: typeof parentValue,
								classifierSlugs: classifiers.map((c) => c.slug),
							},
							"[ClassifierExtraction] Checking parent classification",
						);
						if (parentValue && typeof parentValue === "string") {
							const parentClassifier = classifiers.find(
								(c) => c.slug === config.parent?.slug,
							);
							logger.info(
								{
									foundParent: !!parentClassifier,
									parentVersionId: parentClassifier?.version_id,
									searchingFor: config.parent.slug,
								},
								"[ClassifierExtraction] Parent classifier lookup",
							);
							if (parentClassifier) {
								await sql`
                  INSERT INTO event_classifications (
                    event_id, classifier_version_id, watcher_id, window_id,
                    values, excerpts, confidences, source, is_manual
                  )
                  VALUES (
                    ${citation.content_id},
                    ${parentClassifier.version_id},
                    ${watcherId},
                    ${windowId},
                    ARRAY[${parentValue}]::text[],
                    '{}',
                    '{}',
                    'llm',
                    false
                  )
                  ON CONFLICT (event_id, classifier_version_id, source, COALESCE(watcher_id, 0))
                  DO UPDATE SET
                    values = ARRAY(SELECT DISTINCT unnest(event_classifications.values || EXCLUDED.values)),
                    window_id = EXCLUDED.window_id
                `;
								totalClassifications++;
								logger.info(
									{
										contentId: citation.content_id,
										parentSlug: config.parent.slug,
										parentValue,
										versionId: parentClassifier.version_id,
									},
									"[ClassifierExtraction] Created parent classification",
								);
							}
						}
					}
				} catch (error) {
					logger.warn(
						{
							error,
							contentId: citation.content_id,
							classifierSlug: classifier.slug,
						},
						"[ClassifierExtraction] Failed to create classification",
					);
				}
			}
		}

		// Strip citation fields from items in cleanedData
		const fieldsToStrip = getCitationFieldsToStrip(citationConfig);
		const cleanedItems = extractAtPath(cleanedData, config.source_path);
		for (const cleanedItem of cleanedItems) {
			if (cleanedItem && typeof cleanedItem === "object") {
				for (const field of fieldsToStrip) {
					if (field in cleanedItem) {
						delete cleanedItem[field];
					}
				}
			}
		}
	}

	if (totalClassifications > 0) {
		logger.info(
			{ watcherId, windowId, totalClassifications, invalidCitations },
			"[ClassifierExtraction] Created LLM-based classifications",
		);
	}

	if (invalidCitations > 0) {
		logger.warn(
			{ watcherId, windowId, invalidCitations },
			"[ClassifierExtraction] Some citations referenced invalid content IDs",
		);
	}

	return cleanedData;
}

/**
 * Process watcher classifications: create LLM-based classifications from extracted data.
 *
 * @param sql - Database client
 * @param watcherId - Watcher ID
 * @param windowId - Window ID
 * @param extractedData - Original extracted data (with internal fields like cited_content_ids)
 * @param classifiers - Array of classifiers with extraction_config
 * @param validContentIds - Set of content IDs that are valid for this window (for citation validation)
 */
export async function processWatcherClassifications(
	sql: DbClient,
	watcherId: number,
	windowId: number,
	extractedData: any,
	classifiers: ClassifierRow[],
	validContentIds: Set<number>,
	env: Env,
): Promise<void> {
	if (classifiers.length === 0) return;

	try {
		// Update classifier attribute_values with new values and embeddings
		await updateClassifierValues(sql, watcherId, extractedData, env);

		// Create LLM-based classifications from extracted_data
		await processExtractedClassifications(
			sql,
			watcherId,
			windowId,
			extractedData,
			classifiers,
			validContentIds,
		);
	} catch (error) {
		// Log and re-throw - embeddings are required
		logger.error(
			{ error, watcher_id: watcherId, window_id: windowId },
			"[ClassifierExtraction] Error processing classifications for window",
		);
		throw error;
	}
}

/**
 * Collect all fields that should be stripped from extracted data based on classifier configs.
 * This includes explicit strip_fields and citation config fields from each classifier.
 *
 * @param classifiers - Array of classifiers with extraction_config
 * @returns Set of field names to strip
 */
export function getFieldsToStrip(
	classifiers: Array<{ extraction_config: any }>,
): Set<string> {
	const fieldsToStrip = new Set<string>();

	for (const classifier of classifiers) {
		const config = classifier.extraction_config;
		if (!config) continue;

		// Explicit strip_fields array
		if (config.strip_fields && Array.isArray(config.strip_fields)) {
			for (const field of config.strip_fields) {
				fieldsToStrip.add(field);
			}
		}

		if (config.citation_config) {
			for (const field of getCitationFieldsToStrip(config.citation_config)) {
				fieldsToStrip.add(field);
			}
		}
	}

	return fieldsToStrip;
}

/**
 * Strip specified fields from extracted data recursively.
 * Fields to strip should be configured in extraction_config.strip_fields.
 *
 * @param extractedData - The data to clean
 * @param fieldsToStrip - Array of field names to remove (e.g., ["citations"])
 */
export function stripFields(extractedData: any, fieldsToStrip: string[]): any {
	if (
		!extractedData ||
		typeof extractedData !== "object" ||
		fieldsToStrip.length === 0
	) {
		return extractedData;
	}

	const cleanedData = structuredClone(extractedData);

	function stripRecursive(obj: any): void {
		if (Array.isArray(obj)) {
			for (const item of obj) {
				stripRecursive(item);
			}
		} else if (obj && typeof obj === "object") {
			// Delete any field in the strip list
			for (const field of fieldsToStrip) {
				if (field in obj) {
					delete obj[field];
				}
			}
			// Recurse into nested objects/arrays
			for (const value of Object.values(obj)) {
				stripRecursive(value);
			}
		}
	}

	stripRecursive(cleanedData);
	return cleanedData;
}
