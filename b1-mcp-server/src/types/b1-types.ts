/**
 * SAP Business One Service Layer Type Definitions
 * 
 * These types represent the B1 Service Layer OData metadata structures,
 * optimized for efficient parsing and lazy-loading.
 */

/** Entity classification derived from table identifier prefix:
 *  - 'udt': name starts with U_ AND table identifier starts with @
 *  - 'udo': name does NOT start with U_ AND table identifier starts with @
 *  - 'standard': everything else
 */
export type B1EntityClass = 'standard' | 'udt' | 'udo';

/** Parsed metadata for an OData service. */
export interface ServiceMetadata {
    entities: DiscoveredEntitySet[];
    version: string;
    namespace: string;
}

/** Descriptor for a discovered OData service endpoint. */
export interface ODataService {
    id: string;
    version: string;
    title: string;
    description: string;
    odataVersion: 'v4';
    url: string;
    metadataUrl: string;
    metadata: ServiceMetadata | null;
}

/**
 * EDM Primitive Type categories
 */
export enum EdmPropTypeCategory {
    PRIMITIVE = 0,
    ENUM = 1,
    COMPLEX = 2,
    NAVIGATION = 3
}

/**
 * Base EDM Property Type
 */
export interface EdmPropTypeBase {
    name: string;
    category: EdmPropTypeCategory;
    isArray: boolean;
}

/**
 * EDM Primitive Type (e.g., Edm.String, Edm.Int32)
 */
export interface EdmPrimitiveType extends EdmPropTypeBase {
    category: EdmPropTypeCategory.PRIMITIVE;
}

/**
 * EDM Enum Type
 * Represents B1 enumerations with bidirectional name↔code mapping
 */
export interface EdmEnumType extends EdmPropTypeBase {
    category: EdmPropTypeCategory.ENUM;
    /** Map from member name to code value */
    members: Map<string, string>;
    /** Map from code value to member name */
    codes: Map<string, string>;
}

/**
 * EDM Complex Type
 * Represents nested objects with their own properties
 */
export interface EdmComplexType extends EdmPropTypeBase {
    /** Type namespace (e.g., "SAPB1") */
    namespace: string;
    category: EdmPropTypeCategory.COMPLEX;
    /** Properties of this complex type */
    properties: Map<string, EdmProperty>;
}

/**
 * EDM Property
 * Represents a single property within an EntityType or ComplexType
 */
export interface EdmProperty {
    /** Property name */
    name: string;
    /** Property type (primitive, enum, or complex) */
    type: EdmPrimitiveType | EdmEnumType | EdmComplexType;
    /** Maximum length for string types */
    maxLength?: number;
    /** Whether this is an array/collection */
    isArray?: boolean;
    /** Field alias from SAPB1.ColumnName (e.g., "DocEntry") */
    alias?: string;
    /** Field description from Common.Label */
    description?: string;
    /** Child table name from SAPB1.ChildTableName (typically for complex type properties) */
    childTableName?: string;
    /** Whether this is a User-Defined Field */
    isUDF?: boolean;
    /** Whether this field is marked as personal data in PersonalFieldsSetups */
    isPersonalField?: boolean;
}

/**
 * A single personal field setup row from SAP B1 Service Layer
 */
export interface B1PersonalFieldSetup {
    tableName: string;
    fieldName: string;
    dataClassification: string;
    category?: string;
    abstractTable: string;
}

/**
 * OData collection response shape for PersonalFieldsSetups
 */
export interface B1PersonalFieldsResponse {
    value?: Array<{
        TableName?: string;
        FieldName?: string;
        DataClassification?: string;
        Category?: string;
    }>;
    '@odata.nextLink'?: string;
}

/**
 * EDM Entity Type (extends Complex Type)
 * Represents a full entity with keys.
 */
export interface EdmEntityType extends EdmComplexType {
    /** Key property names */
    keys: string[];
    /** Entity classification derived from the resolved table identifier prefix */
    entityClass?: B1EntityClass;
}

/**
 * EDM EntitySet
 *
 * Strict-spec shape keeps the EntityType reference by name; runtime code may
 * optionally attach the resolved EdmEntityType object.
 */
export interface EdmEntitySet {
    /** EntitySet name (e.g., "Orders") */
    name: string;
    /** Fully qualified EntityType name from metadata (e.g., "SAPB1.Document") */
    entityTypeName: string;
    /** Resolved EntityType object (present when schema is loaded) */
    entityType?: EdmEntityType;
    /** SAP table name */
    table: string;
    /** Human-readable description */
    description: string;
}

/**
 * Lightweight entity list item returned by initial discovery
 * Fetched from: $metadata?scope=entityset&annotation=labelWithTable
 */
export interface DiscoveredEntitySet {
    /** EntitySet name (e.g., "Orders") */
    name: string;
    /** Fully qualified EntityType name from metadata (e.g., "SAPB1.Document") */
    entityTypeName: string;
    /** SAP table name */
    table: string;
    /** Human-readable description */
    description: string;
    /** Entity classification derived from table identifier prefix */
    entityClass?: B1EntityClass;
}

/**
 * Metadata fetch parameters for B1 Service Layer
 */
export interface B1MetadataParams {
    /** Scope of metadata (typically 'entityset') */
    scope?: string;
    /** Annotations to include (e.g., 'labelWithTable,labelWithField') */
    annotation?: string;
    /** Specific entity set to fetch */
    entityset?: string;
    /** Include dependent types (ComplexTypes, Enums) */
    dependency?: boolean;
}

/**
 * Cache statistics for monitoring
 */
export interface B1CacheStats {
    entityListCount: number;
    entitySchemaCacheSize: number;
    complexTypeCacheSize: number;
    enumTypeCacheSize: number;
    cacheHits: number;
    cacheMisses: number;
}

