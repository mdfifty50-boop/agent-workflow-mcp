# agent-workflow-mcp

MCP server for multi-step workflow orchestration. Define workflows with named steps, dependency graphs, and retry policies. Execute, pause, resume, monitor, and cancel workflows through a standard MCP interface.

## Why

Agents coordinating complex multi-step tasks have no standard way to:
- Define step dependencies (step B waits for step A)
- Handle failures with retries
- Pause/resume long-running workflows
- Track progress across parallel branches

This server provides that infrastructure as 8 MCP tools.

## Installation

```bash
npx agent-workflow-mcp
```

Or install globally:

```bash
npm install -g agent-workflow-mcp
```

### Claude Desktop / Cursor

Add to your MCP config:

```json
{
  "mcpServers": {
    "agent-workflow": {
      "command": "npx",
      "args": ["agent-workflow-mcp"]
    }
  }
}
```

### Smithery

```bash
npx @smithery/cli install agent-workflow-mcp
```

## Tools

### `create_workflow`

Define a workflow with steps and dependencies.

```json
{
  "name": "Deploy Pipeline",
  "description": "Build, test, and deploy to production",
  "steps": [
    { "id": "build", "name": "Build", "depends_on": [], "max_retries": 2 },
    { "id": "test", "name": "Test", "depends_on": ["build"], "max_retries": 1 },
    { "id": "deploy", "name": "Deploy", "depends_on": ["test"], "timeout_ms": 60000 }
  ]
}
```

Returns: `workflow_id`, `step_count`, `topological_order`, `validation_result`

Validates the dependency graph for cycles and unknown references.

### `start_workflow`

Start a workflow execution.

```json
{
  "workflow_id": "wf_abc123",
  "input_data": { "branch": "main", "env": "production" }
}
```

Returns: `execution_id`, `ready_steps` (steps with no dependencies that can start immediately)

### `complete_step`

Mark a step as completed, failed, or skipped.

```json
{
  "execution_id": "exec_xyz789",
  "step_id": "build",
  "output": { "artifact": "build-42.tar.gz" },
  "status": "success"
}
```

Returns: `newly_ready_steps` (steps whose dependencies are now met), `workflow_status`, `step_summary`

If a step fails and has retries remaining, it stays ready for re-execution.

### `get_workflow_status`

Get detailed status of a workflow execution.

```json
{ "execution_id": "exec_xyz789" }
```

Returns: overall status, per-step statuses, `elapsed_ms`, lists of pending/completed/failed/blocked steps.

### `pause_workflow`

Pause a running workflow. No new steps become ready until resumed.

```json
{ "execution_id": "exec_xyz789", "reason": "Waiting for manual approval" }
```

### `resume_workflow`

Resume a paused workflow.

```json
{ "execution_id": "exec_xyz789" }
```

Returns: `ready_steps` that can now be executed.

### `list_workflows`

List definitions or executions.

```json
{ "filter": "active" }
```

Filters: `definitions`, `executions`, `active`, `completed`, `failed`

### `cancel_workflow`

Cancel a running or paused workflow. Completed steps are preserved.

```json
{ "execution_id": "exec_xyz789", "reason": "Requirements changed" }
```

## Workflow Engine

### Dependency Resolution

Steps become "ready" when ALL their `depends_on` steps have status `success` or `skipped`. Uses topological sort (Kahn's algorithm) for cycle detection at creation time.

### Step Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for dependencies or ready to execute |
| `success` | Completed successfully |
| `failed` | Failed with no retries remaining |
| `skipped` | Explicitly skipped |
| `blocked` | Cannot proceed because a dependency failed |
| `cancelled` | Cancelled by `cancel_workflow` |

### Retry Policy

When a step fails and `attempts < max_retries`, it stays `pending` for re-execution. The agent receives `retries_remaining` in the response.

### Workflow Statuses

| Status | Meaning |
|--------|---------|
| `running` | Active, steps in progress |
| `completed` | All steps succeeded or skipped |
| `failed` | A step failed with no retries, blocking dependents |
| `paused` | Paused by `pause_workflow` |
| `cancelled` | Cancelled by `cancel_workflow` |

## Data Persistence

Data is stored in-memory with JSON file persistence. Configure the storage directory:

```bash
WORKFLOW_DATA_DIR=/path/to/data npx agent-workflow-mcp
```

Default: `~/.agent-workflow/`

## Development

```bash
npm install
npm test        # Run tests
npm run dev     # Watch mode
```

## License

MIT
