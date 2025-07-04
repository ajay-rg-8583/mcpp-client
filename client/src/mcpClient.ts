import axios from 'axios';

// Based on MCP SDK types
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    isSensitive: boolean; // Changed from outputIsSensitive to isSensitive
}

export interface ListToolsResponse {
    jsonrpc: '2.0';
    id: string;
    result?: {
        tools: ToolDefinition[];
    };
    error?: unknown;
}

export interface CallToolResponse {
    jsonrpc: '2.0';
    id: string;
    result?: {
        content: { type: string, text: string }[];
        isError?: boolean;
    };
    error?: unknown;
}

export interface ToolCallSummary {
    message: string;
    rowCount?: number;
    columnNames?: string[];
    recordId?: string;
    dataRefId: string;
    retrieval_uri: string;
}

export interface TablePayload {
    headers: string[];
    rows: (string | number | boolean | null)[][];
}

export type KeyValuePayload = Record<string, unknown>;

export interface FetchedData {
    type: 'table' | 'keyValue';
    payload: TablePayload | KeyValuePayload;
}

// New access control interfaces
export interface UsageContext {
    data_usage: 'display' | 'process' | 'store' | 'transfer';
    requester: {
        host_id: string;
        session_id?: string;
        timestamp: number;
    };
    target: {
        type: 'client' | 'server' | 'servers' | 'llm' | 'all';
        destination: string | string[];
        purpose?: string;
        llm_metadata?: {
            model_name?: string;
            provider?: string;
            context_window?: number;
            capabilities?: string[];
            data_retention_policy?: 'none' | 'temporary' | 'training_excluded';
        };
    };
}

export interface ConsentRequest {
    request_id: string;
    message: string;
    data_preview?: string;
    destination_info?: string;
    timeout_seconds: number;
    allow_remember: boolean;
}

export interface ConsentResponse {
    consent_recorded: boolean;
    cached_until?: number;
}

export interface ReferenceResult {
    placeholder: string;
    match_details: {
        column: string;
        row_index: number;
        confidence: number;
    };
}

export interface ResolveResult {
    resolved_data: unknown;
    metadata: {
        placeholders_resolved: number;
        cache_hits: number;
        cache_misses: number;
    };
}

// MCPP Error codes
export enum McppErrorCode {
    INVALID_PARAMS = -32602,
    DATA_NOT_FOUND = -32004,
    CACHE_MISS = -32001,
    REFERENCE_NOT_FOUND = -32002,
    RESOLUTION_FAILED = -32003,
    INSUFFICIENT_PERMISSIONS = -32005,
    INVALID_DATA_USAGE = -32006,
    CONSENT_REQUIRED = -32007,
    CONSENT_DENIED = -32008,
    CONSENT_TIMEOUT = -32009,
    INVALID_TARGET = -32010,
    INTERNAL_ERROR = -32603,
    METHOD_NOT_FOUND = -32601
}

export interface McppError {
    code: McppErrorCode;
    message: string;
    data?: unknown;
}

function parseMcpResponse<T>(data: unknown): T {
    if (typeof data === 'string') {
        const lines = data.split('\n');
        const dataLine = lines.find(line => line.startsWith('data:'));
        if (dataLine) {
            const jsonData = dataLine.substring('data:'.length).trim();
            return JSON.parse(jsonData) as T;
        }
    }
    return data as T;
}

export class McpClient {
    private serverUrl: string;
    private dataCache: Map<string, FetchedData> = new Map<string, FetchedData>();

    constructor(serverUrl: string) {
        this.serverUrl = serverUrl;
    }

    async listTools(): Promise<ListToolsResponse> {
        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'tools/list',
                params: {},
            };
            console.log(`[MCP Client] Request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            //console.log(`[MCP Client] Response from ${this.serverUrl}: ${JSON.stringify(response.data)}`);
            return parseMcpResponse<ListToolsResponse>(response.data);
        } catch (error) {
            console.error('Error listing tools from MCP server:', error);
            throw error;
        }
    }

    // Updated: Use the new mcpp/get_references endpoint (renamed from mcpp/find_reference)
    async getReferencePlaceholder(serverKey: string, toolCallId: string, columnName: string, keyword: string): Promise<string | undefined> {
        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/get_references',
                params: {
                    tool_call_id: toolCallId,
                    keyword: keyword,
                    column_name: columnName,
                },
            };
            console.log(`[MCPP Client] Reference request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            const rpcResponse = parseMcpResponse<{ result: ReferenceResult, error?: McppError }>(response.data);
            if (rpcResponse && rpcResponse.result && rpcResponse.result.placeholder) {
                // Ensure placeholder is in the format {serverKey:toolcallId.rowIndex.columnname}
                const placeholder = rpcResponse.result.placeholder.replace(/^{|}$/g, '');
                return `{${serverKey}:${placeholder}}`;
            }
            return undefined;
        } catch (error) {
            console.error('Error fetching reference placeholder:', error);
            return undefined;
        }
    }

    // Modified: Do not resolve placeholders locally, pass them as-is for the server to resolve
    // Accepts placeholders in the format {serverKey:toolCallId.rowIndex.columnName}
    async callTool(toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<CallToolResponse> {
        try {
            // For each argument, if it's a placeholder, strip the serverKey before sending to the server
            const processedArgs: Record<string, unknown> = {};
            for (const key in args) {
                const value = args[key];
                if (typeof value === 'string') {
                    // Match {serverKey:toolCallId.rowIndex.columnName}
                    const match = value.match(/^\{([^:}]+):([^}]+)\}$/);
                    if (match) {
                        // Remove serverKey: prefix for the server
                        processedArgs[key] = `{${match[2]}}`;
                        continue;
                    }
                }
                processedArgs[key] = value;
            }
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: processedArgs,
                    tool_call_id: toolCallId,
                },
            };
            console.log(`[MCP Client] Request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            // When returning placeholder values, prepend the serverKey for the LLM
            // (Assume the host knows its own serverKey, e.g., this.serverKey)
            // This logic can be extended in the host/chatView as needed
            return parseMcpResponse<CallToolResponse>(response.data);
        } catch (error) {
            console.error('Error calling tool on MCP server:', error);
            throw error;
        }
    }

    async getData(dataRefId: string): Promise<FetchedData> {
        if (this.dataCache.has(dataRefId)) {
            return this.dataCache.get(dataRefId)!;
        }

        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/get_data',
                params: {
                    tool_call_id: dataRefId,
                },
            };
            console.log(`[MCPP Client] Get data request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            //console.log(`[MCPP Client] Response from ${this.serverUrl}: ${JSON.stringify(response.data)}`);
            const rpcResponse = parseMcpResponse<{ result: FetchedData, error?: unknown }>(response.data);
            if (rpcResponse.result) {
                const data = rpcResponse.result;
                this.dataCache.set(dataRefId, data);
                return data;
            } else {
                throw new Error(JSON.stringify(rpcResponse.error ?? 'Error fetching data from server'));
            }
        } catch (error) {
            console.error('Error fetching data from server:', error);
            throw error;
        }
    }

    private async resolvePlaceholders(args: Record<string, unknown>): Promise<Record<string, unknown>> {
        const resolvedArgs = { ...args };
        for (const key in resolvedArgs) {
            const value = resolvedArgs[key];
            if (typeof value === 'string') {
                const match = value.match(/^{{([^:]+):(.*)}}$/);
                if (match) {
                    const toolCallId = match[1];
                    const path = match[2];
                    const cachedData = await this.getData(toolCallId);
                    if (cachedData) {
                        resolvedArgs[key] = this.getValueFromPath(cachedData.payload, path);
                    }
                }
            }
        }
        return resolvedArgs;
    }

    /**
     * Resolves multiple placeholders in a single request to the server using MCPP protocol.
     * @param placeholders A map of argument keys to placeholder strings (e.g., { arg1: "{toolCallId.0.email}", arg2: "{toolCallId.1.name}" })
     * @returns A map of argument keys to resolved values
     */
    async resolveData(placeholders: Record<string, string>): Promise<Record<string, unknown>> {
        try {
            // Build text with placeholders for batch resolution
            const placeholderEntries = Object.entries(placeholders);
            const textWithPlaceholders = placeholderEntries.map(([key, placeholder]) => {
                // Strip serverKey prefixes from placeholders before sending to server
                if (typeof placeholder === 'string') {
                    // Match {serverKey:toolCallId.rowIndex.columnName}
                    const match = placeholder.match(/^\{([^:}]+):([^}]+)\}$/);
                    if (match) {
                        // Remove serverKey: prefix for the server
                        return `${key}:{${match[2]}}`;
                    } else {
                        // Keep as-is if no serverKey prefix
                        return `${key}:${placeholder}`;
                    }
                }
                return `${key}:${placeholder}`;
            }).join(' ');

            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/resolve_placeholders',
                params: {
                    text: textWithPlaceholders
                },
            };
            console.log(`[MCPP Client] Batch resolve request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            const rpcResponse = parseMcpResponse<{ result: { placeholders: Record<string, unknown> }, error?: unknown }>(response.data);
            if (rpcResponse && rpcResponse.result && rpcResponse.result.placeholders) {
                // Map the resolved placeholders back to the original argument keys
                const resolvedData: Record<string, unknown> = {};
                for (const [key, originalPlaceholder] of placeholderEntries) {
                    // Find the resolved value for this key's placeholder
                    const strippedPlaceholder = typeof originalPlaceholder === 'string' 
                        ? originalPlaceholder.replace(/^{[^:}]+:/, '{').replace(/^{|}$/g, '')
                        : originalPlaceholder;
                    
                    for (const [resolvedKey, resolvedValue] of Object.entries(rpcResponse.result.placeholders)) {
                        const resolvedKeyStripped = resolvedKey.replace(/^{|}$/g, '');
                        if (resolvedKeyStripped === strippedPlaceholder) {
                            resolvedData[key] = resolvedValue;
                            break;
                        }
                    }
                }
                return resolvedData;
            }
            throw new Error('No result from mcpp/resolve_placeholders');
        } catch (error) {
            console.error('Error resolving data from server:', error);
            throw error;
        }
    }

    /**
     * Resolve placeholders in data using the correct MCPP format
     * @param data - Can be string, object, array, or complex nested structure
     * @returns Resolved data with placeholders replaced and resolution status
     */
    async resolvePlaceholderData(data: string | Record<string, unknown> | unknown[]): Promise<{ 
        data: unknown, 
        resolution_status?: {
            total_placeholders: number,
            resolved_placeholders: number,
            failed_placeholders: string[],
            success_rate: number
        }
    } | null> {
        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/resolve_placeholders',
                params: {
                    data: data
                },
            };
            console.log(`[MCPP Client] Resolve placeholders request to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            
            interface PlaceholderResponse {
                result: {
                    resolved_data: unknown,
                    resolution_status?: {
                        total_placeholders: number,
                        resolved_placeholders: number,
                        failed_placeholders: string[],
                        success_rate: number
                    }
                },
                error?: unknown
            }
            
            const rpcResponse = parseMcpResponse<PlaceholderResponse>(response.data);
            if (rpcResponse && rpcResponse.result) {
                return { 
                    data: rpcResponse.result.resolved_data,
                    resolution_status: rpcResponse.result.resolution_status
                };
            } else {
                console.error(`[MCPP Client] Failed to resolve placeholders: ${JSON.stringify(rpcResponse?.error)}`);
                return null;
            }
        } catch (error) {
            console.error(`[MCPP Client] Error resolving placeholders:`, error);
            return null;
        }
    }

    /**
     * @deprecated Use resolvePlaceholderData instead - kept for backward compatibility
     * Resolves placeholders in text using the MCPP resolve_placeholders endpoint.
     * @param text Text containing placeholders to resolve
     * @returns Object with resolved placeholders
     */
    async resolvePlaceholderText(text: string): Promise<{ placeholders: Record<string, unknown> } | null> {
        try {
            // Convert to new format and call the new method
            const result = await this.resolvePlaceholderData(text);
            if (result && typeof result.data === 'string') {
                // For backward compatibility, extract placeholders from resolved text
                // This is a simplified approach - in practice, the server should handle this
                return { placeholders: { resolved_text: result.data } };
            }
            return null;
        } catch (error) {
            console.error('Error resolving placeholder text from server:', error);
            return null;
        }
    }

    /**
     * New: Resolve placeholders with unified access controls
     * @param data Data containing placeholders to resolve
     * @param usageContext Context for access control validation
     * @param toolName Optional tool name for context
     * @returns Resolved data or throws access control error
     */
    async resolvePlaceholdersWithAccessControl(
        data: unknown, 
        usageContext: UsageContext, 
        toolName?: string
    ): Promise<ResolveResult> {
        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/resolve_placeholders',
                params: {
                    data: data,
                    usage_context: usageContext,
                    tool_name: toolName
                },
            };
            console.log(`[MCPP Client] Resolve placeholders with access control to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            
            const rpcResponse = parseMcpResponse<{ result: ResolveResult, error?: McppError }>(response.data);
            if (rpcResponse && rpcResponse.result) {
                return rpcResponse.result;
            } else {
                throw rpcResponse.error || new Error('Failed to resolve placeholders');
            }
        } catch (error) {
            console.error(`[MCPP Client] Error resolving placeholders with access control:`, error);
            throw error;
        }
    }

    /**
     * New: Provide user consent for a pending operation
     * @param requestId Consent request ID from the error response
     * @param approved Whether user approved the consent
     * @param rememberChoice Whether to remember this choice
     * @param durationMinutes How long to remember the choice
     * @returns Consent response
     */
    async provideConsent(
        requestId: string, 
        approved: boolean, 
        rememberChoice?: boolean, 
        durationMinutes?: number
    ): Promise<ConsentResponse> {
        try {
            const requestBody = {
                jsonrpc: '2.0',
                id: `req-${Date.now()}`,
                method: 'mcpp/provide_consent',
                params: {
                    request_id: requestId,
                    approved: approved,
                    remember_choice: rememberChoice,
                    duration_minutes: durationMinutes
                },
            };
            console.log(`[MCPP Client] Provide consent to ${this.serverUrl}: ${JSON.stringify(requestBody)}`);
            const response = await axios.post(this.serverUrl, requestBody, {
                headers: {
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json'
                }
            });
            
            const rpcResponse = parseMcpResponse<{ result: ConsentResponse, error?: McppError }>(response.data);
            if (rpcResponse && rpcResponse.result) {
                return rpcResponse.result;
            } else {
                throw rpcResponse.error || new Error('Failed to provide consent');
            }
        } catch (error) {
            console.error(`[MCPP Client] Error providing consent:`, error);
            throw error;
        }
    }

    /**
     * Helper: Create usage context for different scenarios
     */
    createUsageContext(
        dataUsage: 'display' | 'process' | 'store' | 'transfer',
        targetType: 'client' | 'server' | 'servers' | 'llm' | 'all',
        destination: string | string[],
        purpose?: string,
        llmMetadata?: UsageContext['target']['llm_metadata']
    ): UsageContext {
        return {
            data_usage: dataUsage,
            requester: {
                host_id: 'vscode-mcpp-client',
                session_id: `session-${Date.now()}`,
                timestamp: Date.now()
            },
            target: {
                type: targetType,
                destination: destination,
                purpose: purpose,
                llm_metadata: llmMetadata
            }
        };
    }

    /**
     * Helper: Check if error is an MCPP access control error
     */
    isAccessControlError(error: unknown): error is { code: McppErrorCode, message: string, data?: unknown } {
        return typeof error === 'object' && 
               error !== null && 
               'code' in error && 
               typeof (error as { code: unknown }).code === 'number' &&
               Object.values(McppErrorCode).includes((error as { code: number }).code);
    }

    /**
     * Helper: Check if error requires consent
     */
    isConsentRequiredError(error: unknown): error is { code: McppErrorCode.CONSENT_REQUIRED, data: { consent_request: ConsentRequest } } {
        return this.isAccessControlError(error) && error.code === McppErrorCode.CONSENT_REQUIRED;
    }

    private getValueFromPath(data: object, path: string): unknown {
        const parts = path.split('.');
        let currentValue: unknown = data;
        for (const part of parts) {
            if (currentValue === null || currentValue === undefined) {
                return undefined;
            }

            const arrayMatch = part.match(/(\w+)\[(\d+)\]/);
            if (arrayMatch) {
                const arrayKey = arrayMatch[1];
                const index = parseInt(arrayMatch[2], 10);
                if (typeof currentValue === 'object' && currentValue !== null && arrayKey in currentValue) {
                    const array = (currentValue as Record<string, unknown>)[arrayKey];
                    if (Array.isArray(array)) {
                        currentValue = array[index];
                    }
                } else {
                    return undefined;
                }
            } else {
                if (typeof currentValue === 'object' && currentValue !== null && part in currentValue) {
                    currentValue = (currentValue as Record<string, unknown>)[part];
                } else {
                    return undefined;
                }
            }
        }
        return currentValue;
    }
}
