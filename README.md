# MCPP Client for VSCode

A VSCode extension that provides a chat interface for interacting with MCPP (Model Context Privacy Protocol) servers.

## Features

- **Privacy-First**: Sensitive data is never exposed to LLMs - only placeholders are used
- **Multi-Server Support**: Connect to multiple MCPP servers simultaneously  
- **Unified Access Controls**: Fine-grained permissions for different targets (LLMs, servers, clients)
- **Consent Management**: User consent flows for sensitive data operations
- **Rich Chat Interface**: Modern chat UI with data visualization and tool confirmations

## Quick Start

### 1. Configuration

Edit `.vscode/settings.json` in your workspace:

```json
{
  "mcpClient.servers": {
    "my-server": {
      "description": "My MCPP server",
      "type": "sse",
      "url": "http://localhost:8000/mcpp"
    }
  },
  "mcpClient.openaiApiKey": "sk-your-openai-api-key-here"
}
```

### 2. Usage

1. Start your MCPP server(s)
2. Open VSCode and install/load this extension
3. Open the "MCP Chat" view from the sidebar
4. Start chatting with your privacy-aware assistant!

## Server Configuration

Each server entry requires:
- **Server Key**: Unique identifier (e.g., "my-server")
- **description**: Human-readable description
- **type**: Connection type (currently only "sse" supported)
- **url**: Server endpoint URL ending with `/mcpp`

## Privacy & Security

- **Placeholder System**: Sensitive data appears as `{tool_123.0.email}` to the LLM
- **Access Controls**: Granular permissions for data usage (display/process/store/transfer)
- **Consent Management**: User approval required for sensitive operations
- **Multi-Server Routing**: Secure cross-server data references

## Development

```bash
npm run compile   # Compile TypeScript
npm run watch     # Watch mode for development
```

## Protocol

This client implements the MCPP (Model Context Privacy Protocol) specification, which extends the standard MCP protocol with privacy and access control features.

See `MCPP_HOST_GUIDE.md` for detailed protocol specification.

## Running the Sample

- Run `npm install` in the root folder of this workspace. This will also install the dependencies for the client.
- Open the workspace in VS Code.
- Press `F5` to launch the extension in a new Extension Development Host window.
- In the Extension Development Host window, open the Explorer. You will find the "MCPP Client" view.
- Open the chat view and start sending your queries.

## Configuration

You will need to provide an OpenAI API key for the LLM to work. This can be configured in the extension's settings.
