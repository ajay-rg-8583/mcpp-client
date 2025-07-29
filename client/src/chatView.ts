import {
	CancellationToken,
	Uri,
	Webview,
	WebviewView,
	WebviewViewProvider,
	WebviewViewResolveContext,
	workspace
} from 'vscode';
import { McpClient, ToolCallSummary, ToolDefinition, UsageContext, ConsentRequest } from './mcpClient';
import { getLlmResponse } from './llm';
import OpenAI from 'openai';

// MCPP Action type definitions - updated with new action types
interface McppActionData {
	reference_request: { tool_call_id: string, column_name: string, keyword: string };
	display_data: { message: string, tool_call_id: string, usage_context?: UsageContext };
	placeholder_message: { message: string, fallback_message: string, usage_context?: UsageContext };
	direct_message: { message: string };
	consent_response: { 
		message: string, 
		consent_details: { 
			request_id: string, 
			data_summary: string, 
			destination: string, 
			purpose: string 
		} 
	};
	access_denied_message: { 
		message: string, 
		alternative_suggestions: string[], 
		error_context: { 
			error_code: string, 
			blocked_target: string, 
			reason: string 
		} 
	};
}

interface McppAction {
	type: keyof McppActionData;
	data: McppActionData[keyof McppActionData];
}

// Consent management
interface PendingConsent {
	requestId: string;
	consentRequest: ConsentRequest;
	resolve: (approved: boolean) => void;
	reject: (error: Error) => void;
}

export class ChatViewProvider implements WebviewViewProvider {

	public static readonly viewType = 'mcp.chatView';

	private _view?: WebviewView;
	private _confirmationResolver?: (confirmed: boolean) => void;
	private _chatHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
	private _tools: ToolDefinition[] = [];
	// Map of serverKey to McpClient instances
	private _mcpClients = new Map<string, McpClient>();

	// Store last tool call summary and columns for reference
	private _lastToolCallId?: string;
	private _lastToolColumns?: string[];

	// Store all chat histories for each LLM call
	private _allChatHistories: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

	// Map to store tool sensitivity
	private _toolSensitivity = new Map<string, boolean>();

	// Map tool_call_id to tool info for validation
	private _toolCallIdToInfo = new Map<string, { toolName: string, isSensitive: boolean }>();

	// Map tool_call_id to serverKey for multi-server routing
	private _toolCallIdToServerKey = new Map<string, string>();

	// Map tool name to serverKey for correct routing
	private _toolNameToServerKey = new Map<string, string>();

	// Consent management
	private _pendingConsents = new Map<string, PendingConsent>();
	private _consentResolver?: (response: { approved: boolean, rememberChoice?: boolean }) => void;

	constructor(
		private readonly _extensionUri: Uri,
	) { }

	public resolveWebviewView(
		webviewView: WebviewView,
		_context: WebviewViewResolveContext,
		_token: CancellationToken,
	) {
		console.log('Resolving webview view');
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(data => {
			console.log('Received message from webview:', data);
			switch (data.type) {
				case 'query':
					{
						this.handleQuery(data.value);
						break;
					}
				case 'confirmToolCallResponse':
					{
						if (this._confirmationResolver) {
							this._confirmationResolver(data.confirmed);
							this._confirmationResolver = undefined;
						}
						break;
					}
				case 'clearChat':
					{
						this._chatHistory = [];
						break;
					}
				case 'getData':
					{
						this.handleGetData(data.dataRefId);
						break;
					}
				case 'showHistoryRequest':
					{
						this.handleShowHistoryRequest();
						break;
					}
				case 'consentResponse':
					{
						if (this._consentResolver) {
							this._consentResolver({
								approved: data.approved,
								rememberChoice: data.rememberChoice
							});
							this._consentResolver = undefined;
						}
						break;
					}
			}
		});

		this.loadTools();
	}

	/**
	 * Get the correct MCP client for a given serverKey.
	 * If serverKey is not provided, fall back to the first configured server.
	 */
	private async getClient(serverKey?: string): Promise<McpClient | undefined> {
		const servers = workspace.getConfiguration('mcpClient').get('servers') as Record<string, { description: string, url: string }>;
		if (!servers || Object.keys(servers).length === 0) {
			this._view?.webview.postMessage({ type: 'response', value: 'No MCP servers configured. Please check your settings.' });
			return undefined;
		}
		
		// If serverKey is not provided or not found, fall back to the first server
		const chosenServerKey = serverKey && servers[serverKey] ? serverKey : Object.keys(servers)[0];
		
		// Return existing client if already created
		if (this._mcpClients.has(chosenServerKey)) {
			return this._mcpClients.get(chosenServerKey);
		}
		
		// Create new client and cache it
		const serverUrl = servers[chosenServerKey].url;
		const client = new McpClient(serverUrl);
		this._mcpClients.set(chosenServerKey, client);
		
		return client;
	}

	private async loadTools() {
		console.log('=== loadTools called ===');
		const servers = workspace.getConfiguration('mcpClient').get('servers') as Record<string, { description: string, url: string }>; 
		console.log('MCP servers configuration:', JSON.stringify(servers, null, 2));
		console.log('Servers type:', typeof servers, 'Keys:', Object.keys(servers || {}));
		
		if (!servers || Object.keys(servers).length === 0) {
			console.log('No MCP servers configured - servers is:', servers);
			this._view?.webview.postMessage({ type: 'response', value: 'No MCP servers configured. Please check your settings.' });
			return;
		}
		
		// Clear existing mappings
		this._toolNameToServerKey.clear();
		this._toolSensitivity.clear();
		
		const allTools = [];
		const serverErrors = [];
		
		// For each server, load tools and map toolName to serverKey
		for (const [serverKey, serverConfig] of Object.entries(servers)) {
			console.log(`Loading tools from server ${serverKey} at ${serverConfig.url}`);
			
			try {
				const client = await this.getClient(serverKey);
				if (!client) {
					serverErrors.push(`Failed to create client for ${serverKey}`);
					continue;
				}
				
				const listToolsResponse = await client.listTools();
				console.log(`Tools response from ${serverKey}:`, listToolsResponse);
				
				if (listToolsResponse.error || !listToolsResponse.result) {
					const error = `Error listing tools from ${serverKey}: ${JSON.stringify(listToolsResponse.error)}`;
					console.error(error);
					serverErrors.push(error);
					continue;
				}
				
				for (const tool of listToolsResponse.result.tools) {
					console.log(`Adding tool ${tool.name} from server ${serverKey}`);
					this._toolNameToServerKey.set(tool.name, serverKey);
					this._toolSensitivity.set(tool.name, tool.isSensitive);
					allTools.push(tool);
				}
			} catch (error) {
				const errorMsg = `Error communicating with MCP server ${serverKey}: ${error}`;
				console.error(errorMsg);
				serverErrors.push(errorMsg);
			}
		}
		
		this._tools = allTools;
		console.log('Final tools loaded:', this._tools.length, this._tools.map(t => t.name));
		
		// Show status message
		let statusMessage = `Tools loaded: ${allTools.length} tools from ${Object.keys(servers).length} servers.`;
		if (serverErrors.length > 0) {
			statusMessage += `\n\nWarnings:\n${serverErrors.join('\n')}`;
		}
		
		this._view?.webview.postMessage({ type: 'response', value: statusMessage });
	}

	private askForConfirmation(toolName: string, args: Record<string, unknown>): Promise<boolean> {
		const message = {
			type: 'confirmToolCall',
			toolName: toolName,
			args: args
		};
		this._view?.webview.postMessage(message);
		return new Promise<boolean>((resolve) => {
			this._confirmationResolver = resolve;
		});
	}

	private extractServerKeyFromPlaceholderOrMap(argValue: string): string | undefined {
		// Try to extract {serverKey:toolCallId...} or {toolCallId...}
		const matchWithServer = argValue.match(/^{([^:}]+):([^}]+)}$/);
		if (matchWithServer) {
			return matchWithServer[1];
		}
		const matchWithoutServer = argValue.match(/^{([^}]+)}$/);
		if (matchWithoutServer) {
			const toolCallId = matchWithoutServer[1].split('.')[0];
			if (this._toolCallIdToServerKey.has(toolCallId)) {
				return this._toolCallIdToServerKey.get(toolCallId);
			}
		}
		return undefined;
	}

	private async handleCallTool(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) {
		const toolName = toolCall.function.name;
		const args = JSON.parse(toolCall.function.arguments);
		const serverKey: string | undefined = this._toolNameToServerKey.get(toolName);
		// Collect placeholders that need cross-server resolution, grouped by server
		const placeholdersByServer: Record<string, Record<string, string>> = {};
		for (const key in args) {
			const value = args[key];
			if (typeof value === 'string') {
				const matchWithServer = value.match(/^{([^:}]+):([^}]+)}$/);
				const matchWithoutServer = value.match(/^{([^}]+)}$/);
				let placeholderServerKey: string | undefined;
				let toolCallId: string | undefined;
				if (matchWithServer) {
					placeholderServerKey = matchWithServer[1];
					toolCallId = matchWithServer[2].split('.')[0];
				} else if (matchWithoutServer) {
					toolCallId = matchWithoutServer[1].split('.')[0];
					if (this._toolCallIdToServerKey.has(toolCallId)) {
						placeholderServerKey = this._toolCallIdToServerKey.get(toolCallId);
					}
				}
				// If placeholder serverKey is present and does not match the tool's serverKey, mark for resolution
				if (placeholderServerKey && serverKey && placeholderServerKey !== serverKey) {
					if (!placeholdersByServer[placeholderServerKey]) {
						placeholdersByServer[placeholderServerKey] = {};
					}
					placeholdersByServer[placeholderServerKey][key] = value;
				}
			}
		}
		// Batch resolve placeholders for each server
		for (const [otherServerKey, placeholderMap] of Object.entries(placeholdersByServer)) {
			const otherClient = await this.getClient(otherServerKey);
			if (otherClient) {
				const resolved = await otherClient.resolveData(placeholderMap);
				if (resolved) {
					// Update args with resolved values
					for (const [argKey, resolvedValue] of Object.entries(resolved)) {
						if (resolvedValue !== undefined) {
							(args as Record<string, unknown>)[argKey] = resolvedValue; // Use resolved value only in client, do not expose to LLM
						}
					}
				}
			}
		}
		const client = await this.getClient(serverKey);
		if (!client) {
			this._view?.webview.postMessage({ type: 'response', value: `Failed to connect to server for tool ${toolName}` });
			return;
		}
		
		const isSensitive = this._toolSensitivity.get(toolName);

		// Track tool_call_id to tool info and serverKey for validation/routing
		this._toolCallIdToInfo.set(toolCall.id, { toolName, isSensitive: !!isSensitive });
		this._toolCallIdToServerKey.set(toolCall.id, serverKey || Object.keys(this._mcpClients)[0]);

		// For each argument, ensure placeholders include the serverKey
		for (const key in args) {
			const value = args[key];
			if (typeof value === 'string') {
				const match = value.match(/^\{([^:}]+):([^}]+)\}$/);
				if (!match) {
					// If missing serverKey, add it
					if (value.match(/^\{[^}]+\}$/)) {
						args[key] = `{${serverKey}:${value.replace(/^{|}$/g, '')}}`;
					}
				}
			}
		}

		// Skip confirmation for tools that don't need user approval
		const skipConfirmation = false; // All tools now require confirmation except via explicit logic

		if (isSensitive) {
			// MCPP flow: Only use placeholders, do not expose data to LLM or user unless explicitly requested
			if (!this._lastToolCallId) {
				if (!skipConfirmation) {
					const confirmed = await this.askForConfirmation(toolName, args);
					if (!confirmed) {
						this._view?.webview.postMessage({ type: 'response', value: 'Tool call cancelled.' });
						this._chatHistory.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: 'User cancelled tool call.',
						});
						this.runConversation();
						return;
					}
				}
				const callToolResponse = await client!.callTool(toolName, args, toolCall.id);
				if (callToolResponse.error || !callToolResponse.result) {
					const error = `Error calling tool: ${JSON.stringify(callToolResponse.error)}`;
					this._view?.webview.postMessage({ type: 'response', value: error });
					this._chatHistory.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: error,
					});
				} else {
					const toolResponseText = callToolResponse.result.content[0].text;
					try {
						const summary: ToolCallSummary = JSON.parse(toolResponseText);
						this._lastToolCallId = toolCall.id;
						this._lastToolColumns = summary.columnNames;
						this._chatHistory.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: toolResponseText,
						});
						this._view?.webview.postMessage({
							type: 'toolResponse',
							summary: summary,
							toolCallId: toolCall.id
						});
					} catch {
						this._chatHistory.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: '{"error": "Failed to parse tool response from server."}',
						});
						this._view?.webview.postMessage({ type: 'response', value: `Error parsing tool response.` });
					}
				}
				this.runConversation();
				return;
			}
			// For chained tool calls, just pass arguments as-is (no placeholder logic)
			if (this._lastToolCallId && this._lastToolColumns && client) {
				// No placeholder logic, just proceed
			}
			if (!skipConfirmation) {
				const confirmed = await this.askForConfirmation(toolName, args);
				if (!confirmed) {
					this._view?.webview.postMessage({ type: 'response', value: 'Tool call cancelled.' });
					this._chatHistory.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: 'User cancelled tool call.',
					});
					this.runConversation();
					return;
				}
			}
			const callToolResponse = await client!.callTool(toolName, args, toolCall.id);
			if (callToolResponse.error || !callToolResponse.result) {
				const error = `Error calling tool: ${JSON.stringify(callToolResponse.error)}`;
				this._view?.webview.postMessage({ type: 'response', value: error });
				this._chatHistory.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: error,
				});
			} else {
				const toolResponseText = callToolResponse.result.content[0].text;
				try {
					const summary: ToolCallSummary = JSON.parse(toolResponseText);
					this._chatHistory.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: toolResponseText,
					});
					if(toolName !== 'internal_reference') // No tool should be called 'get_references' anymore
					{
						this._view?.webview.postMessage({
							type: 'toolResponse',
							summary: summary,
							toolCallId: toolCall.id
						});
					}
				} catch {
					this._chatHistory.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: '{"error": "Failed to parse tool response from server."}',
					});
					this._view?.webview.postMessage({ type: 'response', value: `Error parsing tool response.` });
				}
			}
			// Reset for next query
			this._lastToolCallId = undefined;
			this._lastToolColumns = undefined;
			this.runConversation();
		} else {
			// Non-sensitive: print tool output directly
			const callToolResponse = await client!.callTool(toolName, args, toolCall.id);
			if (callToolResponse.error || !callToolResponse.result) {
				const error = `Error calling tool: ${JSON.stringify(callToolResponse.error)}`;
				this._view?.webview.postMessage({ type: 'response', value: error });
				this._chatHistory.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: error,
				});
			} else {
				const toolResponseText = callToolResponse.result.content[0].text;
				this._chatHistory.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: toolResponseText,
				});
				if (toolName !== 'internal_reference') { // No tool should be called 'get_references' anymore
					let parsedData;
					try {
						parsedData = JSON.parse(toolResponseText);
					} catch {
						parsedData = { error: 'Failed to parse tool response', raw: toolResponseText };
					}
					if(!toolResponseText.includes("error"))
					{
						parsedData = {
							message: toolName + " executed successfully."
						};
						this._view?.webview.postMessage({
						type: 'toolResponse',
						summary: parsedData,
						toolCallId: toolCall.id
					});
					}
					
					
				}
			}
			this.runConversation();
		}
		return;
	}

	private async handleQuery(query: string) {
		this._chatHistory.push({ role: 'user', content: query });
		this.runConversation();
	}

	private async handleGetData(toolCallIdInput: string) {
		// Always resolve serverKey from toolCallId mapping
		let toolCallId: string | undefined;
		if (typeof toolCallIdInput === 'string') {
			const match = toolCallIdInput.match(/^{?([^}:}]+)[^}]*}?$/); // extract toolCallId from {toolCallId} or {toolCallId.something} or just toolCallId
			if (match) {
				toolCallId = match[1];
			} else {
				toolCallId = toolCallIdInput;
			}
		}
		if (!toolCallId || !this._toolCallIdToServerKey.has(toolCallId)) {
			this._chatHistory.push({ role: 'user', content: `Error: The tool_call_id '${toolCallId}' is not recognized by the host. Please correct your request and use a valid tool_call_id from a previous tool call.` });
			this.runConversation();
			return;
		}
		const serverKey = this._toolCallIdToServerKey.get(toolCallId);
		const client = await this.getClient(serverKey);
		if (!client) {
			this._view?.webview.postMessage({ type: 'response', value: 'MCP Client not initialized.' });
			return;
		}
		try {
			const data = await client.getData(toolCallId);
			// Ensure table data is always in the correct format
			if (
				data &&
				data.type === 'table' &&
				data.payload &&
				Array.isArray((data.payload as { headers?: unknown[] }).headers) &&
				Array.isArray((data.payload as { rows?: unknown[] }).rows)
			) {
				this._view?.webview.postMessage({ type: 'dataView', dataRefId: toolCallId, data: data });
			} else {
				// Fallback: send as-is
				this._view?.webview.postMessage({ type: 'dataView', dataRefId: toolCallId, data: data });
			}
		} catch (error) {
			const errorMessage = `Error fetching data: ${error}`;
			console.error(errorMessage);
			this._view?.webview.postMessage({ type: 'response', value: errorMessage });
		}
	}

	// Handle show history request from webview
	public handleShowHistoryRequest() {
		// Compose the latest LLM request: chat history and tool definitions
		const latestLlmRequest = {
			chatHistory: this._chatHistory,
			toolDefinitions: this._tools
		};
		this._view?.webview.postMessage({ type: 'showHistory', value: this._allChatHistories, latestLlmRequest });
	}

	private async runConversation() {
		try {
			// Debug: Check if tools are loaded
			console.log('Tools available for LLM:', this._tools.length, this._tools.map(t => t.name));
			
			const llmResponse = await getLlmResponse(this._chatHistory, this._tools);
			const { message } = llmResponse;

			// Save a copy of the chat history including the new LLM response for debugging
			this._allChatHistories.push([...this._chatHistory, message]);

			// Check if the LLM response is an MCPP action
			if (message.content && typeof message.content === 'string') {
				console.log(`[MCPP Client] ===== LLM RESPONSE PARSING DEBUG =====`);
				console.log(`[MCPP Client] LLM response content:`, message.content);
				
				try {
					const parsedContent = JSON.parse(message.content);
					console.log(`[MCPP Client] Parsed content:`, parsedContent);
					
					if (parsedContent.mcpp_action) {
						console.log(`[MCPP Client] Found MCPP action:`, parsedContent.mcpp_action);
						// Add the message to chat history before handling the action
						this._chatHistory.push(message);
						await this.handleMcppAction(parsedContent.mcpp_action);
						console.log(`[MCPP Client] ===== END LLM RESPONSE PARSING DEBUG =====`);
						return;
					} else {
						console.log(`[MCPP Client] No mcpp_action found in parsed content`);
					}
				} catch (parseError) {
					console.log(`[MCPP Client] Failed to parse as JSON:`, parseError);
					// Not a JSON response, check for placeholders in plain text
					const placeholders = this.extractPlaceholdersFromText(message.content);
					if (placeholders.length > 0) {
						console.log(`[MCPP Client] Found ${placeholders.length} placeholders in plain text:`, placeholders);
						console.log(`[MCPP Client] Original message: "${message.content}"`);
						// Add the message to chat history before handling placeholder resolution
						this._chatHistory.push(message);
						// Auto-resolve placeholders and display the result
						await this.handlePlaceholderMessageAction({
							message: message.content,
							fallback_message: message.content,
							usage_context: undefined
						});
						console.log(`[MCPP Client] ===== END LLM RESPONSE PARSING DEBUG =====`);
						return;
					} else {
						console.log(`[MCPP Client] No placeholders found in plain text`);
					}
				}
				console.log(`[MCPP Client] ===== END LLM RESPONSE PARSING DEBUG =====`);
			} else {
				console.log(`[MCPP Client] Message content is not a string:`, typeof message.content, message.content);
			}

			if (message.tool_calls) {
				this._chatHistory.push(message);
				for (const toolCall of message.tool_calls) {
					await this.handleCallTool(toolCall);
				}
			} else {
				this._chatHistory.push(message);
				// For non-MCPP responses, display the LLM output directly
				if (message.content) {
					this._view?.webview.postMessage({ type: 'response', value: message.content });
				}
			}
		} catch (error) {
			const errorMessage = `Error in conversation: ${error}`;
			console.error(errorMessage);
			this._view?.webview.postMessage({ type: 'response', value: errorMessage });
		}
	}

	/**
	 * Handle unified MCPP action from LLM response
	 */
	private async handleMcppAction(mcppAction: McppAction) {
		const { type, data } = mcppAction;

		switch (type) {
			case 'reference_request':
				await this.handleReferenceRequestAction(data as McppActionData['reference_request']);
				break;
			
			case 'display_data':
				await this.handleDisplayDataAction(data as McppActionData['display_data']);
				break;
			
			case 'placeholder_message':
				await this.handlePlaceholderMessageAction(data as McppActionData['placeholder_message']);
				break;
			
			case 'direct_message':
				await this.handleDirectMessageAction(data as McppActionData['direct_message']);
				break;
			
			case 'consent_response':
				await this.handleConsentResponseAction(data as McppActionData['consent_response']);
				break;
			
			case 'access_denied_message':
				await this.handleAccessDeniedMessageAction(data as McppActionData['access_denied_message']);
				break;
			
			default:
				// Unknown action type, treat as direct message for safety
				console.warn(`Unknown MCPP action type: ${type}`);
				this._view?.webview.postMessage({ 
					type: 'response', 
					value: `Unknown action type: ${type}. Content: ${JSON.stringify(data)}` 
				});
				break;
		}
	}

	/**
	 * Handle reference_request action - LLM needs a placeholder for specific data
	 */
	private async handleReferenceRequestAction(data: { tool_call_id: string, column_name: string, keyword: string }) {
		const { tool_call_id, column_name, keyword } = data;
		
		// Find the server that handled the original tool call
		const serverKey = this._toolCallIdToServerKey.get(tool_call_id);
		if (!serverKey) {
			const errorMessage = `Error: The tool_call_id '${tool_call_id}' is not recognized. Please use a valid tool_call_id from a previous tool call.`;
			this._chatHistory.push({
				role: 'system',
				content: errorMessage
			});
			this.runConversation();
			return;
		}

		const client = await this.getClient(serverKey);
		if (!client) {
			const errorMessage = 'MCP Client not initialized for the requested server.';
			this._chatHistory.push({
				role: 'system',
				content: errorMessage
			});
			this.runConversation();
			return;
		}

		try {
			const placeholder = await client.getReferencePlaceholder(serverKey, tool_call_id, column_name, keyword);
			if (placeholder) {
				// Strip server key from placeholder before sending to LLM
				// Convert {serverKey:placeholder} to {placeholder} for LLM consumption
				const cleanPlaceholder = placeholder.replace(/^{[^:]+:([^}]+)}$/, '{$1}');
				
				// Add the placeholder result to chat history as a system message for the LLM to use
				this._chatHistory.push({
					role: 'system',
					content: `Reference found for keyword "${keyword}" in column "${column_name}": ${cleanPlaceholder}`
				});
				
				// Continue the conversation with the placeholder available
				this.runConversation();
			} else {
				const errorMessage = `No reference found for keyword "${keyword}" in column "${column_name}" of tool call ${tool_call_id}.`;
				this._chatHistory.push({
					role: 'system',
					content: errorMessage
				});
				this.runConversation();
			}
		} catch (error) {
			const errorMessage = `Error getting reference: ${error}`;
			console.error(errorMessage);
			this._chatHistory.push({
				role: 'system',
				content: errorMessage
			});
			this.runConversation();
		}
	}

	/**
	 * Handle display_data action - Show message and fetch/display data
	 */
	private async handleDisplayDataAction(data: { message: string, tool_call_id: string, usage_context?: UsageContext }) {
		const { message, tool_call_id, usage_context } = data;
		
		// Show the display message first
		this._view?.webview.postMessage({ type: 'response', value: message });
		
		try {
			// Use access control if usage_context is provided
			if (usage_context) {
				const client = await this.getClient();
				if (!client) {
					throw new Error('MCP Client not initialized');
				}
				
				// Get the data from cache first
				const cachedData = await client.getData(tool_call_id);
				
				// Resolve with access controls
				const resolvedData = await this.resolveWithAccessControl(
					cachedData,
					usage_context.data_usage,
					usage_context.target.type,
					usage_context.target.destination,
					usage_context.target.purpose
				);
				
				// Display the resolved data
				this._view?.webview.postMessage({ 
					type: 'dataResponse', 
					value: resolvedData
				});
			} else {
				// Fallback to original behavior without access controls
				await this.handleGetData(tool_call_id);
			}
		} catch (error) {
			console.error('Error in display data action:', error);
			this._view?.webview.postMessage({ 
				type: 'response', 
				value: `Error displaying data: ${error instanceof Error ? error.message : String(error)}`
			});
		}
	}

	/**
	 * Handle placeholder_message action - Resolve placeholders and display result
	 */
	private async handlePlaceholderMessageAction(data: { message: string, fallback_message: string, usage_context?: UsageContext }) {
		const { message, fallback_message } = data;
		
		console.log(`[MCPP Client] ===== EFFICIENT PLACEHOLDER RESOLUTION =====`);
		console.log(`[MCPP Client] Message: "${message}"`);
		console.log(`[MCPP Client] Fallback: "${fallback_message}"`);
		
		// Extract placeholders from the message
		const placeholders = this.extractPlaceholdersFromText(message);
		console.log(`[MCPP Client] Detected placeholders:`, placeholders);
		
		if (placeholders.length === 0) {
			console.log(`[MCPP Client] No placeholders detected - returning message as-is`);
			this._view?.webview.postMessage({ type: 'response', value: message });
			return;
		}
		
		try {
			// Efficiently resolve all placeholders
			const resolvedMessage = await this.resolveMessagePlaceholdersEfficiently(message, placeholders);
			
			console.log(`[MCPP Client] Original: "${message}"`);
			console.log(`[MCPP Client] Resolved: "${resolvedMessage}"`);
			
			if (resolvedMessage === message) {
				console.warn(`[MCPP Client] *** Resolution failed - using fallback ***`);
				this._view?.webview.postMessage({ type: 'response', value: fallback_message });
			} else {
				console.log(`[MCPP Client] *** Resolution successful ***`);
				this._view?.webview.postMessage({ type: 'response', value: resolvedMessage });
			}
		} catch (error) {
			console.error('[MCPP Client] Error resolving placeholders:', error);
			this._view?.webview.postMessage({ type: 'response', value: fallback_message });
		}
	}

	/**
	 * Legacy placeholder resolution for backward compatibility
	 */
	private async legacyResolvePlaceholders(message: string): Promise<string> {
		// Use the newer resolvePlaceholderData method directly on the first available client
		// This is a simplified approach for backward compatibility
		const firstClient = await this.getClient();
		if (!firstClient) {
			console.error('[MCPP Client] No MCP client available for placeholder resolution');
			return message;
		}

		try {
			console.log(`[MCPP Client] Legacy resolution: resolving message: "${message}"`);
			console.log(`[MCPP Client] Calling resolvePlaceholderData on client:`, !!firstClient);
			const result = await firstClient.resolvePlaceholderData(message);
			console.log(`[MCPP Client] Raw result from resolvePlaceholderData:`, result);
			if (result && result.data) {
				console.log(`[MCPP Client] Legacy resolution successful, result.data:`, result.data);
				console.log(`[MCPP Client] Type of result.data:`, typeof result.data);
				const resolvedMessage = String(result.data);
				console.log(`[MCPP Client] Final resolved message: "${resolvedMessage}"`);
				return resolvedMessage;
			} else {
				console.warn(`[MCPP Client] Legacy resolution failed or returned no data, result:`, result);
				return message;
			}
		} catch (error) {
			console.error(`[MCPP Client] Legacy placeholder resolution error:`, error);
			return message;
		}
	}

	/**
	 * Handle direct_message action - Display message directly to user
	 */
	private async handleDirectMessageAction(data: { message: string }) {
		const { message } = data;
		this._view?.webview.postMessage({ type: 'response', value: message });
	}

	/**
	 * Handle reference request from LLM to get placeholder for specific data
	 * @deprecated Use handleReferenceRequestAction instead - this is kept for legacy compatibility
	 */
	private async handleReferenceRequest(referenceRequest: { tool_call_id: string, column_name: string, keyword: string }) {
		const { tool_call_id, column_name, keyword } = referenceRequest;
		
		// Find the server that handled the original tool call
		const serverKey = this._toolCallIdToServerKey.get(tool_call_id);
		if (!serverKey) {
			const errorMessage = `Error: The tool_call_id '${tool_call_id}' is not recognized. Please use a valid tool_call_id from a previous tool call.`;
			this._chatHistory.push({
				role: 'assistant',
				content: errorMessage
			});
			this._view?.webview.postMessage({ type: 'response', value: errorMessage });
			return;
		}

		const client = await this.getClient(serverKey);
		if (!client) {
			const errorMessage = 'MCP Client not initialized for the requested server.';
			this._chatHistory.push({
				role: 'assistant',
				content: errorMessage
			});
			this._view?.webview.postMessage({ type: 'response', value: errorMessage });
			return;
		}

		try {
			const placeholder = await client.getReferencePlaceholder(serverKey, tool_call_id, column_name, keyword);
			if (placeholder) {
				// Add the placeholder result to chat history as a system message
				this._chatHistory.push({
					role: 'assistant',
					content: `Reference found for keyword "${keyword}" in column "${column_name}": ${placeholder}`
				});
				
				// Continue the conversation with the placeholder available
				this.runConversation();
			} else {
				const errorMessage = `No reference found for keyword "${keyword}" in column "${column_name}" of tool call ${tool_call_id}.`;
				this._chatHistory.push({
					role: 'assistant',
					content: errorMessage
				});
				this._view?.webview.postMessage({ type: 'response', value: errorMessage });
			}
		} catch (error) {
			const errorMessage = `Error getting reference: ${error}`;
			console.error(errorMessage);
			this._chatHistory.push({
				role: 'assistant',
				content: errorMessage
			});
			this._view?.webview.postMessage({ type: 'response', value: errorMessage });
		}
	}

	/**
	 * @deprecated No longer used with the new efficient placeholder resolution
	 * Helper method to resolve placeholder text using the MCPP client
	 */
	private async resolvePlaceholderText(client: McpClient, text: string): Promise<{ placeholders: Record<string, unknown> } | null> {
		try {
			// We'll add this method to the MCP client
			return await client.resolvePlaceholderText(text);
		} catch (error) {
			console.error('Error resolving placeholder text:', error);
			return null;
		}
	}

	/**
	 * Handle consent_response action - Present consent request to user
	 */
	private async handleConsentResponseAction(data: { 
		message: string, 
		consent_details: { 
			request_id: string, 
			data_summary: string, 
			destination: string, 
			purpose: string 
		} 
	}) {
		const { message, consent_details } = data;
		
		// Display the message first
		this._view?.webview.postMessage({ type: 'response', value: message });
		
		// Present consent request to user
		const consentMessage = `
**Consent Required**

${consent_details.data_summary} will be sent to ${consent_details.destination}.

**Purpose**: ${consent_details.purpose}

Do you want to allow this data transfer?
		`;
		
		this._view?.webview.postMessage({ 
			type: 'consentRequest', 
			value: {
				message: consentMessage,
				requestId: consent_details.request_id
			}
		});
	}

	/**
	 * Handle access_denied_message action - Explain access restrictions and alternatives
	 */
	private async handleAccessDeniedMessageAction(data: { 
		message: string, 
		alternative_suggestions: string[], 
		error_context: { 
			error_code: string, 
			blocked_target: string, 
			reason: string 
		} 
	}) {
		const { message, alternative_suggestions, error_context } = data;
		
		let fullMessage = message;
		
		if (alternative_suggestions.length > 0) {
			fullMessage += '\n\n**Alternative options:**\n';
			alternative_suggestions.forEach((suggestion, index) => {
				fullMessage += `${index + 1}. ${suggestion}\n`;
			});
		}
		
		if (error_context) {
			fullMessage += `\n\n*Technical details: ${error_context.reason} (Error: ${error_context.error_code})*`;
		}
		
		this._view?.webview.postMessage({ type: 'response', value: fullMessage });
	}

	/**
	 * Extract placeholders from plain text content
	 * Matches patterns like {call_XjsFj5wTs9UUm7bNfdnn2oh6.3.Email} or {tool_call_id.row_index.column_name}
	 */
	private extractPlaceholdersFromText(text: string): string[] {
		const placeholderRegex = /\{([^}]+)\}/g;
		const placeholders: string[] = [];
		let match;
		
		while ((match = placeholderRegex.exec(text)) !== null) {
			const placeholder = match[1];
			// Check if it looks like a call reference (contains call_ or has tool_call_id.row.column structure)
			if (placeholder.includes('call_') || /^[^.]+\.\d+\.[^.]+/.test(placeholder)) {
				placeholders.push(placeholder);
			}
		}
		
		return placeholders;
	}

	/**
	 * Efficiently resolve all placeholders in a message by grouping them by server
	 * and sending batch requests to minimize server calls
	 */
	private async resolveMessagePlaceholdersEfficiently(message: string, placeholders: string[]): Promise<string> {
		console.log(`[MCPP Client] ===== EFFICIENT PLACEHOLDER RESOLUTION PROCESS =====`);
		console.log(`[MCPP Client] Input message: "${message}"`);
		console.log(`[MCPP Client] Placeholders to resolve:`, placeholders);
		
		// Step 1: Group placeholders by their source server
		const placeholdersByServer = await this.groupPlaceholdersByServer(placeholders);
		console.log(`[MCPP Client] Placeholders grouped by server:`, placeholdersByServer);
		
		if (Object.keys(placeholdersByServer).length === 0) {
			console.log(`[MCPP Client] No placeholders could be mapped to servers`);
			return message;
		}
		
		// Step 2: Resolve placeholders from each server in parallel
		const resolutionPromises = Object.entries(placeholdersByServer).map(async ([serverKey, serverPlaceholders]) => {
			console.log(`[MCPP Client] Resolving ${serverPlaceholders.length} placeholders from server: ${serverKey}`);
			return this.resolvePlaceholdersFromServer(serverKey, serverPlaceholders);
		});
		
		const resolutionResults = await Promise.allSettled(resolutionPromises);
		console.log(`[MCPP Client] Resolution results:`, resolutionResults);
		
		// Step 3: Collect all resolved values
		const resolvedValues: Record<string, string> = {};
		resolutionResults.forEach((result, index) => {
			if (result.status === 'fulfilled' && result.value) {
				Object.assign(resolvedValues, result.value);
			} else {
				console.warn(`[MCPP Client] Failed to resolve from server ${Object.keys(placeholdersByServer)[index]}:`, result);
			}
		});
		
		console.log(`[MCPP Client] All resolved values:`, resolvedValues);
		
		// Step 4: Replace all placeholders in the message
		let resolvedMessage = message;
		for (const placeholder of placeholders) {
			const resolvedValue = resolvedValues[placeholder];
			if (resolvedValue !== undefined) {
				const placeholderPattern = `{${placeholder}}`;
				resolvedMessage = resolvedMessage.replace(new RegExp(this.escapeRegex(placeholderPattern), 'g'), resolvedValue);
				console.log(`[MCPP Client] Replaced ${placeholderPattern} with: ${resolvedValue}`);
			} else {
				console.warn(`[MCPP Client] No resolution found for placeholder: ${placeholder}`);
			}
		}
		
		console.log(`[MCPP Client] Final resolved message: "${resolvedMessage}"`);
		console.log(`[MCPP Client] ===== END EFFICIENT RESOLUTION PROCESS =====`);
		return resolvedMessage;
	}

	/**
	 * Group placeholders by their source server using tool call history
	 */
	private async groupPlaceholdersByServer(placeholders: string[]): Promise<Record<string, string[]>> {
		const placeholdersByServer: Record<string, string[]> = {};
		
		for (const placeholder of placeholders) {
			// Extract tool call ID from placeholder (e.g., "call_XjsFj5wTs9UUm7bNfdnn2oh6.3.Email" -> "call_XjsFj5wTs9UUm7bNfdnn2oh6")
			const toolCallId = this.extractToolCallIdFromPlaceholder(placeholder);
			console.log(`[MCPP Client] Placeholder: ${placeholder} -> Tool Call ID: ${toolCallId}`);
			
			if (toolCallId) {
				// Find which server handled this tool call
				const serverKey = this._toolCallIdToServerKey.get(toolCallId);
				console.log(`[MCPP Client] Tool Call ID: ${toolCallId} -> Server: ${serverKey}`);
				
				if (serverKey) {
					if (!placeholdersByServer[serverKey]) {
						placeholdersByServer[serverKey] = [];
					}
					placeholdersByServer[serverKey].push(placeholder);
				} else {
					console.warn(`[MCPP Client] No server found for tool call ID: ${toolCallId}`);
					// Try all available servers as fallback
					const availableServers = this.getAvailableServerKeys();
					if (availableServers.length > 0) {
						const fallbackServer = availableServers[0];
						console.log(`[MCPP Client] Using fallback server: ${fallbackServer}`);
						if (!placeholdersByServer[fallbackServer]) {
							placeholdersByServer[fallbackServer] = [];
						}
						placeholdersByServer[fallbackServer].push(placeholder);
					}
				}
			} else {
				console.warn(`[MCPP Client] Could not extract tool call ID from placeholder: ${placeholder}`);
			}
		}
		
		return placeholdersByServer;
	}

	/**
	 * Extract tool call ID from a placeholder
	 * e.g., "call_XjsFj5wTs9UUm7bNfdnn2oh6.3.Email" -> "call_XjsFj5wTs9UUm7bNfdnn2oh6"
	 */
	private extractToolCallIdFromPlaceholder(placeholder: string): string | null {
		// Handle format: call_ID.row.column
		const match = placeholder.match(/^(call_[^.]+)/);
		if (match) {
			return match[1];
		}
		
		// Handle format: tool_call_id.row.column  
		const dotMatch = placeholder.match(/^([^.]+)\.\d+\.[^.]+$/);
		if (dotMatch) {
			return dotMatch[1];
		}
		
		console.warn(`[MCPP Client] Unrecognized placeholder format: ${placeholder}`);
		return null;
	}

	/**
	 * Resolve placeholders from a specific server
	 */
	private async resolvePlaceholdersFromServer(serverKey: string, placeholders: string[]): Promise<Record<string, string> | null> {
		console.log(`[MCPP Client] Resolving ${placeholders.length} placeholders from server ${serverKey}:`, placeholders);
		
		const client = await this.getClient(serverKey);
		if (!client) {
			console.error(`[MCPP Client] No client available for server: ${serverKey}`);
			return null;
		}
		
		try {
			// Create usage context for display
			const usageContext = client.createUsageContext(
				'display',
				'client', 
				'vscode-chat-view',
				'user_display'
			);
			
			// Create a batch request with all placeholders for this server
			const batchData: Record<string, string> = {};
			placeholders.forEach((placeholder, index) => {
				batchData[`placeholder_${index}`] = `{${placeholder}}`;
			});
			
			console.log(`[MCPP Client] Sending batch request to ${serverKey}:`, batchData);
			
			const result = await client.resolvePlaceholdersWithAccessControl(batchData, usageContext);
			console.log(`[MCPP Client] Server ${serverKey} response:`, result);
			
			if (result.resolved_data && typeof result.resolved_data === 'object') {
				// Map resolved data back to original placeholders
				const resolvedValues: Record<string, string> = {};
				placeholders.forEach((placeholder, index) => {
					const key = `placeholder_${index}`;
					const resolvedValue = (result.resolved_data as Record<string, unknown>)[key];
					if (resolvedValue !== undefined) {
						resolvedValues[placeholder] = String(resolvedValue);
					}
				});
				
				console.log(`[MCPP Client] Resolved values from ${serverKey}:`, resolvedValues);
				return resolvedValues;
			}
			
			console.warn(`[MCPP Client] Server ${serverKey} returned unexpected format:`, result);
			return null;
		} catch (error) {
			console.error(`[MCPP Client] Error resolving from server ${serverKey}:`, error);
			return null;
		}
	}

	/**
	 * Get available server keys
	 */
	private getAvailableServerKeys(): string[] {
		return Array.from(this._mcpClients.keys());
	}

	/**
	 * Escape special regex characters
	 */
	private escapeRegex(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Handle placeholder resolution with access controls
	 */
	private async resolveWithAccessControl(
		data: unknown, 
		dataUsage: 'display' | 'process' | 'store' | 'transfer',
		targetType: 'client' | 'server' | 'servers' | 'llm' | 'all',
		destination: string | string[],
		purpose?: string,
		toolName?: string
	): Promise<unknown> {
		console.log(`[MCPP Client] ===== RESOLVE WITH ACCESS CONTROL DEBUG =====`);
		console.log(`[MCPP Client] Input data:`, data);
		console.log(`[MCPP Client] Data usage:`, dataUsage);
		console.log(`[MCPP Client] Target type:`, targetType);
		console.log(`[MCPP Client] Destination:`, destination);
		console.log(`[MCPP Client] Purpose:`, purpose);
		console.log(`[MCPP Client] Tool name:`, toolName);
		
		const client = await this.getClient();
		if (!client) {
			throw new Error('MCP Client not initialized');
		}

		try {
			const usageContext = client.createUsageContext(dataUsage, targetType, destination, purpose);
			console.log(`[MCPP Client] Created usage context:`, usageContext);
			
			const result = await client.resolvePlaceholdersWithAccessControl(data, usageContext, toolName);
			console.log(`[MCPP Client] Server result:`, result);
			
			// Log resolution status for debugging
			if (result.resolution_status) {
				console.log(`[MCPP Client] Placeholder resolution: ${result.resolution_status.resolved_placeholders}/${result.resolution_status.total_placeholders} resolved (${(result.resolution_status.success_rate * 100).toFixed(1)}%)`);
				if (result.resolution_status.failed_placeholders.length > 0) {
					console.warn(`[MCPP Client] Failed placeholders: ${result.resolution_status.failed_placeholders.join(', ')}`);
				}
			}
			
			console.log(`[MCPP Client] Returning resolved_data:`, result.resolved_data);
			console.log(`[MCPP Client] ===== END RESOLVE WITH ACCESS CONTROL DEBUG =====`);
			return result.resolved_data;
		} catch (error: unknown) {
			// Handle access control errors
			if (client.isConsentRequiredError(error)) {
				// Extract consent request and convert to expected format
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const serverConsentRequest = error.data.consent_request as any; // Server format from your examples
				const consentRequest: ConsentRequest = {
					request_id: serverConsentRequest.request_id,
					message: serverConsentRequest.custom_message || 
						`Permission needed to ${serverConsentRequest.transfer_details?.data_usage || 'process'} data ` +
						`from ${serverConsentRequest.tool_name} to ${serverConsentRequest.transfer_details?.destination_description || 'destination'}. ` +
						`This will affect ${serverConsentRequest.data_summary?.placeholder_count || 0} data item(s).`,
					timeout_seconds: serverConsentRequest.options?.timeout_seconds || 30,
					allow_remember: serverConsentRequest.options?.allow_remember || false,
					data_preview: serverConsentRequest.data_summary ? 
						`Data types: ${serverConsentRequest.data_summary.data_types?.join(', ') || 'unknown'}` : undefined,
					destination_info: serverConsentRequest.transfer_details?.destination_description
				};
				return await this.handleConsentFlow(consentRequest, data, client);
			} else if (client.isAccessControlError(error)) {
				// Handle other access control errors
				throw new Error(`Access denied: ${error.message} (Code: ${error.code})`);
			} else {
				throw error;
			}
		}
	}

	/**
	 * Handle consent flow when user consent is required
	 */
	private async handleConsentFlow(consentRequest: ConsentRequest, originalData: unknown, client: McpClient): Promise<unknown> {
		return new Promise((resolve, reject) => {
			// Store the pending consent
			const pendingConsent: PendingConsent = {
				requestId: consentRequest.request_id,
				consentRequest: consentRequest,
				resolve: async (approved: boolean) => {
					try {
						// Provide consent to server
						await client.provideConsent(consentRequest.request_id, approved, false);
						
						if (approved) {
							// Retry the original operation
							const usageContext = client.createUsageContext('display', 'client', 'user_interface');
							const result = await client.resolvePlaceholdersWithAccessControl(originalData, usageContext);
							resolve(result.resolved_data);
						} else {
							reject(new Error('User denied consent for data operation'));
						}
					} catch (error) {
						reject(error);
					}
				},
				reject: reject
			};

			this._pendingConsents.set(consentRequest.request_id, pendingConsent);

			// Present consent UI to user
			const consentMessage = consentRequest.message || 
				`Permission needed to process your request. Do you want to allow access to the requested data?`;
			
			this._view?.webview.postMessage({
				type: 'consentRequest',
				value: {
					message: consentMessage,
					requestId: consentRequest.request_id,
					timeout: consentRequest.timeout_seconds,
					allowRemember: consentRequest.allow_remember
				}
			});

			// Set up consent resolver
			this._consentResolver = (response: { approved: boolean, rememberChoice?: boolean }) => {
				const pending = this._pendingConsents.get(consentRequest.request_id);
				if (pending) {
					this._pendingConsents.delete(consentRequest.request_id);
					pending.resolve(response.approved);
				}
			};

			// Set timeout if specified
			if (consentRequest.timeout_seconds > 0) {
				setTimeout(() => {
					const pending = this._pendingConsents.get(consentRequest.request_id);
					if (pending) {
						this._pendingConsents.delete(consentRequest.request_id);
						pending.reject(new Error('Consent request timed out'));
					}
				}, consentRequest.timeout_seconds * 1000);
			}
		});
	}

	/**
	 * Clear all cached clients and reload configuration
	 */
	public refreshConfiguration() {
		this._mcpClients.clear();
		this._toolNameToServerKey.clear();
		this._toolSensitivity.clear();
		this._toolCallIdToInfo.clear();
		this._toolCallIdToServerKey.clear();
		this.loadTools();
	}

	private _getHtmlForWebview(webview: Webview) {
		const scriptUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'client', 'web', 'main.js'));
		const styleUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'client', 'web', 'styles.css'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>MCP Chat</title>
			</head>
			<body>
				<div id="header-container">
					<button id="clear-button">Clear Chat</button>
					<button id="history-button">Show LLM Chat History</button>
				</div>
				<div id="chat-container"></div>
				<div id="input-container">
					<textarea id="prompt-input" placeholder="Ask a question..." rows="1"></textarea>
					<button id="ask-button">Ask</button>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
