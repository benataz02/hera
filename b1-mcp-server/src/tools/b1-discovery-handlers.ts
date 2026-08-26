/**
 * Discovery handler — Step 1 of the 3-step progressive discovery flow.
 */

import { B1Client } from '../services/b1-client.js';
import { B1DiscoveryService } from '../services/b1-discovery.js';
import { Logger } from '../loggers/app-logger.js';
import { config } from '../utils/config.js';
import { getValidCategories, buildEntityToCategoriesMap } from './b1-category-mappings.js';

export interface DiscoveryContext {
    sapClient: B1Client;
    logger: Logger;
    discoveryService: B1DiscoveryService;
    /** Mutable entity-categories map owned by the registry */
    entityCategories: Map<string, string[]>;
    /** Company DB for OAuth mode; undefined in direct mode */
    companyId?: string;
}

/**
 * Populate entityCategories from the discovered SAP B1 Service Layer metadata.
 * Safe to call multiple times — subsequent calls after first population are cheap.
 */
async function categorizeB1Entities(ctx: DiscoveryContext): Promise<void> {
    if (ctx.entityCategories.size > 0) return; // already populated for this company
    const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
        ctx.companyId,
        ctx.sapClient.getB1Client()
    );
    const b1Service = discoveredServices.find(s => s.id === 'B1_SERVICE_LAYER');
    if (!b1Service?.metadata?.entities) {
        ctx.logger.debug('B1_SERVICE_LAYER entities not found, skipping entity categorization');
        return;
    }

    const globalMapping = buildEntityToCategoriesMap();

    let categorizedCount = 0;
    let uncategorizedCount = 0;

    for (const entity of b1Service.metadata.entities) {
        const entityName = entity.name;
        const entityNameLower = entityName.toLowerCase();

        const categories = globalMapping.get(entityNameLower);
        const entityClass = entity.entityClass
            ?? (entity.table.startsWith('@')
                ? (entityName.startsWith('U_') ? 'udt' : 'udo')
                : 'standard');
        if (categories && categories.length > 0) {
            ctx.entityCategories.set(entityNameLower, categories);
            categorizedCount++;
        } else if (entityClass === 'udt') {
            ctx.entityCategories.set(entityNameLower, ['user-defined-table']);
            ctx.logger.debug(`Entity '${entityName}' classified as user-defined-table`);
            categorizedCount++;
        } else if (entityClass === 'udo') {
            ctx.entityCategories.set(entityNameLower, ['user-defined-object']);
            ctx.logger.debug(`Entity '${entityName}' classified as user-defined-object`);
            categorizedCount++;
        } else {
            ctx.entityCategories.set(entityNameLower, ['all']);
            ctx.logger.debug(`Entity '${entityName}' not categorized, defaulting to 'all'`);
            uncategorizedCount++;
        }
    }

    ctx.logger.debug(`Categorized ${categorizedCount} B1 entities, ${uncategorizedCount} uncategorized`);
}

/**
 * Step 1: Lightweight discovery — returns minimal entity list
 */
export async function discoverEntitiesMinimal(
    args: Record<string, unknown>,
    ctx: DiscoveryContext
) {
    await categorizeB1Entities(ctx);
    try {
        if (config.isOAuthMode()) {
            const companyId = ctx.sapClient.getCompanyId();
            if (!companyId) {
                ctx.logger.debug('Discovery called in OAuth mode without company selected - using default context');
            }
        }

        const query = (args.query as string)?.toLowerCase() || "";
        const requestedCategory = (args.category as string)?.toLowerCase() || "all";
        const limit = (args.limit as number) || 20;

        // Special case: workflow category returns tool descriptors, not entities
        if (requestedCategory === "workflow") {
            const workflowTools = [
                {
                    toolName: "b1_copy_document",
                    description: "Copy a B1 document to create a downstream document (Order→Delivery, Delivery→Invoice, Order→Invoice). Handles BaseType/BaseEntry/BaseLine automatically.",
                    keyParameters: ["sourceEntityName", "sourceDocEntry", "targetEntityName"]
                },
                {
                    toolName: "b1_create_payment",
                    description: "Create an incoming payment for one or more A/R invoices with automatic or manual allocation.",
                    keyParameters: ["cardCode", "invoiceDocEntries", "paymentAmount"]
                }
            ];
            // structuredContent carries the machine-readable payload; the text is for LLM guidance.
            return {
                content: [{
                    type: "text" as const,
                    text: `Workflow tools available:\n\n${JSON.stringify({ category: "workflow", tools: workflowTools }, null, 2)}`
                }],
                structuredContent: { category: "workflow", tools: workflowTools }
            };
        }

        const validCategories = getValidCategories();
        const category = validCategories.includes(requestedCategory) ? requestedCategory : "all";

        if (requestedCategory !== "all" && !validCategories.includes(requestedCategory)) {
            ctx.logger.warn(`Invalid category '${requestedCategory}' requested, using 'all' instead. Valid categories: ${validCategories.join(', ')}`);
        }

        let matches: MinimalMatch[] = [];
        let noMatchFallback = false;

        matches = await performMinimalSearch(query, category, ctx);

        if (matches.length === 0) {
            const queryPart = query ? " for query '" + query + "'" : '';
            const notAll = category !== "all";
            const categoryPart = notAll ? ` in category '${category}'` : '';
            ctx.logger.debug(`No results found${queryPart}${categoryPart}, returning all entities (limited to top ${limit})`);
            matches = await performMinimalSearch("", "all", ctx);
            noMatchFallback = true;
        }

        const totalFound = matches.length;
        const limitedMatches = matches.slice(0, limit);

        // Build compact text for LLM — just enough to name and classify each entity.
        // Full structured data is in structuredContent for code consumers.
        let responseText = "";
        if (noMatchFallback) {
            responseText += `[STEP 1 - NO MATCHES] No results found for "${query}". Returning ALL available entities.\n\n`;
        } else if (query) {
            responseText += `[STEP 1 - SEARCH RESULTS] Found ${totalFound} matches for "${query}"\n\n`;
        } else {
            responseText += `[STEP 1 - ALL ENTITIES] Showing all available entities\n\n`;
        }

        responseText += `NEXT STEP: Call b1_get_entity_schema with one of the entity names below.\n`;
        if (limitedMatches.length < totalFound) {
            responseText += `(Showing ${limitedMatches.length} of ${totalFound} — increase the limit parameter to see more.)\n`;
        }
        responseText += `\n`;

        // Compact one-line-per-entity list; categories in brackets give the LLM useful context.
        const nameWidth = Math.max(...limitedMatches.map(m => m.entityName.length), 10);
        for (const m of limitedMatches) {
            responseText += `  - ${m.entityName.padEnd(nameWidth)}  [${m.categories.join(', ')}]  - ${m.description}\n`;
        }

        // structuredContent: clean payload for code — no prose, no redundant fields.
        const structuredResult = {
            query: query || "all",
            totalFound,
            matches: limitedMatches,
        };

        return {
            content: [{ type: "text" as const, text: responseText }],
            structuredContent: structuredResult
        };

    } catch (error) {
        ctx.logger.error('Error in Step 1 discovery:', error);
        return {
            content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
        };
    }
}

type MinimalMatch = {
    entityName: string;
    description: string;
    categories: string[];
    // matchReason intentionally omitted: it restates entityName + categories as prose,
    // adding token cost with no new information for either LLMs or code consumers.
};

/**
 * Perform minimal search across entities
 */
async function performMinimalSearch(
    query: string,
    category: string,
    ctx: DiscoveryContext
): Promise<MinimalMatch[]> {
    const matches: MinimalMatch[] = [];
    const discoveredServices = await ctx.discoveryService.getDiscoveredServices(
        ctx.companyId,
        ctx.sapClient.getB1Client()
    );

    for (const service of discoveredServices) {
        if (service.id !== 'B1_SERVICE_LAYER') continue;

        if (service.metadata?.entities) {
            const filteredEntities = service.metadata.entities.filter(entity => {
                const entityName = entity.name.toLowerCase();
                if (category !== "all") {
                    const entityCategories = ctx.entityCategories.get(entityName) || [];
                    if (!entityCategories.includes(category)) return false;
                }
                if (query) return entityName.includes(query);
                return true;
            });

            for (const entity of filteredEntities) {
                const entityNameLower = entity.name.toLowerCase();
                const entityCategories = ctx.entityCategories.get(entityNameLower) || ['all'];
                matches.push({
                    entityName: entity.name,
                    description: entity.description,
                    categories: entityCategories,
                });
            }
        }
    }

    return matches;
}
