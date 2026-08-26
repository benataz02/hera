import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { B1Client } from "../services/b1-client.js";
import { B1DiscoveryService } from "../services/b1-discovery.js";
import { Logger } from "../loggers/app-logger.js";
import { config } from "../utils/config.js";
import { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from "zod";
import {
    B1_OBJECT_TYPES,
    B1_DOCUMENT_FLOWS,
    B1_FIELD_PATTERNS,
    B1_DOCUMENT_STATUS,
    B1_LINE_STATUS,
    B1_PAYMENT_TYPES,
    B1_BP_TYPES
} from "./b1-constants.js";
import { getAllCategories, getCategoryDescriptions } from "./b1-category-mappings.js";
import { B1CompanySelectionToolRegistry } from "./b1-auth-tools.js";
import {
    DiscoveryContext,
    discoverEntitiesMinimal
} from "./b1-discovery-handlers.js";
import {
    EntityOperationContext,
    getEntityMetadata,
    executeEntityReadOperation,
    executeEntityWriteOperation
} from "./b1-schema-execute-handlers.js";
import {
    WorkflowContext,
    createDocumentFromBase,
    preparePaymentForInvoices
} from "./b1-workflow-handlers.js";
import { McpToolRequestContext } from './b1-elicitation.js';
import { getRequestContext } from '../utils/request-context.js';

/**
 * B1 Tool Registry — orchestrates the 5 MCP tools via progressive discovery.
 *
 * Tool implementations live in sibling handler files:
 *   - b1-discovery-handlers.ts  (Step 1: b1_find_entities)
 *   - b1-schema-execute-handlers.ts  (Steps 2 & 3: b1_get_entity_schema, b1_read, b1_write)
 *   - b1-workflow-handlers.ts  (b1_copy_document, b1_create_payment)
 */
export class B1SAPToolRegistry {
    private readonly entityCategories = new Map<string, string[]>();
    private companyId?: string;
    private readonly companySelectionToolRegistry?: B1CompanySelectionToolRegistry;

    constructor(
        private readonly mcpServer: McpServer,
        private readonly sapClient: B1Client,
        private readonly logger: Logger,
        private readonly discoveryService: B1DiscoveryService
    ) {
        if (config.isOAuthMode()) {
            this.companySelectionToolRegistry = new B1CompanySelectionToolRegistry(
                mcpServer,
                logger,
                config,
                (companyId) => this.setCompanyId(companyId)
            );
        }
    }

    setCompanyId(companyId?: string) {
        if (this.companyId !== companyId) {
            this.entityCategories.clear();
            this.logger.debug(`Company changed to '${companyId ?? 'none'}' — entity category cache cleared`);
        }
        this.companyId = companyId;
        this.sapClient.setCompanyId(companyId);
        this.logger.debug(`Company ID ${companyId ? 'set' : 'cleared'} for tool registry`);

        // Pre-warm the metadata cache in the background so the first b1_read/b1_write
        // does not block waiting for the full $metadata fetch.
        if (companyId) {
            this.discoveryService.getDiscoveredServices(companyId, this.sapClient.getB1Client())
                .then(() => this.logger.info(`Metadata pre-warm complete for company '${companyId}'`))
                .catch(err => this.logger.warn(`Metadata pre-warm failed for company '${companyId}':`, err));
        }
    }

    // -----------------------------------------------------------------------
    // Context builders
    // -----------------------------------------------------------------------

    private getDiscoveryContext(): DiscoveryContext {
        const requestContext = getRequestContext();
        return {
            sapClient: this.sapClient,
            logger: this.logger,
            discoveryService: this.discoveryService,
            entityCategories: this.entityCategories,
            companyId: requestContext?.companyId ?? this.companyId
        };
    }

    private getEntityOperationContext(mcpRequestContext?: McpToolRequestContext): EntityOperationContext {
        const requestContext = getRequestContext();
        return {
            sapClient: this.sapClient,
            logger: this.logger,
            discoveryService: this.discoveryService,
            companyId: requestContext?.companyId ?? this.companyId,
            sourceIp: requestContext?.sourceIp,
	        mcpRequestContext
        };
    }

    private getWorkflowContext(mcpRequestContext?: McpToolRequestContext): WorkflowContext {
        const requestContext = getRequestContext();
        return {
            sapClient: this.sapClient,
            logger: this.logger,
            discoveryService: this.discoveryService,
            companyId: requestContext?.companyId ?? this.companyId,
            mcpRequestContext
        };
    }

    // -----------------------------------------------------------------------
    // Tool registration
    // -----------------------------------------------------------------------

    public async registerDiscoveryTools(): Promise<void> {
        const toolCount = this.companySelectionToolRegistry
            ? '8 SAP B1 tools (4 core + 2 workflow helpers + 2 company selection)'
            : '6 SAP B1 tools (4 core + 2 workflow helpers)';
        this.logger.info(`Registering ${toolCount} for services`);

        const categoryDescriptions = getCategoryDescriptions();
        const categoryList = getAllCategories().map(c => `'${c}'`).join(', ');

        // Step 1: Lightweight entity discovery
        this.mcpServer.registerTool(
            "b1_find_entities",
            {
                title: "Find SAP B1 Entities",
                description: `Searches SAP Business One Service Layer entities by business category and optional name filter. Returns a minimal list (entityName, categories). If no matches are found, all entities are returned. Use \`b1_get_entity_schema\` next to retrieve the full schema for a selected entity. Use category='workflow' to discover available workflow tools. Available categories: ${categoryDescriptions}.`,
                inputSchema: {
                    category: z.string().optional().describe(`Business area filter. Default: 'all'. Options: ${categoryList}.`),
                    query: z.string().optional().describe("Optional name filter within the selected category. Example: 'invoice'."),
                    limit: z.number().min(1).max(50).optional().describe("Maximum number of results. Default: 20.")
                },
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                }
            },
            async (args: Record<string, unknown>) =>
                discoverEntitiesMinimal(args, this.getDiscoveryContext())
        );

        // Step 2: Full entity schema
        this.mcpServer.registerTool(
            "b1_get_entity_schema",
            {
                title: "Get SAP B1 Entity Schema",
                description: "Get the schema for a SAP B1 entity.\nStep 2.1: call with entityName only — returns all properties and structural (complex) types.\nStep 2.2 (optional): call with entityName + structuralTypeName to drill into a complex type's sub-properties. Step 2.1 must be called first for the same entity.",
                inputSchema: {
                    entityName: z.string().describe("B1 entity name from b1_find_entities results. Examples: 'Items', 'BusinessPartners', 'Orders', 'Invoices'. Use the 'entityName' field exactly as returned (case-sensitive)."),
                    structuralTypeName: z.string().optional().describe("Optional (Step 2.2 only). Use the complexTypeName from a structuralProperties entry in the Step 2.1 result, or from a nestedStructuralProperties entry in a previous Step 2.2 result. Example: 'DocumentLine', 'LineTaxJurisdiction'.")
                },
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                }
            },
            async (args: Record<string, unknown>) =>
                getEntityMetadata(args, this.getEntityOperationContext())
        );

        // Step 3a: Read execution
        this.mcpServer.registerTool(
            "b1_read",
            {
                title: "Read SAP B1 Entity Data",
                description: "Executes read operations on SAP B1 Service Layer entities. Use `b1_get_entity_schema` first to confirm field names and key properties. Supports `read` for list queries and `read-single` for a specific entity by key.",
                inputSchema: {
                    entityName: z.string().describe("B1 entity name from b1_find_entities results. Examples: 'Items', 'BusinessPartners', 'Orders', 'Invoices'. Use the 'entityName' field exactly as returned (case-sensitive)."),
                    operation: z.enum(['read', 'read-single']).describe("'read' returns a list; 'read-single' returns one entity by key (requires parameters with key fields)."),
                    parameters: z.record(z.string(), z.unknown()).optional().describe("Key fields for read-single (e.g. { DocEntry: 1 }). Omit for list reads."),
                    filterString: z.string()
                        .max(2000, "filterString must not exceed 2000 characters")
                        // eslint-disable-next-line no-control-regex
                        .refine(s => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s), "filterString contains invalid control characters")
                        .optional()
                        .describe("OData $filter without prefix. Example: \"DocTotal gt 1000\"."),
                    selectString: z.string()
                        .max(500, "selectString must not exceed 500 characters")
                        .refine(s => /^[\w,\s/]*$/.test(s), "selectString must contain only word characters, commas, spaces, and slashes")
                        .optional()
                        .describe("Comma-separated fields to return. Example: \"DocEntry,DocNum,CardCode\"."),
                    orderbyString: z.string()
                        .max(200, "orderbyString must not exceed 200 characters")
                        .refine(s => /^[\w,\s/]*$/.test(s), "orderbyString must contain only word characters, commas, and spaces")
                        .optional()
                        .describe("OData $orderby without prefix. Example: \"DocDate desc\"."),
                    topNumber: z.number().optional().describe("Number of records to return."),
                    skipNumber: z.number().optional().describe("Number of records to skip (for pagination).")
                },
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false
                }
            },
            async (args: Record<string, unknown>, extra?: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
                executeEntityReadOperation(args, this.getEntityOperationContext(extra ? { sendRequest: extra.sendRequest } : undefined))
        );

        // Step 3b: Write execution
        this.mcpServer.registerTool(
            "b1_write",
            {
                title: "Write SAP B1 Entity Data",
                description: "Executes write operations on SAP B1 Service Layer entities: create, update, and delete. Requires elicitation confirmation before execution.",
                inputSchema: {
                    entityName: z.string().describe("B1 entity name from b1_find_entities results. Examples: 'Items', 'BusinessPartners', 'Orders', 'Invoices'. Use the 'entityName' field exactly as returned (case-sensitive)."),
                    operation: z.enum(['create', 'update', 'delete']).describe("'create' adds a new entity; 'update' modifies an existing one by key; 'delete' removes one by key."),
                    parameters: z.record(z.string(), z.unknown()).describe("Entity data as a flat object. create: body fields only. update: key fields + fields to change (keys identify the record; handler separates them automatically). delete: key fields only.")
                },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: true,
                    idempotentHint: false,
                    openWorldHint: true
                }
            },
            async (args: Record<string, unknown>, extra?: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
                executeEntityWriteOperation(args, this.getEntityOperationContext(extra ? { sendRequest: extra.sendRequest } : undefined))
        );

        // Workflow Tool 1: Copy Document
        this.mcpServer.registerTool(
            "b1_copy_document",
            {
                title: "Copy Sales Document",
                description: "Creates a new sales document by copying an existing source document, automatically resolving BaseType, BaseEntry, and BaseLine references. Supports standard B1 flows: Order→Delivery, Delivery→Invoice, Order→Invoice. Use `lineSelections` to copy specific lines only; omit to copy all. Use `additionalFields` to override header fields. The final document creation requires a client-supported elicitation confirmation.",
                inputSchema: {
                    sourceEntityName: z.string().describe("Source entity name. Examples: 'Orders', 'DeliveryNotes', 'Invoices'."),
                    sourceDocEntry: z.number().describe("DocEntry of the source document to copy from"),
                    targetEntityName: z.string().describe("Target entity name to create. Examples: 'DeliveryNotes', 'Invoices'."),
                    lineSelections: z.array(z.number()).optional().describe("Zero-based line indexes to copy. Omit to copy all lines."),
                    additionalFields: z.record(z.string(), z.any()).optional().describe("Optional header fields to add or override in the target document. Example: {\"Comments\": \"Urgent delivery\"}")
                },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: true
                }
            },
            async (args: Record<string, unknown>, extra?: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
                createDocumentFromBase(args, this.getWorkflowContext(extra ? { sendRequest: extra.sendRequest } : undefined))
        );

        // Workflow Tool 2: Create Payment
        this.mcpServer.registerTool(
            "b1_create_payment",
            {
                title: "Create Incoming Payment",
                description: "Validates and creates an incoming payment for one or more A/R invoices. Fetches open balances, allocates the payment amount automatically (oldest-first) or manually per invoice, then creates the IncomingPayments record. Set `validateOnly` to true to check allocations without posting; omit or set to false to validate and post. Posting the payment requires a client-supported elicitation confirmation.",
                inputSchema: {
                    cardCode: z.string().describe("Business Partner code (CardCode) for the payment. All invoices must belong to this BP."),
                    invoiceDocEntries: z.array(z.number()).describe("Array of invoice DocEntry numbers to pay. Example: [123, 456] for paying two invoices."),
                    paymentAmount: z.number().describe("Total payment amount to allocate across invoices"),
                    allocationType: z.enum(['auto', 'manual']).optional().describe("'auto' allocates oldest-first; 'manual' requires manualAllocations. Default: 'auto'."),
                    manualAllocations: z.array(z.object({
                        docEntry: z.number(),
                        amountToApply: z.number()
                    })).optional().describe("Required if allocationType='manual'. Specify exact amount per invoice. Example: [{\"docEntry\": 123, \"amountToApply\": 500}]"),
                    transferAccount: z.string().optional().describe("G/L account for bank transfer. Default: '_SYS00000000001'."),
                    transferDate: z.string().optional().describe("Payment date in YYYY-MM-DD format. Default: today"),
                    transferReference: z.string().optional().describe("Payment reference/check number"),
                    remarks: z.string().optional().describe("Payment remarks/notes"),
                    validateOnly: z.boolean().optional().describe("If true, validates allocations without posting. Default: false (validate and post).")
                },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: true
                }
            },
            async (args: Record<string, unknown>, extra?: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
                preparePaymentForInvoices(args, this.getWorkflowContext(extra ? { sendRequest: extra.sendRequest } : undefined))
        );

        // Register company selection tools when in OAuth mode
        this.companySelectionToolRegistry?.registerCompanySelectionTools();
    }

    // -----------------------------------------------------------------------
    // Resource registration
    // -----------------------------------------------------------------------

    public registerServiceMetadataResources(): void {
        this.mcpServer.registerResource(
            "b1-service-metadata",
            "b1://service-layer/metadata",
            {
                title: "SAP Business One (B1) Service Layer Metadata",
                description: "Metadata for the SAP Business One Service Layer: entity list with names."
            },
            async (uri) => {
                const discoveredServices = await this.discoveryService.getDiscoveredServices(
                    this.companyId,
                    this.sapClient.getB1Client()
                );
                const service = discoveredServices[0];
                if (!service) throw new Error("SAP B1 Service Layer not yet discovered");
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify({
                            service: { id: service.id, title: service.title, description: service.description, url: service.url, version: service.version },
                            entities: service.metadata?.entities?.map(entity => ({
                                name: entity.name
                            })) || []
                        }, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );

        this.mcpServer.registerResource(
            "b1-constants",
            new ResourceTemplate("b1://constants/{category}", { list: undefined }),
            {
                title: "SAP Business One Constants and Reference Data",
                description: "Static reference data for SAP B1 including object type codes (Orders=17, DeliveryNotes=15, Invoices=13), document flows (Order→Delivery→Invoice→Payment), field patterns, status codes, and payment types. Available as contextual knowledge - no tool call needed. Categories: objectTypes, documentFlows, fieldPatterns, statuses, paymentTypes, all."
            },
            async (uri, variables) => {
                const category = (variables.category as string) || 'all';
                const result: Record<string, unknown> = {};

                if (category === 'all' || category === 'objectTypes') result.objectTypes = B1_OBJECT_TYPES;
                if (category === 'all' || category === 'documentFlows') result.documentFlows = B1_DOCUMENT_FLOWS;
                if (category === 'all' || category === 'fieldPatterns') result.fieldPatterns = B1_FIELD_PATTERNS;
                if (category === 'all' || category === 'statuses') result.statuses = { documentStatus: B1_DOCUMENT_STATUS, lineStatus: B1_LINE_STATUS };
                if (category === 'all' || category === 'paymentTypes') result.paymentTypes = { paymentTypes: B1_PAYMENT_TYPES, bpTypes: B1_BP_TYPES };

                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(result, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );

        this.logger.info('Registered SAP metadata resources + B1 constants resources');
    }
}
