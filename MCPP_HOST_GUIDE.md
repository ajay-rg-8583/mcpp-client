# Model Context Privacy Protocol (MCPP) Host Protocol Guide

This guide defines the protocol specifications for implementing an MCPP host (client) that can interact with MCPP-enabled servers to manage sensitive data flows while maintaining privacy and security, including support for LLM targets and fine-grained access controls.

## Overview

The Model Context Privacy Protocol (MCPP) is an extension to the Model Context Protocol (MCP) that enables privacy-enhanced data handling for sensitive tool outputs. An MCPP host acts as a client that can:

1. Execute tools on MCPP servers and cache sensitive outputs
2. Generate privacy-preserving placeholders for sensitive data
3. Resolve placeholders back to actual values when needed
4. Manage data flows between different tools, servers, and LLMs
5. Handle consent management and access control validation
6. Support unified target access controls for all destination types

## Key Features

- **🔒 Enhanced Privacy Controls**: Fine-grained data usage validation and access controls
- **🤖 LLM Target Support**: Native support for Language Model targets with specialized policies
- **🎯 Unified Access Controls**: Single framework for all target types (LLMs, servers, clients)
- **👤 Consent Management**: Asynchronous user consent flows with caching
- **📊 Hierarchical Data Usage**: display < process < store < transfer validation
- **🛡️ Target-Specific Policies**: Customizable policies per target with metadata support

## Protocol Specifications

### 1. Communication Protocol

MCPP uses JSON-RPC 2.0 over HTTP/HTTPS for communication between hosts and servers. All requests follow the standard JSON-RPC format:

```json
{
  "jsonrpc": "2.0",
  "method": "endpoint_name",
  "params": { /* endpoint-specific parameters */ },
  "id": "unique_request_id"
}
```

### 2. Base URL Structure

MCPP endpoints are accessed via the `/mcpp` path on the server:
- Base URL: `http://server-host:port/mcpp`
- All MCPP-specific methods use the `mcpp/` prefix

### 3. Data Structures

#### Usage Context Structure
```json
{
  "data_usage": "display" | "process" | "store" | "transfer",
  "requester": {
    "host_id": "string",
    "session_id": "string (optional)",
    "timestamp": "number"
  },
  "target": {
    "type": "client" | "server" | "llm" | "all",
    "destination": "string or array",
    "purpose": "string (optional)",
    "llm_metadata": {
      "model_name": "string (optional)",
      "provider": "string (optional)", 
      "context_window": "number (optional)",
      "capabilities": "array (optional)",
      "data_retention_policy": "none | temporary | training_excluded (optional)"
    }
  }
}
```

#### CachedData Structure
```json
{
  "type": "table" | "text" | "json",
  "payload": {
    // Type-specific data structure
  },
  "metadata": {
    "tool_name": "string",
    "timestamp": "number",
    "is_sensitive": "boolean"
  }
}
```

#### Table Data Format
```json
{
  "type": "table",
  "payload": {
    "headers": ["column1", "column2", "column3"],
    "rows": [
      ["value1", "value2", "value3"],
      ["value4", "value5", "value6"]
    ]
  }
}
```

#### Placeholder Format
Placeholders follow the pattern: `{tool_call_id.row_index.column_name}`
- Example: `{tool_12345.0.Name}` references row 0, column "Name" from tool call ID "tool_12345"

## MCPP Endpoint Specifications

### 1. Standard Tool Execution

**Endpoint**: Standard MCP `tools/call` method
**Purpose**: Execute tools on the server and receive results

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    },
    "tool_call_id": "unique_identifier"
  },
  "id": "request_id"
}
```

**Response Format**:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Tool execution result"
      }
    ],
    "isError": false
  },
  "id": "request_id"
}
```

### 2. Data Retrieval Endpoint

**Endpoint**: `mcpp/get_data`
**Purpose**: Retrieve cached data from a previous tool execution

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "method": "mcpp/get_data",
  "params": {
    "tool_call_id": "unique_tool_call_identifier",
    "usage_context": {
      "data_usage": "display",
      "requester": {
        "host_id": "client_001",
        "session_id": "session_123",
        "timestamp": 1672531200000
      },
      "target": {
        "type": "client",
        "destination": "dashboard_app",
        "purpose": "user_display"
      }
    }
  },
  "id": "request_id"
}
```

**Success Response**:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "type": "table",
    "payload": {
      "headers": ["ID", "Name", "Email"],
      "rows": [
        ["1", "John Doe", "john@example.com"],
        ["2", "Jane Smith", "jane@example.com"]
      ]
    },
    "metadata": {
      "tool_name": "get_contacts",
      "timestamp": 1672531200000,
      "is_sensitive": true
    }
  },
  "id": "request_id"
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32004,
    "message": "Cached data not found for the given tool_call_id",
    "data": {
      "tool_call_id": "missing_id",
      "available_caches": ["tool_123", "tool_456"]
    }
  },
  "id": "request_id"
}
```

### 3. Reference Finding Endpoint

**Endpoint**: `mcpp/find_reference`
**Purpose**: Find placeholder references for specific data using similarity matching

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "method": "mcpp/find_reference",
  "params": {
    "tool_call_id": "source_tool_call_id",
    "keyword": "search_term",
    "column_name": "optional_specific_column"
  },
  "id": "request_id"
}
```

**Success Response**:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "placeholder": "{tool_123.0.Name}",
    "metadata": {
      "similarity": 0.95,
      "keyword": "John Doe",
      "similarity_threshold": 0.7,
      "best_similarity": 0.95,
      "searched_rows": 10,
      "searched_columns": 5
    }
  },
  "id": "request_id"
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32002,
    "message": "No reference found for keyword: unknown_term",
    "data": {
      "keyword": "unknown_term",
      "tool_call_id": "tool_123",
      "similarity_threshold": 0.7
    }
  },
  "id": "request_id"
}
```

### 4. Placeholder Resolution Endpoint

**Endpoint**: `mcpp/resolve_placeholders`
**Purpose**: Resolve placeholders in text back to their actual values

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "method": "mcpp/resolve_placeholders",
  "params": {
    "data": "Hello {tool_123.0.Name}, your email is {tool_123.0.Email}",
    "usage_context": {
      "data_usage": "transfer",
      "requester": {
        "host_id": "llm_client_001",
        "session_id": "llm_session_456",
        "timestamp": 1672531200000
      },
      "target": {
        "type": "llm",
        "destination": "claude-3",
        "purpose": "customer_support",
        "llm_metadata": {
          "model_name": "claude-3",
          "provider": "anthropic",
          "context_window": 100000,
          "capabilities": ["text_generation", "analysis"],
          "data_retention_policy": "none"
        }
      }
    },
    "tool_name": "get_customer_records"
  },
  "id": "request_id"
}
```

**Success Response**:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "resolved_data": "Hello John Doe, your email is john@example.com",
    "resolution_status": {
      "total_placeholders": 2,
      "resolved_placeholders": 2,
      "failed_placeholders": 0,
      "success_rate": 1.0
    }
  },
  "id": "request_id"
}
```

**Consent Required Response**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32007,
    "message": "User consent required for data transfer",
    "data": {
      "consent_request": {
        "request_id": "consent_1672531200_abc123",
        "tool_name": "get_customer_records",
        "data_summary": {
          "placeholder_count": 2,
          "data_types": ["Name", "Email"],
          "sensitive_fields": ["Email"]
        },
        "transfer_details": {
          "destination_server": "claude-3",
          "destination_description": "Anthropic Claude 3 Language Model",
          "data_usage": "transfer",
          "trust_level": "high"
        },
        "options": {
          "allow_remember": true,
          "timeout_seconds": 30,
          "show_data_preview": true
        },
        "custom_message": "This operation will send customer data to Claude-3 for analysis. Do you want to proceed?"
      }
    }
  },
  "id": "request_id"
}
```

**Access Denied Response**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32005,
    "message": "Target access denied: llm_blocked_by_tool",
    "data": {
      "validation_details": {
        "data_usage_valid": true,
        "target_permissions_valid": false,
        "consent_check": {
          "consent_required": false,
          "reason": ["target_denied"],
          "trusted_server": false
        }
      }
    }
  },
  "id": "request_id"
}
```

### 5. Consent Management Endpoint

**Endpoint**: `mcpp/provide_consent`
**Purpose**: Provide user consent for pending data transfer requests

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "method": "mcpp/provide_consent",
  "params": {
    "request_id": "consent_1672531200_abc123",
    "approved": true,
    "remember_choice": false,
    "duration_minutes": 60
  },
  "id": "request_id"
}
```

**Success Response**:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "consent_recorded": true,
    "request_id": "consent_1672531200_abc123",
    "expires_at": 1672534800000,
    "cache_key": "claude-3_transfer_llm"
  },
  "id": "request_id"
}
```
  "id": "request_id"
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32003,
    "message": "Failed to resolve placeholders: tool_456.0.Phone",
    "data": {
      "failed_placeholders": ["tool_456.0.Phone"],
      "resolved_placeholders": {
        "tool_123.0.Name": "John Doe"
      }
    }
  },
  "id": "request_id"
}
```

## Error Code Specifications

MCPP uses standard JSON-RPC error codes plus additional codes for privacy-specific errors:

| Code | Name | Description |
|------|------|-------------|
| -32602 | INVALID_PARAMS | Invalid method parameters |
| -32004 | DATA_NOT_FOUND | Requested data not found in cache |
| -32001 | CACHE_MISS | Cache miss for requested tool_call_id |
| -32002 | REFERENCE_NOT_FOUND | No matching reference found for keyword |
| -32003 | RESOLUTION_FAILED | Failed to resolve one or more placeholders |
| -32005 | INSUFFICIENT_PERMISSIONS | Access denied due to permission restrictions |
| -32006 | INVALID_DATA_USAGE | Invalid or unauthorized data usage level |
| -32007 | CONSENT_REQUIRED | User consent required for operation |
| -32008 | CONSENT_DENIED | User denied consent for operation |
| -32009 | CONSENT_TIMEOUT | Consent request timed out |
| -32010 | INVALID_TARGET | Invalid or unsupported target specification |
| -32603 | INTERNAL_ERROR | Server internal error |
| -32601 | METHOD_NOT_FOUND | Requested method not supported |

### Enhanced Error Responses

**Permission Error Example**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32005,
    "message": "Target access denied: llm_not_in_allowlist",
    "data": {
      "validation_details": {
        "data_usage_valid": true,
        "target_permissions_valid": false,
        "consent_check": {
          "consent_required": false,
          "reason": ["target_denied"],
          "trusted_server": false
        }
      },
      "target": {
        "type": "llm",
        "destination": "gpt-4"
      },
      "tool_name": "get_sensitive_data"
    }
  },
  "id": "request_id"
}
```

## Host Implementation Requirements

### 1. Connection Management

The host must:
- Establish connection to MCPP server via standard MCP transport
- Maintain connection state and handle reconnection
- Support both stdio and HTTP transport methods
- Handle authentication if required by the server
- Support HTTPS for production deployments

### 2. Data Usage Context Management

The host must implement:
- **Data Usage Hierarchies**: Understand display < process < store < transfer levels
- **Target Type Support**: Handle client, server, llm, and all target types
- **Usage Context Generation**: Create proper usage context for each request
- **Purpose Tracking**: Track and specify purpose for each data access

### 3. Target Management

The host should support:
- **Unified Target Handling**: Same logic for LLMs, servers, and clients
- **Target Metadata**: Include relevant metadata for LLM targets (model, provider, etc.)
- **Target Validation**: Validate target format and accessibility
- **Target Categories**: Handle different target categories (internal, external, etc.)

### 4. Consent Management

The host must implement:
- **Consent Request Handling**: Process consent requests from server
- **User Interface**: Provide UI for user consent decisions
- **Consent Caching**: Cache consent decisions when allowed
- **Timeout Handling**: Handle consent timeouts gracefully
- **Remember Preferences**: Support user preference storage

### 5. Data Caching Strategy

The host should implement:
- Local cache for tool execution results
- Cache key format: `tool_call_id` → cached data
- Configurable cache expiration policies
- Cache cleanup mechanisms for memory management
- Sensitive data encryption in cache

### 6. Access Control Validation

The host should handle:
- **Permission Checking**: Validate target permissions before requests
- **Policy Enforcement**: Enforce data usage policies
- **Error Handling**: Handle permission denied scenarios gracefully
- **Fallback Strategies**: Implement fallback for blocked targets

#### Unified Target Access Control Implementation

MCPP implements a unified access control system that treats all target types (LLMs, servers, clients) consistently. This approach simplifies configuration and ensures consistent behavior across different target types.

##### Core Access Control Concepts

**Target Permissions Structure**:
```json
{
  "allowed_targets": ["target1", "target2"] | "all" | "none",
  "blocked_targets": ["blocked_target1", "blocked_target2"],
  "allowed_clients": ["client1", "client2"] | "all" | "none",
  "allowed_servers": ["server1", "server2"] | "all" | "none", 
  "blocked_servers": ["blocked_server1", "blocked_server2"]
}
```

**Target Categories Configuration**:
```json
{
  "target_identifier": {
    "type": "server" | "llm" | "client" | "other",
    "category": "internal" | "partner" | "external" | "public",
    "trust_level": "high" | "medium" | "low",
    "requires_consent": "boolean",
    "metadata": {
      "provider": "string (for LLMs)",
      "model_type": "local | cloud | hybrid (for LLMs)",
      "data_retention": "none | temporary | permanent (for LLMs)",
      "allowed_data_types": ["array for LLMs"],
      "domain": "string (for servers)",
      "application_type": "string (for clients)"
    },
    "description": "string"
  }
}
```

##### Target Permission Validation Flow

1. **Check Unified Controls First**: Look at `allowed_targets` and `blocked_targets`
2. **Legacy Fallback**: Use type-specific rules if no unified rules exist
3. **Global Policy Check**: Apply `trusted_targets` and consent requirements
4. **Target Category Lookup**: Check `target_categories` for specific policies
5. **Data Usage Validation**: Ensure usage context matches permissions
6. **LLM-Specific Checks**: Apply data retention and data type policies for LLM targets

##### LLM-Specific Access Control Considerations

For LLM targets, additional validation applies:
- **Data Retention Policy**: Check if LLM retains data permanently
- **Allowed Data Types**: Validate data types against LLM capabilities
- **Provider Trust**: Consider LLM provider trust level
- **Consent Requirements**: Apply LLM-specific consent rules
```

### 7. Sensitivity Detection

The host must implement sensitivity detection logic:
- Pattern-based detection (configurable patterns)
- Keyword-based detection (email, phone, etc.)
- Manual override capabilities
- Default sensitivity levels
- Context-aware sensitivity classification

### 8. Configuration Examples

#### Example 1: Tool with Unified Target Controls

```json
{
  "name": "get_customer_data",
  "description": "Retrieves sensitive customer information",
  "isSensitive": true,
  "dataPolicy": {
    "data_usage_permissions": {
      "display": "allow",
      "process": "allow",
      "store": "prompt",
      "transfer": "prompt"
    },
    "target_permissions": {
      "allowed_targets": ["internal_llm", "analytics_server", "mobile_app"],
      "blocked_targets": ["external_llm", "competitor_api"]
    },
    "consent_overrides": {
      "custom_consent_message": "This will access sensitive customer data. Continue?",
      "allowed_without_consent": ["internal_llm"]
    }
  }
}
```

#### Example 2: Server Configuration with Target Categories

```json
{
  "global_policies": {
    "default_data_usage_policy": {
      "display": "allow",
      "process": "allow",
      "store": "prompt",
      "transfer": "prompt"
    },
    "user_consent_settings": {
      "require_consent_for": {
        "sensitive_data_transfer": true,
        "llm_data_access": true,
        "external_server_transfer": true
      },
      "trusted_targets": [
        "internal_llm",
        "company_analytics",
        "mobile_app_v2"
      ]
    },
    "target_categories": {
      "internal_llm": {
        "type": "llm",
        "category": "internal",
        "trust_level": "high",
        "requires_consent": false,
        "metadata": {
          "provider": "internal",
          "model_type": "local",
          "data_retention": "none",
          "allowed_data_types": ["customer_data", "analytics", "reports"]
        }
      },
      "gpt-4": {
        "type": "llm",
        "category": "external",
        "trust_level": "medium",
        "requires_consent": true,
        "metadata": {
          "provider": "openai",
          "model_type": "cloud",
          "data_retention": "temporary",
          "allowed_data_types": ["general", "public_data"]
        }
      },
      "analytics_server": {
        "type": "server",
        "category": "internal",
        "trust_level": "high",
        "requires_consent": false,
        "metadata": {
          "domain": "analytics.company.com"
        }
      },
      "mobile_app_v2": {
        "type": "client",
        "category": "internal",
        "trust_level": "high",
        "requires_consent": false,
        "metadata": {
          "application_type": "mobile",
          "platform": "ios_android"
        }
      }
    }
  }
}
```

### 9. Placeholder Management

The host should handle:
- Placeholder generation: `{tool_call_id.row_index.column_name}`
- Placeholder validation and syntax checking
- Bulk placeholder resolution
- Partial resolution handling (fallback strategies)
- Cross-reference placeholder support

### 10. Enhanced Request Flow Management

Enhanced MCPP host request flow with access controls:

1. **Pre-execution Validation**
   - Validate target permissions
   - Check data usage requirements
   - Determine consent needs

2. **Tool Execution Phase**
   - Execute tool via standard MCP `tools/call`
   - Generate unique `tool_call_id`
   - Cache result locally with encryption
   - Detect data sensitivity
   - Generate placeholders if sensitive

3. **Access Control Phase**
   - **Unified Target Validation**: Check `allowed_targets` and `blocked_targets` first
   - **Legacy Fallback**: Use type-specific rules (`allowed_servers`, etc.) if no unified rules
   - **Global Policy Check**: Apply `trusted_targets` and consent requirements
   - **Target Category Lookup**: Check `target_categories` for specific policies
   - **Data Usage Hierarchy**: Validate usage context (display < process < store < transfer)
   - **LLM-Specific Checks**: Apply data retention and data type policies for LLM targets
   - **Consent Management**: Handle consent requests for restricted operations

4. **Reference Generation Phase**
   - Use `mcpp/find_reference` to find data references
   - Store placeholder mappings securely
   - Handle similarity matching results

5. **Resolution Phase**
   - Include usage context in resolution requests
   - Handle consent requirements
   - Use `mcpp/resolve_placeholders` for final output
   - Handle resolution failures gracefully
   - Provide fallback values when needed

### 11. LLM Integration Support

The host should support:
- **LLM Target Recognition**: Identify and handle LLM destinations
- **Model Metadata**: Include model name, provider, capabilities
- **Data Retention Policies**: Understand and enforce retention policies
- **LLM-Specific Consent**: Handle LLM-specific consent messages
- **Context Window Management**: Consider LLM context limitations

## Security and Privacy Considerations

### 1. Data Protection

- Never log or persist sensitive data without encryption
- Implement secure cache storage mechanisms
- Use HTTPS for server communication in production
- Clear sensitive data from memory after use

### 2. Input Validation

- Validate all placeholder syntax before resolution
- Sanitize user inputs to prevent injection attacks
- Validate tool_call_id format and existence
- Check parameter types and required fields

### 3. Access Control

- Implement user-based access controls if needed
- Validate permissions for data access
- Log access attempts for audit purposes
- Support role-based data filtering

### 4. Error Handling

- Never expose sensitive data in error messages
- Provide generic error messages to clients
- Log detailed errors securely on server side
- Implement proper error recovery mechanisms

## Usage Patterns

### 1. Basic Tool Execution with Access Controls

1. Create usage context with target information
2. Execute tool: `tools/call` → get `tool_call_id`
3. Cache result locally with sensitivity flag
4. Generate placeholders for sensitive data
5. Return sanitized result to user

**Example Usage Context for Client Display**:
```json
{
  "data_usage": "display",
  "requester": { 
    "host_id": "app_001", 
    "timestamp": 1699123456789 
  },
  "target": { 
    "type": "client", 
    "destination": "dashboard" 
  }
}
```

### 2. LLM Data Transfer with Consent

1. Create LLM usage context with metadata
2. Attempt placeholder resolution
3. Handle consent request if required
4. Proceed after consent approval

**Example LLM Analysis Request**:
```json
{
  "data_usage": "transfer",
  "requester": { 
    "host_id": "ai_assistant", 
    "timestamp": 1699123456789 
  },
  "target": {
    "type": "llm",
    "destination": "claude-3",
    "purpose": "customer_support",
    "llm_metadata": {
      "model_name": "claude-3",
      "provider": "anthropic",
      "data_retention_policy": "none"
    }
  }
}
```

### 3. Cross-Tool Data Reference with Validation

1. Execute first tool and cache result
2. Validate target permissions for second tool
3. Find reference: `mcpp/find_reference` → get placeholder
4. Use placeholder in second tool execution with usage context
5. Resolve final output: `mcpp/resolve_placeholders` with consent

### 4. Consent Flow Management

1. Attempt data operation
2. Receive consent required error
3. Present consent request to user
4. Submit consent decision via `mcpp/provide_consent`
5. Retry original operation
6. Cache consent decision if allowed

**Example Consent Flow Implementation**:
```json
// 1. Attempt operation
{
  "jsonrpc": "2.0",
  "method": "mcpp/resolve_placeholders",
  "params": { "data": "...", "usage_context": "..." }
}

// 2. Handle consent required error (-32007)
{
  "error": {
    "code": -32007,
    "data": {
      "consent_request": {
        "request_id": "consent_123",
        "message": "Send data to Claude-3?",
        "timeout_seconds": 30
      }
    }
  }
}

// 3. Submit consent decision
{
  "jsonrpc": "2.0", 
  "method": "mcpp/provide_consent",
  "params": {
    "request_id": "consent_123",
    "approved": true,
    "remember_choice": true
  }
}

// 4. Retry original operation
```

### 5. Batch Processing with Mixed Targets

1. Execute multiple tools in sequence
2. Cache all results with unique `tool_call_id`s
3. Build operations with multiple placeholders for different targets
4. Handle different consent requirements per target
5. Resolve final results with appropriate usage contexts

### 6. Data Pipeline Processing with Access Control

1. Execute data source tool
2. Generate references for key fields
3. Validate permissions for each processing step
4. Execute processing tools using placeholders with usage contexts
5. Handle consent requirements at each stage
6. Resolve final results for appropriate targets

### 7. Unified Target Handling

The same request patterns work for all target types:

**LLM Target Example**:
```json
{
  "target": {
    "type": "llm",
    "destination": "claude-3",
    "purpose": "analysis"
  }
}
```

**Server Target Example**:
```json
{
  "target": {
    "type": "server", 
    "destination": "analytics_server",
    "purpose": "data_processing"
  }
}
```

**Client Target Example**:
```json
{
  "target": {
    "type": "client",
    "destination": "mobile_app",
    "purpose": "user_display"
  }
}
```

This protocol specification provides the foundation for implementing MCPP hosts in any programming language while ensuring consistent behavior and interoperability with MCPP-enabled servers.

## Advanced Features Summary

### 🔒 **Enhanced Access Controls**
- **Unified Target Framework**: Single `allowed_targets`/`blocked_targets` for all target types (LLMs, servers, clients)
- **Backward Compatibility**: Legacy type-specific rules still supported but unified approach takes precedence
- **Hierarchical Data Usage Validation**: display < process < store < transfer with granular permissions
- **Target Categories**: Rich metadata and policies per target (trust level, data retention, consent requirements)
- **Tool-Specific Policies**: Override global policies at the tool level
- **Global Policy Enforcement**: Server-wide defaults with `trusted_targets` and domain-based trust
- **Fine-Grained LLM Controls**: Data type restrictions, retention policies, and provider-specific rules

### 🤖 **Native LLM Support**
- Specialized handling for Language Model targets
- LLM metadata support (model, provider, capabilities)
- Data retention policy enforcement
- LLM-specific consent messages

### 👤 **Sophisticated Consent Management**
- Asynchronous consent workflows
- Consent caching with expiration
- User preference memory
- Timeout handling

### 🎯 **Target-Agnostic Design**
- Same API for all target types
- Consistent validation logic
- Unified configuration approach
- Extensible for future target types

### 📊 **Rich Metadata Support**
- Detailed usage context tracking
- Purpose specification for data access
- Comprehensive error reporting
- Validation details in responses

This enhanced MCPP specification enables secure, privacy-conscious data handling across diverse ecosystems including AI/ML systems, enterprise servers, and client applications while maintaining a simple and consistent developer experience.
