import { randomUUID } from 'node:crypto';
import {
  dbSaveWorkflow,
  dbGetWorkflow,
  dbGetAllWorkflows,
  dbSaveExecution,
  dbGetExecution,
  dbGetAllExecutions,
  dbGetExecutionsByStatus,
  dbLogStep,
  _resetDb,
} from './db.js';

// ═══════════════════════════════════════════
// GRAPH UTILITIES
// ═══════════════════════════════════════════

/**
 * Detect circular dependencies using Kahn's algorithm (topological sort).
 * Returns { valid: true, order: [...] } or { valid: false, cycle_hint: [...] }
 */
function validateDAG(steps) {
  const ids = new Set(steps.map(s => s.id));
  const inDegree = new Map();
  const adj = new Map();

  for (const s of steps) {
    inDegree.set(s.id, 0);
    adj.set(s.id, []);
  }

  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (!ids.has(dep)) {
        return { valid: false, cycle_hint: [`Step "${s.id}" depends on unknown step "${dep}"`] };
      }
      adj.get(dep).push(s.id);
      inDegree.set(s.id, inDegree.get(s.id) + 1);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const neighbor of adj.get(node)) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  if (order.length !== steps.length) {
    const remaining = steps.filter(s => !order.includes(s.id)).map(s => s.id);
    return { valid: false, cycle_hint: remaining };
  }

  return { valid: true, order };
}

/**
 * Given an execution, compute which steps are now ready to run.
 * A step is ready when:
 * - status is "pending" (not already running/completed/failed/skipped)
 * - ALL depends_on steps have status "success" or "skipped"
 * - If a dependency failed, the step becomes "blocked" unless retries are available
 */
function computeReadySteps(execution) {
  const stepMap = new Map(execution.steps.map(s => [s.id, s]));
  const ready = [];

  for (const step of execution.steps) {
    if (step.status !== 'pending') continue;

    let allDepsResolved = true;
    let anyDepFailed = false;

    for (const depId of step.depends_on) {
      const dep = stepMap.get(depId);
      if (!dep) continue;
      if (dep.status === 'success' || dep.status === 'skipped') continue;
      if (dep.status === 'failed') {
        anyDepFailed = true;
        allDepsResolved = false;
      } else {
        allDepsResolved = false;
      }
    }

    if (anyDepFailed) {
      step.status = 'blocked';
    } else if (allDepsResolved) {
      ready.push({ id: step.id, name: step.name });
    }
  }

  return ready;
}

/**
 * Determine overall workflow status from step statuses.
 */
function computeWorkflowStatus(execution) {
  const steps = execution.steps;
  const allDone = steps.every(s =>
    s.status === 'success' || s.status === 'skipped' || s.status === 'failed' || s.status === 'blocked'
  );

  if (execution.status === 'paused') return 'paused';
  if (execution.status === 'cancelled') return 'cancelled';

  if (!allDone) return 'running';

  const anyFailed = steps.some(s => s.status === 'failed' || s.status === 'blocked');
  if (anyFailed) return 'failed';

  return 'completed';
}

// ═══════════════════════════════════════════
// WORKFLOW OPERATIONS
// ═══════════════════════════════════════════

export function createWorkflow(name, description, steps) {
  // Validate unique step IDs
  const ids = steps.map(s => s.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    return { error: `Duplicate step IDs: ${[...new Set(dupes)].join(', ')}` };
  }

  // Validate DAG
  const dagResult = validateDAG(steps);
  if (!dagResult.valid) {
    return {
      error: 'Circular dependency detected',
      cycle_hint: dagResult.cycle_hint,
    };
  }

  const workflow_id = `wf_${randomUUID().slice(0, 12)}`;

  const definition = {
    workflow_id,
    name,
    description,
    steps: steps.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      depends_on: s.depends_on || [],
      max_retries: s.max_retries ?? 0,
      timeout_ms: s.timeout_ms ?? 0,
    })),
    created_at: new Date().toISOString(),
  };

  dbSaveWorkflow(definition);

  return {
    workflow_id,
    step_count: steps.length,
    topological_order: dagResult.order,
    validation_result: 'valid',
  };
}

export function startWorkflow(workflow_id, input_data) {
  const def = dbGetWorkflow(workflow_id);
  if (!def) return { error: `Workflow "${workflow_id}" not found` };

  const execution_id = `exec_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  const execution = {
    execution_id,
    workflow_id,
    workflow_name: def.name,
    status: 'running',
    input_data: input_data || {},
    steps: def.steps.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      depends_on: [...s.depends_on],
      max_retries: s.max_retries,
      timeout_ms: s.timeout_ms,
      status: 'pending',
      attempts: 0,
      output: null,
      started_at: null,
      completed_at: null,
    })),
    started_at: now,
    completed_at: null,
    paused_at: null,
    pause_reason: null,
    cancel_reason: null,
  };

  const ready_steps = computeReadySteps(execution);
  dbSaveExecution(execution);

  return {
    execution_id,
    workflow_id,
    workflow_name: def.name,
    status: 'running',
    ready_steps,
    total_steps: execution.steps.length,
  };
}

export function completeStep(execution_id, step_id, output, status) {
  const execution = dbGetExecution(execution_id);
  if (!execution) return { error: `Execution "${execution_id}" not found` };
  if (execution.status === 'paused') return { error: 'Workflow is paused. Resume before completing steps.' };
  if (execution.status === 'cancelled') return { error: 'Workflow is cancelled.' };
  if (execution.status === 'completed' || execution.status === 'failed') {
    return { error: `Workflow already ${execution.status}.` };
  }

  const step = execution.steps.find(s => s.id === step_id);
  if (!step) return { error: `Step "${step_id}" not found in execution` };

  const now = new Date().toISOString();

  // Snapshot which steps were ready BEFORE this completion
  const readyBefore = new Set(computeReadySteps(execution).map(s => s.id));

  if (status === 'failed') {
    step.attempts += 1;
    if (step.attempts <= step.max_retries) {
      // Retry available — keep as pending so agent can retry
      step.output = output || null;
      step.status = 'pending';

      const readyAfter = computeReadySteps(execution);
      const newlyReady = readyAfter.filter(s => !readyBefore.has(s.id));

      dbLogStep({
        execution_id,
        step_name: step_id,
        status: 'pending_retry',
        output,
        ended_at: now,
      });
      dbSaveExecution(execution);

      return {
        step_id,
        step_status: 'pending_retry',
        attempt: step.attempts,
        max_retries: step.max_retries,
        retries_remaining: step.max_retries - step.attempts,
        newly_ready_steps: newlyReady,
        workflow_status: computeWorkflowStatus(execution),
        message: `Step failed but has ${step.max_retries - step.attempts} retries remaining`,
      };
    }
  }

  // Apply the status
  step.status = status;
  step.output = output || null;
  step.completed_at = now;
  if (!step.started_at) step.started_at = now;
  if (status === 'failed') step.attempts += 1;

  // Recompute ready steps and return only NEWLY ready ones
  const readyAfter = computeReadySteps(execution);
  const ready = readyAfter.filter(s => !readyBefore.has(s.id));

  // Check overall workflow status
  const wfStatus = computeWorkflowStatus(execution);
  execution.status = wfStatus;
  if (wfStatus === 'completed' || wfStatus === 'failed') {
    execution.completed_at = now;
  }

  dbLogStep({
    execution_id,
    step_name: step_id,
    status,
    output,
    started_at: step.started_at,
    ended_at: now,
  });
  dbSaveExecution(execution);

  const summary = {
    pending: execution.steps.filter(s => s.status === 'pending').length,
    running: execution.steps.filter(s => s.status === 'running').length,
    success: execution.steps.filter(s => s.status === 'success').length,
    failed: execution.steps.filter(s => s.status === 'failed').length,
    skipped: execution.steps.filter(s => s.status === 'skipped').length,
    blocked: execution.steps.filter(s => s.status === 'blocked').length,
  };

  return {
    step_id,
    step_status: status,
    newly_ready_steps: ready,
    workflow_status: wfStatus,
    step_summary: summary,
  };
}

export function getWorkflowStatus(execution_id) {
  const execution = dbGetExecution(execution_id);
  if (!execution) return { error: `Execution "${execution_id}" not found` };

  const now = Date.now();
  const started = new Date(execution.started_at).getTime();
  const elapsed_ms = execution.completed_at
    ? new Date(execution.completed_at).getTime() - started
    : now - started;

  return {
    execution_id,
    workflow_id: execution.workflow_id,
    workflow_name: execution.workflow_name,
    status: execution.status,
    elapsed_ms,
    started_at: execution.started_at,
    completed_at: execution.completed_at,
    paused_at: execution.paused_at,
    steps: execution.steps.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      attempts: s.attempts,
      max_retries: s.max_retries,
      started_at: s.started_at,
      completed_at: s.completed_at,
      has_output: s.output !== null,
    })),
    pending_steps: execution.steps.filter(s => s.status === 'pending').map(s => s.id),
    completed_steps: execution.steps.filter(s => s.status === 'success').map(s => s.id),
    failed_steps: execution.steps.filter(s => s.status === 'failed').map(s => s.id),
    blocked_steps: execution.steps.filter(s => s.status === 'blocked').map(s => s.id),
    skipped_steps: execution.steps.filter(s => s.status === 'skipped').map(s => s.id),
  };
}

export function pauseWorkflow(execution_id, reason) {
  const execution = dbGetExecution(execution_id);
  if (!execution) return { error: `Execution "${execution_id}" not found` };
  if (execution.status !== 'running') {
    return { error: `Cannot pause workflow with status "${execution.status}"` };
  }

  const now = new Date().toISOString();
  execution.status = 'paused';
  execution.paused_at = now;
  execution.pause_reason = reason || null;

  dbSaveExecution(execution);

  return {
    execution_id,
    paused_at: now,
    reason: reason || null,
    in_progress_steps: execution.steps
      .filter(s => s.status === 'pending')
      .map(s => ({ id: s.id, name: s.name })),
  };
}

export function resumeWorkflow(execution_id) {
  const execution = dbGetExecution(execution_id);
  if (!execution) return { error: `Execution "${execution_id}" not found` };
  if (execution.status !== 'paused') {
    return { error: `Cannot resume workflow with status "${execution.status}". Only paused workflows can be resumed.` };
  }

  const now = new Date().toISOString();
  execution.status = 'running';
  execution.paused_at = null;
  execution.pause_reason = null;

  // Reset blocked steps to pending so they get re-evaluated
  for (const step of execution.steps) {
    if (step.status === 'blocked') {
      step.status = 'pending';
    }
  }

  const ready = computeReadySteps(execution);
  dbSaveExecution(execution);

  return {
    execution_id,
    resumed_at: now,
    ready_steps: ready,
    status: 'running',
  };
}

export function listWorkflows(filter) {
  if (!filter || filter === 'definitions') {
    const defs = dbGetAllWorkflows();
    return {
      type: 'definitions',
      count: defs.length,
      workflows: defs.map(d => ({
        workflow_id: d.workflow_id,
        name: d.name,
        description: d.description,
        step_count: d.steps.length,
        created_at: d.created_at,
      })),
    };
  }

  let items = dbGetAllExecutions();

  if (filter === 'active') {
    items = items.filter(e => e.status === 'running' || e.status === 'paused');
  } else if (filter === 'completed') {
    items = items.filter(e => e.status === 'completed');
  } else if (filter === 'failed') {
    items = items.filter(e => e.status === 'failed');
  }

  return {
    type: filter,
    count: items.length,
    executions: items.map(e => ({
      execution_id: e.execution_id,
      workflow_id: e.workflow_id,
      workflow_name: e.workflow_name,
      status: e.status,
      started_at: e.started_at,
      completed_at: e.completed_at,
      total_steps: e.steps.length,
      completed_steps: e.steps.filter(s => s.status === 'success').length,
      failed_steps: e.steps.filter(s => s.status === 'failed').length,
    })),
  };
}

export function cancelWorkflow(execution_id, reason) {
  const execution = dbGetExecution(execution_id);
  if (!execution) return { error: `Execution "${execution_id}" not found` };
  if (execution.status === 'completed' || execution.status === 'cancelled') {
    return { error: `Cannot cancel workflow with status "${execution.status}"` };
  }

  const now = new Date().toISOString();

  const cancelled_steps = [];
  const completed_steps_preserved = [];

  for (const step of execution.steps) {
    if (step.status === 'success' || step.status === 'skipped') {
      completed_steps_preserved.push({ id: step.id, name: step.name, status: step.status });
    } else if (step.status === 'pending' || step.status === 'blocked') {
      step.status = 'cancelled';
      step.completed_at = now;
      cancelled_steps.push({ id: step.id, name: step.name });
    }
  }

  execution.status = 'cancelled';
  execution.completed_at = now;
  execution.cancel_reason = reason || null;

  dbSaveExecution(execution);

  return {
    execution_id,
    cancelled_at: now,
    reason: reason || null,
    cancelled_steps,
    completed_steps_preserved,
  };
}

// ═══════════════════════════════════════════
// RESOURCE HELPERS
// ═══════════════════════════════════════════

export function getActiveExecutions() {
  return dbGetAllExecutions()
    .filter(e => e.status === 'running' || e.status === 'paused')
    .map(e => ({
      execution_id: e.execution_id,
      workflow_name: e.workflow_name,
      status: e.status,
      started_at: e.started_at,
      total_steps: e.steps.length,
      completed: e.steps.filter(s => s.status === 'success').length,
      failed: e.steps.filter(s => s.status === 'failed').length,
      pending: e.steps.filter(s => s.status === 'pending').length,
    }));
}

export function getStats() {
  const allExec = dbGetAllExecutions();
  const allDefs = dbGetAllWorkflows();
  const completed = allExec.filter(e => e.status === 'completed');
  const failed = allExec.filter(e => e.status === 'failed');

  const durations = completed
    .filter(e => e.completed_at && e.started_at)
    .map(e => new Date(e.completed_at).getTime() - new Date(e.started_at).getTime());

  return {
    total_definitions: allDefs.length,
    total_executions: allExec.length,
    active: allExec.filter(e => e.status === 'running').length,
    paused: allExec.filter(e => e.status === 'paused').length,
    completed: completed.length,
    failed: failed.length,
    cancelled: allExec.filter(e => e.status === 'cancelled').length,
    success_rate: allExec.length > 0
      ? Math.round((completed.length / (completed.length + failed.length || 1)) * 100)
      : 0,
    avg_duration_ms: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0,
    generated_at: new Date().toISOString(),
  };
}

// For testing: reset SQLite state
export function _resetForTest() {
  _resetDb();
}
