import { Logger } from '../loggers/app-logger.js';
import { Config } from '../utils/config.js';
import {
    B1MetadataParams,
    B1PersonalFieldSetup,
    B1PersonalFieldsResponse
} from '../types/b1-types.js';
import { Agent as UndiciAgent, type Dispatcher } from 'undici';
import { getRequestContext } from '../utils/request-context.js';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export class B1ServiceLayer {
    private readonly baseUrl: string;
    private readonly companyDb: string;
    private readonly userName: string;
    private readonly password: string;
    private readonly allowSelfSigned: boolean;
    private readonly logger: Logger;
    /** Per-instance undici dispatcher that bypasses TLS verification (only when allowSelfSigned=true). */
    private readonly insecureDispatcher: Dispatcher | undefined;

    private cookieHeader: string | null = null;
    private companyId?: string;

    constructor(config: Config, logger: Logger) {
        this.logger = logger;

        const rawBase = (config.get('b1.serviceLayerUrl', '') as string) || '';
        this.baseUrl = rawBase.replace(/\/+$/, '') + '/b1s/v2/';
        this.companyDb = config.get('b1.companyDb', '') as string;
        this.userName = config.get('b1.userName', '') as string;
        this.password = config.get('b1.password', '') as string;
        this.allowSelfSigned = config.get('auth.allowSelfSigned', false) as boolean;

        if (this.allowSelfSigned) {
            this.insecureDispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });
            this.logger.warn('B1 SSL verification disabled (AUTH_ALLOW_SELF_SIGNED=true). Use only for local/dev.');
        }
    }

    /**
     * Set the company ID for OAuth mode (used in x-b1-companyID header)
     */
    setCompanyId(companyId: string): void {
        this.companyId = companyId;
        this.logger.debug(`Company ID set to: ${companyId}`);
    }

    /**
     * Get the current company ID
     */
    getCompanyId(): string | undefined {
        return this.companyId;
    }

    private async login(): Promise<void> {
        const url = this.joinUrl('Login');
        const body = {
            CompanyDB: this.companyDb,
            UserName: this.userName,
            Password: this.password
        };

        const res = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
        });

        const setCookie = res.headers.get('set-cookie');
        if (setCookie) {
            this.cookieHeader = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
        } else {
            try {
                const data = await res.json();
                if (!data?.SessionId) {
                    throw new Error('B1 Login succeeded but no cookies or SessionId found.');
                }
                this.cookieHeader = `B1SESSION=${data.SessionId}; CompanyDB=${this.companyDb}`;
            } catch {
                throw new Error('B1 Login succeeded but response did not contain cookie or JSON SessionId.');
            }
        }

        this.logger.info('SAP B1 Service Layer login successful');
    }

    private async ensureSession(effectiveToken?: string): Promise<void> {
        // Skip session management when using OAuth bearer token
        if (effectiveToken) {
            return;
        }

        if (!this.cookieHeader) {
            await this.login();
        }
    }

    private joinUrl(pathOrUrl: string): string {
        if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
        if (pathOrUrl.startsWith('/')) return this.baseUrl + pathOrUrl.slice(1);
        return this.baseUrl + pathOrUrl;
    }

    /**
     * Fetch metadata with optional query parameters for optimized retrieval
     * @param params Query parameters for metadata fetching
     * @returns XML metadata as string
     */
    async fetchMetadata(params?: B1MetadataParams): Promise<string> {
        let url = '$metadata';

        if (params) {
            const queryParams: string[] = [];

            if (params.scope) {
                queryParams.push(`scope=${encodeURIComponent(params.scope)}`);
            }

            // Handle multiple annotations - split by comma and add as separate parameters
            if (params.annotation) {
                const annotations = params.annotation.split(',').map(a => a.trim());
                annotations.forEach(annotation => {
                    queryParams.push(`annotation=${encodeURIComponent(annotation)}`);
                });
            }

            if (params.entityset) {
                queryParams.push(`entityset=${encodeURIComponent(params.entityset)}`);
            }

            if (params.dependency !== undefined) {
                queryParams.push(`dependency=${params.dependency}`);
            }

            if (queryParams.length > 0) {
                url += `?${queryParams.join('&')}`;
            }
        }

        this.logger.debug(`Fetching B1 metadata: ${url}`);

        const response = await this.request({
            url,
            method: 'GET',
            headers: { 'Accept': 'application/xml' }
        });

        return response.data as string;
    }

    /**
     * Fetch all PersonalFieldsSetups entries with transparent OData paging.
     * Returns only fields needed by metadata logic: TableName, FieldName, DataClassification.
     * 
     * Note: PersonalFieldsSetups is available in SAP B1 10.0 FP2608 and later.
     */
    async fetchPersonalFieldsSetups(maxPageSize = 200): Promise<B1PersonalFieldSetup[]> {
        const allFields: B1PersonalFieldSetup[] = [];
        let nextPath = 'PersonalFieldsSetups';

        while (nextPath) {
            const response = await this.request({
                url: nextPath,
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Prefer': `odata.maxpagesize=${maxPageSize}`
                }
            });

            const data = response.data as B1PersonalFieldsResponse;
            const entries = Array.isArray(data?.value) ? data.value : [];

            for (const row of entries) {
                if (!row?.TableName || !row?.FieldName) continue;
                allFields.push({
                    tableName: row.TableName,
                    fieldName: row.FieldName,
                    dataClassification: row.DataClassification ?? '',
                    category: row.Category,
                    abstractTable: row.TableName, // Assuming abstractTable is the same as TableName; adjust if needed
                });
            }

            nextPath = typeof data?.['@odata.nextLink'] === 'string' && data['@odata.nextLink'].trim().length > 0
                ? data['@odata.nextLink']
                : '';
        }

        return allFields;
    }

    /**
     * Fetch personal fields for a specific physical table via service function.
     * Uses: PersonalFieldsSetupsService_GetPersonalFieldsByTable
     * 
     * Note: PersonalFieldsSetupsService_GetPersonalFieldsByTable is available in SAP B1 10.0 FP2608 and later.
     */
    async fetchPersonalFieldsByTable(tableName: string): Promise<B1PersonalFieldSetup[]> {
        const response = await this.request({
            url: 'PersonalFieldsSetupsService_GetPersonalFieldsByTable',
            method: 'POST',
            data: {
                PersonalFieldsSetupTableParams: {
                    TableName: tableName
                }
            },
            headers: {
                'Accept': 'application/json'
            }
        });

        const data = response.data as B1PersonalFieldsResponse;
        const entries = Array.isArray(data?.value) ? data.value : [];

        const rows: B1PersonalFieldSetup[] = [];
        for (const row of entries) {
            if (!row?.TableName || !row?.FieldName) continue;
            rows.push({
                tableName: tableName,
                fieldName: row.FieldName,
                dataClassification: row.DataClassification ?? '',
                category: row.Category,
                abstractTable: row.TableName,
            });
        }

        return rows;
    }

    async request(options: {
        url: string;
        method: HttpMethod;
        data?: unknown;
        headers?: Record<string, string>;
    }): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
        const requestContext = getRequestContext();
        const requestId = requestContext?.requestId;
        const effectiveToken = requestContext?.token;
        const effectiveCompanyId = requestContext?.companyId ?? this.companyId;

        await this.ensureSession(effectiveToken);

        const url = this.joinUrl(options.url);
        this.logger.debug('Sending SAP B1 Service Layer request', {
            requestId,
            method: options.method,
            url,
            hasOAuthToken: Boolean(effectiveToken),
            companyId: effectiveCompanyId
        });

        const headers: Record<string, string> = {
            'Accept': options.headers?.Accept || 'application/json',
            'Content-Type': options.headers?.['Content-Type'] || 'application/json',
            'Cookie': this.cookieHeader || '',
            ...(options.headers)
        };

        // Use bearer token authentication if available (OAuth mode)
        if (effectiveToken) {
            headers['Authorization'] = `Bearer ${effectiveToken}`;

            // Add company ID header for OAuth mode
            if (effectiveCompanyId) {
                headers['x-b1-companyID'] = effectiveCompanyId;
            }
        } else {
            // Use cookie-based authentication (direct mode)
            headers['Cookie'] = this.cookieHeader || '';
        }

        let res: Response;
        try {
            res = await fetch(url, {
                method: options.method,
                headers,
                body: options.data !== undefined && options.method !== 'GET'
                    ? JSON.stringify(options.data)
                    : undefined,
                ...(this.insecureDispatcher ? { dispatcher: this.insecureDispatcher } : {})
            });
        } catch (error) {
            this.logger.error('SAP B1 Service Layer network request failed', {
                requestId,
                method: options.method,
                url,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }

        // Only retry with re-login in direct mode (cookie-based)
        if ((res.status === 401 || res.status === 403) && this.cookieHeader && !effectiveToken) {
            this.logger.warn(`B1 request unauthorized (${res.status}). Re-logging in and retrying once...`, {
                requestId,
                method: options.method,
                url
            });
            this.cookieHeader = null;
            await this.ensureSession();
            return this.request(options);
        }

        const contentType = res.headers.get('content-type') || '';
        const isXml = contentType.includes('xml');
        const payload = await res.text();
        let data = payload;
        if (!isXml) {
            try { data = payload ? JSON.parse(payload) : null; } catch { /* keep text */ }
        }

        if (!res.ok) {
            const msg = typeof data === 'string' ? data : JSON.stringify(data);
            this.logger.error('SAP B1 Service Layer request failed', {
                requestId,
                method: options.method,
                url,
                status: res.status,
                responseBody: msg
            });
            // Tenant -1 means no company ID was provided or it was invalid; surface actionable guidance.
            if (res.status === 401 && /Cannot find the binding user on tenant/i.test(msg)) {
                throw new Error('No company selected. Call b1_list_companies to get available companies, then call b1_select_company with the CompanySchemaName.');
            }
            throw new Error(`B1 API Error ${res.status}: ${msg}`);
        }

        return {
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            data
        };
    }
}
