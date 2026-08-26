import { Logger } from '../loggers/app-logger.js';
import { config as defaultConfig, Config } from '../utils/config.js';
import { B1ServiceLayer } from './b1-service-layer.js';


export class B1Client {
    private readonly config: Config;
    private readonly serviceClient: B1ServiceLayer;

    constructor(
        private readonly logger: Logger,
        config?: Config
    ) {
        this.config = config || defaultConfig;

        if (this.config.isOAuthMode()) {
            // In OAuth mode, token is resolved from request context
            this.serviceClient = new B1ServiceLayer(this.config, this.logger);
            this.logger.info('B1 client initialized in OAuth mode');
        } else {
            this.serviceClient = new B1ServiceLayer(this.config, this.logger);
            this.logger.info('B1 direct mode enabled');
        }
    }

    /**
     * Set the company ID for OAuth mode
     */
    setCompanyId(companyId?: string) {
        if (this.serviceClient) {
            if (companyId) {
                this.serviceClient.setCompanyId(companyId);
            }
        } else {
            this.logger.warn('Cannot set company ID: B1 client not initialized');
        }
    }

    /**
     * Get the current company ID (OAuth mode)
     */
    getCompanyId(): string | undefined {
        return this.serviceClient?.getCompanyId();
    }

    /**
     * Get B1 Service Layer client
     */
    getB1Client(): B1ServiceLayer | undefined {
        return this.serviceClient;
    }

    async dispatchRequest(options: {
        url: string;
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
        data?: unknown;
        headers?: Record<string, string>;
        isDiscovery?: boolean;
    }) {
        if (this.serviceClient) {
            this.logger.debug(`[B1] ${options.method} ${options.url}`);
            return this.serviceClient.request({
                url: options.url,
                method: options.method,
                data: options.data,
                headers: options.headers
            });
        }

        if (this.config.isOAuthMode()) {
            throw new Error('OAuth mode is enabled but no user token is available. User must authenticate first.');
        }

        throw new Error('Direct authentication mode is required. Set AUTHENTICATION_MODE=direct and configure B1_* environment variables, or let the server auto-detect by configuring SERVICE_LAYER_ROOT_URL, B1_COMPANY_DB, and B1_USERNAME.');
    }

    async readEntitySet(servicePath: string, entitySet: string, queryOptions?: {
        $filter?: string;
        $select?: string;
        $orderby?: string;
        $top?: number;
        $skip?: number;
    }, isDiscovery = false) {
        let url = `${servicePath}${entitySet}`;

        if (queryOptions) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(queryOptions)) {
                if (value !== undefined && value !== null) {
                    params.set(key, String(value));
                }
            }

            if (params.toString()) {
                url += `?${params.toString()}`;
            }
        }

        return this.dispatchRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async readEntity(servicePath: string, entitySet: string, key: string | number, isDiscovery = false, queryOptions?: {
        $select?: string;
    }) {
        // Handle numeric keys (like DocEntry) vs string keys (like CardCode)
        // Numeric keys: Orders(123)
        // String keys: Items('A00001')
        const keyPart = typeof key === 'number' ? key : `'${key}'`;
        let url = `${servicePath}${entitySet}(${keyPart})`;

        if (queryOptions) {
            const params = new URLSearchParams();
            for (const [k, value] of Object.entries(queryOptions)) {
                if (value !== undefined && value !== null) {
                    params.set(k, String(value));
                }
            }

            if (params.toString()) {
                url += `?${params.toString()}`;
            }
        }

        this.logger.debug(`[B1Client.readEntity] Constructed URL: ${url} (key type: ${typeof key}, key value: ${key})`);

        return this.dispatchRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async createEntity(
        servicePath: string,
        entitySet: string,
        data: unknown,
        options?: { preferReturnNoContent?: boolean }
    ) {
        const url = `${servicePath}${entitySet}`;
        const headers: Record<string, string> = {};
        if (options?.preferReturnNoContent) {
            headers.Prefer = 'return-no-content';
        }

        return this.dispatchRequest({
            method: 'POST',
            url,
            data,
            headers: Object.keys(headers).length > 0 ? headers : undefined
        });
    }

    async updateEntity(servicePath: string, entitySet: string, key: string | number, data: unknown) {
        // Handle numeric keys (like DocEntry) vs string keys (like CardCode)
        const keyPart = typeof key === 'number' ? key : `'${key}'`;
        const url = `${servicePath}${entitySet}(${keyPart})`;

        return this.dispatchRequest({
            method: 'PATCH',
            url,
            data
        });
    }

    async deleteEntity(servicePath: string, entitySet: string, key: string | number) {
        // Handle numeric keys (like DocEntry) vs string keys (like CardCode)
        const keyPart = typeof key === 'number' ? key : `'${key}'`;
        const url = `${servicePath}${entitySet}(${keyPart})`;

        return this.dispatchRequest({
            method: 'DELETE',
            url
        });
    }

}
