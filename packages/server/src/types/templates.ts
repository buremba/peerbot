/**
 * Shared Template Types
 *
 * Types for component reference documentation.
 */

export interface ComponentReferenceDocumentation {
  overview: string;
  data_types: Array<{
    type: string;
    description: string;
    required_fields: string[];
    optional_fields?: string[];
    example: unknown;
  }>;
  available_components: Array<{
    name: string;
    category: string;
    description: string;
    props?: Record<string, string>;
    example: unknown;
  }>;
  template_variables: Array<{
    variable: string;
    description: string;
  }>;
  security_restrictions: string[];
  complete_examples: Array<{
    name: string;
    description: string;
    prompt?: string;
    extraction_schema?: unknown;
    data?: Record<string, { query: string }>;
    json_template?: unknown;
  }>;
}
