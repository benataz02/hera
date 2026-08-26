# Developer Guide

## Overview

This guide helps developers extend this SAP Business One Service Layer MCP Server sample by implementing new features, particularly new MCP tools. We'll use **adding support for creating documents from base documents** as a concrete example throughout this guide.

## Table of Contents

- [Developer Guide](#developer-guide)
  - [Overview](#overview)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
    - [Required Knowledge](#required-knowledge)
    - [Development Environment](#development-environment)
  - [Architecture Overview](#architecture-overview)
    - [System Components](#system-components)
    - [3-Step Discovery Pattern](#3-step-discovery-pattern)
  - [Adding a New Tool - Complete Workflow](#adding-a-new-tool---complete-workflow)
    - [Example: Adding Document Creation from Base Document](#example-adding-document-creation-from-base-document)
    - [Step 1: Research the Feature](#step-1-research-the-feature)
      - [1.1 Understand B1 Document-to-Document Creation](#11-understand-b1-document-to-document-creation)
      - [1.2 Test Document Creation with curl](#12-test-document-creation-with-curl)
    - [Step 2: Define Types](#step-2-define-types)
    - [Step 3: Add Service Layer Support](#step-3-add-service-layer-support)
    - [Step 4: Get Base Document Information (Helper Method)](#step-4-get-base-document-information-helper-method)
    - [Step 5: Create Service Class (Best Practice)](#step-5-create-service-class-best-practice)
    - [Step 6: Register the MCP Tool](#step-6-register-the-mcp-tool)
    - [Step 7: Add Constants (If Needed)](#step-7-add-constants-if-needed)
    - [Step 8: Write Tests](#step-8-write-tests)
    - [Step 10: Test End-to-End](#step-10-test-end-to-end)
  - [Key Files \& Their Roles](#key-files--their-roles)
    - [Core Files](#core-files)
    - [Service Classes (Pattern)](#service-classes-pattern)
    - [Configuration \& Utilities](#configuration--utilities)
    - [Constants \& Reference Data](#constants--reference-data)
  - [Implementation Patterns](#implementation-patterns)
    - [Pattern 1: MCP Tool Registration](#pattern-1-mcp-tool-registration)
    - [Pattern 2: Error Handling](#pattern-2-error-handling)
    - [Pattern 3: Service Class Structure](#pattern-3-service-class-structure)
    - [Pattern 4: Response Formatting](#pattern-4-response-formatting)
  - [Testing](#testing)
    - [Unit Tests with Vitest](#unit-tests-with-vitest)
    - [Integration Testing](#integration-testing)
    - [Testing Checklist](#testing-checklist)
  - [Documentation](#documentation)
    - [Code Documentation (JSDoc)](#code-documentation-jsdoc)
  - [Best Practices](#best-practices)
    - [1. Follow Existing Patterns](#1-follow-existing-patterns)
    - [2. Error Handling](#2-error-handling)
    - [3. Type Safety](#3-type-safety)
    - [4. Testing](#4-testing)
    - [5. Performance](#5-performance)
    - [6. Security](#6-security)
  - [Troubleshooting](#troubleshooting)
    - [Common Issues](#common-issues)
      - [Tool Not Appearing in MCP Client](#tool-not-appearing-in-mcp-client)
      - [Authentication Errors](#authentication-errors)
      - [Type Errors](#type-errors)
      - [Metadata Parsing Errors](#metadata-parsing-errors)
  - [Additional Resources](#additional-resources)
  - [Conclusion](#conclusion)


---

## Prerequisites

### Required Knowledge

- **TypeScript**: Strong understanding of TypeScript, generics, and type safety
- **OData Protocol**: Understanding of OData v4 (queries, operations, metadata)
- **SAP Business One Service Layer**: Familiarity with B1 Service Layer API structure
- **MCP Protocol**: Basic understanding of Model Context Protocol
- **Node.js**: Experience with async/await, Promises, and Node.js APIs

### Development Environment

```bash
# 1. install
# Requires Node.js >=22.22.3 and npm >=10.9.8
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your B1 Service Layer credentials

# 3. Build and test
npm run build
npm test

# 4. Start server
npm start
```

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Assistant (Cline/Claude)              │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP Protocol
┌────────────────────────▼────────────────────────────────────┐
│              MCP Server (this project)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  B1SAPToolRegistry                         │   │
│  │  - Registers all MCP tools                           │   │
│  │  - Step 1: b1_find_entities                        │   │
│  │  - Step 2: b1_get_entity_schema                    │   │
│  │  - Step 3a: b1_read                                │   │
│  │  - Step 3b: b1_write                               │   │
│  │  - Workflow helpers (document, payment, etc.)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │  Service Layer (b1-service-layer.ts)                  │  │
│  │  - Session management                                 │  │
│  │  - HTTPS communication                           │  │
│  │  - Authentication (username/password or OAuth)        │  │
│  └──────────────────────┬────────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────▼────────────────────────────────────┐
│        SAP Business One Service Layer OData API              │
│        - Entities (Orders, Invoices, BusinessPartners)       │
│        - Functions (Login, Logout, business logic)           │
│        - Metadata ($metadata)                                │
└──────────────────────────────────────────────────────────────┘
```

### 3-Step Discovery Pattern

This server uses a progressive discovery architecture to avoid tool explosion:

1. **Step 1: b1_find_entities** - Lightweight search (minimal fields)
2. **Step 2: b1_get_entity_schema** - Progressive schema details for both entity-level and nested structural types
3. **Step 3a: b1_read** - Read and read-single operations
4. **Step 3b: b1_write** - Create/update/delete operations

See [THREE_STEP_APPROACH.md](./THREE_STEP_APPROACH.md) for details.

---

## Adding a New Tool - Complete Workflow

### Example: Adding Document Creation from Base Document

SAP Business One supports creating new documents based on existing documents (e.g., creating an Invoice from an Order, or an Order from a Quote). This is a common business workflow that requires special handling. Let's add MCP tool support for this feature.

### Step 1: Research the Feature

#### 1.1 Understand B1 Document-to-Document Creation

```bash
# Get B1 Service Layer metadata
curl -k https://localhost:50000/b1s/v2/$metadata > metadata.xml

# Search for document entities
grep "EntityType.*Document" metadata.xml
```

Example document entity relationship from B1:

```
Quote (Quotations) → Order (Orders) → Delivery (DeliveryNotes) → A/R Invoice (Invoices)
Purchase Order (PurchaseOrders) → Goods Receipt PO (PurchaseDeliveryNotes) → A/P Invoice (PurchaseInvoices)
```

Key fields for document-to-document creation:
- `BaseType`: Source document object type (e.g., "17" for Orders)
- `BaseEntry`: Source document DocEntry (primary key)
- `BaseLine`: Source document line number (for line-level copying)

#### 1.2 Test Document Creation with curl

```bash
# Login first to get session
curl -k -X POST https://localhost:50000/b1s/v2/Login \
  -H "Content-Type: application/json" \
  -d '{"CompanyDB": "SBODEMOUS", "UserName": "manager", "Password": "password"}' \
  -c cookies.txt

# Create Invoice from Order (simplified example)
curl -k -X POST https://localhost:50000/b1s/v2/Invoices \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "CardCode": "C20000",
    "DocumentLines": [
      {
        "ItemCode": "A00001",
        "Quantity": 10,
        "BaseType": 17,
        "BaseEntry": 123,
        "BaseLine": 0
      }
    ]
  }'
```

### Step 2: Define Types

Create type definitions in `src/types/b1-types.ts`:

```typescript
/**
 * Base document reference for document-to-document creation
 */
export interface B1BaseDocumentLine {
    BaseType: number;      // Source document object type (e.g., 17 for Orders)
    BaseEntry: number;     // Source document DocEntry
    BaseLine: number;      // Source document line number
    Quantity?: number;     // Optional: Override quantity
    ItemCode?: string;     // Item code (usually copied from base)
}

/**
 * Document creation request with base document reference
 */
export interface B1DocumentFromBaseRequest {
    targetEntity: string;                    // Target entity (e.g., "Invoices")
    CardCode: string;                        // Business partner code
    DocumentLines: B1BaseDocumentLine[];     // Lines with base document references
    additionalFields?: Record<string, unknown>;  // Optional additional fields
}

/**
 * Document creation result
 */
export interface B1DocumentCreationResult {
    success: boolean;
    docEntry?: number;     // Created document's DocEntry
    docNum?: number;       // Created document's DocNum
    error?: string;
}
```

### Step 3: Add Service Layer Support

Update `src/services/b1-service-layer.ts` to support document creation:

```typescript
/**
 * Create a document with base document reference
 * @param entityName Target entity name (e.g., "Invoices")
 * @param documentData Document data including base document references
 * @returns Created document result
 */
async createDocumentFromBase(
    entityName: string,
    documentData: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
    this.logger.debug(`Creating ${entityName} from base document`);
    
    return this.request({
        url: entityName,
        method: 'POST',
        data: documentData,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Prefer': 'return=representation'  // Return created document
        }
    });
}
```

### Step 4: Get Base Document Information (Helper Method)

Optionally, add a helper method to fetch the base document details. This can be useful for validation:

```typescript
/**
 * Get base document details for validation
 * @param entityName Source entity name (e.g., "Orders")
 * @param docEntry Source document DocEntry
 * @returns Document details
 */
async getBaseDocument(
    entityName: string,
    docEntry: number
): Promise<{ status: number; data: unknown }> {
    this.logger.debug(`Fetching ${entityName}(${docEntry}) for base document validation`);
    
    return this.request({
        url: `${entityName}(${docEntry})`,
        method: 'GET',
        headers: {
            'Accept': 'application/json'
        }
    });
}
```

This step is optional but helps validate that the base document exists before attempting to create from it.

### Step 5: Create Service Class (Best Practice)

Create `src/services/b1-document-creation-service.ts`:

```typescript
import { SAPClient } from './sap-client.js';
import { Logger } from '../utils/logger.js';
import { 
    B1DocumentFromBaseRequest, 
    B1DocumentCreationResult 
} from '../types/b1-types.js';

export class B1DocumentCreationService {
    constructor(
        private readonly sapClient: SAPClient,
        private readonly logger: Logger,
        private readonly serviceUrl: string
    ) {}

    /**
     * Create a document from a base document with validation
     */
    async createFromBase(
        request: B1DocumentFromBaseRequest
    ): Promise<B1DocumentCreationResult> {
        try {
            this.logger.info(`Creating ${request.targetEntity} from base document`);
            
            // Validate inputs
            this.validateRequest(request);
            
            // Build document data
            const documentData: Record<string, unknown> = {
                CardCode: request.CardCode,
                DocumentLines: request.DocumentLines,
                ...request.additionalFields
            };
            
            // Create the document
            const response = await this.sapClient.request({
                serviceUrl: this.serviceUrl,
                path: request.targetEntity,
                method: 'POST',
                data: documentData
            });
            
            // Extract DocEntry and DocNum from response
            const createdDoc = response.data as Record<string, unknown>;
            
            return {
                success: true,
                docEntry: createdDoc.DocEntry as number,
                docNum: createdDoc.DocNum as number
            };
            
        } catch (error) {
            this.logger.error(`Error creating document from base:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    
    /**
     * Helper: Validate request inputs
     */
    private validateRequest(request: B1DocumentFromBaseRequest): void {
        if (!request.targetEntity || request.targetEntity.trim() === '') {
            throw new Error('Target entity is required');
        }
        
        if (!request.CardCode || request.CardCode.trim() === '') {
            throw new Error('CardCode (Business Partner) is required');
        }
        
        if (!request.DocumentLines || request.DocumentLines.length === 0) {
            throw new Error('At least one document line is required');
        }
        
        // Validate each line has required base document fields
        request.DocumentLines.forEach((line, index) => {
            if (!line.BaseType) {
                throw new Error(`Line ${index}: BaseType is required`);
            }
            if (!line.BaseEntry) {
                throw new Error(`Line ${index}: BaseEntry is required`);
            }
            if (line.BaseLine === undefined) {
                throw new Error(`Line ${index}: BaseLine is required`);
            }
        });
    }
}
```

### Step 6: Register the MCP Tool

Update `src/tools/b1-tool-registry.ts`:

```typescript
import { B1DocumentService } from '../services/b1-document-service.js';

export class B1SAPToolRegistry {
    // ... existing code ...
    public async registerDiscoveryTools(): Promise<void> {
        // ... Step 1/2/3 tool registration ...

        this.mcpServer.registerTool(
            'b1_copy_document',
            {
                title: 'Copy Sales Document',
                description:
                    'Creates a new sales document by copying an existing source document, automatically resolving ' +
                    'BaseType, BaseEntry, and BaseLine references. Supports standard B1 flows: Order→Delivery, ' +
                    'Delivery→Invoice, Order→Invoice. Use lineSelections to copy specific lines only; omit to copy all. ' +
                    'Use additionalFields to override header fields.',
                inputSchema: {
                    sourceEntityName: z.string().describe("Source entity name. Examples: 'Orders', 'DeliveryNotes', 'Invoices'."),
                    sourceDocEntry: z.number().describe('DocEntry of the source document to copy from'),
                    targetEntityName: z.string().describe("Target entity name to create. Examples: 'DeliveryNotes', 'Invoices'."),
                    lineSelections: z.array(z.number()).optional().describe('Zero-based line indexes to copy. Omit to copy all lines.'),
                    additionalFields: z.record(z.any()).optional().describe('Optional header fields to add or override in the target document.')
                }
            },
            async (args: Record<string, unknown>) => {
                return this.createDocumentFromBase(args);
            }
        );
    }
    
    /**
     * Create document from base
     */
    private async createDocumentFromBase(args: Record<string, unknown>) {
        try {
            const sourceEntityName = args.sourceEntityName as string;
            const sourceDocEntry = args.sourceDocEntry as number;
            const targetEntityName = args.targetEntityName as string;
            const lineSelections = args.lineSelections as number[] | undefined;
            const additionalFields = args.additionalFields as Record<string, unknown> | undefined;

            // Validate service
            const service = this.discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
            if (!service) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: 'ERROR: SAP B1 Service Layer not initialized.'
                    }],
                    isError: true
                };
            }
            
            // Create document workflow service
            const documentService = new B1DocumentService(
                this.sapClient,
                this.logger,
                service.url
            );

            // Create document
            const result = await documentService.createDocumentFromBase(
                sourceEntityName,
                sourceDocEntry,
                targetEntityName,
                lineSelections,
                additionalFields
            );
            
            if (!result.success) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `ERROR: ${result.error}\n\nSource: ${result.sourceDocument.entityName} DocEntry ${result.sourceDocument.docEntry}`
                    }],
                    isError: true
                };
            }

            let responseText = `SUCCESS: Created ${result.targetDocument?.entityName} from ${result.sourceDocument.entityName}\n\n`;
            responseText += `Source Document:\n`;
            responseText += `  - Entity: ${result.sourceDocument.entityName}\n`;
            responseText += `  - DocEntry: ${result.sourceDocument.docEntry}\n`;
            responseText += `  - DocNum: ${result.sourceDocument.docNum}\n\n`;
            responseText += `Target Document Created:\n`;
            responseText += `  - Entity: ${result.targetDocument?.entityName}\n`;
            responseText += `  - DocEntry: ${result.targetDocument?.docEntry}\n`;
            responseText += `  - DocNum: ${result.targetDocument?.docNum}\n`;
            
            return {
                content: [{
                    type: 'text' as const,
                    text: responseText
                }]
            };
            
        } catch (error) {
            this.logger.error('Error creating document from base:', error);
            return {
                content: [{
                    type: 'text' as const,
                    text: `ERROR: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }
}
```

### Step 7: Add Constants (If Needed)

Update `src/tools/b1-constants.ts` with document object type mappings:

```typescript
/**
 * Common B1 document object types for base document references
 */
export const B1_DOCUMENT_OBJECT_TYPES: Record<string, number> = {
    // Sales Documents
    QUOTATION: 23,
    ORDER: 17,
    DELIVERY: 15,
    RETURN: 16,
    INVOICE: 13,
    CREDIT_NOTE: 14,
    DOWN_PAYMENT_REQUEST: 203,
    DOWN_PAYMENT_INVOICE: 203,
    
    // Purchasing Documents
    PURCHASE_QUOTATION: 540000006,
    PURCHASE_ORDER: 22,
    GOODS_RECEIPT_PO: 20,
    GOODS_RETURN: 21,
    AP_INVOICE: 18,
    AP_CREDIT_NOTE: 19,
    AP_DOWN_PAYMENT_REQUEST: 204,
    AP_DOWN_PAYMENT_INVOICE: 204
};

/**
 * Valid document-to-document workflows
 */
export const B1_DOCUMENT_WORKFLOWS: Record<string, {
    from: number;
    to: string;
    description: string;
}[]> = {
    'Sales Cycle': [
        { from: 23, to: 'Orders', description: 'Quotation → Order' },
        { from: 17, to: 'DeliveryNotes', description: 'Order → Delivery' },
        { from: 17, to: 'Invoices', description: 'Order → Invoice' },
        { from: 15, to: 'Invoices', description: 'Delivery → Invoice' }
    ],
    'Purchasing Cycle': [
        { from: 22, to: 'PurchaseDeliveryNotes', description: 'PO → Goods Receipt' },
        { from: 22, to: 'PurchaseInvoices', description: 'PO → AP Invoice' },
        { from: 20, to: 'PurchaseInvoices', description: 'Goods Receipt → AP Invoice' }
    ]
};
```

### Step 8: Write Tests

Create `src/tests/unit/b1-document-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { B1DocumentService } from '../src/services/b1-document-service.js';
import { SAPClient } from '../src/services/sap-client.js';
import { Logger } from '../src/utils/logger.js';

describe('B1DocumentService', () => {
    let docService: B1DocumentService;
    let mockSAPClient: SAPClient;
    let mockLogger: Logger;
    
    beforeEach(() => {
        mockSAPClient = {
            readEntity: vi.fn(),
            createEntity: vi.fn()
        } as unknown as SAPClient;

        mockLogger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        } as unknown as Logger;

        docService = new B1DocumentService(
            mockSAPClient,
            mockLogger,
            'https://localhost:50000/b1s/v2/'
        );
    });
    
    it('returns error for unsupported document flow', async () => {
        const result = await docService.createDocumentFromBase('Orders', 123, 'PurchaseOrders');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid document flow');
        expect((mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
        expect((mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
    
    it('creates target document from source with base references', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 123,
                DocNum: 'SO-1001',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: [{ ItemCode: 'A00001', Quantity: 2, Price: 50 }]
            }
        });

        (mockSAPClient.createEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: { DocEntry: 456, DocNum: 'INV-2001' }
        });

        const result = await docService.createDocumentFromBase('Orders', 123, 'Invoices', [0]);

        expect(result.success).toBe(true);
        expect(result.targetDocument?.docEntry).toBe(456);
        expect(result.targetDocument?.entityName).toBe('Invoices');
    });
    
    it('returns error when selected lines are out of range', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 123,
                DocNum: 'SO-1001',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: [{ ItemCode: 'A00001', Quantity: 2 }]
            }
        });

        const result = await docService.createDocumentFromBase('Orders', 123, 'Invoices', [99]);

        expect(result.success).toBe(false);
        expect(result.error).toBe('No valid lines to copy');
    });
    
    it('validateSourceDocument returns invalid when source has no lines', async () => {
        (mockSAPClient.readEntity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: {
                DocEntry: 321,
                DocNum: 'SO-4321',
                CardCode: 'C20000',
                CardName: 'ACME Corp',
                DocDate: '2026-03-20',
                DocDueDate: '2026-03-25',
                DocumentLines: []
            }
        });

        const result = await docService.validateSourceDocument('Orders', 321);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('has no lines to copy');
    });
});
```

### Step 10: Test End-to-End

```bash
# 1. Build
npm run build

# 2. Run unit tests
npm test

# 3. Start server
npm start

# 4. Test with MCP Inspector
npm run inspect -- http://localhost:3000/mcp

# 5. Test the tool manually in the inspector
# Call b1_copy_document with test parameters:
# {
#   "sourceEntityName": "Orders",
#   "sourceDocEntry": 123,
#   "targetEntityName": "Invoices",
#   "lineSelections": [0, 1]
# }

# 6. Test with Cline in VS Code
# - Add the MCP server to your Cline configuration
# - Ask: "Create an invoice from order 123"
# - Verify the tool is called correctly and the document is created
```

---

## Key Files & Their Roles

### Core Files

| File                                  | Purpose                                                                      | When to Modify                |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| `src/tools/b1-tool-registry.ts`       | **Tool Registration Hub** - All MCP tools are registered here                | Add/modify MCP tools          |
| `src/services/b1-service-layer.ts`    | **B1 API Communication** - Session management, authentication, HTTP requests | Add new B1 API operations     |
| `src/types/b1-types.ts`               | **B1 Type Definitions** - Types for B1 entities, metadata, functions         | Add new B1 data structures    |
| `src/services/b1-metadata-manager.ts` | **Metadata Parsing** - Lazy-loading entity schemas, ComplexTypes, Enums      | Add metadata parsing features |

### Service Classes (Pattern)

| File                                  | Purpose                         | When to Create                 |
| ------------------------------------- | ------------------------------- | ------------------------------ |
| `src/services/b1-document-service.ts` | Document-to-document operations | Specialized document workflows |
| `src/services/b1-payment-service.ts`  | Payment creation and validation | Payment-related operations     |

### Configuration & Utilities

| File                         | Purpose                         |
| ---------------------------- | ------------------------------- |
| `src/utils/config.ts`        | Environment variable management |
| `src/loggers/app-logger.ts`  | Logging with Winston            |
| `src/utils/error-handler.ts` | Global error handling           |

### Constants & Reference Data

| File                                | Purpose                                         |
| ----------------------------------- | ----------------------------------------------- |
| `src/tools/b1-constants.ts`         | B1 object types, document flows, field patterns |
| `src/tools/b1-category-mappings.ts` | Entity categorization for discovery             |

---

## Implementation Patterns

### Pattern 1: MCP Tool Registration

```typescript
// In b1-tool-registry.ts
this.mcpServer.registerTool(
    'tool-name',
    {
        title: 'Human-readable Title',
        description: 'Detailed description for AI assistant. Include context, examples, and constraints.',
        inputSchema: {
            param1: z.string()
                .describe('Parameter description with examples'),
            param2: z.number()
                .optional()
                .describe('Optional parameter description'),
            param3: z.record(z.any())
                .optional()
                .describe('Complex object parameter')
        }
    },
    async (args: Record<string, unknown>) => {
        return this.handleToolExecution(args);
    }
);
```

### Pattern 2: Error Handling

```typescript
private async handleToolExecution(args: Record<string, unknown>) {
    try {
        // 1. Validate inputs
        const param = args.param as string;
        if (!param) {
            return {
                content: [{
                    type: 'text' as const,
                    text: 'ERROR: Parameter is required'
                }],
                isError: true
            };
        }
        
        // 2. Execute operation
        const result = await this.executeOperation(param);
        
        // 3. Format success response
        return {
            content: [{
                type: 'text' as const,
                text: `SUCCESS: Operation completed\n\n${JSON.stringify(result, null, 2)}`
            }]
        };
        
    } catch (error) {
        // 4. Handle errors
        this.logger.error('Operation failed:', error);
        return {
            content: [{
                type: 'text' as const,
                text: `ERROR: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
        };
    }
}
```

### Pattern 3: Service Class Structure

```typescript
export class B1CustomService {
    constructor(
        private readonly sapClient: SAPClient,
        private readonly logger: Logger,
        private readonly serviceUrl: string
    ) {}
    
    /**
     * Main operation with business logic
     */
    async performOperation(
        param1: string,
        options?: {
            option1?: string;
            option2?: number;
        }
    ): Promise<{ success: boolean; result?: unknown; error?: string }> {
        try {
            // 1. Validate inputs
            this.validateInputs(param1);
            
            // 2. Execute operation
            const response = await this.sapClient.request({
                serviceUrl: this.serviceUrl,
                path: 'TargetEntity',
                method: 'POST',
                data: { param1, ...options }
            });
            
            // 3. Return structured result
            return {
                success: true,
                result: response.data
            };
            
        } catch (error) {
            this.logger.error('Operation failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    
    /**
     * Helper: Input validation
     */
    private validateInputs(param: string): void {
        if (!param || param.trim() === '') {
            throw new Error('Parameter is required');
        }
    }
}
```

### Pattern 4: Response Formatting

```typescript
// Success response with structured data
return {
    content: [{
        type: 'text' as const,
        text: [
            'SUCCESS: Operation completed',
            '',
            '== DETAILS ==',
            `- Field 1: ${result.field1}`,
            `- Field 2: ${result.field2}`,
            '',
            '== FULL RESULT ==',
            JSON.stringify(result, null, 2)
        ].join('\n')
    }]
};

// Error response with helpful hints
return {
    content: [{
        type: 'text' as const,
        text: [
            'ERROR: Operation failed',
            '',
            `Error Details: ${error.message}`,
            '',
            'TIP: Check that the entity exists and you have permissions.',
            '',
            'RETRY STRATEGY:',
            '1. Verify the entity name is correct',
            '2. Ensure you have a valid session',
            '3. Check B1 Service Layer is accessible'
        ].join('\n')
    }],
    isError: true
};
```

---

## Testing

### Unit Tests with Vitest

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('MyService', () => {
    let service: MyService;
    let mockClient: SAPClient;
    
    beforeEach(() => {
        mockClient = {
            request: vi.fn()
        } as unknown as SAPClient;
        
        service = new MyService(mockClient, new Logger('test'), 'http://test');
    });
    
    it('should handle successful operation', async () => {
        mockClient.request = vi.fn().mockResolvedValue({
            status: 200,
            data: { result: 'success' }
        });
        
        const result = await service.performOperation('test');
        
        expect(result.success).toBe(true);
        expect(result.result).toEqual({ result: 'success' });
    });
    
    it('should handle errors gracefully', async () => {
        mockClient.request = vi.fn().mockRejectedValue(new Error('API Error'));
        
        const result = await service.performOperation('test');
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('API Error');
    });
});
```

### Integration Testing

```bash
# 1. Set up test environment
cp .env.example .env.test
# Edit .env.test with test B1 instance

# 2. Run unit tests
npm test

# 3. Run integration tests (requires live B1 instance)
npm run test:integration

# 4. Test with real B1 instance
npm start
# Use MCP Inspector or Cline to test tools
```

### Testing Checklist

- [ ] Unit tests for service classes
- [ ] Unit tests for tool handlers
- [ ] Integration tests with mock B1 responses
- [ ] Manual testing with MCP Inspector
- [ ] End-to-end testing with Cline/VS Code
- [ ] Error scenario testing
- [ ] Performance testing (for metadata operations)

---

## Documentation

### Code Documentation (JSDoc)

```typescript
/**
 * Create a document from a base document
 * 
 * @param request - Document creation request with base document references
 * @param request.targetEntity - Target entity name (e.g., "Invoices", "Orders")
 * @param request.CardCode - Business Partner code
 * @param request.DocumentLines - Array of lines with base document references
 * @param request.additionalFields - Optional additional header fields
 * @returns Promise with document creation result including DocEntry and DocNum
 * 
 * @example
 * ```typescript
 * const result = await service.createFromBase({
 *   targetEntity: 'Invoices',
 *   CardCode: 'C20000',
 *   DocumentLines: [
 *     { BaseType: 17, BaseEntry: 123, BaseLine: 0 },
 *     { BaseType: 17, BaseEntry: 123, BaseLine: 1, Quantity: 5 }
 *   ],
 *   additionalFields: {
 *     Comments: 'Created from Order 123'
 *   }
 * });
 * 
 * if (result.success) {
 *   console.log(`Created document: ${result.docNum} (DocEntry: ${result.docEntry})`);
 * }
 * ```
 * 
 * @throws {Error} If request validation fails or B1 API returns error
 */
async createFromBase(
    request: B1DocumentFromBaseRequest
): Promise<B1DocumentCreationResult> {
    // Implementation
}
```

## Best Practices

### 1. Follow Existing Patterns

- Service classes in `src/services/`
- Types in `src/types/`
- Tool registration in `b1-tool-registry.ts`
- Constants in `src/tools/b1-constants.ts`

### 2. Error Handling

- Always return structured results: `{ success: boolean; result?: T; error?: string }`
- Log errors with context
- Provide helpful error messages for AI assistants
- Include retry strategies in error responses

### 3. Type Safety

- Define TypeScript interfaces for all data structures
- Use Zod schemas for MCP tool inputs
- Avoid `any` types where possible

### 4. Testing

- Write unit tests for all service classes
- Test error scenarios
- Use mocks for external dependencies

### 5. Performance

- Cache metadata when possible
- Use lazy-loading for large datasets
- Avoid N+1 query problems

### 6. Security

- Never log sensitive data (passwords, tokens)
- Validate all inputs
- Use environment variables for credentials

---

## Troubleshooting

### Common Issues

#### Tool Not Appearing in MCP Client

1. Check tool registration in `b1-tool-registry.ts`
2. Verify `registerDiscoveryTools()` calls your registration method
3. Rebuild: `npm run build`
4. Restart MCP server
5. Restart MCP client (Cline/VS Code)

#### Authentication Errors

1. Check `.env` file configuration
2. Verify B1 Service Layer is accessible
3. Check session cookie handling in `b1-service-layer.ts`
4. Test with curl to isolate issue

#### Type Errors

1. Run `npm run build` (tsc runs as part of the build)
2. Check type definitions in `src/types/`
3. Ensure imported types match actual usage

#### Metadata Parsing Errors

1. Download metadata: `curl -k https://localhost:50000/b1s/v2/$metadata > metadata.xml`
2. Inspect XML structure
3. Check namespace handling in `b1-metadata-manager.ts`
4. Verify element selectors match actual XML

---

## Additional Resources

- [SAP Business One Service Layer API Reference](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5ab2a5d99c3a63f3d/c1b8f2307e104e0fb7b5c2e859b55c0d.html)
- [OData v4 Specification](https://www.odata.org/documentation/)
- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

---

## Conclusion

This guide provides a complete workflow for adding new tools to the SAP Business One Service Layer MCP Server. By following these patterns and best practices, you can extend the server's capabilities while maintaining code quality and consistency.

Key takeaways:

- **Research first**: Understand B1 API behavior before coding
- **Follow patterns**: Use existing service classes as templates
- **Test thoroughly**: Unit tests + integration tests + manual testing
- **Document well**: Code comments + README updates + examples
