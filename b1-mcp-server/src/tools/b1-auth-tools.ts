/**
 * B1 Company Selection Tools Registry
 *
 * Handles company selection in OAuth mode.
 *
 * Tools:
 * - b1_list_companies: List available companies from SLD
 * - b1_select_company: Select active company for subsequent requests
 *
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Logger } from '../loggers/app-logger.js';
import { Config } from '../utils/config.js';
import { setRequestContextCompanyId } from '../utils/request-context.js';
import { Agent as UndiciAgent, type Dispatcher } from 'undici';

// SLD API response interfaces
interface B1Company {
    CompanyID: string;
    CompanySchemaName: string;
    CompanyName: string;
    Status: string;
}

interface CompanyDetails {
    Version?: string;
    Localization?: number;
    LanguageCode?: number;
    CompanyName?: string;
    Country?: string;
    ManagingDirector?: string;
    LocalCurrency?: string;
}

interface ToolExtra {
    authInfo?: {
        token?: string;
        extra?: Record<string, unknown>;
    };
}

interface SLDCompanyBindingResult {
    CompanySchemaName?: string;
    CompanyDisplayName?: string;
    CompanyID?: string;
    Confirmed?: boolean;
}

export class B1CompanySelectionToolRegistry {
    private readonly mcpServer: McpServer;
    private readonly logger: Logger;
    private readonly setCompanyIdCallback: (companyId: string) => void;
    private readonly sldRootUrl: string;
    private readonly serviceLayerUrl: string;
    private readonly companyListCache = new Map<string, { companies: B1Company[]; expiresAt: number }>();
    private readonly companyListTtlMs: number;
    /** Per-instance dispatcher for self-signed certificate bypass (only when AUTH_ALLOW_SELF_SIGNED=true). */
    private readonly insecureDispatcher: Dispatcher | undefined;

    constructor(
        mcpServer: McpServer,
        logger: Logger,
        config: Config,
        setCompanyIdCallback: (companyId: string) => void
    ) {
        this.mcpServer = mcpServer;
        this.logger = logger;
        this.setCompanyIdCallback = setCompanyIdCallback;
        this.sldRootUrl = config.get<string>('sld.rootUrl');
        this.serviceLayerUrl = ((config.get<string>('b1.serviceLayerUrl', '') || '').replace(/\/+$/, '')) + '/b1s/v2/';
        this.companyListTtlMs = config.get<number>('company.listCacheTtl', 5) * 60 * 1000;

        const allowSelfSigned = config.get<boolean>('auth.allowSelfSigned', false);
        if (allowSelfSigned) {
            this.insecureDispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });
        }

        if (!this.sldRootUrl) {
            this.logger.warn('SLD_ROOT_URL not configured. Company selection tools will not be available.');
        }
    }

    /**
     * Register company selection tools
     */
    public registerCompanySelectionTools(): void {
        this.logger.info('Registering company selection tools (b1_list_companies, b1_select_company)');
        this.registerListCompaniesTool();
        this.registerSelectCompanyTool();
        this.logger.info('Registered 2 company selection tools');
    }

    /**
     * b1_list_companies: list available companies from SLD
     */
    private registerListCompaniesTool(): void {
        this.mcpServer.registerTool(
            "b1_list_companies",
            {
                title: "List Available SAP B1 Companies",
                description: "Returns the list of available SAP B1 companies.\nReturns: CompanyID, CompanySchemaName, CompanyName, Status.\nNext: b1_select_company with CompanySchemaName.",
                inputSchema: {}
            },
            async (_args: Record<string, unknown>, extra?: ToolExtra) => {
                try {
                    const token = extra?.authInfo?.token;
                    if (!token) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: "Error: No authentication token available. User must authenticate first."
                            }]
                        };
                    }

                    // Fetch companies
                    const companies = await this.getCompanyList(token);

                    let responseText = `Found ${companies.length} available ${companies.length === 1 ? 'company' : 'companies'}:\n\n`;
                    responseText += JSON.stringify(companies, null, 2);

                    responseText += `\n\n Next step: Ask user to select a company.`;

                    // structuredContent exposes the list directly for code; text is for LLM guidance.
                    return {
                        content: [{
                            type: "text" as const,
                            text: responseText
                        }],
                        structuredContent: { count: companies.length, companies }
                    };
                } catch (error) {
                    this.logger.error('Error fetching company list:', error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: ` Error discovering companies: ${error instanceof Error ? error.message : String(error)}`
                        }]
                    };
                }
            }
        );
    }

    /**
     * b1_select_company: select active company for subsequent requests
     */
    private registerSelectCompanyTool(): void {
        this.mcpServer.registerTool(
            "b1_select_company",
            {
                title: "Select SAP B1 Company",
                description: "Select a SAP B1 company.\nSets the active company for all subsequent requests.\nOptions: getDetails=true for company info (version, localization, etc.).\nNext: b1_find_entities to search available entities.",
                inputSchema: {
                    companySchemaName: z.string().describe("Company database schema name from b1_list_companies results. Example: 'SBODEMOUS' or 'SBODEMODE'. This is the CompanySchemaName field from the company list."),
                    getDetails: z.boolean().optional().describe("Retrieve detailed company information (version, localization, etc.). Default: false")
                },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: true
                }
            },
            
            async (args: Record<string, unknown>, extra?: ToolExtra) => {
                try {
                    const token = extra?.authInfo?.token;
                    if (!token) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: " Error: No authentication token available. User must authenticate first."
                            }]
                        };
                    }

                    const companySchemaName = args.companySchemaName as string;
                    if (!companySchemaName) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: " Error: companySchemaName parameter is required. Call b1_list_companies to see available companies."
                            }]
                        };
                    }

                    const isGetDetails = args.getDetails === true;

                    // Get company list to validate and find CompanyID
                    const companies = await this.getCompanyList(token);
                    const selectedCompany = companies.find(
                        (c: B1Company) => c.CompanySchemaName === companySchemaName
                    );

                    if (!selectedCompany) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: ` Error: Company '${companySchemaName}' not found or not accessible.\n\nAvailable companies: ${companies.map((c: B1Company) => c.CompanySchemaName).join(', ')}\n\nCall b1_list_companies to see the full list.`
                            }]
                        };
                    }

                    // Set company ID in session and tool registry
                    const companyId = selectedCompany.CompanyID;
                    this.setCompanyIdCallback(companyId);
                    setRequestContextCompanyId(companyId);

                    // Store in extra.authInfo for session persistence
                    if (extra?.authInfo) {
                        extra.authInfo.extra = extra.authInfo.extra || {};
                        extra.authInfo.extra.currentCompanyID = companyId;
                    }

                    this.logger.info(`Company selected: ${selectedCompany.CompanyName} (${companySchemaName})`);

                    let responseText = ` Successfully selected company:\n\n`;
                    responseText += ` Company Name: ${selectedCompany.CompanyName}\n`;
                    responseText += ` Database: ${companySchemaName}\n`;
                    responseText += ` Company ID: ${companyId}\n`;
                    responseText += ` Status: ${selectedCompany.Status}\n`;

                    // Build the structured payload alongside the text.
                    // Optional details section is appended when getDetails=true.
                    const structured: Record<string, unknown> = {
                        selected: {
                            CompanyID: companyId,
                            CompanySchemaName: companySchemaName,
                            CompanyName: selectedCompany.CompanyName,
                            Status: selectedCompany.Status
                        }
                    };

                    // Optionally fetch detailed company information
                    if (isGetDetails) {
                        try {
                            const companyDetails = await this.getCompanyInformation(token, companyId);
                            responseText += `\n Detailed Company Information:\n\n`;
                            responseText += JSON.stringify(companyDetails, null, 2);
                            structured.details = companyDetails;
                        } catch (error) {
                            this.logger.warn('Failed to fetch company details:', error);
                            responseText += `\n\n Detailed info not available: ${error instanceof Error ? error.message : String(error)}`;
                        }
                    }

                    responseText += `\n\n You can now use the following tools:\n`;
                    responseText += `  b1_find_entities - Explore available entities\n`;
                    responseText += `  b1_get_entity_schema - Get entity schemas\n`;
                    responseText += `  b1_read - Perform read operations\n`;
                    responseText += `  b1_write - Perform create/update/delete operations`;

                    // structuredContent exposes the selection result for code; text is for LLM guidance.
                    return {
                        content: [{
                            type: "text" as const,
                            text: responseText
                        }],
                        structuredContent: structured
                    };
                } catch (error) {
                    this.logger.error('Error selecting company:', error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Error selecting company: ${error instanceof Error ? error.message : String(error)}`
                        }]
                    };
                }
            }
        );
    }

    /**
     * Fetch company list from SLD
     */
    private async getCompanyList(token: string): Promise<B1Company[]> {
        if (!this.sldRootUrl) {
            throw new Error('SLD_ROOT_URL not configured. Required for OAuth mode.');
        }

        const cached = this.companyListCache.get(token);
        if (cached && Date.now() < cached.expiresAt) {
            this.logger.debug('Returning cached company list');
            return cached.companies;
        }

        const url = `${this.sldRootUrl}/sld/sld0100.svc/CurrentUserInfo?IncludeB1UserBinding=true`;

        this.logger.debug(`Fetching company list from SLD: ${url}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            },
            ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to retrieve company list: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();
        // Extract company list from response
        // The structure is: data.value.B1UserBinding.value[].Company
        const results = data?.d?.CurrentUserInfo?.B1UserBindings?.results;
        let companies: B1Company[] = [];
        if (Array.isArray(results) && results.length > 0) {
            companies = results.map((item: SLDCompanyBindingResult) => ({
                CompanySchemaName: item.CompanySchemaName ?? '',
                CompanyName: item.CompanyDisplayName ?? '',
                CompanyID: item.CompanyID ?? '',
                Status: item.Confirmed ? 'Confirmed' : 'Unconfirmed'
            }));
        }
        this.logger.debug(`Retrieved ${companies.length} companies from SLD`);
        this.companyListCache.set(token, { companies, expiresAt: Date.now() + this.companyListTtlMs });
        return companies;
    }

    /**
     * Fetch detailed company information from SAP B1 Service Layer
     */
    private async getCompanyInformation(token: string, companyId: string): Promise<CompanyDetails | null> {
        if (!this.serviceLayerUrl) {
            throw new Error('SERVICE_LAYER_ROOT_URL not configured. Required for company details.');
        }

        const urlBasic = `${this.serviceLayerUrl}CompanyService_GetCompanyInfo`;
        const urlAdmin = `${this.serviceLayerUrl}CompanyService_GetAdminInfo`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'x-b1-companyID': companyId
        };

        this.logger.debug(`Fetching company information from Service Layer`);

        const [resBasic, resAdmin] = await Promise.all([
            fetch(urlBasic, {
                method: 'GET', headers,
                ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
            }),
            fetch(urlAdmin, {
                method: 'GET', headers,
                ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
            })
        ]);

        const [bodyBasicText, bodyAdminText] = await Promise.all([
            resBasic.text(),
            resAdmin.text()
        ]);

        let bodyBasic: Record<string, unknown>;
        let bodyAdmin: Record<string, unknown>;
        try {
            bodyBasic = bodyBasicText ? JSON.parse(bodyBasicText) as Record<string, unknown> : {};
        } catch {
            throw new Error('Failed to parse company basic info response');
        }
        try {
            bodyAdmin = bodyAdminText ? JSON.parse(bodyAdminText) as Record<string, unknown> : {};
        } catch {
            throw new Error('Failed to parse company admin info response');
        }

        if (!resBasic.ok) {
            throw new Error(`Failed to retrieve company basic info: ${resBasic.status} ${resBasic.statusText}`);
        }
        if (!resAdmin.ok) {
            throw new Error(`Failed to retrieve company admin info: ${resAdmin.status} ${resAdmin.statusText}`);
        }

        return {
            Version: bodyBasic?.Version as string | undefined,
            Localization: bodyBasic?.Localization as number | undefined,
            LanguageCode: bodyBasic?.LanguageCode as number | undefined,
            CompanyName: (bodyBasic?.CompanyName || bodyAdmin?.CompanyName) as string | undefined,
            Country: bodyAdmin?.Country as string | undefined,
            ManagingDirector: bodyAdmin?.ManagingDirector as string | undefined,
            LocalCurrency: bodyAdmin?.LocalCurrency as string | undefined,
        };
    }
}
