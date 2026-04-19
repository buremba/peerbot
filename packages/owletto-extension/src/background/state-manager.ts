/**
 * State Manager
 * Handles chrome.storage operations and state persistence
 */

export interface ExtensionState {
  // Auth
  sessionToken?: string; // better-auth session token for API calls
  userId?: string;

  // Worker registration
  workerId?: string;

  // Config cache
  extractorConfigs?: Record<string, ExtractorDefinition>;
  configLastFetched?: number;

  // Activity log
  activityLog?: ActivityLogEntry[];
}

export interface ExtractorDefinition {
  platform: string;
  version: number;
  enabled: boolean;
  url_patterns: string[];
  selectors: {
    container: string;
    fields: Record<string, SelectorDef>;
    pagination: PaginationConfig;
  };
  rate_limits: {
    requests_per_minute: number;
    delay_between_pages_ms: number;
  };
  validation: {
    min_items_expected: number;
    required_fields: string[];
    date_range: { min: string; max: string };
  };
}

export interface SelectorDef {
  selector: string;
  attribute?: string;
  regex?: string;
  transform?: 'text' | 'html' | 'number' | 'date';
}

export interface PaginationConfig {
  type: 'url_param' | 'cursor' | 'infinite_scroll';
  next_button?: string;
  page_param?: string;
  scroll_container?: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  type: 'sync_started' | 'sync_completed' | 'sync_failed' | 'auth' | 'permission';
  platform?: string;
  message: string;
  details?: Record<string, unknown>;
}

export class StateManager {
  private cache: Partial<ExtensionState> = {};

  /**
   * Get a value from storage
   */
  async get<K extends keyof ExtensionState>(key: K): Promise<ExtensionState[K] | undefined> {
    // Check cache first
    if (this.cache[key] !== undefined) {
      return this.cache[key] as ExtensionState[K];
    }

    const result = await chrome.storage.local.get(key);
    const value = result[key] as ExtensionState[K];

    // Update cache
    if (value !== undefined) {
      this.cache[key] = value;
    }

    return value;
  }

  /**
   * Set a value in storage
   */
  async set<K extends keyof ExtensionState>(key: K, value: ExtensionState[K]): Promise<void> {
    this.cache[key] = value;
    await chrome.storage.local.set({ [key]: value });
  }

  /**
   * Remove a value from storage
   */
  async remove<K extends keyof ExtensionState>(key: K): Promise<void> {
    delete this.cache[key];
    await chrome.storage.local.remove(key);
  }

  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    this.cache = {};
    await chrome.storage.local.clear();
  }

  /**
   * Add an entry to the activity log
   */
  async addActivityLog(entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const log = (await this.get('activityLog')) || [];

    const newEntry: ActivityLogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    // Keep last 100 entries
    const updatedLog = [newEntry, ...log].slice(0, 100);
    await this.set('activityLog', updatedLog);
  }

  /**
   * Get cached extractor config for a platform
   */
  async getExtractorConfig(platform: string): Promise<ExtractorDefinition | undefined> {
    const configs = await this.get('extractorConfigs');
    return configs?.[platform];
  }

  /**
   * Update cached extractor configs
   */
  async setExtractorConfigs(configs: ExtractorDefinition[]): Promise<void> {
    const configMap: Record<string, ExtractorDefinition> = {};
    for (const config of configs) {
      configMap[config.platform] = config;
    }
    await this.set('extractorConfigs', configMap);
    await this.set('configLastFetched', Date.now());
  }
}
