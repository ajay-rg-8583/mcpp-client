# MCPP Client Example

This is a Visual Studio Code extension that acts as a client for MCPP (Model Context Privacy Protocol) servers. It provides a chat interface to interact with different MCPP servers, powered by an OpenAI Large Language Model.

## Features

- **Chat View:** A dedicated view in the explorer to send queries and receive responses from MCPP servers.
- **Privacy-Enhanced Data Handling:** Implements the Model Context Privacy Protocol to protect sensitive data while enabling complex workflows.
- **Pluggable MCPP Servers:** The client is designed to be extensible to connect to various available MCPP servers.
- **LLM Powered:** Utilizes an OpenAI LLM to process and respond to queries while maintaining data privacy.

## Running the Sample

- Run `npm install` in the root folder of this workspace. This will also install the dependencies for the client.
- Open the workspace in VS Code.
- Press `F5` to launch the extension in a new Extension Development Host window.
- In the Extension Development Host window, open the Explorer. You will find the "MCPP Client" view.
- Open the chat view and start sending your queries.

## Configuration

You will need to provide an OpenAI API key for the LLM to work. This can be configured in the extension's settings.
