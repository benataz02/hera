# 3-Step Progressive Discovery Architecture

## Overview

The SAP Business One Service Layer OData MCP Server uses a **progressive discovery architecture** optimized for LLM token efficiency and clear workflow separation. This approach solves the "tool explosion" problem by reducing 300+ individual CRUD tools down to just a few intelligent tools.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant                            │
└─────────────────────────────────────────────────────────────────┘
                                  │
         ┌────────────────────────┴──────────────────────────┐
         │              Data Operations (3 Steps)           │
         └────────────────────────────────────────────────────┘
                  │                 │                 │
        ┌─────────▼─────────┐  ┌───▼──────┐  ┌──────▼────────┐
        │   Step 1          │  │ Step 2   │  │  Step 3       │
        │   Discovery       │  │ Metadata │  │  Execution    │
        │                   │  │          │  │               │
        │ Minimal data      │  │ Full     │  │ Authenticated │
        │ for decision      │  │ schema   │  │ CRUD Operation│
        └───────────────────┘  └──────────┘  └───────────────┘
                  │                 │                 │
                  └─────────────────┴─────────────────┘
                                    │
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │      SAP Business One Service Layer OData API           │
        └─────────────────────────────────────────────────────────┘
```

When integrating Service Layer with LLM-based automation (e.g., Copilot, Claude, Cline), a naive approach would register hundreds of CRUD tools (5 ops × 300+ entities). This leads to:
- **Token overflow**: LLM context is flooded with tool definitions
- **Poor tool selection**: LLM struggles to pick the right tool
- **Slow performance**: Tool registry and LLM context become bloated

---

## Data Operations (Steps 1-3)

## Step 1: b1_find_entities

### Purpose
Lightweight search and discovery of SAP services and entities with **minimal token usage**.

### Returns
Only essential fields for LLM decision-making:
- `entityName` - Entity name
- `categories` - Business area categories

### Behavior
1. **With Query**: Returns services/entities matching the search term
2. **No Matches**: Automatically returns ALL available services (still minimal fields)
3. **No Query**: Returns complete service catalog (minimal fields)

### Examples

```javascript
// Search for BusinessPartners-related entities
{
  "query": "BusinessPartners",
  "limit": 20
}
```

**Response (minimal):**
```json
{
  "query": "businesspartners",
  "totalFound": 1,
  "matches": [
    {
      "entityName": "BusinessPartners",
      "description": "Business Partners",
      "categories": [
        "business-partner",
        "master-data"
      ]
    }
  ]
}
```

### Token Efficiency
- Returns ~90% less data than full schemas
- Typical response: 10-30KB vs 1800KB with full schemas
- Allows LLM to quickly scan and select relevant entities

---

## Step 2: b1_get_entity_schema

### Purpose
Get **progressive schema details** for a specific entity after selection from Step 1.

### Returns
Step 2 has two modes:

- Step 2.1 entity schema: scalar properties, key properties, capabilities, and `structuralProperties[]`
- Step 2.2 structural type schema: the sub-properties of a selected structural type plus the reachable reference path(s) from the entity to that type

### Input

**Step 2.1: Entity schema**
```javascript
{
  "entityName": "BusinessPartners"
}
```

**Step 2.2: Structural type schema**
```javascript
{
  "entityName": "BusinessPartners",
  "structuralTypeName": "BPAddress"
}
```

### Output

**Step 2.1 response**
```json
{
  "entity": {
    "name": "BusinessPartner",
    "entitySet": "BusinessPartners",
    "namespace": "SAPB1",
    "keyProperties": ["CardCode"],
    "propertyCount": 333
  },
  "properties": [
    { "name": "CardCode", "type": "Edm.String", "maxLength": "15", "isKey": true },
    { "name": "CardName", "type": "Edm.String", "maxLength": "100", "isKey": false }
    // ... all other properties
  ],
  "structuralProperties": [
    { "name": "BPAddresses", "complexTypeName": "BPAddress", "isArray": true, "description": "Business Partners - Addresses" }
  ]
}
```

**Step 2.2 response**
```json
{
  "parentEntity": "BusinessPartners",
  "structuralTypeName": "BPAddress",
  "referencingProperties": [
    {
      "name": "BPAddresses",
      "path": "BPAddresses",
      "isArray": true,
      "description": "Business Partners - Addresses",
      "depth": 1
    }
  ],
  "propertyCount": 20,
  "properties": [
    { "name": "AddressName", "type": "Edm.String", "maxLength": "50" },
    { "name": "Street", "type": "Edm.String", "maxLength": "100" }
  ],
  "nestedStructuralProperties": []
}
```

### Discovery Flow For Nested Types

- Call Step 2.1 with only `entityName` to get the entity schema and top-level `structuralProperties[]`
- Call Step 2.2 with a top-level structural type such as `DocumentLine` from `Orders` or `BPAddress` from `BusinessPartners` to get the schema for that type.
- If that response contains `nestedStructuralProperties[]`, you can call Step 2.2 again with one of those nested `complexTypeName` values, such as `LineTaxJurisdiction` referenced by `DocumentLine`, to get the schema for that deeper type.
- Use `referencingProperties[].path` to understand where that structural type appears in the entity payload

### Use Cases
- Understanding entity structure before CRUD operations
- Expanding complex and collection properties progressively
- Expanding deeply nested complex types without guessing payload paths
- Checking operation capabilities
- Building proper OData queries

---

## Step 3: b1_read and b1_write

### Purpose
Execute authenticated operations on SAP entities using metadata from Step 2.

### Operations by Tool
- `b1_read`: `read`, `read-single`
- `b1_write`: `create`, `update`, `delete`

### Input Examples
```javascript
// Read orders over $1000
{
  "entityName": "Orders",
  "operation": "read",
  "filterString": "DocTotal gt 1000",
  "selectString": "DocEntry,DocNum,CardCode,DocTotal",
  "topNumber": 10
}

// Read single order
{
  "entityName": "Orders",
  "operation": "read-single",
  "parameters": { "DocEntry": 12345 }
}

// Create a purchase order
{
  "entityName": "PurchaseOrders",
  "operation": "create",
  "parameters": {
    "CardCode": "V00001",
    "DocDate": "2025-12-25",
    "Comments": "Created via MCP",
    "DocumentLines": [
      { "ItemCode": "A00001", "Quantity": 10, "Price": 100.00 }
    ]
  }
}

// Update a business partner
{
  "entityName": "BusinessPartners",
  "operation": "update",
  "parameters": {
    "CardCode": "C00001",
    "Phone1": "123-456-7890"
  }
}

```

### OData Options
- `filterString` - OData $filter (without prefix)
- `selectString` - OData $select (without prefix)
- `orderbyString` - OData $orderby (without prefix)
- `topNumber` - OData $top limit
- `skipNumber` - OData $skip offset
- `parameters` - Entity data for create/update/delete

### Read Redaction Behavior

- If `selectString` is omitted, empty, or whitespace-only, personal fields are redacted across the full read response.
- If `selectString` is meaningful and contains only scalar properties, the response returns those explicitly selected scalar fields.
- If `selectString` is meaningful and includes complex properties such as `DocumentLines` or `AddressExtension`, explicitly selected scalar fields remain visible, but personal fields are still redacted inside those selected complex properties.

Example:

```javascript
{
  "tool": "b1_read",
  "entityName": "BusinessPartners",
  "operation": "read",
  "selectString": "CardCode, CardName, Address, ZipCode, CardType, MailAddress, BPAddresses"
}
```

With this selection, top-level scalar fields such as `CardCode`, `CardName`, and `Address` stay visible, while nested personal fields inside `BPAddresses` are redacted.


---

## Complete Workflow Examples

### Standard Workflow (3 Steps)

**Scenario: "Update business partner C00001 to set phone number"**

#### Step 1: Search Entity
```javascript
{
  "query": "BusinessPartners"
}
```

**Response**: Minimal list showing BusinessPartners entity exists in categories `business-partner`, `master-data`

#### Step 2: Get Schema
```javascript
{
  "entityName": "BusinessPartners"
}
```

**Response**: Full schema showing:
- Key: CardCode
- Phone1 property exists: `Phone1` (Edm.String)
- Updatable: true
- Top-level structural properties are available in `structuralProperties[]`; deeper structural types can be expanded in follow-up Step 2.2 calls using `nestedStructuralProperties[]`

#### Step 3: Execute Update (b1_write)
```javascript
{
  "entityName": "BusinessPartners",
  "operation": "update",
  "parameters": {
    "CardCode": "C00001",
    "Phone1": "123-456-7890"
  }
}
```

**Result**: Business partner updated successfully

---

## LLM Instructions

### Recommended Workflow

```
ALWAYS follow this workflow:

1. Call b1_find_entities to find relevant entities
   → Returns minimal list for quick scanning

2. Call b1_get_entity_schema for selected entity
  → Returns entity schema first; call again with `structuralTypeName` for top-level or nested structural type details as needed

3. Call b1_read for read operations or b1_write for create/update/delete
  → Uses schema from step 2 to execute

NEVER skip Step 2 (b1_get_entity_schema)!
```

### Common Mistakes to Avoid

**Skipping Step 2 (b1_get_entity_schema)**
```
b1_find_entities → b1_write
(Missing schema details!)
```

**Calling Step 1 multiple times**
```
b1_find_entities → b1_find_entities → b1_find_entities
(Use results from first call!)
```

**Correct Flow**
```
b1_find_entities → b1_get_entity_schema → b1_read/b1_write
```
---

## Workflow Tool Discovery

Call `b1_find_entities` with `category='workflow'` to discover the available workflow tools without needing to know their names in advance:

```javascript
await mcpClient.callTool('b1_find_entities', { category: 'workflow' });
```

**Response**:
```json
{
  "category": "workflow",
  "tools": [
    {
      "toolName": "b1_copy_document",
      "description": "Copy a B1 document to create a downstream document (Order→Delivery, Delivery→Invoice, Order→Invoice). Handles BaseType/BaseEntry/BaseLine automatically.",
      "keyParameters": ["sourceEntityName", "sourceDocEntry", "targetEntityName"]
    },
    {
      "toolName": "b1_create_payment",
      "description": "Create an incoming payment for one or more A/R invoices with automatic or manual allocation.",
      "keyParameters": ["cardCode", "invoiceDocEntries", "paymentAmount"]
    }
  ]
}
```

These tools encapsulate multi-step B1 logic (BaseEntry/BaseLine resolution, invoice allocation) that cannot be replicated with a single `b1_read` or `b1_write` call.

---

## Conclusion

The 3-Step progressive discovery architecture provides:
- **Optimal token efficiency** for LLM interactions
- **Clear workflow separation** for better UX
- **Progressive detail** for smarter data loading
- **Better scalability** as entity count grows
