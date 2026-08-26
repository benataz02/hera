/**
 * B1 Metadata Parser
 *
 * XML parsing layer for SAP Business One OData metadata.
 */

import { JSDOM } from 'jsdom';
import {
    DiscoveredEntitySet,
    EdmEntitySet,
    EdmPropTypeCategory,
    EdmPrimitiveType,
    EdmEnumType,
    EdmComplexType,
    EdmEntityType,
    EdmProperty
} from '../types/b1-types.js';

const UNSUPPORTED_ENTITY_SETS = new Set([
    'Attachments2',
    'B1Sessions',
    'ItemImages',
    'EmployeeImages',
    'Pictures'
]);

export class B1MetadataParser {
    private readonly primitiveTypes: Map<string, EdmPrimitiveType>;

    constructor() {
        this.primitiveTypes = this.buildPrimitiveTypes();
    }

    /**
     * Parse lightweight entity list from Phase 1 XML
     * Input: $metadata?scope=entityset&annotation=labelWithTable
     */
    parseEntityList(xml: string): DiscoveredEntitySet[] {
        const dom = new JSDOM(xml, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;

        const entitySetNodes = xmlDoc.querySelectorAll('EntitySet');
        const entityList: DiscoveredEntitySet[] = [];

        entitySetNodes.forEach((node: Element) => {
            const name = node.getAttribute('Name');
            const entityTypeName = node.getAttribute('EntityType');

            if (name && entityTypeName) {
                if (UNSUPPORTED_ENTITY_SETS.has(name)) {
                    return;
                }

                const label = this.getAnnotationString(node, 'Common.Label');
                const tableName = this.getAnnotationString(node, 'SAPB1.TableName');
                const resolvedTable = tableName || name;
                const resolvedDescription = label || name;

                // Classify: UDT = U_ prefix + @ identifier; UDO = no U_ prefix + @ identifier
                let entityClass: 'standard' | 'udt' | 'udo' = 'standard';
                if (resolvedTable.startsWith('@')) {
                    entityClass = name.startsWith('U_') ? 'udt' : 'udo';
                }

                entityList.push({
                    name,
                    table: resolvedTable,
                    description: resolvedDescription,
                    entityTypeName,
                    entityClass
                });
            }
        });

        return entityList;
    }

    /**
     * Parse EnumTypes from Phase 2 XML
     * Returns a map of type name → EdmEnumType
     */
    parseEnumTypes(xml: string): Map<string, EdmEnumType> {
        const dom = new JSDOM(xml, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;
        const result = new Map<string, EdmEnumType>();

        xmlDoc.querySelectorAll('EnumType').forEach((enumNode: Element) => {
            const name = enumNode.getAttribute('Name');
            if (!name) return;

            const enumType: EdmEnumType = {
                name,
                category: EdmPropTypeCategory.ENUM,
                isArray: false,
                members: new Map(),
                codes: new Map()
            };

            enumNode.querySelectorAll('Member').forEach((memberNode: Element) => {
                const memberName = memberNode.getAttribute('Name');
                const code = this.getAnnotationString(memberNode, 'SAPB1.ValidValue');
                if (memberName && code) {
                    enumType.members.set(memberName, code);
                    enumType.codes.set(code, memberName);
                }
            });

            result.set(name, enumType);
        });

        return result;
    }

    /**
     * Parse ComplexTypes from Phase 2 XML
     * Requires enumTypes so collection properties that reference EnumTypes can be resolved
     * Returns a map of type name → EdmComplexType
     */
    parseComplexTypes(
        xml: string,
        enumTypes: Map<string, EdmEnumType>
    ): Map<string, EdmComplexType> {
        const dom = new JSDOM(xml, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;
        const schemaNamespace = this.getSchemaNamespace(xmlDoc);
        const result = new Map<string, EdmComplexType>();

        const complexNodes = xmlDoc.querySelectorAll('ComplexType');

        // First pass: create placeholders so forward-references resolve
        complexNodes.forEach((node: Element) => {
            const name = node.getAttribute('Name');
            if (name) {
                result.set(name, {
                    name,
                    namespace: schemaNamespace,
                    category: EdmPropTypeCategory.COMPLEX,
                    isArray: false,
                    properties: new Map()
                });
            }
        });

        // Second pass: populate properties
        complexNodes.forEach((node: Element) => {
            const name = node.getAttribute('Name');
            if (!name) return;
            const ct = result.get(name)!;
            if (ct.properties.size > 0) return; // already populated

            node.querySelectorAll('Property').forEach((propNode: Element) => {
                const prop = this.createEdmProperty(propNode, result, enumTypes);
                if (prop) ct.properties.set(prop.name, prop);
            });
        });

        return result;
    }

    /**
     * Parse the EdmEntitySet (with resolved EdmEntityType) for a specific EntitySet from Phase 2 XML
     * Requires complexTypes and enumTypes from prior parse calls
     */
    parseEntitySet(
        xml: string,
        entitySetName: string,
        complexTypes: Map<string, EdmComplexType>,
        enumTypes: Map<string, EdmEnumType>
    ): EdmEntitySet {
        const dom = new JSDOM(xml, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;
        const schemaNamespace = this.getSchemaNamespace(xmlDoc);

        // Find the EntitySet node for this entity
        const entitySetNode = Array.from(xmlDoc.querySelectorAll('EntitySet'))
            .find((n: Element) => n.getAttribute('Name') === entitySetName);

        if (!entitySetNode) {
            throw new Error(`EntitySet '${entitySetName}' not found in metadata`);
        }

        const entityTypeName = entitySetNode.getAttribute('EntityType');
        if (!entityTypeName) {
            throw new Error(`EntityType not specified for EntitySet '${entitySetName}'`);
        }

        const tableName = this.getAnnotationString(entitySetNode, 'SAPB1.TableName');
        const description = this.getAnnotationString(entitySetNode, 'Common.Label') || entitySetName;

        let entityClass: 'standard' | 'udt' | 'udo' = 'standard';
        if (tableName?.startsWith('@')) {
            entityClass = entitySetName.startsWith('U_') ? 'udt' : 'udo';
        }

        // Look up the entity type by short name
        const typeName = entityTypeName.split('.').pop() || entityTypeName;

        const entityTypeNode = Array.from(xmlDoc.querySelectorAll('EntityType'))
            .find((n: Element) => n.getAttribute('Name') === typeName);
        if (!entityTypeNode) {
            throw new Error(`EntityType '${typeName}' not found in metadata`);
        }

        const namespace = entityTypeName.includes('.')
            ? entityTypeName.slice(0, entityTypeName.lastIndexOf('.'))
            : schemaNamespace;

        const entityType: EdmEntityType = {
            name: typeName,
            namespace,
            category: EdmPropTypeCategory.COMPLEX,
            isArray: false,
            properties: new Map(),
            keys: [],
            entityClass
        };

        entityTypeNode.querySelectorAll('Property').forEach((propNode: Element) => {
            const prop = this.createEdmProperty(propNode, complexTypes, enumTypes);
            if (prop) entityType.properties.set(prop.name, prop);
        });

        const keyEl = entityTypeNode.querySelector('Key');
        if (keyEl) {
            keyEl.querySelectorAll('PropertyRef').forEach((keyNode: Element) => {
                const keyName = keyNode.getAttribute('Name');
                if (keyName) entityType.keys.push(keyName);
            });
        }

        return {
            name: entitySetName,
            entityTypeName,
            entityType,
            table: tableName || entitySetName,
            description
        };
    }

    private getSchemaNamespace(xmlDoc: Document): string {
        const schemaNode = xmlDoc.querySelector('Schema');
        return schemaNode?.getAttribute('Namespace') || 'SAPB1';
    }

    /**
     * Create an EdmProperty from an XML Property element
     * Returns null if the property type cannot be resolved
     */
    createEdmProperty(
        propNode: Element,
        complexTypes: Map<string, EdmComplexType>,
        enumTypes: Map<string, EdmEnumType>
    ): EdmProperty | null {
        const name = propNode.getAttribute('Name');
        let typeName = propNode.getAttribute('Type');
        if (!name || !typeName) return null;

        // Detect collection
        let isArray = false;
        if (typeName.startsWith('Collection(')) {
            typeName = typeName.slice('Collection('.length, -1);
            isArray = true;
        }

        // Resolve type: primitives first, then SAPB1 namespace types
        let type: EdmPrimitiveType | EdmEnumType | EdmComplexType | null =
            this.primitiveTypes.get(typeName) || null;

        if (!type && typeName.startsWith('SAPB1.')) {
            const shortName = typeName.slice('SAPB1.'.length);
            type = complexTypes.get(shortName) ?? enumTypes.get(shortName) ?? null;
        }

        if (!type) return null;

        const maxLengthStr = propNode.getAttribute('MaxLength');

        if (type.category === EdmPropTypeCategory.COMPLEX) {
            return {
                name,
                type,
                isArray,
                description: this.getAnnotationString(propNode, 'Common.Label') || undefined,
                childTableName: this.getAnnotationString(propNode, 'SAPB1.ChildTableName') || undefined,
            };
        } else {
            return {
                name,
                type,
                maxLength: maxLengthStr ? Number.parseInt(maxLengthStr, 10) : undefined,
                alias: this.getAnnotationString(propNode, 'SAPB1.ColumnName') || undefined,
                description: this.getAnnotationString(propNode, 'Common.Label') || undefined,
                isUDF: name.startsWith('U_')
            };
        }
    }

    private getAnnotationString(node: Element, term: string): string | null {
        const annotationNode = Array.from(node.querySelectorAll('Annotation'))
            .find((child: Element) => child.parentElement === node && child.getAttribute('Term') === term);

        const value = annotationNode?.getAttribute('String');
        return value?.trim() || null;
    }

    private buildPrimitiveTypes(): Map<string, EdmPrimitiveType> {
        const primitiveTypeNames = [
            'Edm.String', 'Edm.Byte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64',
            'Edm.Time', 'Edm.TimeOfDay', 'Edm.DateTime', 'Edm.Date',
            'Edm.DateTimeOffset', 'Edm.Double', 'Edm.Decimal', 'Edm.Boolean', 'Edm.Guid'
        ];
        const types = new Map<string, EdmPrimitiveType>();
        for (const name of primitiveTypeNames) {
            types.set(name, { name, category: EdmPropTypeCategory.PRIMITIVE, isArray: false });
        }
        return types;
    }
}
