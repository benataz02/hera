import { B1Client } from './b1-client.js';
import { Logger } from '../loggers/app-logger.js';
import { Config } from '../utils/config.js';
import { ODataService, ServiceMetadata } from '../types/b1-types.js';
import { B1MetadataManager } from './b1-metadata-manager.js';
import { B1ServiceLayer } from './b1-service-layer.js';

export class B1DiscoveryService {
    // Per-company metadata managers and discovered services (keyed by companyDb, '' for direct mode)
    private readonly metadataManagers = new Map<string, B1MetadataManager>();
    private readonly companyServices = new Map<string, ODataService>();
    private readonly pendingInit = new Map<string, Promise<ODataService>>();

    constructor(
        private readonly b1Client: B1Client,
        private readonly logger: Logger,
        private readonly config: Config
    ) { }

    /**
     * Get B1 Metadata Manager instance (for lazy-loading), keyed by company DB
     * Returns undefined if metadata for that company has not been loaded
     */
    getB1MetadataManager(companyDb?: string): B1MetadataManager | undefined {
        return this.metadataManagers.get(companyDb ?? '');
    }

    getPersonalFieldCacheHealthSummary(): { healthy: boolean; error?: string } {
        for (const manager of this.metadataManagers.values()) {
            if (!manager.isPersonalFieldCacheHealthy()) {
                return {
                    healthy: false,
                    error: manager.getPersonalFieldCacheError() || 'PersonalFieldsSetups cache is unhealthy.'
                };
            }
        }

        return { healthy: true };
    }

    /**
     * Get discovered services for a company. Uses per-company cache keyed by companyDb
     * Pass the per-session b1Client so metadata is fetched with the correct company context
     * In direct mode, companyDb and b1Client are both undefined → key '' → falls back to shared b1Client
     */
    async getDiscoveredServices(
        companyDb?: string,
        b1Client?: B1ServiceLayer
    ): Promise<ODataService[]> {
        const key = companyDb ?? '';

        const cached = this.companyServices.get(key);
        if (cached) {
            this.logger.info(`Returning cached services for company '${key || 'direct mode'}'`);
            return [cached];
        }

        const pending = this.pendingInit.get(key);
        if (pending) {
            this.logger.info(`Awaiting in-flight metadata initialization for company '${key || 'direct mode'}'`);
            return [await pending];
        }

        this.logger.info(`No services for company '${key || 'direct mode'}', initiating discovery`);
        const initPromise = this.discoverAllServices(key, b1Client).then(services => {
            const service = services[0];
            this.companyServices.set(key, service);
            this.pendingInit.delete(key);
            return service;
        }).catch(err => {
            this.pendingInit.delete(key);
            throw err;
        });
        this.pendingInit.set(key, initPromise);
        return [await initPromise];
    }

    private async discoverAllServices(
        companyDb: string,
        b1Client?: B1ServiceLayer
    ): Promise<ODataService[]> {
        const services: ODataService[] = [];

        try {
            const baseUrl = ((this.config.get('b1.serviceLayerUrl', '') as string) || '').replace(/\/+$/, '') + '/b1s/v2/';
            const b1Service: ODataService = {
                id: 'B1_SERVICE_LAYER',
                version: '10.0',
                title: 'SAP Business One Service Layer',
                description: 'Direct local Service Layer access to SAP Business One',
                odataVersion: 'v4',
                url: baseUrl,
                metadataUrl: `${baseUrl}$metadata`,
                metadata: null
            };

            try {
                this.logger.info(`Discovering B1 metadata at ${b1Service.metadataUrl}`);
                b1Service.metadata = await this.getServiceMetadata(b1Service, companyDb, b1Client);
            } catch (err) {
                this.logger.warn('Failed to fetch B1 metadata:', err);
                throw err;
            }

            this.logger.info('Successfully initialized 1 OData service (B1)');
            services.push(b1Service);
            return services;

        } catch (error) {
            this.logger.error('Service discovery failed:', error);
            throw error;
        }
    }

    private async getServiceMetadata(
        service: ODataService,
        companyDb: string,
        b1Client?: B1ServiceLayer
    ): Promise<ServiceMetadata> {
        try {
            // Use B1-optimized metadata manager for B1 Service Layer
            this.logger.info('Using B1 optimized metadata discovery (two-phase with lazy-loading)');
            return await this.parseB1MetadataOptimized(companyDb, b1Client);
        } catch (error) {
            this.logger.error(`Failed to get metadata for service ${service.id}:`, error);
            throw error;
        }
    }

    /**
     * Parse B1 Service Layer metadata using optimized two-phase approach
     * Phase 1: Fast entity list loading
     * Phase 2: Lazy schema loading on-demand
     *
     * Uses per-company B1MetadataManager keyed by companyDb.
     * The per-session b1Client is used for initialization to avoid shared-client mutation races
     */
    private async parseB1MetadataOptimized(
        companyDb: string,
        b1Client?: B1ServiceLayer
    ): Promise<ServiceMetadata> {
        // Use the provided per-session client if available; fall back to shared client (direct mode)
        const client = b1Client ?? this.b1Client.getB1Client();
        if (!client) {
            throw new Error('B1 client not available');
        }

        // Get or create a per-company metadata manager
        let manager = this.metadataManagers.get(companyDb);
        if (!manager) {
            manager = new B1MetadataManager(client, this.logger);
            this.metadataManagers.set(companyDb, manager);
        }

        // Phase 1: Fast initialization with entity list only
        await manager.initialize();
        const entities = manager.getEntityList();

        this.logger.info(`B1 Optimized: Initialized with ${entities.length} entities (lazy-loading enabled) for company '${companyDb || 'direct mode'}'`);

        // Log cache stats
        const stats = manager.getCacheStats();
        this.logger.info(`B1 Cache: ${stats.entityListCount} entities, ${stats.entitySchemaCacheSize} schemas loaded`);

        return {
            entities,
            version: 'v4',
            namespace: 'SAPB1'
        };
    }
}
