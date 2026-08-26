/**
 * SAP Business One Document Service
 * Handles document operations including document-to-document copying
 */

import { B1Client } from './b1-client.js';
import { Logger } from '../loggers/app-logger.js';
import {
    getObjectTypeByEntity,
    getDocumentFlow,
    isValidDocumentFlow
} from '../tools/b1-constants.js';
import {
    SourceDocumentInfo,
    DocumentFromBaseResult,
    DocumentLineWithBase
} from '../types/b1-workflow-types.js';

export class B1DocumentService {
    constructor(
        private readonly sapClient: B1Client,
        private readonly logger: Logger,
        private readonly serviceUrl: string
    ) { }

    /**
     * Get source document details by DocEntry
     */
    async getSourceDocument(
        entityName: string,
        docEntry: number
    ): Promise<SourceDocumentInfo> {
        try {
            this.logger.debug(`Fetching ${entityName} document with DocEntry: ${docEntry}`);

            const response = await this.sapClient.readEntity(
                this.serviceUrl,
                entityName,
                docEntry,
                false
            );

            if (!response.data) {
                throw new Error(`Document not found: ${entityName} DocEntry ${docEntry}`);
            }

            const doc = response.data as Record<string, unknown>;

            // Validate required fields
            if (!doc.CardCode) {
                throw new Error(`Source document ${docEntry} is missing CardCode`);
            }

            if (!doc.DocumentLines || !Array.isArray(doc.DocumentLines)) {
                throw new Error(`Source document ${docEntry} has no DocumentLines`);
            }

            return {
                docEntry: doc.DocEntry as number,
                docNum: doc.DocNum as string,
                cardCode: doc.CardCode as string,
                cardName: doc.CardName as string,
                docDate: doc.DocDate as string,
                docDueDate: doc.DocDueDate as string,
                documentLines: doc.DocumentLines as DocumentLineWithBase[],
                ...doc
            };
        } catch (error) {
            this.logger.error(`Error fetching source document:`, error);
            throw error;
        }
    }

    /**
     * Create a target document from a source document
     */
    async createDocumentFromBase(
        sourceEntityName: string,
        sourceDocEntry: number,
        targetEntityName: string,
        lineSelections?: number[],
        additionalFields?: Record<string, unknown>
    ): Promise<DocumentFromBaseResult> {
        try {
            // Validate document flow
            if (!isValidDocumentFlow(sourceEntityName, targetEntityName)) {
                return {
                    success: false,
                    error: `Invalid document flow: ${sourceEntityName} → ${targetEntityName}. Use get-b1-constants to see supported flows.`,
                    sourceDocument: {
                        docEntry: sourceDocEntry,
                        docNum: '',
                        entityName: sourceEntityName
                    }
                };
            }

            // Get object types
            const sourceObjectType = getObjectTypeByEntity(sourceEntityName);
            const targetObjectType = getObjectTypeByEntity(targetEntityName);
            const documentFlow = getDocumentFlow(sourceEntityName, targetEntityName);

            if (!sourceObjectType || !targetObjectType || !documentFlow) {
                return {
                    success: false,
                    error: `Could not resolve object types for ${sourceEntityName} → ${targetEntityName}`,
                    sourceDocument: {
                        docEntry: sourceDocEntry,
                        docNum: '',
                        entityName: sourceEntityName
                    }
                };
            }

            this.logger.info(`Creating ${targetEntityName} from ${sourceEntityName} (DocEntry: ${sourceDocEntry})`);
            this.logger.debug(`Document flow: ${documentFlow.name} (BaseType: ${sourceObjectType.code})`);

            // Fetch source document
            const sourceDoc = await this.getSourceDocument(sourceEntityName, sourceDocEntry);

            // Build target document lines with base references
            const targetLines: DocumentLineWithBase[] = [];
            const linesToCopy = lineSelections ||
                sourceDoc.documentLines.map((_, index) => index);

            for (const lineIndex of linesToCopy) {
                if (lineIndex >= sourceDoc.documentLines.length) {
                    this.logger.warn(`Line index ${lineIndex} out of range, skipping`);
                    continue;
                }

                const sourceLine = sourceDoc.documentLines[lineIndex];

                // Build target line with base reference
                const targetLine: DocumentLineWithBase = {
                    BaseType: sourceObjectType.code,
                    BaseEntry: sourceDoc.docEntry,
                    BaseLine: lineIndex
                };

                // Copy only safe business fields (allowlist approach)
                // Excludes system-managed, calculated, and accounting fields
                const allowedFields = new Set([
                    'ItemCode',
                    'ItemDescription',
                    'Quantity',
                    'Price',
                    'UnitPrice',
                    'Currency',
                    'DiscountPercent',
                    'WarehouseCode',
                    'TaxCode',
                    'TaxOnly',
                    'CostingCode',
                    'CostingCode2',
                    'CostingCode3',
                    'CostingCode4',
                    'CostingCode5',
                    'ProjectCode',
                    'VatGroup',
                    'UoMCode',
                    'UoMEntry',
                    'MeasureUnit',
                    'UnitsOfMeasurment',
                    'U_', // User-defined fields prefix
                    'FreeText',
                    'Text',
                    'LineVendor'
                ]);

                for (const [key, value] of Object.entries(sourceLine)) {
                    // Include field if it's in allowlist or starts with U_ (user-defined fields)
                    if ((allowedFields.has(key) || key.startsWith('U_')) && value !== null && value !== undefined) {
                        targetLine[key] = value;
                    }
                }

                targetLines.push(targetLine);
            }

            if (targetLines.length === 0) {
                return {
                    success: false,
                    error: 'No valid lines to copy',
                    sourceDocument: {
                        docEntry: sourceDoc.docEntry,
                        docNum: sourceDoc.docNum,
                        entityName: sourceEntityName
                    }
                };
            }

            // Build target document
            const targetDocument: Record<string, unknown> = {
                CardCode: sourceDoc.cardCode,
                DocDate: sourceDoc.docDate,
                DocDueDate: sourceDoc.docDueDate,
                Comments: `Created from ${sourceEntityName} ${sourceDoc.docNum} (DocEntry: ${sourceDoc.docEntry}) via MCP`,
                DocumentLines: targetLines,
                ...additionalFields
            };

            // Create the target document
            this.logger.debug(`Creating ${targetEntityName} with ${targetLines.length} lines`);
            const response = await this.sapClient.createEntity(
                this.serviceUrl,
                targetEntityName,
                targetDocument
            );

            const responseData = response.data as Record<string, unknown>;
            if (!responseData?.DocEntry) {
                throw new Error('Document created but DocEntry not returned');
            }

            const result: DocumentFromBaseResult = {
                success: true,
                targetDocument: {
                    docEntry: responseData.DocEntry as number,
                    docNum: (responseData.DocNum as string) || '',
                    entityName: targetEntityName
                },
                sourceDocument: {
                    docEntry: sourceDoc.docEntry,
                    docNum: sourceDoc.docNum,
                    entityName: sourceEntityName
                }
            };

            this.logger.info(`Successfully created ${targetEntityName} DocEntry: ${result.targetDocument?.docEntry}`);
            return result;

        } catch (error) {
            this.logger.error(`Error creating document from base:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                sourceDocument: {
                    docEntry: sourceDocEntry,
                    docNum: '',
                    entityName: sourceEntityName
                }
            };
        }
    }

    /**
     * Validate if source document exists and is valid for copying
     */
    async validateSourceDocument(
        entityName: string,
        docEntry: number
    ): Promise<{ valid: boolean; error?: string; document?: SourceDocumentInfo }> {
        try {
            const doc = await this.getSourceDocument(entityName, docEntry);

            // Check if document has lines
            if (!doc.documentLines || doc.documentLines.length === 0) {
                return {
                    valid: false,
                    error: `Document ${docEntry} has no lines to copy`
                };
            }

            return {
                valid: true,
                document: doc
            };
        } catch (error) {
            return {
                valid: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
