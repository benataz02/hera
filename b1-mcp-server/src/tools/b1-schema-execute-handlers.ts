/**
 * Schema and execute handlers — Steps 2 & 3 of the 3-step progressive discovery flow
 */

import { B1Client } from '../services/b1-client.js';
import { B1DiscoveryService } from '../services/b1-discovery.js';
import { Logger } from '../loggers/app-logger.js';
import { AuditLogger, type AuditSubCategory } from '../loggers/audit-logger.js';
import { config } from '../utils/config.js';
import { getRequestContext } from '../utils/request-context.js';
import { EdmPropTypeCategory, type EdmComplexType, type EdmEntityType, type EdmProperty } from '../types/b1-types.js';
import {
    McpToolRequestContext,
    requireSensitiveReadConfirmation,
    requireWriteConfirmation
} from './b1-elicitation.js';

export interface EntityOperationContext {
    sapClient: B1Client;
    logger: Logger;
    discoveryService: B1DiscoveryService;
    /** Company DB for OAuth mode; undefined in direct mode */
    companyId?: string;
    sourceIp?: string;
    mcpRequestContext?: McpToolRequestContext;
}

type WriteOperation = 'create' | 'update' | 'delete';
type ScalarProp = { name: string; type: string; maxLength?: string; isUDF?: boolean; isPersonalField?: boolean; isEnum?: boolean };
type StructuralProp = { name: string; complexTypeName: string; isArray: boolean; description?: string };
type StructuralTypeReference = StructuralProp & {
    path: string;
    parentPath?: string;
    parentStructuralTypeName?: string;
    depth: number;
};
type EnumMember = { name: string; code: string };
type EnumTypeMetadata = { members: EnumMember[] };

type ComplexTypePropertyResolver = {
    getComplexTypeProperties(entitySetName: string, typeName: string): EdmProperty[] | null;
};

const auditLogger = new AuditLogger('b1-schema-execute');

function isWriteOperation(operation: string | undefined): operation is WriteOperation {
    return operation === 'create' || operation === 'update' || operation === 'delete';
}

function resolveWriteSubCategory(operation: WriteOperation): AuditSubCategory {
    switch (operation) {
        case 'create':
            return 'Create';
        case 'update':
            return 'Update';
        case 'delete':
            return 'Delete';
    }
}

function resolveWriteSuccessEvent(operation: WriteOperation): string {
    switch (operation) {
        case 'create':
            return 'EntityCreated';
        case 'update':
            return 'EntityUpdated';
        case 'delete':
            return 'EntityDeleted';
    }
}

function resolveWriteFailureEvent(operation: WriteOperation): string {
    switch (operation) {
        case 'create':
            return 'EntityCreateFailed';
        case 'update':
            return 'EntityUpdateFailed';
        case 'delete':
            return 'EntityDeleteFailed';
    }
}

function summarizeFieldNames(
    parameters: Record<string, unknown>,
    excludedFields: readonly string[] = []
): string[] | undefined {
    const excludedFieldNames = new Set(excludedFields);
    const fieldNames = Object.keys(parameters)
        .filter((fieldName) => !excludedFieldNames.has(fieldName))
        .sort();

    return fieldNames.length > 0 ? fieldNames : undefined;
}

function summarizePersonalFieldNames(
    entityType: EdmEntityType,
    includedFieldNames: readonly string[]
): string[] | undefined {
    const includedFieldNameSet = new Set(includedFieldNames.map((fieldName) => fieldName.toLowerCase()));
    const personalFieldNames = Array.from(entityType.properties.values())
        .filter((property) => property.isPersonalField && includedFieldNameSet.has(property.name.toLowerCase()))
        .map((property) => property.name)
        .sort();

    return personalFieldNames.length > 0 ? personalFieldNames : undefined;
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== undefined)
    );
}

function toStructuralProp(prop: EdmProperty): StructuralProp | null {
    if (prop.type.category !== EdmPropTypeCategory.COMPLEX) {
        return null;
    }

    return {
        name: prop.name,
        complexTypeName: prop.type.name,
        isArray: !!prop.isArray,
        description: prop.description
    };
}

function collectStructuralProperties(properties: Iterable<EdmProperty>): StructuralProp[] {
    const structuralProperties: StructuralProp[] = [];

    for (const prop of properties) {
        const structuralProp = toStructuralProp(prop);
        if (structuralProp) {
            structuralProperties.push(structuralProp);
        }
    }

    return structuralProperties;
}

function collectEnumTypes(properties: Iterable<EdmProperty>): Record<string, EnumTypeMetadata> | undefined {
    const enumTypes = new Map<string, EnumTypeMetadata>();

    for (const prop of properties) {
        if (prop.type.category !== EdmPropTypeCategory.ENUM) {
            continue;
        }

        if (enumTypes.has(prop.type.name)) {
            continue;
        }

        enumTypes.set(prop.type.name, {
            members: Array.from(prop.type.members.entries())
                .map(([name, code]) => ({ name, code }))
                .sort((left, right) => left.name.localeCompare(right.name))
        });
    }

    return enumTypes.size > 0 ? Object.fromEntries(enumTypes) : undefined;
}

function resolveStructuralTypeReferences(options: {
    entitySetName: string;
    targetTypeName: string;
    rootStructuralProperties: StructuralProp[];
    typeResolver: ComplexTypePropertyResolver;
}): { references: StructuralTypeReference[]; availableStructuralTypes: string[] } {
    const references: StructuralTypeReference[] = [];
    const availableStructuralTypes = new Set<string>();

    const walk = (
        structuralProperties: StructuralProp[],
        pathPrefix: string,
        parentStructuralTypeName: string | undefined,
        ancestry: string[]
    ): void => {
        for (const structuralProp of structuralProperties) {
            availableStructuralTypes.add(structuralProp.complexTypeName);

            const path = pathPrefix ? `${pathPrefix}.${structuralProp.name}` : structuralProp.name;
            if (structuralProp.complexTypeName === options.targetTypeName) {
                references.push({
                    ...structuralProp,
                    path,
                    parentPath: pathPrefix || undefined,
                    parentStructuralTypeName,
                    depth: ancestry.length + 1
                });
            }

            if (ancestry.includes(structuralProp.complexTypeName)) {
                continue;
            }

            const nestedProperties = options.typeResolver.getComplexTypeProperties(
                options.entitySetName,
                structuralProp.complexTypeName
            );
            if (!nestedProperties) {
                continue;
            }

            const nestedStructuralProperties = collectStructuralProperties(nestedProperties);
            if (nestedStructuralProperties.length === 0) {
                continue;
            }

            walk(
                nestedStructuralProperties,
                path,
                structuralProp.complexTypeName,
                [...ancestry, structuralProp.complexTypeName]
            );
        }
    };

    walk(options.rootStructuralProperties, '', undefined, []);

    return {
        references,
        availableStructuralTypes: Array.from(availableStructuralTypes).sort()
    };
}

function recordWriteAudit(options: {
    operation: WriteOperation;
    entitySet?: string;
    companyId?: string;
    sourceIp?: string;
    userName?: string;
    keyValue?: string | number;
    fieldNames?: string[];
    outcome: 'success' | 'failure';
    errorMessage?: string;
    usedAuthenticatedContext: boolean;
}): void {
    const entityTarget = options.entitySet || 'unknown-entity-set';
    const event = options.outcome === 'success'
        ? resolveWriteSuccessEvent(options.operation)
        : resolveWriteFailureEvent(options.operation);
    const message = options.outcome === 'success'
        ? `${options.operation} ${entityTarget} completed`
        : `${options.operation} ${entityTarget} failed`;

    auditLogger.record({
        event,
        category: 'DataModification',
        subCategory: resolveWriteSubCategory(options.operation),
        outcome: options.outcome,
        userName: options.userName,
        companyId: options.companyId,
        sourceIp: options.sourceIp,
        message,
        details: compactDetails({
            entitySet: options.entitySet,
            keyValue: options.keyValue,
            fieldNames: options.fieldNames,
            usedAuthenticatedContext: options.usedAuthenticatedContext,
            reason: options.errorMessage
        })
    });
}

function recordWriteConfirmationAudit(options: {
    operation: WriteOperation;
    entitySet?: string;
    companyId?: string;
    sourceIp?: string;
    userName?: string;
    keyValue?: string | number;
    fieldNames?: string[];
    usedAuthenticatedContext: boolean;
}): void {
    const entityTarget = options.entitySet || 'unknown-entity-set';

    auditLogger.record({
        event: 'WriteConfirmationApproved',
        category: 'DataModification',
        subCategory: resolveWriteSubCategory(options.operation),
        outcome: 'info',
        userName: options.userName,
        companyId: options.companyId,
        sourceIp: options.sourceIp,
        message: `${options.operation} ${entityTarget} confirmation approved`,
        details: compactDetails({
            entitySet: options.entitySet,
            keyValue: options.keyValue,
            fieldNames: options.fieldNames,
            usedAuthenticatedContext: options.usedAuthenticatedContext,
            confirmationType: 'mcp-elicitation'
        })
    });
}

function recordSensitiveReadConfirmationAudit(options: {
    entitySet?: string;
    companyId?: string;
    sourceIp?: string;
    userName?: string;
    selectString: string;
    selectedPersonalFields: string[];
    usedAuthenticatedContext: boolean;
}): void {
    const entityTarget = options.entitySet || 'unknown-entity-set';

    auditLogger.record({
        event: 'SensitiveReadConfirmationApproved',
        category: 'Authorization',
        subCategory: 'Context',
        outcome: 'info',
        userName: options.userName,
        companyId: options.companyId,
        sourceIp: options.sourceIp,
        message: `sensitive read ${entityTarget} confirmation approved`,
        details: compactDetails({
            entitySet: options.entitySet,
            selectString: options.selectString,
            selectedPersonalFields: options.selectedPersonalFields,
            usedAuthenticatedContext: options.usedAuthenticatedContext,
            confirmationType: 'mcp-elicitation'
        })
    });
}

// ---------------------------------------------------------------------------
// Step 2: Get full entity metadata
// ---------------------------------------------------------------------------

export async function getEntityMetadata(
    args: Record<string, unknown>,
    ctx: EntityOperationContext
) {
    try {
        const effectiveCompanyId = ctx.companyId ?? ctx.sapClient.getCompanyId();

        if (config.isOAuthMode()) {
            if (!effectiveCompanyId) {
                ctx.logger.debug('Metadata retrieval in OAuth mode without company selected - using default context');
            }
        }

        const entityName = args.entityName as string;
        const structuralTypeName = args.structuralTypeName as string | undefined;

        if (!entityName) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: entityName is required.\n\nUsage: Call b1_find_entities first, then use the entityName from those results.`
                }],
                isError: true
            };
        }

        const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
            effectiveCompanyId,
            ctx.sapClient.getB1Client()
        );
        const service = discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
        if (!service) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: SAP B1 Service Layer not initialized.`
                }],
                isError: true
            };
        }

        const b1Manager = ctx.discoveryService?.getB1MetadataManager(effectiveCompanyId);
        if (!b1Manager) {
            return {
                content: [{
                    type: "text" as const,
                    text: "ERROR: B1MetadataManager not available."
                }],
                isError: true
            };
        }

        const availableEntityNames = b1Manager.getEntityList().map(e => e.name);
        const resolvedEntityName = availableEntityNames.find(name => name === entityName);
        if (!resolvedEntityName) {
            const availableEntities = availableEntityNames.join(', ') || 'none';
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Entity '${entityName}' not found.\n\nAvailable entities: ${availableEntities}`
                }],
                isError: true
            };
        }

        let b1EntityType: EdmEntityType;
        try {
            b1EntityType = await b1Manager.getEntitySchema(resolvedEntityName);
        } catch (error) {
            ctx.logger.error(`B1 schema load failed for ${resolvedEntityName}:`, error);
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Failed to load B1 entity schema for '${resolvedEntityName}': ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }

        // Resolve scalar and structural (complex) properties
        const structuralProperties = collectStructuralProperties(b1EntityType.properties.values());

        // Step 2.2: structural type schema requested
        if (structuralTypeName) {
            const { references: structuralEntries, availableStructuralTypes } = resolveStructuralTypeReferences({
                entitySetName: resolvedEntityName,
                targetTypeName: structuralTypeName,
                rootStructuralProperties: structuralProperties,
                typeResolver: b1Manager
            });
            if (structuralEntries.length === 0) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `ERROR: Structural type '${structuralTypeName}' not found on entity '${entityName}'.\n\nAvailable structural types: ${availableStructuralTypes.join(', ') || 'none'}`
                    }],
                    isError: true
                };
            }
            const ctProps = b1Manager.getComplexTypeProperties(resolvedEntityName, structuralTypeName);
            if (!ctProps) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `ERROR: Schema for structural type '${structuralTypeName}' is not in cache.\n\nThis should not happen — please call b1_get_entity_schema with only entityName="${resolvedEntityName}" first to load the entity schema.`
                    }],
                    isError: true
                };
            }
            const ctScalar: ScalarProp[] = [];
            const ctStructural: StructuralProp[] = [];
            for (const prop of ctProps) {
                const structuralProp = toStructuralProp(prop);
                if (structuralProp) {
                    ctStructural.push(structuralProp);
                } else {
                    ctScalar.push({
                        name: prop.name,
                        type: prop.type.name,
                        maxLength: prop.maxLength?.toString(),
                        isEnum: prop.type.category === EdmPropTypeCategory.ENUM || undefined,
                        isUDF: prop.isUDF || undefined,
                        isPersonalField: prop.isPersonalField || undefined
                    });
                }
            }
            const enumTypes = collectEnumTypes(ctProps);
            const ctMetadata = {
                parentEntity: entityName,
                structuralTypeName,
                referencingProperties: structuralEntries.map(entry => ({
                    name: entry.name,
                    path: entry.path,
                    isArray: entry.isArray,
                    description: entry.description,
                    parentPath: entry.parentPath,
                    parentStructuralTypeName: entry.parentStructuralTypeName,
                    depth: entry.depth
                })),
                propertyCount: ctScalar.length,
                properties: ctScalar,
                ...(enumTypes ? { enumTypes } : {}),
                ...(ctStructural.length > 0 ? { nestedStructuralProperties: ctStructural } : {})
            };
            let responseText = `[STEP 2 - STRUCTURAL TYPE SCHEMA] ${structuralTypeName} on ${entityName}\n\n`;
            responseText += `NEXT STEP: Use b1_read to query ${entityName}\n\n`;

            if (ctMetadata.referencingProperties.length > 0) {
                responseText += `Referenced via: ${ctMetadata.referencingProperties.map((r: { path: string }) => r.path).join(', ')}\n`;
            }
            responseText += `Total Properties: ${ctMetadata.propertyCount}\n`;

            if (ctMetadata.nestedStructuralProperties && (ctMetadata.nestedStructuralProperties as unknown[]).length > 0) {
                const nested = ctMetadata.nestedStructuralProperties as Array<{ name: string; complexTypeName: string; isArray: boolean }>;
                responseText += `\nNested Structural Properties (${nested.length}):\n`;
                for (const p of nested) {
                    responseText += `  - ${p.name}  ${p.isArray ? '[array]' : '[object]'}  type: ${p.complexTypeName}\n`;
                }
            }

            if (ctMetadata.enumTypes) {
                const ENUM_TRUNCATE_THRESHOLD = 20;
                responseText += `\nEnum Types:\n`;
                for (const [enumName, enumMeta] of Object.entries(ctMetadata.enumTypes as Record<string, { members: Array<{ name: string; code: string }> }>)) {
                    const members = enumMeta.members;
                    if (members.length <= ENUM_TRUNCATE_THRESHOLD) {
                        responseText += `  ${enumName}: ${members.map(m => `${m.name}(${m.code})`).join(', ')}\n`;
                    } else {
                        const shown = members.slice(0, ENUM_TRUNCATE_THRESHOLD);
                        responseText += `  ${enumName}: ${shown.map(m => `${m.name}(${m.code})`).join(', ')} ... (${members.length} total)\n`;
                    }
                }
            }

            // Compact property table — name and type only.
            // Full details (enum members, nesting paths) are in structuredContent.
            responseText += `\nProperties:\n`;
            const props = ctMetadata.properties as Array<{ name: string; type: string; isEnum?: boolean; isUDF?: boolean }>;
            const ctNameWidth = Math.max(...props.map(p => p.name.length), 4);
            const ctTypeWidth = Math.max(...props.map(p => p.type.length), 4);
            for (const p of props) {
                const flags: string[] = [];
                if (p.isEnum) flags.push('enum');
                if (p.isUDF) flags.push('udf');
                const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
                responseText += `  ${p.name.padEnd(ctNameWidth)}  ${p.type.padEnd(ctTypeWidth)}${flagStr}\n`;
            }

            // structuredContent carries the full machine-readable payload (all enum members,
            // all nesting paths) without the LLM needing to parse the compact text above.
            return {
                content: [{ type: "text" as const, text: responseText }],
                structuredContent: ctMetadata
            };
        }

        // Step 2.1: entity schema (default)
        const scalarProperties: ScalarProp[] = [];
        for (const prop of b1EntityType.properties.values()) {
            if (prop.type.category === EdmPropTypeCategory.COMPLEX) {
                continue;
            }

            scalarProperties.push({
                name: prop.name,
                type: prop.type.name,
                maxLength: prop.maxLength?.toString(),
                isEnum: prop.type.category === EdmPropTypeCategory.ENUM || undefined,
                isUDF: prop.isUDF || undefined,
                isPersonalField: prop.isPersonalField || undefined
            });
        }

        const enumTypes = collectEnumTypes(b1EntityType.properties.values());

        const metadata = {
            entity: {
                name: b1EntityType.name,
                entitySet: resolvedEntityName,
                namespace: b1EntityType.namespace,
                keyProperties: b1EntityType.keys,
                propertyCount: scalarProperties.length
            },
            properties: scalarProperties.map(prop => ({
                name: prop.name,
                type: prop.type,
                maxLength: prop.maxLength,
                isEnum: prop.isEnum,
                isUDF: prop.isUDF,
                isPersonalField: prop.isPersonalField,
                isKey: b1EntityType.keys.includes(prop.name) || undefined
            })),
            ...(enumTypes ? { enumTypes } : {}),
            structuralProperties
        };

        let responseText = `[STEP 2 - ENTITY METADATA] Schema for ${entityName}\n\n`;
        responseText += `NEXT STEP: Use b1_read or b1_write with entityName="${entityName}"\n\n`;
        responseText += `Key Properties: [${b1EntityType.keys.join(', ')}]\n`;
        responseText += `Total Properties: ${scalarProperties.length}\n`;

        if (structuralProperties.length > 0) {
            responseText += `\nStructural Properties (${structuralProperties.length}) — call b1_get_entity_schema with structuralTypeName to drill in:\n`;
            const spNameWidth = Math.max(...structuralProperties.map(p => p.name.length), 4);
            for (const p of structuralProperties) {
                const kind = p.isArray ? '[array]' : '[object]';
                responseText += `  - ${p.name.padEnd(spNameWidth)}  ${kind}  type: ${p.complexTypeName}\n`;
            }
        }

        if (enumTypes) {
            const ENUM_TRUNCATE_THRESHOLD = 20;
            responseText += `\nEnum Types:\n`;
            for (const [enumName, enumMeta] of Object.entries(enumTypes)) {
                const members = enumMeta.members;
                if (members.length <= ENUM_TRUNCATE_THRESHOLD) {
                    responseText += `  ${enumName}: ${members.map(m => `${m.name}(${m.code})`).join(', ')}\n`;
                } else {
                    const shown = members.slice(0, ENUM_TRUNCATE_THRESHOLD);
                    responseText += `  ${enumName}: ${shown.map(m => `${m.name}(${m.code})`).join(', ')} ... (${members.length} total)\n`;
                }
            }
        }

        // Compact property table — name, type, optional flags.
        // Full JSON (all 301+ props) is in structuredContent for code consumers.
        responseText += `\nProperties:\n`;
        const propNameWidth = Math.max(...scalarProperties.map(p => p.name.length), 4);
        const propTypeWidth = Math.max(...scalarProperties.map(p => p.type.length), 4);
        for (const p of scalarProperties) {
            const flags: string[] = [];
            if (b1EntityType.keys.includes(p.name)) flags.push('key');
            if (p.isEnum) flags.push('enum');
            if (p.isUDF) flags.push('udf');
            if (p.isPersonalField) flags.push('personal');
            const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
            responseText += `  ${p.name.padEnd(propNameWidth)}  ${p.type.padEnd(propTypeWidth)}${flagStr}\n`;
        }

        // structuredContent carries the full machine-readable payload (all properties, all
        // enum members) without the LLM needing to parse the compact text above.
        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: metadata
        };

    } catch (error) {
        ctx.logger.error('Error in Step 2 metadata retrieval:', error);
        return {
            content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
        };
    }
}

// ---------------------------------------------------------------------------
// Step 3: Execute CRUD operation
// ---------------------------------------------------------------------------

type EntityOperation = 'read' | 'read-single' | 'create' | 'update' | 'delete';

export async function executeEntityReadOperation(
    args: Record<string, unknown>,
    ctx: EntityOperationContext
) {
    return executeEntityOperation(args, ctx, ['read', 'read-single'], 'b1_read');
}

export async function executeEntityWriteOperation(
    args: Record<string, unknown>,
    ctx: EntityOperationContext
) {
    return executeEntityOperation(args, ctx, ['create', 'update', 'delete'], 'b1_write');
}

async function executeEntityOperation(
    args: Record<string, unknown>,
    ctx: EntityOperationContext,
    allowedOperations: EntityOperation[],
    toolName: string
) {
    const entityName = args.entityName as string;
    const rawOperation = (args.operation as string | undefined)?.toLowerCase();
    const parameters = args.parameters as Record<string, unknown> || {};
    const requestContext = getRequestContext();
    const requestToken = requestContext?.token;
    const effectiveCompanyId = ctx.companyId ?? ctx.sapClient.getCompanyId();
    let resolvedEntityName: string | undefined;
    let writeKeyValue: string | number | undefined;
    let writeFieldNames: string[] | undefined;
    let usedAuthenticatedContext = false;

    try {
        if (config.isOAuthMode()) {
            if (!effectiveCompanyId) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: No company selected.\n\nIn OAuth mode, you must select a company before performing data operations.\n\nPlease follow these steps:\n1. Call RetrieveCompanyList to see available companies\n2. Call SelectCompanyToLogon with your desired company\n3. Then retry this operation"
                    }]
                };
            }
        }

        const validOperationSet = new Set(allowedOperations);
        if (!rawOperation || !validOperationSet.has(rawOperation as EntityOperation)) {
            throw new Error(
                `Invalid operation for ${toolName}: ${rawOperation}. Valid operations are: ${allowedOperations.join(', ')}`
            );
        }
        const operation = rawOperation as EntityOperation;

        type ODataQueryOptions = {
            $filter?: string; $select?: string;
            $orderby?: string; $top?: number; $skip?: number;
            [key: string]: unknown;
        };
        const queryOptions: ODataQueryOptions = {};
        if (typeof args.filterString === 'string') queryOptions.$filter = args.filterString;
        if (typeof args.selectString === 'string') queryOptions.$select = args.selectString;
        if (typeof args.orderbyString === 'string') queryOptions.$orderby = args.orderbyString;
        if (typeof args.topNumber === 'number') queryOptions.$top = args.topNumber;
        if (typeof args.skipNumber === 'number') queryOptions.$skip = args.skipNumber;
        let meaningfulSelectString = getMeaningfulSelectString(queryOptions.$select);
        let meaningfulOrderbyString = getMeaningfulOrderbyString(queryOptions.$orderby);
        let selectedFields: string[] = [];

        usedAuthenticatedContext = !!requestToken;

        const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
            ctx.companyId,
            ctx.sapClient.getB1Client()
        );
        const service = discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
        if (!service) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: SAP B1 Service Layer not initialized.`
                }],
                isError: true
            };
        }

        const b1Manager = ctx.discoveryService?.getB1MetadataManager(ctx.companyId);
        if (!b1Manager) {
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: B1MetadataManager not available.`
                }],
                isError: true
            };
        }

        const availableEntityNames = b1Manager.getEntityList().map(e => e.name);
        resolvedEntityName = availableEntityNames.find(name => name === entityName);
        if (!resolvedEntityName) {
            const availableEntities = availableEntityNames.join(', ') || 'none';
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Entity '${entityName}' not found.\n\nAvailable entities: ${availableEntities}`
                }],
                isError: true
            };
        }

        let b1EntityType: EdmEntityType;
        try {
            b1EntityType = await b1Manager.getEntitySchema(resolvedEntityName);
        } catch (error) {
            ctx.logger.error(`B1 schema load failed for ${resolvedEntityName}:`, error);
            throw new Error(`Failed to load entity schema: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (operation === 'read' || operation === 'read-single') {
            if (meaningfulSelectString) {
                meaningfulSelectString = normalizeSelectStringAgainstMetadata(meaningfulSelectString, b1EntityType, resolvedEntityName);
                queryOptions.$select = meaningfulSelectString;
                selectedFields = parseSelectedFields(meaningfulSelectString);
            }

            if (meaningfulOrderbyString) {
                meaningfulOrderbyString = normalizeOrderbyStringAgainstMetadata(meaningfulOrderbyString, b1EntityType, resolvedEntityName);
                queryOptions.$orderby = meaningfulOrderbyString;
            }
        }

        let response;
        let operationDescription = "";

        if ((operation === 'read' || operation === 'read-single') && meaningfulSelectString) {
            const selectedPersonalFields = findSelectedPersonalFields(b1EntityType, selectedFields);

            if (selectedPersonalFields.length > 0) {
                await requireSensitiveReadConfirmation({
                    requestContext: ctx.mcpRequestContext,
                    entityName,
                    selectString: meaningfulSelectString,
                    selectedPersonalFields
                });
                recordSensitiveReadConfirmationAudit({
                    entitySet: resolvedEntityName,
                    companyId: effectiveCompanyId,
                    sourceIp: ctx.sourceIp,
                    userName: requestContext?.userName,
                    selectString: meaningfulSelectString,
                    selectedPersonalFields,
                    usedAuthenticatedContext
                });
            }
        }

        switch (operation) {
            case 'read':
                operationDescription = `Reading ${entityName} entities`;
                if (typeof queryOptions.$top === 'number') operationDescription += ` (top ${queryOptions.$top})`;
                if (typeof queryOptions.$filter === 'string') operationDescription += ` with filter: ${queryOptions.$filter}`;
                response = await ctx.sapClient.readEntitySet(service.url, resolvedEntityName, queryOptions, false);
                break;

            case 'read-single': {
                const keyValue = buildKeyValue(b1EntityType, parameters, ctx.logger);
                operationDescription = `Reading single ${entityName} with key: ${keyValue}`;
                const singleEntityQueryOptions = {
                    $select: queryOptions.$select
                };
                response = await ctx.sapClient.readEntity(service.url, resolvedEntityName, keyValue, false, singleEntityQueryOptions);
                break;
            }

            case 'create':
                writeFieldNames = summarizeFieldNames(parameters);
                await requireWriteConfirmation({
                    requestContext: ctx.mcpRequestContext,
                    operation: 'create',
                    entityName,
                    parameters,
                    personalFieldNames: summarizePersonalFieldNames(b1EntityType, Object.keys(parameters))
                });
                recordWriteConfirmationAudit({
                    operation: 'create',
                    entitySet: resolvedEntityName,
                    companyId: effectiveCompanyId,
                    sourceIp: ctx.sourceIp,
                    userName: requestContext?.userName,
                    fieldNames: writeFieldNames,
                    usedAuthenticatedContext
                });
                operationDescription = `Creating new ${entityName}`;
                response = await ctx.sapClient.createEntity(service.url, resolvedEntityName, parameters, {
                    preferReturnNoContent: true
                });
                break;

            case 'update': {
                const updateKeyValue = buildKeyValue(b1EntityType, parameters, ctx.logger);
                writeKeyValue = updateKeyValue;
                const updateData = { ...parameters };
                b1EntityType.keys.forEach(key => delete updateData[key]);
                await requireWriteConfirmation({
                    requestContext: ctx.mcpRequestContext,
                    operation: 'update',
                    entityName,
                    target: String(updateKeyValue),
                    parameters: updateData,
                    personalFieldNames: summarizePersonalFieldNames(b1EntityType, Object.keys(updateData))
                });
                writeFieldNames = summarizeFieldNames(updateData, b1EntityType.keys);
                recordWriteConfirmationAudit({
                    operation: 'update',
                    entitySet: resolvedEntityName,
                    companyId: effectiveCompanyId,
                    sourceIp: ctx.sourceIp,
                    userName: requestContext?.userName,
                    keyValue: writeKeyValue,
                    fieldNames: writeFieldNames,
                    usedAuthenticatedContext
                });
                operationDescription = `Updating ${entityName} with key: ${updateKeyValue}`;
                response = await ctx.sapClient.updateEntity(service.url, resolvedEntityName, updateKeyValue, updateData);
                break;
            }

            case 'delete': {
                const deleteKeyValue = buildKeyValue(b1EntityType, parameters, ctx.logger);
                await requireWriteConfirmation({
                    requestContext: ctx.mcpRequestContext,
                    operation: 'delete',
                    entityName,
                    target: String(deleteKeyValue)
                });
                writeKeyValue = deleteKeyValue;
                recordWriteConfirmationAudit({
                    operation: 'delete',
                    entitySet: resolvedEntityName,
                    companyId: effectiveCompanyId,
                    sourceIp: ctx.sourceIp,
                    userName: requestContext?.userName,
                    keyValue: writeKeyValue,
                    usedAuthenticatedContext
                });
                operationDescription = `Deleting ${entityName} with key: ${deleteKeyValue}`;
                await ctx.sapClient.deleteEntity(service.url, resolvedEntityName, deleteKeyValue);
                response = { data: { message: `Successfully deleted ${entityName} with key: ${deleteKeyValue}`, success: true } };
                break;
            }

            default:
                throw new Error(`Unsupported operation: ${operation}`);
        }

        if (isWriteOperation(operation)) {
            recordWriteAudit({
                operation,
                entitySet: resolvedEntityName,
                companyId: effectiveCompanyId,
                sourceIp: ctx.sourceIp,
                keyValue: writeKeyValue,
                fieldNames: writeFieldNames,
                outcome: 'success',
                usedAuthenticatedContext
            });
        }

        let redactedPersonalFields: string[] = [];
        if (operation === 'read' || operation === 'read-single') {
            if (!b1Manager) {
                throw new Error(`B1MetadataManager not available for mandatory personal-field redaction on '${entityName}'.`);
            }

            let entitySetSchema: EdmEntityType;
            try {
                entitySetSchema = await b1Manager.getEntitySchema(entityName);
            } catch (error) {
                throw new Error(`Failed to load nested redaction schema for '${entityName}': ${error instanceof Error ? error.message : String(error)}`);
            }

            if (!meaningfulSelectString) {
                redactedPersonalFields = redactResponsePersonalFields(operation, response.data, entitySetSchema);
            } else {
                const selectedComplexProperties = getSelectedComplexProperties(entitySetSchema, selectedFields);
                if (selectedComplexProperties.length > 0) {
                    redactedPersonalFields = redactSelectedComplexResponsePersonalFields(
                        operation,
                        response.data,
                        selectedComplexProperties
                    );
                }
            }

            if (redactedPersonalFields.length > 0) {
                ctx.logger.info(
                    `Redacted ${redactedPersonalFields.length} personal field(s) from ${operation} ${entityName}: ${redactedPersonalFields.join(', ')}`
                );
            }
        }

       
        let responseText = `SUCCESS: ${operationDescription}\n\n`;
        let structuredPayload: Record<string, unknown>;
        if (operation === 'create' && response.status === 204) {
            const headers = response.headers as Record<string, string> | undefined;
            const preferenceApplied = headers?.['preference-applied'];
            const locationRaw = headers?.location;
            // Strip the absolute base (scheme + host + /b1s/v2/) — only the entity+key part is useful.
            const location = locationRaw?.replace(/^https?:\/\/[^/]+\/b1s\/v[^/]+\//, '') ?? locationRaw;
            structuredPayload = {
                success: true,
                status: '204 No Content',
                preferenceApplied: preferenceApplied || undefined,
                location: location || undefined
            };
            // Text shows only the key HTTP-level info; structuredContent has the same as an object.
            responseText += `status: 204 No Content\n`;
            if (preferenceApplied) responseText += `preferenceApplied: ${preferenceApplied}\n`;
            if (location) responseText += `location: ${location}\n`;
        } else {
            // response.data is the full OData JSON body (e.g. { value: [...] } for reads).
            structuredPayload = { success: true, data: response.data };
            responseText += JSON.stringify(response.data, null, 2);
        }
        // structuredContent exposes the raw data to code without text-parsing;
        // the text above (with the SUCCESS header and guidance) is kept for LLM agents.
        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: structuredPayload
        };

    } catch (error) {
        ctx.logger.error('Error executing entity operation:', error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isWriteOperation(rawOperation)) {
            recordWriteAudit({
                operation: rawOperation,
                entitySet: resolvedEntityName,
                companyId: effectiveCompanyId,
                sourceIp: ctx.sourceIp,
                userName: requestContext?.userName,
                keyValue: writeKeyValue,
                fieldNames: writeFieldNames,
                outcome: 'failure',
                errorMessage,
                usedAuthenticatedContext
            });
        }
        let responseText = `ERROR: Failed to execute ${args.operation} operation on ${args.entityName}\n\n`;
        responseText += `Error Details: ${errorMessage}\n\n`;

        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: { success: false, error: errorMessage },
            isError: true
        };
    }
}

function parseSelectedFields(selectString: string): string[] {
    return selectString
        .split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0);
}

type PathResolutionResult =
    | { isValid: true; canonicalPath: string }
    | { isValid: false; reason: string };

function findPropertyCaseInsensitive(
    properties: Map<string, EdmProperty>,
    name: string
): EdmProperty | undefined {
    const direct = properties.get(name);
    if (direct) {
        return direct;
    }

    const lowerName = name.toLowerCase();
    for (const [propName, prop] of properties.entries()) {
        if (propName.toLowerCase() === lowerName) {
            return prop;
        }
    }

    return undefined;
}

function resolvePropertyPathAgainstMetadata(
    entityType: EdmEntityType,
    propertyPath: string,
    options: { allowComplexTerminal: boolean }
): PathResolutionResult {
    const segments = propertyPath
        .split('/')
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0);

    if (segments.length === 0) {
        return { isValid: false, reason: 'empty property path' };
    }

    let currentType: EdmEntityType | EdmComplexType = entityType;
    const canonicalSegments: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const matchedProperty = findPropertyCaseInsensitive(currentType.properties, segment);
        if (!matchedProperty) {
            return {
                isValid: false,
                reason: `property segment '${segment}' not found on type '${currentType.name}'`
            };
        }

        canonicalSegments.push(matchedProperty.name);

        const isLastSegment = index === segments.length - 1;
        if (!isLastSegment) {
            if (matchedProperty.type.category !== EdmPropTypeCategory.COMPLEX) {
                return {
                    isValid: false,
                    reason: `property segment '${segment}' is not a structural property and cannot have nested members`
                };
            }
            currentType = matchedProperty.type;
            continue;
        }

        // Mid-path structural segments are already required above; this terminal check
        // controls query semantics: select can target structural properties, but
        // orderby must end at a scalar/enum property.
        if (!options.allowComplexTerminal && matchedProperty.type.category === EdmPropTypeCategory.COMPLEX) {
            return {
                isValid: false,
                reason: `property path '${propertyPath}' resolves to a structural property, but a scalar/enum property is required`
            };
        }
    }

    return { isValid: true, canonicalPath: canonicalSegments.join('/') };
}

function normalizeSelectStringAgainstMetadata(
    selectString: string,
    entityType: EdmEntityType,
    entitySetName: string
): string {
    const fields = parseSelectedFields(selectString);
    const invalidFields: string[] = [];
    const normalizedFields: string[] = [];

    for (const field of fields) {
        if (field === '*') {
            normalizedFields.push(field);
            continue;
        }

        const pathResolution = resolvePropertyPathAgainstMetadata(entityType, field, {
            allowComplexTerminal: true
        });
        if (!pathResolution.isValid) {
            invalidFields.push(`${field} (${pathResolution.reason})`);
            continue;
        }

        normalizedFields.push(pathResolution.canonicalPath);
    }

    if (invalidFields.length > 0) {
        throw new Error(
            `Invalid selectString. The following fields are not valid for '${entitySetName}': ${invalidFields.join(', ')}`
        );
    }

    return normalizedFields.join(',');
}

type OrderbyFieldClause = {
    propertyPath: string;
    direction?: 'asc' | 'desc';
};

function parseOrderbyClauses(orderbyString: string): OrderbyFieldClause[] {
    const clauses = orderbyString
        .split(',')
        .map(clause => clause.trim())
        .filter(clause => clause.length > 0);

    const parsedClauses: OrderbyFieldClause[] = [];
    for (const clause of clauses) {
        const match = clause.match(/^(.*?)(?:\s+(asc|desc))?\s*$/i);
        const propertyPath = match?.[1]?.trim();
        const direction = match?.[2]?.toLowerCase() as 'asc' | 'desc' | undefined;
        if (!propertyPath) {
            throw new Error(`Invalid orderbyString clause '${clause}'. Expected format: <propertyPath> [asc|desc]`);
        }
        parsedClauses.push({ propertyPath, direction });
    }

    return parsedClauses;
}

function normalizeOrderbyStringAgainstMetadata(
    orderbyString: string,
    entityType: EdmEntityType,
    entitySetName: string
): string {
    const clauses = parseOrderbyClauses(orderbyString);
    const invalidFields: string[] = [];
    const normalizedClauses: string[] = [];

    for (const clause of clauses) {
        const pathResolution = resolvePropertyPathAgainstMetadata(entityType, clause.propertyPath, {
            allowComplexTerminal: false
        });
        if (!pathResolution.isValid) {
            invalidFields.push(`${clause.propertyPath} (${pathResolution.reason})`);
            continue;
        }

        normalizedClauses.push(clause.direction
            ? `${pathResolution.canonicalPath} ${clause.direction}`
            : pathResolution.canonicalPath);
    }

    if (invalidFields.length > 0) {
        throw new Error(
            `Invalid orderbyString. The following fields are not valid for '${entitySetName}': ${invalidFields.join(', ')}`
        );
    }

    return normalizedClauses.join(',');
}

function getSelectedComplexProperties(entityType: EdmEntityType, selectedFields: string[]): EdmProperty[] {
    if (selectedFields.length === 0) {
        return [];
    }

    const selectedRootNames = new Set(
        selectedFields
            .map(field => field.split('/')[0]?.trim())
            .filter((field): field is string => typeof field === 'string' && field.length > 0)
            .map(field => field.toLowerCase())
    );

    return Array.from(entityType.properties.values())
        .filter(prop => prop.type.category === EdmPropTypeCategory.COMPLEX && selectedRootNames.has(prop.name.toLowerCase()));
}

function getMeaningfulSelectString(selectValue: unknown): string | undefined {
    if (typeof selectValue !== 'string') {
        return undefined;
    }

    const trimmed = selectValue.trim();
    return trimmed.length > 0 ? selectValue : undefined;
}

function getMeaningfulOrderbyString(orderbyValue: unknown): string | undefined {
    if (typeof orderbyValue !== 'string') {
        return undefined;
    }

    const trimmed = orderbyValue.trim();
    return trimmed.length > 0 ? orderbyValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactResponsePersonalFields(
    operation: 'read' | 'read-single',
    data: unknown,
    edmEntityType: EdmEntityType
): string[] {
    if (operation === 'read-single') {
        return isRecord(data) ? redactPersonalFields(data, edmEntityType) : [];
    }

    if (!isRecord(data)) {
        return [];
    }

    const collection = data.value;
    if (!Array.isArray(collection)) {
        return [];
    }

    return redactPersonalFieldsFromCollection(collection, edmEntityType)
        .map(fieldPath => `value${fieldPath}`)
        .sort();
}

function redactSelectedComplexResponsePersonalFields(
    operation: 'read' | 'read-single',
    data: unknown,
    selectedComplexProperties: EdmProperty[]
): string[] {
    if (selectedComplexProperties.length === 0) {
        return [];
    }

    if (operation === 'read-single') {
        return isRecord(data) ? redactSelectedComplexProperties(data, selectedComplexProperties) : [];
    }

    if (!isRecord(data)) {
        return [];
    }

    const collection = data.value;
    if (!Array.isArray(collection)) {
        return [];
    }

    const redacted = new Set<string>();

    collection.forEach((item, index) => {
        if (!isRecord(item)) {
            return;
        }

        for (const fieldPath of redactSelectedComplexProperties(item, selectedComplexProperties)) {
            redacted.add(`value[${index}].${fieldPath}`);
        }
    });

    return Array.from(redacted).sort();
}

function redactSelectedComplexProperties(
    data: Record<string, unknown>,
    selectedComplexProperties: EdmProperty[]
): string[] {
    const redacted = new Set<string>();

    for (const prop of selectedComplexProperties) {
        const child = data[prop.name];
        if (child === undefined || child === null || prop.type.category !== EdmPropTypeCategory.COMPLEX) {
            continue;
        }

        const complexType = prop.type;
        if (prop.isArray) {
            if (!Array.isArray(child)) {
                continue;
            }

            child.forEach((item, index) => {
                if (!isRecord(item)) {
                    return;
                }

                for (const fieldPath of redactPersonalFields(item, complexType)) {
                    redacted.add(`${prop.name}[${index}].${fieldPath}`);
                }
            });
            continue;
        }

        if (!isRecord(child)) {
            continue;
        }

        for (const fieldPath of redactPersonalFields(child, complexType)) {
            redacted.add(`${prop.name}.${fieldPath}`);
        }
    }

    return Array.from(redacted).sort();
}

function redactPersonalFieldsFromCollection(
    items: unknown[],
    edmEntityType: EdmEntityType
): string[] {
    const redacted = new Set<string>();

    items.forEach((item, index) => {
        if (!isRecord(item)) {
            return;
        }

        for (const fieldPath of redactPersonalFields(item, edmEntityType)) {
            redacted.add(`[${index}].${fieldPath}`);
        }
    });

    return Array.from(redacted).sort();
}

function redactPersonalFields(
    data: Record<string, unknown>,
    edmEntityType: EdmEntityType | EdmComplexType
): string[] {
    const redacted = new Set<string>();

    const redactFromProperties = (
        properties: Iterable<EdmProperty>,
        target: Record<string, unknown>,
        pathPrefix = ''
    ): void => {
        for (const prop of properties) {
            if (prop.isPersonalField && prop.name in target) {
                target[prop.name] = '[redacted]';
                redacted.add(`${pathPrefix}${prop.name}`);
            }

            const child = target[prop.name];

            if (prop.type.category !== EdmPropTypeCategory.COMPLEX || child === undefined || child === null) continue;
            const complexType = prop.type;

            if (prop.isArray) {
                if (!Array.isArray(child)) continue;
                child.forEach((item, index) => {
                    if (isRecord(item)) {
                        redactFromProperties(
                            complexType.properties.values(),
                            item,
                            `${pathPrefix}${prop.name}[${index}].`
                        );
                    }
                });
            } else if (isRecord(child)) {
                redactFromProperties(
                    complexType.properties.values(),
                    child,
                    `${pathPrefix}${prop.name}.`
                );
            }
        }
    };
    redactFromProperties(edmEntityType.properties.values(), data);
    return Array.from(redacted).sort();
}

function findSelectedPersonalFields(entityType: EdmEntityType, selectedFields: string[]): string[] {
    if (selectedFields.length === 0 || entityType.properties.size === 0) {
        return [];
    }

    const selectedFieldSet = new Set(selectedFields.map(f => f.toLowerCase()));
    return Array.from(entityType.properties.values())
        .filter(prop => prop.isPersonalField && selectedFieldSet.has(prop.name.toLowerCase()))
        .map(prop => prop.name);
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/**
 * Build key value for entity operations (handles single and composite keys).
 */
function buildKeyValue(
    entityType: EdmEntityType,
    parameters: Record<string, unknown>,
    logger: Logger
): string | number {
    const isNumericKeyType = (keyType: string): boolean =>
        keyType === 'Edm.Int32' || keyType === 'Edm.Int64' || keyType === 'Edm.Int16';

    const escapeODataString = (value: string): string => value.replace(/'/g, "''");

    const keyProperties = Array.from(entityType.properties.values()).filter(p => entityType.keys.includes(p.name));

    if (keyProperties.length === 1) {
        const keyName = keyProperties[0].name;
        if (!(keyName in parameters)) {
            throw new Error(`Missing required key property: ${keyName}. Required keys: ${entityType.keys.join(', ')}`);
        }
        const keyValue = parameters[keyName];
        const keyType = keyProperties[0].type.name;

        if (isNumericKeyType(keyType)) {
            const numericKey = typeof keyValue === 'number' ? keyValue : Number(keyValue);
            logger.debug(`buildKeyValue: resolved numeric key ${keyName}=${numericKey}`);
            return numericKey;
        }
        const stringKey = escapeODataString(String(keyValue));
        logger.debug(`buildKeyValue: resolved string key ${keyName}='${stringKey}'`);
        return stringKey;
    }

    // Composite key
    const keyParts = keyProperties.map(prop => {
        if (!(prop.name in parameters)) {
            throw new Error(`Missing required key property: ${prop.name}. Required keys: ${entityType.keys.join(', ')}`);
        }

        const rawKeyValue = parameters[prop.name];
        if (isNumericKeyType(prop.type.name)) {
            const numericKey = typeof rawKeyValue === 'number' ? rawKeyValue : Number(rawKeyValue);
            return `${prop.name}=${numericKey}`;
        }

        const stringKey = escapeODataString(String(rawKeyValue));
        return `${prop.name}='${stringKey}'`;
    });
    return keyParts.join(',');
}
