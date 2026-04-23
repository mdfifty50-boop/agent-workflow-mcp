#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createWorkflow,
  startWorkflow,
  completeStep,
  getWorkflowStatus,
  pauseWorkflow,
  resumeWorkflow,
  listWorkflows,
  cancelWorkflow,
  getActiveExecutions,
  getStats,
} from './workflow.js';

const server = new McpServer({
  name: 'agent-workflow-mcp',
  version: '0.1.0',
  description: 'Multi-step workflow orchestration — define, execute, pause, resume, and monitor complex agent workflows with dependency resolution',
});

// ═══════════════════════════════════════════
// TOOL: create_workflow
// ═══════════════════════════════════════════

server.tool(
  'create_workflow',
  'Define a workflow with named steps, dependencies between steps, and retry policies. Validates the dependency graph for cycles.',
  {
    name: z.string().describe('Human-readable name for this workflow'),
    description: z.string().describe('What this workflow accomplishes'),
    steps: z.array(z.object({
      id: z.string().describe('Unique step identifier within the workflow'),
      name: z.string().describe('Human-readable step name'),
      description: z.string().optional().describe('What this step does'),
      depends_on: z.array(z.string()).default([]).describe('Step IDs that must complete before this step can start'),
      max_retries: z.number().int().min(0).default(0).describe('Maximum retry attempts on failure (default 0)'),
      timeout_ms: z.number().int().min(0).default(0).describe('Timeout in milliseconds (0 = no timeout)'),
    })).describe('Array of workflow steps with dependency declarations'),
  },
  async ({ name, description, steps }) => {
    const result = createWorkflow(name, description, steps);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: start_workflow
// ═══════════════════════════════════════════

server.tool(
  'start_workflow',
  'Start executing a workflow. Returns an execution_id and the initial set of ready steps (those with no dependencies).',
  {
    workflow_id: z.string().describe('ID of the workflow definition to execute'),
    input_data: z.record(z.any()).optional().describe('Optional input data available to all steps'),
  },
  async ({ workflow_id, input_data }) => {
    const result = startWorkflow(workflow_id, input_data);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: complete_step
// ═══════════════════════════════════════════

server.tool(
  'complete_step',
  'Mark a workflow step as completed, failed, or skipped. Returns newly ready steps whose dependencies are now satisfied.',
  {
    execution_id: z.string().describe('Execution ID of the running workflow'),
    step_id: z.string().describe('Step ID to mark as complete'),
    output: z.record(z.any()).optional().describe('Output data from this step (available to downstream steps)'),
    status: z.enum(['success', 'failed', 'skipped']).describe('Outcome: success, failed, or skipped'),
  },
  async ({ execution_id, step_id, output, status }) => {
    const result = completeStep(execution_id, step_id, output, status);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: get_workflow_status
// ═══════════════════════════════════════════

server.tool(
  'get_workflow_status',
  'Get the current status of a workflow execution including per-step statuses, timing, and counts.',
  {
    execution_id: z.string().describe('Execution ID to check'),
  },
  async ({ execution_id }) => {
    const result = getWorkflowStatus(execution_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: pause_workflow
// ═══════════════════════════════════════════

server.tool(
  'pause_workflow',
  'Pause a running workflow. No new steps will be marked ready until resumed.',
  {
    execution_id: z.string().describe('Execution ID to pause'),
    reason: z.string().optional().describe('Reason for pausing'),
  },
  async ({ execution_id, reason }) => {
    const result = pauseWorkflow(execution_id, reason);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: resume_workflow
// ═══════════════════════════════════════════

server.tool(
  'resume_workflow',
  'Resume a paused workflow. Returns the steps that are ready to execute.',
  {
    execution_id: z.string().describe('Execution ID to resume'),
  },
  async ({ execution_id }) => {
    const result = resumeWorkflow(execution_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: list_workflows
// ═══════════════════════════════════════════

server.tool(
  'list_workflows',
  'List workflow definitions or executions. Filter by type: definitions, executions, active, completed, or failed.',
  {
    filter: z.enum(['definitions', 'executions', 'active', 'completed', 'failed']).optional()
      .describe('Filter type (default: definitions)'),
  },
  async ({ filter }) => {
    const result = listWorkflows(filter);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: cancel_workflow
// ═══════════════════════════════════════════

server.tool(
  'cancel_workflow',
  'Cancel a running or paused workflow. Completed steps are preserved, pending steps are cancelled.',
  {
    execution_id: z.string().describe('Execution ID to cancel'),
    reason: z.string().optional().describe('Reason for cancellation'),
  },
  async ({ execution_id, reason }) => {
    const result = cancelWorkflow(execution_id, reason);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'active-workflows',
  'workflows://active',
  async () => ({
    contents: [{
      uri: 'workflows://active',
      mimeType: 'application/json',
      text: JSON.stringify(getActiveExecutions(), null, 2),
    }],
  })
);

server.resource(
  'workflow-stats',
  'workflows://stats',
  async () => ({
    contents: [{
      uri: 'workflows://stats',
      mimeType: 'application/json',
      text: JSON.stringify(getStats(), null, 2),
    }],
  })
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Workflow MCP Server running on stdio');
}

main().catch(console.error);
