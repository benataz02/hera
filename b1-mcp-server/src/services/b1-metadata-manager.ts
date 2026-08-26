/**
 * B1 Metadata Manager
 *
 * Fetches XML from SAP B1 Service Layer
 * Maintains per-company caches
 *
 * Two-phase loading:
 *   Phase 1 (Fast)  — initialize(): entity list only
 *   Phase 2 (Lazy)  — getEntitySchema(): full schema per entity, on demand
 */

import { B1ServiceLayer } from './b1-service-layer.js';
import { B1MetadataParser } from './b1-metadata-parser.js';
import { Logger } from '../loggers/app-logger.js';
import {
    DiscoveredEntitySet,
    EdmEntitySet,
    EdmEnumType,
    EdmComplexType,
    EdmEntityType,
    EdmProperty,
    EdmPropTypeCategory,
    B1CacheStats,
    B1PersonalFieldSetup
} from '../types/b1-types.js';
import { config } from '../utils/config.js';

export class B1MetadataManager {
    private readonly parser = new B1MetadataParser();
    private readonly metadataCacheTtlMs = config.get<number>('metadata.cacheTtlMinutes') * 60 * 1000;

    // Caches
    private entityListCache: DiscoveredEntitySet[] = [];
    private entityListCacheLoadedAt = 0;
    private readonly entitySetSchemaCache = new Map<string, EdmEntitySet>();
    private readonly entitySetSchemaCacheLoadedAt = new Map<string, number>();
    private readonly complexTypeCacheByEntitySet = new Map<string, Map<string, EdmComplexType>>();
    private readonly enumTypeCache = new Map<string, EdmEnumType>();
    private readonly personalFieldCache = new Map<string, B1PersonalFieldSetup>();
    private readonly personalFieldTablesLoaded = new Set<string>();
    private personalFieldCacheHealthy = true;
    private personalFieldCacheError?: string;

    // Cache statistics
    private cacheHits = 0;
    private cacheMisses = 0;

    constructor(
        private readonly b1Client: B1ServiceLayer,
        private readonly logger: Logger
    ) { }

    /**
     * Phase 1: Initialize with lightweight entity list
     * Fetches: $metadata?scope=entityset&annotation=labelWithTable
     */
    async initialize(): Promise<boolean> {
        if (this.entityListCache.length > 0 && !this.isExpired(this.entityListCacheLoadedAt, this.metadataCacheTtlMs)) {
            return false;
        }

        const startTime = Date.now();
        this.logger.info('B1MetadataManager: Starting Phase 1 initialization...');

        // Metadata list refresh invalidates entity/schema/type caches derived from prior snapshots.
        this.entitySetSchemaCache.clear();
        this.entitySetSchemaCacheLoadedAt.clear();
        this.complexTypeCacheByEntitySet.clear();

        const xml = await this.b1Client.fetchMetadata({
            scope: 'entityset',
            annotation: 'labelWithTable'
        });

        this.entityListCache = this.parser.parseEntityList(xml);
        this.entityListCacheLoadedAt = Date.now();

        this.logger.info(
            `B1MetadataManager: Phase 1 complete - ${this.entityListCache.length} entities discovered in ${Date.now() - startTime}ms`
        );

        return true;
    }

    isPersonalFieldCacheHealthy(): boolean {
        return this.personalFieldCacheHealthy;
    }

    getPersonalFieldCacheError(): string | undefined {
        return this.personalFieldCacheError;
    }

    getPersonalFieldCacheSize(): number {
        return this.personalFieldCache.size;
    }

    /** Return the lightweight entity list built in Phase 1 */
    getEntityList(): DiscoveredEntitySet[] {
        return this.entityListCache;
    }

    /**
     * Phase 2: Lazy-load the full schema for a single entity
     * Fetches: $metadata?scope=entityset&annotation=labelWithField,labelWithTable&entityset={name}&dependency=true
     */
    async getEntitySchema(entityName: string): Promise<EdmEntityType> {
        const metadataRefreshed = await this.initialize();

        const cachedSchema = this.entitySetSchemaCache.get(entityName);
        const schemaLoadedAt = this.entitySetSchemaCacheLoadedAt.get(entityName) ?? 0;
        if (cachedSchema && !this.isExpired(schemaLoadedAt, this.metadataCacheTtlMs)) {
            this.cacheHits++;
            this.logger.debug(`B1MetadataManager: Cache hit for ${entityName}`);
            const entityType = cachedSchema.entityType;
            if (!entityType) {
                throw new Error(`Cached EntitySet '${entityName}' has no resolved EntityType`);
            }
            return entityType;
        }

        if (cachedSchema) {
            this.entitySetSchemaCache.delete(entityName);
            this.entitySetSchemaCacheLoadedAt.delete(entityName);
            this.complexTypeCacheByEntitySet.delete(entityName);
        }

        this.cacheMisses++;
        const startTime = Date.now();
        this.logger.debug(`B1MetadataManager: Lazy-loading schema for ${entityName}...`);

        try {
            const xml = await this.b1Client.fetchMetadata({
                scope: 'entityset',
                annotation: 'labelWithField,labelWithTable',
                entityset: entityName,
                dependency: true
            });

            // Parse in dependency order: enums → complex types → entity
            // Merge results into persistent caches (additive — multiple entities share types)
            const newEnums = this.parser.parseEnumTypes(xml);
            for (const [k, v] of newEnums) this.enumTypeCache.set(k, v);

            const entityScopedComplexTypes = this.parser.parseComplexTypes(xml, this.enumTypeCache);
            this.complexTypeCacheByEntitySet.set(entityName, entityScopedComplexTypes);

            const entitySet = this.parser.parseEntitySet(
                xml,
                entityName,
                entityScopedComplexTypes,
                this.enumTypeCache
            );

            const entityType = entitySet.entityType;
            if (!entityType) {
                throw new Error(`EntityType not resolved for EntitySet '${entityName}'`);
            }

            await this.applyPersonalFieldFlags(entitySet, metadataRefreshed || Boolean(cachedSchema));
            this.entitySetSchemaCache.set(entityName, entitySet);
            this.entitySetSchemaCacheLoadedAt.set(entityName, Date.now());

            this.logger.info(
                `B1MetadataManager: Schema loaded for ${entityName} (${entityType.properties.size} properties) in ${Date.now() - startTime}ms`
            );

            return entityType;

        } catch (error) {
            this.logger.error(`B1MetadataManager: Failed to load schema for ${entityName}:`, error);
            throw error;
        }
    }

    /**
     * Get properties of a named ComplexType (for collection expansion, Step 2.2)
     * Returns null if the parent entity schema has not been loaded
     */
    getComplexTypeProperties(entitySetName: string, typeName: string): EdmProperty[] | null {
        const typeMap = this.complexTypeCacheByEntitySet.get(entitySetName);
        if (!typeMap) return null;

        const ct = typeMap.get(typeName);
        if (!ct) return null;
        return Array.from(ct.properties.values());
    }

    private async ensurePersonalFieldsByTable(tableName: string, forceRefresh = false): Promise<void> {
        const normalizedTable = tableName.trim().toUpperCase();
        if (!normalizedTable || (!forceRefresh && this.personalFieldTablesLoaded.has(normalizedTable))) {
            return;
        }

        try {
            const personalFields = await this.b1Client.fetchPersonalFieldsByTable(normalizedTable);
            this.removePersonalFieldRowsForTable(normalizedTable);
            for (const row of personalFields) {
                this.personalFieldCache.set(
                    this.buildPersonalFieldKey(row.tableName, row.fieldName),
                    row
                );
            }

            this.personalFieldTablesLoaded.add(normalizedTable);
            this.personalFieldCacheHealthy = true;
            this.personalFieldCacheError = undefined;

            this.logger.debug(
                `B1MetadataManager: Personal fields loaded for table ${normalizedTable} (${personalFields.length} rows)`
            );
        } catch (error) {
            this.personalFieldCacheHealthy = false;
            this.personalFieldCacheError = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `B1MetadataManager: Failed to load PersonalFieldsSetups for table ${normalizedTable}.`,
                error
            );

            if (config.isProduction()) {
                throw new Error(
                    `B1MetadataManager: Failed to load PersonalFieldsSetups for table ${normalizedTable} in fail-closed mode: ${this.personalFieldCacheError}`
                );
            }
        }
    }

    /**
     * Applies `isPersonalField` markers to both top-level entity properties and
     * nested complex-type properties.
     *
     * Table resolution rules:
     * - Top-level scalar/enum properties are matched against the entity table.
     * - Complex properties switch table context to `childTableName` when present.
     * - Nested complex properties inherit the current table context unless they
     *   define their own `childTableName`.
     *
     * A visited set guards recursive complex-type graphs from infinite traversal.
     */
    private async applyPersonalFieldFlags(entitySet: EdmEntitySet, forceTableRefresh = false): Promise<void> {
        const entityType = entitySet.entityType;
        if (!entityType) return;
        const rootTable = entitySet.table;
        if (!rootTable) return;

        const tablesToLoad = new Set<string>();
        const visitedForTableCollection = new Set<string>();
        const collectComplexTypeTables = (type: EdmComplexType, tableName: string): void => {
            const visitKey = `${type.name}::${tableName.trim().toUpperCase()}`;
            if (visitedForTableCollection.has(visitKey)) return;
            visitedForTableCollection.add(visitKey);

            for (const prop of type.properties.values()) {
                if (prop.type.category !== EdmPropTypeCategory.COMPLEX) continue;
                const nestedTable = prop.childTableName || tableName;
                tablesToLoad.add(nestedTable);
                collectComplexTypeTables(prop.type as EdmComplexType, nestedTable);
            }
        };

        tablesToLoad.add(rootTable);
        for (const prop of entityType.properties.values()) {
            if (prop.type.category !== EdmPropTypeCategory.COMPLEX || !prop.childTableName) continue;
            tablesToLoad.add(prop.childTableName);
            collectComplexTypeTables(prop.type as EdmComplexType, prop.childTableName);
        }

        for (const tableName of tablesToLoad) {
            await this.ensurePersonalFieldsByTable(tableName, forceTableRefresh);
        }

        const markByTable = (prop: EdmProperty, tableName: string): void => {
            const fieldName = prop.alias || prop.name;
            prop.isPersonalField = this.personalFieldCache.has(
                this.buildPersonalFieldKey(tableName, fieldName)
            ) || undefined;
        };

        const visited = new Set<string>();
        const markComplexTypeProperties = (type: EdmComplexType, tableName: string): void => {
            const visitKey = `${type.name}::${tableName.trim().toUpperCase()}`;
            if (visited.has(visitKey)) return;
            visited.add(visitKey);

            for (const prop of type.properties.values()) {
                if (prop.type.category === EdmPropTypeCategory.COMPLEX) {
                    const nestedTable = prop.childTableName || tableName;
                    markComplexTypeProperties(prop.type as EdmComplexType, nestedTable);
                    continue;
                }
                markByTable(prop, tableName);
            }
        };

        for (const prop of entityType.properties.values()) {
            if (prop.type.category === EdmPropTypeCategory.COMPLEX) {
                const childTable = prop.childTableName;
                if (!childTable) continue;
                markComplexTypeProperties(prop.type as EdmComplexType, childTable);
                continue;
            }
            markByTable(prop, rootTable);
        }
    }

    private buildPersonalFieldKey(tableName: string, fieldName: string): string {
        return `${tableName.trim().toUpperCase()}::${fieldName.trim().toUpperCase()}`;
    }

    private removePersonalFieldRowsForTable(tableName: string): void {
        const tablePrefix = `${tableName}::`;
        for (const key of this.personalFieldCache.keys()) {
            if (key.startsWith(tablePrefix)) {
                this.personalFieldCache.delete(key);
            }
        }
    }

    private isExpired(loadedAt: number, ttlMs: number): boolean {
        if (ttlMs <= 0) return true;
        if (loadedAt <= 0) return true;
        return (Date.now() - loadedAt) > ttlMs;
    }

    /** Return cache statistics for monitoring */
    getCacheStats(): B1CacheStats {
        const complexTypeCacheSize = Array.from(this.complexTypeCacheByEntitySet.values())
            .reduce((total, map) => total + map.size, 0);

        return {
            entityListCount: this.entityListCache.length,
            entitySchemaCacheSize: this.entitySetSchemaCache.size,
            complexTypeCacheSize,
            enumTypeCacheSize: this.enumTypeCache.size,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses
        };
    }
}
