import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { B1MetadataParser } from '../../services/b1-metadata-parser.js';
import { EdmPropTypeCategory } from '../../types/b1-types.js';

// ---------------------------------------------------------------------------
// Fixture XML helpers
// ---------------------------------------------------------------------------

/** Wrap a Schema fragment in a minimal EDMX envelope */
function edmx(schemaBody: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0"
    xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"
    xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices>
    <Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:sap="http://www.sap.com/Protocols/SAPData">
      ${schemaBody}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

/** Minimal EntityContainer holding one or more EntitySet declarations */
function entityContainer(entitySets: string): string {
    return `<EntityContainer Name="ServiceLayer">${entitySets}</EntityContainer>`;
}

// ---------------------------------------------------------------------------
// describe: parseEntityList
// ---------------------------------------------------------------------------

describe('B1MetadataParser.parseEntityList', () => {
    const parser = new B1MetadataParser();

    const PHASE1_XML = edmx(entityContainer(`
        <EntitySet EntityType="SAPB1.Item" Name="Items">
            <Annotation Term="Common.Label" String="Items"/>
            <Annotation Term="SAPB1.TableName" String="OITM"/>
        </EntitySet>
        <EntitySet EntityType="SAPB1.Document" Name="Orders">
            <Annotation Term="Common.Label" String="Sales Order"/>
            <Annotation Term="SAPB1.TableName" String="ORDR"/>
        </EntitySet>
        <EntitySet EntityType="SAPB1.U_CustomTable" Name="U_CustomTable">
            <Annotation Term="Common.Label" String="My UDT"/>
            <Annotation Term="SAPB1.TableName" String="@CustomTable"/>
        </EntitySet>
        <EntitySet EntityType="SAPB1.U_ProjectData" Name="U_ProjectData">
            <Annotation Term="Common.Label" String="Project Data"/>
            <Annotation Term="SAPB1.TableName" String="@ProjectData"/>
        </EntitySet>
        <EntitySet EntityType="SAPB1.MyUDO" Name="MyUDO">
            <Annotation Term="Common.Label" String="My UDO"/>
            <Annotation Term="SAPB1.TableName" String="@MyUDO"/>
        </EntitySet>
        <EntitySet EntityType="SAPB1.NoLabel" Name="NoLabel"/>
        <EntitySet EntityType="SAPB1.B1Session" Name="B1Sessions"/>
        <EntitySet EntityType="SAPB1.ItemImage" Name="ItemImages"/>
        <EntitySet EntityType="SAPB1.EmployeeImage" Name="EmployeeImages"/>
        <EntitySet EntityType="SAPB1.Picture" Name="Pictures"/>
        <EntitySet EntityType="SAPB1.Attachments2" Name="Attachments2"/>
    `));

    let entities: ReturnType<B1MetadataParser['parseEntityList']>;
    beforeEach(() => { entities = parser.parseEntityList(PHASE1_XML); });

    it('returns one entry per EntitySet', () => {
        expect(entities).toHaveLength(6);
    });

    it('excludes unsupported entity sets from the parsed entity list', () => {
        expect(entities.some(e => e.name === 'Attachments2')).toBe(false);
        expect(entities.some(e => e.name === 'B1Sessions')).toBe(false);
        expect(entities.some(e => e.name === 'ItemImages')).toBe(false);
        expect(entities.some(e => e.name === 'EmployeeImages')).toBe(false);
        expect(entities.some(e => e.name === 'Pictures')).toBe(false);
    });

    it('maps name and entityType correctly', () => {
        const items = entities.find(e => e.name === 'Items');
        expect(items?.entityTypeName).toBe('SAPB1.Item');
    });

    it('sets table from SAPB1.TableName annotation', () => {
        expect(entities.find(e => e.name === 'Items')?.table).toBe('OITM');
        expect(entities.find(e => e.name === 'Orders')?.table).toBe('ORDR');
    });

    it('sets description from Common.Label annotation', () => {
        expect(entities.find(e => e.name === 'Orders')?.description).toBe('Sales Order');
    });

    it('classifies standard entities correctly', () => {
        expect(entities.find(e => e.name === 'Items')?.entityClass).toBe('standard');
        expect(entities.find(e => e.name === 'Orders')?.entityClass).toBe('standard');
    });

    it('classifies UDT: name starts with U_ and table annotation starts with @', () => {
        expect(entities.find(e => e.name === 'U_CustomTable')?.entityClass).toBe('udt');
        expect(entities.find(e => e.name === 'U_ProjectData')?.entityClass).toBe('udt');
    });

    it('classifies UDO: name does NOT start with U_ and table annotation starts with @', () => {
        expect(entities.find(e => e.name === 'MyUDO')?.entityClass).toBe('udo');
    });

    it('falls back to name for table and description when annotations are absent', () => {
        const e = entities.find(i => i.name === 'NoLabel');
        expect(e?.table).toBe('NoLabel');
        expect(e?.description).toBe('NoLabel');
        expect(e?.entityClass).toBe('standard');
    });
});

// ---------------------------------------------------------------------------
// describe: parseEnumTypes
// ---------------------------------------------------------------------------

describe('B1MetadataParser.parseEnumTypes', () => {
    const parser = new B1MetadataParser();

    const ENUM_XML = edmx(`
        <EnumType IsFlags="false" Name="BoStatus" UnderlyingType="Edm.Int32">
            <Member Name="bost_Open" Value="0">
            <Annotation String="O" Term="SAPB1.ValidValue" />
            </Member>
            <Member Name="bost_Close" Value="1">
            <Annotation String="C" Term="SAPB1.ValidValue" />
            </Member>
            <Member Name="bost_Paid" Value="2">
            <Annotation String="P" Term="SAPB1.ValidValue" />
            </Member>
            <Member Name="bost_Delivered" Value="3">
            <Annotation String="D" Term="SAPB1.ValidValue" />
            </Member>
        </EnumType>
        <EnumType IsFlags="false" Name="BoYesNoEnum" UnderlyingType="Edm.Int32">
            <Member Name="tNO" Value="0">
            <Annotation String="N" Term="SAPB1.ValidValue" />
            </Member>
            <Member Name="tYES" Value="1">
            <Annotation String="Y" Term="SAPB1.ValidValue" />
            </Member>
        </EnumType>
    `);

    it('returns one entry per EnumType', () => {
        const result = parser.parseEnumTypes(ENUM_XML);
        expect(result.size).toBe(2);
        expect(result.has('BoStatus')).toBe(true);
        expect(result.has('BoYesNoEnum')).toBe(true);
    });

    it('sets category to ENUM', () => {
        const result = parser.parseEnumTypes(ENUM_XML);
        expect(result.get('BoStatus')?.category).toBe(EdmPropTypeCategory.ENUM);
    });

    it('populates members map (name → code)', () => {
        const result = parser.parseEnumTypes(ENUM_XML);
        expect(result.get('BoStatus')?.members.get('bost_Open')).toBe('O');
        expect(result.get('BoStatus')?.members.get('bost_Close')).toBe('C');
    });

    it('populates codes map (code → name)', () => {
        const result = parser.parseEnumTypes(ENUM_XML);
        expect(result.get('BoYesNoEnum')?.codes.get('Y')).toBe('tYES');
        expect(result.get('BoYesNoEnum')?.codes.get('N')).toBe('tNO');
    });

    it('returns empty map when no EnumTypes present', () => {
        expect(parser.parseEnumTypes(edmx('<EntityContainer Name="X"/>')).size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// describe: parseComplexTypes
// ---------------------------------------------------------------------------

describe('B1MetadataParser.parseComplexTypes', () => {
    const parser = new B1MetadataParser();
    const emptyEnums = new Map();

    const COMPLEX_XML = edmx(`
        <ComplexType Name="DocumentLine">
            <Property Name="LineNum" Type="Edm.Int32">
                <Annotation Term="Common.Label" String="Row Number"/>
                <Annotation Term="SAPB1.ColumnName" String="LineNum"/>
            </Property>
            <Property Name="ItemCode" Type="Edm.String" MaxLength="50">
                <Annotation Term="Common.Label" String="Item No."/>
                <Annotation Term="SAPB1.ColumnName" String="ItemCode"/>
            </Property>
            <Property Name="Quantity" Type="Edm.Double"/>
            <Property Name="U_SOR_UDF1" Type="Edm.String">
                <Annotation Term="Common.Label" String="UDF1 Row"/>
                <Annotation Term="SAPB1.ColumnName" String="U_SOR_UDF1"/>
            </Property>
        </ComplexType>
        <ComplexType Name="DocumentLineAdditionalExpense" OpenType="true">
            <Property Name="LineNumber" Type="Edm.Int32">
                <Annotation Term="Common.Label" String="Row Number"/>
                <Annotation Term="SAPB1.ColumnName" String="LineNum"/>
            </Property>
            <Property Name="ExpenseCode" Type="Edm.Int32">
                <Annotation Term="Common.Label" String="Freight Code"/>
                <Annotation Term="SAPB1.ColumnName" String="ExpnsCode"/>
            </Property>
        </ComplexType>
    `);

    it('returns one entry per ComplexType', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        expect(result.size).toBe(2);
        expect(result.has('DocumentLine')).toBe(true);
        expect(result.has('DocumentLineAdditionalExpense')).toBe(true);
    });

    it('sets category to COMPLEX', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        expect(result.get('DocumentLine')?.category).toBe(EdmPropTypeCategory.COMPLEX);
    });

    it('parses all properties of a ComplexType', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        const props = result.get('DocumentLine')!.properties;
        expect(props.size).toBe(4);
        expect(props.has('LineNum')).toBe(true);
        expect(props.has('ItemCode')).toBe(true);
        expect(props.has('Quantity')).toBe(true);
        expect(props.has('U_SOR_UDF1')).toBe(true);
    });

    it('sets alias and description from Common.Label and SAPB1.ColumnName', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        const itemCode = result.get('DocumentLine')!.properties.get('ItemCode');
        expect(itemCode?.alias).toBe('ItemCode');
        expect(itemCode?.description).toBe('Item No.');
    });

    it('marks U_ prefixed property as isUDF', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        const udf = result.get('DocumentLine')!.properties.get('U_SOR_UDF1');
        expect(udf?.isUDF).toBe(true);
    });

    it('respects MaxLength', () => {
        const result = parser.parseComplexTypes(COMPLEX_XML, emptyEnums);
        const itemCode = result.get('DocumentLine')!.properties.get('ItemCode');
        expect(itemCode?.maxLength).toBe(50);
    });
});

// ---------------------------------------------------------------------------
// describe: parseEntityType
// ---------------------------------------------------------------------------

describe('B1MetadataParser.parseEntityType', () => {
    const parser = new B1MetadataParser();

    const PHASE2_XML = edmx(`
        <ComplexType Name="DocumentLine">
            <Property Name="LineNum" Type="Edm.Int32">
                <Annotation Term="Common.Label" String="Row Number"/>
                <Annotation Term="SAPB1.ColumnName" String="LineNum"/>
            </Property>
            <Property Name="ItemCode" Type="Edm.String">
                <Annotation Term="Common.Label" String="Item No."/>
                <Annotation Term="SAPB1.ColumnName" String="ItemCode"/>
            </Property>
        </ComplexType>
        <EntityType Name="Document">
            <Key><PropertyRef Name="DocEntry"/></Key>
            <Property Name="DocEntry" Type="Edm.Int32"/>
            <Property Name="DocNum" Type="Edm.Int32"/>
            <Property Name="U_SOH_UDF1" Type="Edm.String">
                <Annotation Term="Common.Label" String="UDF1 Header"/>
                <Annotation Term="SAPB1.ColumnName" String="U_SOH_UDF1"/>
            </Property>
            <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
        </EntityType>
        ${entityContainer(`
            <EntitySet EntityType="SAPB1.Document" Name="Orders">
                <Annotation Term="Common.Label" String="Sales Order"/>
                <Annotation Term="SAPB1.TableName" String="ORDR"/>
            </EntitySet>
        `)}
    `);

    const PHASE2_UDT_XML = edmx(`
        <EntityType Name="U_ProjectData">
            <Key><PropertyRef Name="Code"/></Key>
            <Property Name="Code" Type="Edm.String" MaxLength="20"/>
            <Property Name="Name" Type="Edm.String"/>
        </EntityType>
        ${entityContainer(`
            <EntitySet EntityType="SAPB1.U_ProjectData" Name="U_ProjectData">
                <Annotation Term="Common.Label" String="Project Data"/>
                <Annotation Term="SAPB1.TableName" String="@ProjectData"/>
            </EntitySet>
        `)}
    `);

    const PHASE2_UDO_XML = edmx(`
        <EntityType Name="MyUDO">
            <Key><PropertyRef Name="DocEntry"/></Key>
            <Property Name="DocEntry" Type="Edm.Int32"/>
        </EntityType>
        ${entityContainer(`
            <EntitySet EntityType="SAPB1.MyUDO" Name="MyUDO">
                <Annotation Term="Common.Label" String="My UDO"/>
                <Annotation Term="SAPB1.TableName" String="@MyUDO"/>
            </EntitySet>
        `)}
    `);

    it('parses entity name', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const et = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map()).entityType!;
        expect(et.name).toBe('Document');
    });

    it('extracts key properties', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const et = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map()).entityType!;
        expect(et.keys).toEqual(['DocEntry']);
    });

    it('parses scalar properties (non-collection)', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const et = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map()).entityType!;
        expect(et.properties.has('DocEntry')).toBe(true);
        expect(et.properties.has('DocNum')).toBe(true);
        expect(et.properties.has('U_SOH_UDF1')).toBe(true);
        const docEntry = et.properties.get('DocEntry')!;
        expect(docEntry.isArray).toBeUndefined();
    });

    it('marks U_ prefixed property as isUDF', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const et = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map()).entityType!;
        expect(et.properties.get('U_SOH_UDF1')?.isUDF).toBe(true);
    });

    it('parses collection property with isArray=true and correct ComplexType reference', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const et = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map()).entityType!;
        const docLines = et.properties.get('DocumentLines')!;
        expect(docLines).toBeDefined();
        expect(docLines.isArray).toBe(true);
        expect(docLines.type.name).toBe('DocumentLine');
        expect(docLines.type.category).toBe(EdmPropTypeCategory.COMPLEX);
    });

    it('sets entityClass=standard for a normal entity', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        const entitySet = parser.parseEntitySet(PHASE2_XML, 'Orders', complexTypes, new Map());
        const et = entitySet.entityType!;
        expect(et.entityClass).toBe('standard');
        expect(entitySet.table).toBe('ORDR');
    });

    it('sets entityClass=udt for U_ entity with @ table annotation', () => {
        const et = parser.parseEntitySet(PHASE2_UDT_XML, 'U_ProjectData', new Map(), new Map()).entityType!;
        expect(et.entityClass).toBe('udt');
    });

    it('sets entityClass=udo for non-U_ entity with @ table annotation', () => {
        const et = parser.parseEntitySet(PHASE2_UDO_XML, 'MyUDO', new Map(), new Map()).entityType!;
        expect(et.entityClass).toBe('udo');
    });

    it('throws when EntitySet is not found', () => {
        const complexTypes = parser.parseComplexTypes(PHASE2_XML, new Map());
        expect(() =>
            parser.parseEntitySet(PHASE2_XML, 'NonExistent', complexTypes, new Map())
        ).toThrow("EntitySet 'NonExistent' not found");
    });

    it('supports same complex type names as entity-set exclusive by using separate maps', () => {
        const ORDERS_XML = edmx(`
            <ComplexType Name="DocumentLine">
                <Property Name="OrderOnlyField" Type="Edm.String"/>
            </ComplexType>
            <EntityType Name="Document">
                <Key><PropertyRef Name="DocEntry"/></Key>
                <Property Name="DocEntry" Type="Edm.Int32"/>
                <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
            </EntityType>
            ${entityContainer(`
                <EntitySet EntityType="SAPB1.Document" Name="Orders">
                    <Annotation Term="SAPB1.TableName" String="ORDR"/>
                </EntitySet>
            `)}
        `);

        const INVOICES_XML = edmx(`
            <ComplexType Name="DocumentLine">
                <Property Name="InvoiceOnlyField" Type="Edm.String"/>
            </ComplexType>
            <EntityType Name="Document">
                <Key><PropertyRef Name="DocEntry"/></Key>
                <Property Name="DocEntry" Type="Edm.Int32"/>
                <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
            </EntityType>
            ${entityContainer(`
                <EntitySet EntityType="SAPB1.Document" Name="Invoices">
                    <Annotation Term="SAPB1.TableName" String="OINV"/>
                </EntitySet>
            `)}
        `);

        const orderComplexTypes = parser.parseComplexTypes(ORDERS_XML, new Map());
        const invoiceComplexTypes = parser.parseComplexTypes(INVOICES_XML, new Map());

        const orderEntity = parser.parseEntitySet(ORDERS_XML, 'Orders', orderComplexTypes, new Map()).entityType!;
        const invoiceEntity = parser.parseEntitySet(INVOICES_XML, 'Invoices', invoiceComplexTypes, new Map()).entityType!;

        const orderLinesType = orderEntity.properties.get('DocumentLines')?.type;
        const invoiceLinesType = invoiceEntity.properties.get('DocumentLines')?.type;

        expect(orderLinesType?.category).toBe(EdmPropTypeCategory.COMPLEX);
        expect(invoiceLinesType?.category).toBe(EdmPropTypeCategory.COMPLEX);
        expect((orderLinesType as { properties?: Map<string, unknown> }).properties?.has('OrderOnlyField')).toBe(true);
        expect((invoiceLinesType as { properties?: Map<string, unknown> }).properties?.has('InvoiceOnlyField')).toBe(true);
        expect((orderLinesType as { properties?: Map<string, unknown> }).properties?.has('InvoiceOnlyField')).toBe(false);
        expect((invoiceLinesType as { properties?: Map<string, unknown> }).properties?.has('OrderOnlyField')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// describe: createEdmProperty
// ---------------------------------------------------------------------------

describe('B1MetadataParser.createEdmProperty', () => {
    const parser = new B1MetadataParser();

    /** Create a minimal Property element using JSDOM */
    function makePropNode(attrs: Record<string, string>): Element {
        const dom = new JSDOM('<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" xmlns:sap="http://www.sap.com/Protocols/SAPData"/>', { contentType: 'text/xml' });
        const el = dom.window.document.createElementNS('http://docs.oasis-open.org/odata/ns/edm', 'Property');
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
    }

    function addAnnotation(node: Element, term: string, value: string): void {
        const annotation = node.ownerDocument.createElementNS('http://docs.oasis-open.org/odata/ns/edm', 'Annotation');
        annotation.setAttribute('Term', term);
        annotation.setAttribute('String', value);
        node.appendChild(annotation);
    }

    it('parses a primitive type property', () => {
        const prop = parser.createEdmProperty(
            makePropNode({ Name: 'DocEntry', Type: 'Edm.Int32' }),
            new Map(), new Map()
        );
        expect(prop).not.toBeNull();
        expect(prop?.name).toBe('DocEntry');
        expect(prop?.type.name).toBe('Edm.Int32');
        expect(prop?.isArray).toBeUndefined();
    });

    it('parses a collection (array) property and sets isArray=true', () => {
        const complexTypes = new Map();
        complexTypes.set('DocumentLine', {
            name: 'DocumentLine',
            category: EdmPropTypeCategory.COMPLEX,
            isArray: false,
            properties: new Map()
        });
        const prop = parser.createEdmProperty(
            makePropNode({ Name: 'DocumentLines', Type: 'Collection(SAPB1.DocumentLine)' }),
            complexTypes, new Map()
        );
        expect(prop?.isArray).toBe(true);
        expect(prop?.type.name).toBe('DocumentLine');
        expect(prop?.type.category).toBe(EdmPropTypeCategory.COMPLEX);
    });

    it('captures SAPB1.ChildTableName annotation for complex collection property', () => {
        const complexTypes = new Map();
        complexTypes.set('RelatedDocument', {
            name: 'RelatedDocument',
            category: EdmPropTypeCategory.COMPLEX,
            isArray: false,
            properties: new Map()
        });

        const node = makePropNode({ Name: 'RelatedDocuments', Type: 'Collection(SAPB1.RelatedDocument)' });
        addAnnotation(node, 'SAPB1.ChildTableName', 'ECM5');
        const prop = parser.createEdmProperty(node, complexTypes, new Map());

        expect(prop?.isArray).toBe(true);
        expect(prop?.childTableName).toBe('ECM5');
    });

    it('marks U_ prefixed property as isUDF', () => {
        const prop = parser.createEdmProperty(
            makePropNode({ Name: 'U_SOR_UDF1', Type: 'Edm.String' }),
            new Map(), new Map()
        );
        expect(prop?.isUDF).toBe(true);
    });

    it('sets alias and description from Common.Label and SAPB1.ColumnName', () => {
        const node = makePropNode({ Name: 'ItemCode', Type: 'Edm.String' });
        addAnnotation(node, 'Common.Label', 'Item No.');
        addAnnotation(node, 'SAPB1.ColumnName', 'ItemCode');
        const prop = parser.createEdmProperty(node, new Map(), new Map());
        expect(prop?.alias).toBe('ItemCode');
        expect(prop?.description).toBe('Item No.');
    });

    it('respects MaxLength attribute', () => {
        const prop = parser.createEdmProperty(
            makePropNode({ Name: 'CardCode', Type: 'Edm.String', MaxLength: '15' }),
            new Map(), new Map()
        );
        expect(prop?.maxLength).toBe(15);
    });

    it('returns null when Name is missing', () => {
        expect(parser.createEdmProperty(
            makePropNode({ Type: 'Edm.String' }), new Map(), new Map()
        )).toBeNull();
    });

    it('returns null for an unknown type', () => {
        expect(parser.createEdmProperty(
            makePropNode({ Name: 'Foo', Type: 'SAPB1.UnknownType' }), new Map(), new Map()
        )).toBeNull();
    });
});
