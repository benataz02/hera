import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { isHumanConfirmationEnabled } from '../utils/config.js';

export interface PrimitiveBooleanSchema {
    type: 'boolean';
    default?: boolean;
    title?: string;
    description?: string;
}

export interface FormElicitationRequest {
    mode?: 'form';
    message: string;
    requestedSchema: {
        type: 'object';
        properties: Record<string, PrimitiveBooleanSchema>;
        required?: string[];
    };
}

/**
 * Result returned by MCP `elicitation/create`.
 *
 * Note: for form mode, many clients return `action: 'accept'` whenever the form is submitted,
 * even if the user left `confirmed` as false. Treat `content.confirmed === true` as the
 * authoritative approval signal for write operations.
 */
export interface FormElicitationResult {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
}

export interface McpToolRequestContext {
    sendRequest?: RequestHandlerExtra<ServerRequest, ServerNotification>['sendRequest'];
}

export interface WriteConfirmationOptions {
    requestContext?: McpToolRequestContext;
    operation: string;
    entityName: string;
    target?: string;
    parameters?: Record<string, unknown>;
    personalFieldNames?: readonly string[];
    summaryLines?: string[];
}

export interface SensitiveReadConfirmationOptions {
    requestContext?: McpToolRequestContext;
    entityName: string;
    selectString: string;
    selectedPersonalFields: string[];
}

export async function requireWriteConfirmation(options: WriteConfirmationOptions): Promise<void> {
    if (!isHumanConfirmationEnabled()) {
        return;
    }

    const result = await requestConfirmation(options);

    if (result.action === 'decline') {
        throw new Error('Write operation was declined by the user.');
    }

    if (result.action === 'cancel') {
        throw new Error('Write operation was cancelled by the user.');
    }

    if (result.content?.confirmed !== true) {
        throw new Error('Write operation was not approved by the user.');
    }
}

export async function requireSensitiveReadConfirmation(options: SensitiveReadConfirmationOptions): Promise<void> {
    if (!isHumanConfirmationEnabled()) {
        return;
    }

    const sendRequest = options.requestContext?.sendRequest;
    const request: FormElicitationRequest = {
        mode: 'form',
        message: buildSensitiveReadMessage(options),
        requestedSchema: {
            type: 'object',
            properties: {
                confirmed: {
                    type: 'boolean',
                    default: false,
                    title: 'Approve personal-field query',
                    description: 'Set to true to allow querying the selected personal fields from SAP Business One.'
                }
            },
            required: ['confirmed']
        }
    };

    if (!sendRequest) {
        throw new Error(
            'Sensitive read blocked: this MCP client invocation does not provide server-initiated elicitation support. This server requires explicit user confirmation before querying personal fields.'
        );
    }

    let result: FormElicitationResult;
    try {
        result = await sendRequest({
            method: 'elicitation/create',
            params: request
        }, ElicitResultSchema) as FormElicitationResult;
    } catch (error) {
        throw new Error(
            `Sensitive read blocked: failed to obtain user confirmation via MCP elicitation. ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (result.action === 'decline') {
        throw new Error('Sensitive read operation was declined by the user.');
    }

    if (result.action === 'cancel') {
        throw new Error('Sensitive read operation was cancelled by the user.');
    }

    if (result.content?.confirmed !== true) {
        throw new Error('Sensitive read operation was not approved by the user.');
    }
}

async function requestConfirmation(options: WriteConfirmationOptions): Promise<FormElicitationResult> {
    const sendRequest = options.requestContext?.sendRequest;
    const request: FormElicitationRequest = {
        mode: 'form' as const,
        message: buildConfirmationMessage(options),
        requestedSchema: {
            type: 'object' as const,
            properties: {
                confirmed: {
                    type: 'boolean' as const,
                    default: false,
                    title: 'Approve write operation',
                    description: 'Set to true to approve this SAP Business One write operation.'
                }
            },
            required: ['confirmed']
        }
    };

    if (!sendRequest) {
        throw new Error(
            'Write operation blocked: this MCP client invocation does not provide server-initiated elicitation support. This server will not perform SAP Business One write operations without explicit user confirmation.'
        );
    }

    try {
        return await sendRequest({
            method: 'elicitation/create',
            params: request
        }, ElicitResultSchema) as FormElicitationResult;
    } catch (error) {
        throw new Error(
            `Write operation blocked: failed to obtain user confirmation via MCP elicitation. ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildConfirmationMessage(options: WriteConfirmationOptions): string {
    const segments = [
        'CONFIRM WRITE OPERATION',
        `OPERATION: ${options.operation}`,
        `ENTITY: ${options.entityName}`
    ];

    if (options.target) {
        segments.push(`TARGET: ${options.target}`);
    }

    for (const line of options.summaryLines ?? []) {
        segments.push(`SUMMARY: ${line}`);
    }

    const parameterSummary = summarizeParameters(options.parameters, options.personalFieldNames);
    if (parameterSummary) {
        segments.push(`FIELDS: ${parameterSummary}`);
    }

    segments.push('RISK: This action will modify SAP Business One data.');
    segments.push('ACTION: Set confirmed=true only if you intend to continue.');

    return segments.join(' | ');
}

function buildSensitiveReadMessage(options: SensitiveReadConfirmationOptions): string {
    const personalFields = options.selectedPersonalFields.join(', ');

    return [
        'CONFIRM SENSITIVE READ OPERATION',
        `ENTITY: ${options.entityName}`,
        `SELECTED_FIELDS: ${options.selectString}`,
        `PERSONAL_FIELDS: ${personalFields}`,
        'RISK: This query may expose sensitive data.',
        'ACTION: Set confirmed=true only if you intend to continue.'
    ].join(' | ');
}

function summarizeParameters(
    parameters?: Record<string, unknown>,
    personalFieldNames: readonly string[] = []
): string {
    if (!parameters) {
        return '';
    }

    const entries = Object.entries(parameters);
    if (entries.length === 0) {
        return '';
    }

    const personalFieldNameSet = new Set(personalFieldNames.map((fieldName) => fieldName.toLowerCase()));

    const visibleEntries = entries.slice(0, 8).map(([key, value]) => {
        if (personalFieldNameSet.has(key.toLowerCase())) {
            return `${key}: [Personal Field]`;
        }

        if (Array.isArray(value)) {
            return `${key}[${value.length}]`;
        }

        if (value !== null && typeof value === 'object') {
            return `${key}{...}`;
        }

        return `${key}: ${truncateScalarValue(value)}`;
    });

    if (entries.length > visibleEntries.length) {
        visibleEntries.push(`+${entries.length - visibleEntries.length} more`);
    }

    return visibleEntries.join(', ');
}

function truncateScalarValue(value: unknown): string {
    const normalizedValue = String(value);
    if (normalizedValue.length <= 50) {
        return normalizedValue;
    }

    return `${normalizedValue.slice(0, 47)}...`;
}