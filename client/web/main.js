(function () {
    console.log('MCP Client webview script loaded');
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const askButton = document.getElementById('ask-button');
    const promptInput = document.getElementById('prompt-input');
    const clearButton = document.getElementById('clear-button');
    const historyButton = document.getElementById('history-button');

    function addMessage(sender, text) {
        const messageElement = document.createElement('div');
        messageElement.className = 'message ' + sender + '-message';

        const parts = text.split('```');

        parts.forEach((part, index) => {
            if (part.trim() === '') {
                return;
            }

            if (index % 2 === 1) {
                // Code block
                const pre = document.createElement('pre');
                pre.className = 'code-block-in-message';
                
                let codeContent = part;
                const firstLine = part.split('\n')[0].trim();
                // Check if the first line is a language specifier and remove it
                if (firstLine.match(/^[a-zA-Z]+$/)) {
                    codeContent = part.substring(part.indexOf('\n') + 1);
                }
                
                pre.textContent = codeContent.trim();
                messageElement.appendChild(pre);
            } else {
                // Normal text
                const span = document.createElement('span');
                span.textContent = part;
                span.style.whiteSpace = 'pre-wrap'; // Preserve newlines in normal text
                messageElement.appendChild(span);
            }
        });

        chatContainer.appendChild(messageElement);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function addToolResponseMessage(summary, toolCallId) {
        const messageElement = document.createElement('div');
        messageElement.className = 'message bot-message';
        messageElement.dataset.toolCallId = toolCallId; // Store toolCallId for later

        let summaryText = summary.message;
        if (summary.rowCount !== undefined) {
            summaryText += ` (${summary.rowCount} rows)`;
        }
        if (summary.recordId !== undefined) {
            summaryText += ` Record ID: ${summary.recordId}`;
        }

        const textElement = document.createElement('p');
        textElement.textContent = summaryText;
        messageElement.appendChild(textElement);

        // The button is no longer needed, as the LLM will trigger the data view
        // const viewDataButton = document.createElement('button');
        // viewDataButton.textContent = 'View Data';
        // viewDataButton.className = 'view-data-button';
        // viewDataButton.addEventListener('click', () => {
        //     vscode.postMessage({
        //         type: 'getData',
        //         dataRefId: summary.dataRefId
        //     });
        //     viewDataButton.disabled = true;
        //     viewDataButton.textContent = 'Loading...';
        // });

        // messageElement.appendChild(viewDataButton);
        chatContainer.appendChild(messageElement);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderDataView(dataRefId, data) {
        // Always create a new message element for each data display
        const newMessageElement = document.createElement('div');
        newMessageElement.className = 'message bot-message';
        newMessageElement.dataset.toolCallId = dataRefId;
        chatContainer.appendChild(newMessageElement);
        renderDataInContainer(newMessageElement, data);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderDataInContainer(container, data) {
        // Clear previous data views to avoid stacking multiple tables
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }
        const dataContainer = document.createElement('div');
        dataContainer.className = 'data-view';

        if (data.type === 'table') {
            // Create a scrollable wrapper for the table
            const tableWrapper = document.createElement('div');
            tableWrapper.className = 'table-scroll-wrapper';
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const tbody = document.createElement('tbody');

            const headerRow = document.createElement('tr');
            data.payload.headers.forEach(headerText => {
                const th = document.createElement('th');
                th.textContent = headerText;
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);

            data.payload.rows.forEach(rowData => {
                const tr = document.createElement('tr');
                rowData.forEach(cellData => {
                    const td = document.createElement('td');
                    td.textContent = cellData;
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });

            table.appendChild(thead);
            table.appendChild(tbody);
            tableWrapper.appendChild(table);
            dataContainer.appendChild(tableWrapper);
        } else if (data.type === 'keyValue') {
            const pre = document.createElement('pre');
            pre.className = 'code-block-in-message';
            pre.textContent = JSON.stringify(data.payload, null, 2);
            dataContainer.appendChild(pre);
        }

        container.appendChild(dataContainer);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function addConfirmationMessage(toolName, args) {
        const messageElement = document.createElement('div');
        messageElement.className = 'message bot-message';

        const textElement = document.createElement('p');
        textElement.textContent = `Do you want to call the following tool?`;
        messageElement.appendChild(textElement);

        const codeBlock = document.createElement('div');
        codeBlock.className = 'code-block';

        const toolNameElement = document.createElement('div');
        toolNameElement.className = 'tool-name';
        toolNameElement.textContent = toolName;
        codeBlock.appendChild(toolNameElement);

        const argsElement = document.createElement('pre');
        argsElement.className = 'tool-args';
        argsElement.textContent = JSON.stringify(args, null, 2);
        codeBlock.appendChild(argsElement);

        messageElement.appendChild(codeBlock);

        const buttonContainer = document.createElement('div');

        const continueButton = document.createElement('button');
        continueButton.textContent = 'Continue';
        continueButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'confirmToolCallResponse',
                confirmed: true
            });
            chatContainer.removeChild(messageElement);
        });

        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'confirmToolCallResponse',
                confirmed: false
            });
            chatContainer.removeChild(messageElement);
        });

        buttonContainer.appendChild(continueButton);
        buttonContainer.appendChild(cancelButton);
        messageElement.appendChild(buttonContainer);

        chatContainer.appendChild(messageElement);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    clearButton.addEventListener('click', () => {
        chatContainer.innerHTML = '';
        vscode.postMessage({
            type: 'clearChat'
        });
    });

    askButton.addEventListener('click', () => {
        const query = promptInput.value;
        console.log('Ask button clicked. Query:', query);
        if (query) {
            vscode.postMessage({
                type: 'query',
                value: query
            });
            addMessage('user', query);
            promptInput.value = '';
        }
    });

    promptInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            askButton.click();
        }
    });

    historyButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'showHistoryRequest' });
    });

    function showHistoryPopup(histories, latestLlmRequest) {
        const popup = document.createElement('div');
        popup.style.position = 'fixed';
        popup.style.top = '10%';
        popup.style.left = '10%';
        popup.style.width = '80%';
        popup.style.height = '80%';
        popup.style.background = 'white';
        popup.style.border = '2px solid #888';
        popup.style.overflow = 'auto';
        popup.style.zIndex = 10000;
        popup.style.padding = '20px';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.float = 'right';
        closeBtn.onclick = () => popup.remove();
        popup.appendChild(closeBtn);

        const title = document.createElement('h2');
        title.textContent = 'Latest LLM Request (Chat History & Tool Definitions)';
        popup.appendChild(title);

        // Show latest LLM request (chat history and tool definitions)
        if (latestLlmRequest) {
            const section = document.createElement('div');
            section.style.marginBottom = '20px';
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(latestLlmRequest, null, 2);
            section.appendChild(pre);
            popup.appendChild(section);
        } else {
            const noHistory = document.createElement('p');
            noHistory.textContent = 'No LLM history available.';
            popup.appendChild(noHistory);
        }

        document.body.appendChild(popup);
    }

    function showConsentDialog(consentData) {
        const { message, timeout, allowRemember } = consentData;
        
        // Create consent dialog overlay
        const overlay = document.createElement('div');
        overlay.className = 'consent-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1000;
        `;

        const dialog = document.createElement('div');
        dialog.className = 'consent-dialog';
        dialog.style.cssText = `
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        `;

        const messageEl = document.createElement('div');
        messageEl.innerHTML = message.replace(/\n/g, '<br>');
        messageEl.style.cssText = `
            margin-bottom: 20px;
            color: var(--vscode-editor-foreground);
            line-height: 1.4;
        `;

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.cssText = `
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            align-items: center;
        `;

        let rememberCheckbox = null;
        if (allowRemember) {
            const rememberContainer = document.createElement('label');
            rememberContainer.style.cssText = `
                display: flex;
                align-items: center;
                gap: 5px;
                margin-right: auto;
                color: var(--vscode-editor-foreground);
                font-size: 12px;
            `;
            
            rememberCheckbox = document.createElement('input');
            rememberCheckbox.type = 'checkbox';
            rememberCheckbox.id = 'rememberChoice';
            
            const rememberLabel = document.createElement('span');
            rememberLabel.textContent = 'Remember my choice';
            
            rememberContainer.appendChild(rememberCheckbox);
            rememberContainer.appendChild(rememberLabel);
            buttonsContainer.appendChild(rememberContainer);
        }

        const denyButton = document.createElement('button');
        denyButton.textContent = 'Deny';
        denyButton.className = 'consent-button deny';
        denyButton.style.cssText = `
            padding: 8px 16px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;

        const allowButton = document.createElement('button');
        allowButton.textContent = 'Allow';
        allowButton.className = 'consent-button allow';
        allowButton.style.cssText = `
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;

        function closeDialog() {
            document.body.removeChild(overlay);
        }

        function sendResponse(approved) {
            const rememberChoice = rememberCheckbox ? rememberCheckbox.checked : false;
            vscode.postMessage({
                type: 'consentResponse',
                approved: approved,
                rememberChoice: rememberChoice
            });
            closeDialog();
        }

        denyButton.addEventListener('click', () => sendResponse(false));
        allowButton.addEventListener('click', () => sendResponse(true));

        // Handle timeout if specified
        if (timeout && timeout > 0) {
            setTimeout(() => {
                if (document.body.contains(overlay)) {
                    sendResponse(false); // Default to deny on timeout
                }
            }, timeout * 1000);
        }

        buttonsContainer.appendChild(denyButton);
        buttonsContainer.appendChild(allowButton);

        dialog.appendChild(messageEl);
        dialog.appendChild(buttonsContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Focus the allow button by default
        allowButton.focus();
    }

    window.addEventListener('message', event => {
        const message = event.data;
        console.log('Received message from extension:', message);
        switch (message.type) {
            case 'response':
                addMessage('bot', message.value);
                break;
            case 'toolResponse': {
                addToolResponseMessage(message.summary, message.toolCallId);
                break;
            }
            case 'dataView': {
                renderDataView(message.dataRefId, message.data);
                break;
            }
            case 'confirmToolCall': {
                addConfirmationMessage(message.toolName, message.args);
                break;
            }
            case 'showHistory': {
                showHistoryPopup(message.value, message.latestLlmRequest);
                break;
            }
            case 'consentRequest': {
                showConsentDialog(message.value);
                break;
            }
            case 'dataResponse': {
                addMessage('bot', JSON.stringify(message.value, null, 2));
                break;
            }
        }
    });
}());
