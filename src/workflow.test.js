import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflow,
  startWorkflow,
  completeStep,
  getWorkflowStatus,
  pauseWorkflow,
  resumeWorkflow,
  listWorkflows,
  cancelWorkflow,
  getStats,
  _resetForTest,
} from './workflow.js';

beforeEach(() => {
  _resetForTest();
});

// ═══════════════════════════════════════════
// create_workflow
// ═══════════════════════════════════════════

describe('createWorkflow', () => {
  it('creates a valid linear workflow', () => {
    const result = createWorkflow('Deploy Pipeline', 'Build, test, deploy', [
      { id: 'build', name: 'Build', depends_on: [] },
      { id: 'test', name: 'Test', depends_on: ['build'] },
      { id: 'deploy', name: 'Deploy', depends_on: ['test'] },
    ]);

    assert.ok(result.workflow_id);
    assert.equal(result.step_count, 3);
    assert.equal(result.validation_result, 'valid');
    assert.deepEqual(result.topological_order, ['build', 'test', 'deploy']);
  });

  it('creates a diamond dependency workflow', () => {
    const result = createWorkflow('Diamond', 'A -> B,C -> D', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
      { id: 'c', name: 'C', depends_on: ['a'] },
      { id: 'd', name: 'D', depends_on: ['b', 'c'] },
    ]);

    assert.ok(result.workflow_id);
    assert.equal(result.step_count, 4);
    assert.equal(result.validation_result, 'valid');
    // a must come first, d must come last
    assert.equal(result.topological_order[0], 'a');
    assert.equal(result.topological_order[3], 'd');
  });

  it('rejects circular dependencies', () => {
    const result = createWorkflow('Circular', 'Should fail', [
      { id: 'a', name: 'A', depends_on: ['c'] },
      { id: 'b', name: 'B', depends_on: ['a'] },
      { id: 'c', name: 'C', depends_on: ['b'] },
    ]);

    assert.ok(result.error);
    assert.match(result.error, /circular/i);
  });

  it('rejects unknown dependency references', () => {
    const result = createWorkflow('Bad Ref', 'Missing dep', [
      { id: 'a', name: 'A', depends_on: ['nonexistent'] },
    ]);

    assert.ok(result.error || result.cycle_hint);
  });

  it('rejects duplicate step IDs', () => {
    const result = createWorkflow('Dupes', 'Should fail', [
      { id: 'a', name: 'First A', depends_on: [] },
      { id: 'a', name: 'Second A', depends_on: [] },
    ]);

    assert.ok(result.error);
    assert.match(result.error, /duplicate/i);
  });

  it('allows workflow with no dependencies (all parallel)', () => {
    const result = createWorkflow('Parallel', 'All independent', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: [] },
      { id: 'c', name: 'C', depends_on: [] },
    ]);

    assert.ok(result.workflow_id);
    assert.equal(result.step_count, 3);
    assert.equal(result.validation_result, 'valid');
  });
});

// ═══════════════════════════════════════════
// start_workflow
// ═══════════════════════════════════════════

describe('startWorkflow', () => {
  it('starts a workflow and returns ready steps', () => {
    const wf = createWorkflow('Test', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: [] },
      { id: 'c', name: 'C', depends_on: ['a', 'b'] },
    ]);

    const result = startWorkflow(wf.workflow_id, { key: 'value' });

    assert.ok(result.execution_id);
    assert.equal(result.status, 'running');
    assert.equal(result.total_steps, 3);
    // A and B have no deps, so they should be ready
    assert.equal(result.ready_steps.length, 2);
    const readyIds = result.ready_steps.map(s => s.id).sort();
    assert.deepEqual(readyIds, ['a', 'b']);
  });

  it('returns error for unknown workflow', () => {
    const result = startWorkflow('wf_nonexistent');
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════
// complete_step — basic flow
// ═══════════════════════════════════════════

describe('completeStep', () => {
  it('completes a step and unlocks dependents', () => {
    const wf = createWorkflow('Linear', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    const result = completeStep(exec.execution_id, 'a', { data: 42 }, 'success');

    assert.equal(result.step_status, 'success');
    assert.equal(result.workflow_status, 'running');
    // B should now be ready
    assert.equal(result.newly_ready_steps.length, 1);
    assert.equal(result.newly_ready_steps[0].id, 'b');
  });

  it('completes workflow when all steps succeed', () => {
    const wf = createWorkflow('Simple', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    completeStep(exec.execution_id, 'a', null, 'success');
    const result = completeStep(exec.execution_id, 'b', null, 'success');

    assert.equal(result.workflow_status, 'completed');
    assert.equal(result.step_summary.success, 2);
  });

  it('blocks dependents when a step fails with no retries', () => {
    const wf = createWorkflow('FailTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [], max_retries: 0 },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    const result = completeStep(exec.execution_id, 'a', null, 'failed');

    assert.equal(result.workflow_status, 'failed');
    assert.equal(result.step_summary.blocked, 1);
  });

  it('handles skipped steps correctly', () => {
    const wf = createWorkflow('SkipTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    completeStep(exec.execution_id, 'a', null, 'skipped');
    const result = completeStep(exec.execution_id, 'b', null, 'success');

    assert.equal(result.workflow_status, 'completed');
    assert.equal(result.step_summary.skipped, 1);
    assert.equal(result.step_summary.success, 1);
  });

  it('returns error for unknown execution', () => {
    const result = completeStep('exec_nonexistent', 'a', null, 'success');
    assert.ok(result.error);
  });

  it('returns error for unknown step', () => {
    const wf = createWorkflow('Test', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    const result = completeStep(exec.execution_id, 'nonexistent', null, 'success');
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════
// complete_step — retry logic
// ═══════════════════════════════════════════

describe('completeStep — retries', () => {
  it('keeps step pending when retries remain', () => {
    const wf = createWorkflow('RetryTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [], max_retries: 2 },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    const r1 = completeStep(exec.execution_id, 'a', null, 'failed');
    assert.equal(r1.step_status, 'pending_retry');
    assert.equal(r1.retries_remaining, 1);
    assert.equal(r1.workflow_status, 'running');
  });

  it('fails step after exhausting retries', () => {
    const wf = createWorkflow('RetryExhaust', 'desc', [
      { id: 'a', name: 'A', depends_on: [], max_retries: 1 },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    // First failure — retry available
    const r1 = completeStep(exec.execution_id, 'a', null, 'failed');
    assert.equal(r1.step_status, 'pending_retry');
    assert.equal(r1.retries_remaining, 0);

    // Second failure — no more retries
    const r2 = completeStep(exec.execution_id, 'a', null, 'failed');
    assert.equal(r2.step_status, 'failed');
    assert.equal(r2.workflow_status, 'failed');
  });

  it('succeeds on retry after failure', () => {
    const wf = createWorkflow('RetrySuccess', 'desc', [
      { id: 'a', name: 'A', depends_on: [], max_retries: 2 },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    // Fail once
    completeStep(exec.execution_id, 'a', null, 'failed');

    // Succeed on retry
    const r2 = completeStep(exec.execution_id, 'a', { result: 'ok' }, 'success');
    assert.equal(r2.step_status, 'success');
    assert.equal(r2.newly_ready_steps.length, 1);
    assert.equal(r2.newly_ready_steps[0].id, 'b');
  });
});

// ═══════════════════════════════════════════
// get_workflow_status
// ═══════════════════════════════════════════

describe('getWorkflowStatus', () => {
  it('returns detailed status of running workflow', () => {
    const wf = createWorkflow('StatusTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
      { id: 'c', name: 'C', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'a', null, 'success');

    const status = getWorkflowStatus(exec.execution_id);

    assert.equal(status.status, 'running');
    assert.ok(status.elapsed_ms >= 0);
    assert.equal(status.steps.length, 3);
    assert.deepEqual(status.completed_steps, ['a']);
    assert.equal(status.pending_steps.length, 2);
  });

  it('returns error for unknown execution', () => {
    const result = getWorkflowStatus('exec_nonexistent');
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════
// pause / resume
// ═══════════════════════════════════════════

describe('pauseWorkflow', () => {
  it('pauses a running workflow', () => {
    const wf = createWorkflow('PauseTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    const result = pauseWorkflow(exec.execution_id, 'Need human review');

    assert.ok(result.paused_at);
    assert.equal(result.reason, 'Need human review');
  });

  it('cannot pause non-running workflow', () => {
    const wf = createWorkflow('PauseFail', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    pauseWorkflow(exec.execution_id);

    const result = pauseWorkflow(exec.execution_id);
    assert.ok(result.error);
  });

  it('prevents step completion while paused', () => {
    const wf = createWorkflow('PauseBlock', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    pauseWorkflow(exec.execution_id);

    const result = completeStep(exec.execution_id, 'a', null, 'success');
    assert.ok(result.error);
    assert.match(result.error, /paused/i);
  });
});

describe('resumeWorkflow', () => {
  it('resumes a paused workflow and returns ready steps', () => {
    const wf = createWorkflow('ResumeTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    pauseWorkflow(exec.execution_id);

    const result = resumeWorkflow(exec.execution_id);

    assert.ok(result.resumed_at);
    assert.equal(result.status, 'running');
    assert.equal(result.ready_steps.length, 2);
  });

  it('cannot resume non-paused workflow', () => {
    const wf = createWorkflow('ResumeFail', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);

    const result = resumeWorkflow(exec.execution_id);
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════
// list_workflows
// ═══════════════════════════════════════════

describe('listWorkflows', () => {
  it('lists definitions by default', () => {
    createWorkflow('A', 'desc', [{ id: 'x', name: 'X', depends_on: [] }]);
    createWorkflow('B', 'desc', [{ id: 'y', name: 'Y', depends_on: [] }]);

    const result = listWorkflows();
    assert.equal(result.type, 'definitions');
    assert.equal(result.count, 2);
  });

  it('lists active executions', () => {
    const wf = createWorkflow('Active', 'desc', [{ id: 'x', name: 'X', depends_on: [] }]);
    startWorkflow(wf.workflow_id);

    const result = listWorkflows('active');
    assert.equal(result.type, 'active');
    assert.equal(result.count, 1);
  });

  it('lists completed executions', () => {
    const wf = createWorkflow('Done', 'desc', [{ id: 'x', name: 'X', depends_on: [] }]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'x', null, 'success');

    const result = listWorkflows('completed');
    assert.equal(result.count, 1);
  });

  it('lists all executions', () => {
    const wf = createWorkflow('All', 'desc', [{ id: 'x', name: 'X', depends_on: [] }]);
    startWorkflow(wf.workflow_id);
    const e2 = startWorkflow(wf.workflow_id);
    completeStep(e2.execution_id, 'x', null, 'success');

    const result = listWorkflows('executions');
    assert.equal(result.count, 2);
  });
});

// ═══════════════════════════════════════════
// cancel_workflow
// ═══════════════════════════════════════════

describe('cancelWorkflow', () => {
  it('cancels a running workflow and preserves completed steps', () => {
    const wf = createWorkflow('CancelTest', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
      { id: 'c', name: 'C', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'a', null, 'success');

    const result = cancelWorkflow(exec.execution_id, 'No longer needed');

    assert.ok(result.cancelled_at);
    assert.equal(result.reason, 'No longer needed');
    assert.equal(result.completed_steps_preserved.length, 1);
    assert.equal(result.completed_steps_preserved[0].id, 'a');
    assert.equal(result.cancelled_steps.length, 2);
  });

  it('cannot cancel already completed workflow', () => {
    const wf = createWorkflow('CancelDone', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'a', null, 'success');

    const result = cancelWorkflow(exec.execution_id);
    assert.ok(result.error);
  });

  it('cannot complete steps after cancellation', () => {
    const wf = createWorkflow('CancelBlock', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: [] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    cancelWorkflow(exec.execution_id);

    const result = completeStep(exec.execution_id, 'a', null, 'success');
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════
// Complex workflow scenarios
// ═══════════════════════════════════════════

describe('complex scenarios', () => {
  it('handles a full diamond workflow end-to-end', () => {
    const wf = createWorkflow('Diamond E2E', 'A -> B,C -> D', [
      { id: 'a', name: 'Fetch Data', depends_on: [] },
      { id: 'b', name: 'Process CSV', depends_on: ['a'] },
      { id: 'c', name: 'Process JSON', depends_on: ['a'] },
      { id: 'd', name: 'Merge Results', depends_on: ['b', 'c'] },
    ]);

    const exec = startWorkflow(wf.workflow_id, { source: 'api' });
    assert.equal(exec.ready_steps.length, 1);
    assert.equal(exec.ready_steps[0].id, 'a');

    // Complete A -> B and C become ready
    const r1 = completeStep(exec.execution_id, 'a', { rows: 100 }, 'success');
    assert.equal(r1.newly_ready_steps.length, 2);

    // Complete B -> D not ready yet (C still pending)
    const r2 = completeStep(exec.execution_id, 'b', { csv_done: true }, 'success');
    assert.equal(r2.newly_ready_steps.length, 0);
    assert.equal(r2.workflow_status, 'running');

    // Complete C -> D becomes ready
    const r3 = completeStep(exec.execution_id, 'c', { json_done: true }, 'success');
    assert.equal(r3.newly_ready_steps.length, 1);
    assert.equal(r3.newly_ready_steps[0].id, 'd');

    // Complete D -> workflow done
    const r4 = completeStep(exec.execution_id, 'd', { merged: true }, 'success');
    assert.equal(r4.workflow_status, 'completed');
    assert.equal(r4.step_summary.success, 4);
  });

  it('handles partial failure in diamond — blocks downstream', () => {
    const wf = createWorkflow('Partial Fail', 'A -> B,C -> D', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
      { id: 'c', name: 'C', depends_on: ['a'] },
      { id: 'd', name: 'D', depends_on: ['b', 'c'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'a', null, 'success');

    // B fails, C succeeds
    completeStep(exec.execution_id, 'b', null, 'failed');
    const r = completeStep(exec.execution_id, 'c', null, 'success');

    // D should be blocked because B failed
    assert.equal(r.step_summary.blocked, 1);
    assert.equal(r.workflow_status, 'failed');
  });

  it('pause-resume preserves workflow state', () => {
    const wf = createWorkflow('PauseResume', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
      { id: 'b', name: 'B', depends_on: ['a'] },
    ]);
    const exec = startWorkflow(wf.workflow_id);
    completeStep(exec.execution_id, 'a', { v: 1 }, 'success');

    pauseWorkflow(exec.execution_id, 'lunch break');

    const status = getWorkflowStatus(exec.execution_id);
    assert.equal(status.status, 'paused');

    const resumed = resumeWorkflow(exec.execution_id);
    assert.equal(resumed.ready_steps.length, 1);
    assert.equal(resumed.ready_steps[0].id, 'b');

    const final = completeStep(exec.execution_id, 'b', null, 'success');
    assert.equal(final.workflow_status, 'completed');
  });

  it('multiple independent workflows run concurrently', () => {
    const wf = createWorkflow('Multi', 'desc', [
      { id: 'x', name: 'X', depends_on: [] },
    ]);

    const e1 = startWorkflow(wf.workflow_id);
    const e2 = startWorkflow(wf.workflow_id);

    assert.notEqual(e1.execution_id, e2.execution_id);

    completeStep(e1.execution_id, 'x', null, 'success');
    const s1 = getWorkflowStatus(e1.execution_id);
    const s2 = getWorkflowStatus(e2.execution_id);

    assert.equal(s1.status, 'completed');
    assert.equal(s2.status, 'running');
  });
});

// ═══════════════════════════════════════════
// stats
// ═══════════════════════════════════════════

describe('getStats', () => {
  it('returns aggregate statistics', () => {
    const wf = createWorkflow('Stats', 'desc', [
      { id: 'a', name: 'A', depends_on: [] },
    ]);

    const e1 = startWorkflow(wf.workflow_id);
    completeStep(e1.execution_id, 'a', null, 'success');

    const e2 = startWorkflow(wf.workflow_id);
    completeStep(e2.execution_id, 'a', null, 'failed');

    startWorkflow(wf.workflow_id); // active

    const stats = getStats();
    assert.equal(stats.total_definitions, 1);
    assert.equal(stats.total_executions, 3);
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.active, 1);
    assert.ok(stats.generated_at);
  });
});
