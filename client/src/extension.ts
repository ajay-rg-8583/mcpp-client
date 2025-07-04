/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { ExtensionContext, window } from 'vscode';
import { ChatViewProvider } from './chatView';

export function activate(context: ExtensionContext) {
	const chatViewProvider = new ChatViewProvider(context.extensionUri);

	context.subscriptions.push(
		window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
	);
}
