import { B1SAPToolRegistry } from './tools/b1-tool-registry.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import 'dotenv/config';
import { pkgName, pkgVersion } from './utils/pkg.js';
import { B1Client } from './services/b1-client.js';
import { B1DiscoveryService } from './services/b1-discovery.js';
import { Logger } from './loggers/app-logger.js';
import { config } from './utils/config.js';

import { ErrorHandler } from './utils/error-handler.js';

export class B1MCPServer {
    private readonly logger: Logger;
    private readonly sapClient: B1Client;
    private readonly mcpServer: McpServer;
    private readonly toolRegistry: B1SAPToolRegistry;

    constructor(discoveryService: B1DiscoveryService) {
        this.logger = new Logger('mcp-core');

        this.sapClient = new B1Client(this.logger, config);

        this.mcpServer = new McpServer({
            name: pkgName,
            version: pkgVersion,

        });
        this.mcpServer.server.onerror = (error) => {
            this.logger.error('MCP Server Error:', error);
            ErrorHandler.handle(error);
        };

        this.toolRegistry = new B1SAPToolRegistry(this.mcpServer, this.sapClient, this.logger, discoveryService);
        this.logger.info('B1 MCP tool initialized');
    }

    async initialize(): Promise<void> {
        try {
            this.toolRegistry.registerServiceMetadataResources();
            await this.toolRegistry.registerDiscoveryTools();
            this.logger.info('Registered MCP tools for SAP Business One Service Layer');
        } catch (error) {
            this.logger.error('Failed to initialize server:', error);
            throw error;
        }
    }

    createHTTPTransport(options?: {
        enableDnsRebindingProtection?: boolean;
        allowedHosts?: string[];
    }): StreamableHTTPServerTransport {
        return new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: options?.enableDnsRebindingProtection || true,
            allowedHosts: options?.allowedHosts || config.get<string[]>('mcp.allowedHosts')
        });
    }

    getServer(): McpServer {
        return this.mcpServer;
    }
}

export async function createB1MCPServer(
    discoveryService: B1DiscoveryService
): Promise<B1MCPServer> {
    const server = new B1MCPServer(discoveryService);
    await server.initialize();
    return server;
}
