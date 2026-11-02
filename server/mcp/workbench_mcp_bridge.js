#!/usr/bin/env node
// D:\Ashish_P\AI-Tools\custom-OCT\server\mcp\workbench_mcp_bridge.js
// Independent Model Context Protocol (MCP) Stdio Bridge for Workbench Agents

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';

// Parse command-line args and environment variables
const args = process.argv.slice(2);
function getArg(flag, envVar, defaultVal = null) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  if (process.env[envVar]) return process.env[envVar];
  return defaultVal;
}

const AGENT_ID = (getArg('--agent', 'WORKBENCH_AGENT_ID', 'claude')).toLowerCase();
const PORT = Number(getArg('--port', 'WORKBENCH_PORT', 0));
const TOKEN = getArg('--token', 'WORKBENCH_TOKEN', '');
const BRIDGE_CWD = getArg('--cwd', 'WORKBENCH_PROJECT_CWD', process.cwd());
const SESSION_ID = `mcp_${AGENT_ID}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

if (!PORT || !TOKEN) {
  console.error(`[MCP Bridge ${AGENT_ID}] Error: WORKBENCH_PORT and WORKBENCH_TOKEN are required.`);
  process.exit(1);
}

const COORDINATOR_BASE = `http://127.0.0.1:${PORT}`;

// Helper for authenticated HTTP requests to Workbench Coordinator
async function coordinatorFetch(endpoint, method = 'GET', body = null) {
  const url = `${COORDINATOR_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'X-Session-Token': TOKEN,
      'Content-Type': 'application/json'
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Coordinator HTTP ${res.status} on ${endpoint}: ${errText}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────
// MCP Server Initialization
// ──────────────────────────────────────────────────────────────────────────

const mcpServer = new Server(
  {
    name: `workbench-${AGENT_ID}-bridge`,
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────────────────────────────────

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error(`[MCP Bridge ${AGENT_ID}] ListToolsRequest received.`);
  const tools = [
    {
      name: 'discover_peers',
      description: 'Discover active AI agent peers registered in the local Workbench workspace.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  ];

  if (AGENT_ID === 'claude') {
    tools.push(
      {
        name: 'delegate_to_gemini',
        description: 'Delegate an implementation or refactoring task to the interactive Gemini CLI agent. Holds until Gemini completes.',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              description: 'The architectural plan or specification formulated by Claude.'
            },
            instructions: {
              type: 'string',
              description: 'Clear, actionable instructions for Gemini to execute.'
            },
            expectedFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of files expected to be created or modified.'
            },
            timeoutSeconds: {
              type: 'number',
              description: 'Optional custom timeout in seconds (default: 600).'
            }
          },
          required: ['instructions'],
          additionalProperties: false
        }
      },
      {
        name: 'get_delegation_status',
        description: 'Check the real-time status of a delegated task by its correlation ID.',
        inputSchema: {
          type: 'object',
          properties: {
            correlationId: {
              type: 'string',
              description: 'The correlation ID of the delegated task.'
            }
          },
          required: ['correlationId'],
          additionalProperties: false
        }
      }
    );
  }

  if (AGENT_ID === 'gemini') {
    tools.push(
      {
        name: 'get_inbox',
        description: 'Fetch approved delegated tasks waiting in the Workbench inbox for Gemini to execute.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'claim_task',
        description: 'Claim a pending delegated task to begin execution.',
        inputSchema: {
          type: 'object',
          properties: {
            correlationId: {
              type: 'string',
              description: 'The correlation ID of the task to claim.'
            }
          },
          required: ['correlationId'],
          additionalProperties: false
        }
      },
      {
        name: 'report_progress',
        description: 'Report incremental progress or the current execution step on a claimed task without changing task lifecycle state.',
        inputSchema: {
          type: 'object',
          properties: {
            correlationId: {
              type: 'string',
              description: 'The correlation ID of the claimed task.'
            },
            step: {
              type: 'string',
              description: 'Short label of current step (e.g., "Inspecting dependencies", "Running tests").'
            },
            message: {
              type: 'string',
              description: 'Optional additional detail or findings for the current step.'
            }
          },
          required: ['correlationId', 'step'],
          additionalProperties: false
        }
      },
      {
        name: 'report_task_completion',
        description: 'Report the successful completion of a delegated task back to Claude and the Workbench.',
        inputSchema: {
          type: 'object',
          properties: {
            correlationId: {
              type: 'string',
              description: 'The correlation ID of the completed task.'
            },
            summary: {
              type: 'string',
              description: 'Detailed summary of the code changes and implementation performed.'
            },
            modifiedFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of files modified or created during implementation.'
            },
            testResults: {
              type: 'string',
              description: 'Optional execution logs or verification test results.'
            }
          },
          required: ['correlationId', 'summary'],
          additionalProperties: false
        }
      },
      {
        name: 'report_task_failure',
        description: 'Report that a delegated task could not be completed.',
        inputSchema: {
          type: 'object',
          properties: {
            correlationId: {
              type: 'string',
              description: 'The correlation ID of the failed task.'
            },
            error: {
              type: 'string',
              description: 'Explanation of the error or blocker encountered.'
            }
          },
          required: ['correlationId', 'error'],
          additionalProperties: false
        }
      }
    );
  }

  return { tools };
});

// ──────────────────────────────────────────────────────────────────────────
// Tool Execution Handlers
// ──────────────────────────────────────────────────────────────────────────

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;

  try {
    if (name === 'discover_peers') {
      const peers = await coordinatorFetch('/api/intercom/peers');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ peers }, null, 2)
          }
        ]
      };
    }

    if (name === 'delegate_to_gemini') {
      const { plan, instructions, expectedFiles, timeoutSeconds } = toolArgs || {};
      const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : 900000;

      if (!instructions || typeof instructions !== 'string' || instructions.trim() === '') {
        throw new Error('instructions parameter is required and cannot be empty');
      }

      console.error(`[MCP Bridge ${AGENT_ID}] Delegating task to Gemini in ${BRIDGE_CWD}...`);
      const result = await coordinatorFetch('/api/intercom/delegate', 'POST', {
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: plan || instructions,
        instructions: instructions.trim(),
        expectedFiles: expectedFiles || [],
        cwd: BRIDGE_CWD,
        requiresApproval: true,
        timeoutMs
      });

      if (result.rejected) {
        return {
          content: [
            {
              type: 'text',
              text: `[DELEGATION REJECTED BY USER]\nReason: ${result.rejectionReason || 'User chose to reject this plan.'}\n\nPlease formulate an alternative plan or ask the user for guidance.`
            }
          ]
        };
      }

      if (result.cancelled) {
        return {
          content: [
            {
              type: 'text',
              text: `[DELEGATION CANCELLED]\n${result.error || 'Delegation was cancelled by user.'}`
            }
          ]
        };
      }

      const testResultsText = result.testResults
        ? (typeof result.testResults === 'object' ? JSON.stringify(result.testResults, null, 2) : String(result.testResults))
        : 'None reported';

      return {
        content: [
          {
            type: 'text',
            text: `Gemini implementation completed successfully!\nCorrelation ID: ${result.correlationId}\nDuration: ${Math.round(result.durationMs / 1000)}s\nSummary:\n${result.summary}\n\nFiles Modified:\n${(result.modifiedFiles || []).join(', ') || 'None reported'}\n\nTest Results:\n${testResultsText}\n\nPlease review these changes, run appropriate tests in your terminal, and report your review findings to the user.`
          }
        ]
      };
    }

    if (name === 'get_delegation_status') {
      const { correlationId } = toolArgs || {};
      const task = await coordinatorFetch(`/api/intercom/tasks/${correlationId}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(task, null, 2)
          }
        ]
      };
    }

    if (name === 'get_inbox') {
      const inbox = await coordinatorFetch(`/api/intercom/inbox?agentId=${AGENT_ID}&cwd=${encodeURIComponent(BRIDGE_CWD)}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tasks: inbox }, null, 2)
          }
        ]
      };
    }

    if (name === 'claim_task') {
      const { correlationId } = toolArgs || {};
      const task = await coordinatorFetch('/api/intercom/claim', 'POST', {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        correlationId,
        cwd: BRIDGE_CWD
      });
      return {
        content: [
          {
            type: 'text',
            text: `Task '${correlationId}' claimed successfully!\n\nInstructions:\n${task.instructions}\n\nPlan:\n${task.plan}\n\nExpected Files: ${(task.expectedFiles || []).join(', ') || 'None specified'}`
          }
        ]
      };
    }

    if (name === 'report_progress') {
      const { correlationId, step, message } = toolArgs || {};
      const res = await coordinatorFetch('/api/intercom/progress', 'POST', {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        correlationId,
        step,
        message
      });
      return {
        content: [
          {
            type: 'text',
            text: res.throttled
              ? `Progress reported for task '${correlationId}' (coalesced)`
              : `Progress reported for task '${correlationId}': ${step}`
          }
        ]
      };
    }

    if (name === 'report_task_completion') {
      const { correlationId, summary, modifiedFiles, testResults } = toolArgs || {};
      await coordinatorFetch('/api/intercom/complete', 'POST', {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        correlationId,
        summary,
        modifiedFiles: modifiedFiles || [],
        testResults: testResults || null
      });
      return {
        content: [
          {
            type: 'text',
            text: `Task '${correlationId}' marked COMPLETED and reported back to Claude!`
          }
        ]
      };
    }

    if (name === 'report_task_failure') {
      const { correlationId, error } = toolArgs || {};
      await coordinatorFetch('/api/intercom/fail', 'POST', {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        correlationId,
        error
      });
      return {
        content: [
          {
            type: 'text',
            text: `Task '${correlationId}' failure reported back to Coordinator: ${error}`
          }
        ]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    console.error(`[MCP Bridge ${AGENT_ID}] Tool execution error (${name}):`, err.message);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${err.message}`
        }
      ]
    };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle & Heartbeat Management
// ──────────────────────────────────────────────────────────────────────────

let heartbeatInterval = null;
let currentBackoffMs = 2000;
let isReRegistering = false;

async function registerWithCoordinator() {
  const result = await coordinatorFetch('/api/intercom/register', 'POST', {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    pid: process.pid,
    cliVersion: process.version,
    cwd: BRIDGE_CWD,
    capabilities: AGENT_ID === 'claude'
      ? ['planning', 'delegation', 'verification']
      : ['implementation', 'refactoring', 'testing']
  });
  console.error(`[MCP Bridge ${AGENT_ID}] Successfully registered with Workbench Coordinator (session: ${SESSION_ID}).`);
  currentBackoffMs = 2000; // Reset backoff on success
  return result;
}

async function sendHeartbeat() {
  try {
    const res = await coordinatorFetch('/api/intercom/heartbeat', 'POST', {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      status: 'ONLINE'
    });

    if (res && res.status === 'unrecognized_peer') {
      console.error(`[MCP Bridge ${AGENT_ID}] Heartbeat received 'unrecognized_peer'. Re-registering session...`);
      if (!isReRegistering) {
        isReRegistering = true;
        try {
          await registerWithCoordinator();
        } catch (regErr) {
          console.error(`[MCP Bridge ${AGENT_ID}] Re-registration error:`, regErr.message);
        } finally {
          isReRegistering = false;
        }
      }
    } else {
      currentBackoffMs = 2000; // Reset backoff on successful heartbeat
    }
  } catch (err) {
    console.error(`[MCP Bridge ${AGENT_ID}] Heartbeat failed: ${err.message}`);
    // If fatal authentication failure, stop heartbeat loop
    if (err.message.includes('401') || err.message.includes('403')) {
      console.error(`[MCP Bridge ${AGENT_ID}] Fatal authentication error. Halting heartbeats.`);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      return;
    }

    // Apply exponential backoff with jitter capped at 15s
    const jitter = Math.floor(Math.random() * 500);
    currentBackoffMs = Math.min(15000, currentBackoffMs * 1.5 + jitter);
  }
}

async function startBridge() {
  console.error(`[MCP Bridge ${AGENT_ID}] Initializing MCP server for ${AGENT_ID}...`);

  // 1. Initial registration with Workbench Coordinator
  try {
    await registerWithCoordinator();
  } catch (err) {
    console.error(`[MCP Bridge ${AGENT_ID}] Initial registration warning: ${err.message}`);
  }

  // 2. Start heartbeat timer (cadence: 10s)
  heartbeatInterval = setInterval(sendHeartbeat, 10000);
  heartbeatInterval.unref();

  // 3. Connect stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error(`[MCP Bridge ${AGENT_ID}] MCP stdio transport connected and listening.`);
}

async function shutdownBridge() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  try {
    await coordinatorFetch('/api/intercom/disconnect', 'POST', {
      agentId: AGENT_ID,
      sessionId: SESSION_ID
    });
    console.error(`[MCP Bridge ${AGENT_ID}] Disconnected cleanly from Coordinator.`);
  } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdownBridge);
process.on('SIGTERM', shutdownBridge);
process.stdin.on('close', shutdownBridge);
process.stdin.on('end', shutdownBridge);
process.on('exit', () => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
});

startBridge().catch((err) => {
  console.error(`[MCP Bridge ${AGENT_ID}] Fatal startup error:`, err);
  process.exit(1);
});
