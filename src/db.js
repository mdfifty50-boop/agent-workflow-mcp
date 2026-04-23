import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WORKFLOW_DATA_DIR || join(homedir(), '.agent-workflow-mcp');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = join(DATA_DIR, 'workflows.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH);

  // WAL mode for better concurrency
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id   TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS executions (
      execution_id  TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      status        TEXT NOT NULL,
      current_step  TEXT,
      state_json    TEXT NOT NULL DEFAULT '{}',
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      error         TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    );

    CREATE TABLE IF NOT EXISTS steps (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id  TEXT NOT NULL,
      step_name     TEXT NOT NULL,
      status        TEXT NOT NULL,
      input_json    TEXT NOT NULL DEFAULT '{}',
      output_json   TEXT NOT NULL DEFAULT '{}',
      started_at    TEXT,
      ended_at      TEXT,
      error         TEXT,
      FOREIGN KEY (execution_id) REFERENCES executions(execution_id)
    );

    CREATE INDEX IF NOT EXISTS idx_executions_workflow_id ON executions(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_steps_execution_id ON steps(execution_id);
  `);

  return _db;
}

// ─── Workflow CRUD ────────────────────────────────────────────────

export function dbSaveWorkflow(workflow) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO workflows (workflow_id, name, definition_json, status, created_at, updated_at, metadata_json)
    VALUES (@workflow_id, @name, @definition_json, @status, @created_at, @updated_at, @metadata_json)
    ON CONFLICT(workflow_id) DO UPDATE SET
      name = excluded.name,
      definition_json = excluded.definition_json,
      status = excluded.status,
      updated_at = excluded.updated_at,
      metadata_json = excluded.metadata_json
  `).run({
    workflow_id: workflow.workflow_id,
    name: workflow.name,
    definition_json: JSON.stringify(workflow),
    status: 'active',
    created_at: workflow.created_at || now,
    updated_at: now,
    metadata_json: '{}',
  });
}

export function dbGetWorkflow(workflow_id) {
  const db = getDb();
  const row = db.prepare('SELECT definition_json FROM workflows WHERE workflow_id = ?').get(workflow_id);
  if (!row) return null;
  return JSON.parse(row.definition_json);
}

export function dbGetAllWorkflows() {
  const db = getDb();
  return db.prepare('SELECT definition_json FROM workflows').all()
    .map(r => JSON.parse(r.definition_json));
}

// ─── Execution CRUD ───────────────────────────────────────────────

export function dbSaveExecution(execution) {
  const db = getDb();
  db.prepare(`
    INSERT INTO executions (execution_id, workflow_id, status, current_step, state_json, started_at, ended_at, error)
    VALUES (@execution_id, @workflow_id, @status, @current_step, @state_json, @started_at, @ended_at, @error)
    ON CONFLICT(execution_id) DO UPDATE SET
      status = excluded.status,
      current_step = excluded.current_step,
      state_json = excluded.state_json,
      ended_at = excluded.ended_at,
      error = excluded.error
  `).run({
    execution_id: execution.execution_id,
    workflow_id: execution.workflow_id,
    status: execution.status,
    current_step: execution.current_step || null,
    state_json: JSON.stringify(execution),
    started_at: execution.started_at,
    ended_at: execution.completed_at || null,
    error: execution.error || null,
  });
}

export function dbGetExecution(execution_id) {
  const db = getDb();
  const row = db.prepare('SELECT state_json FROM executions WHERE execution_id = ?').get(execution_id);
  if (!row) return null;
  return JSON.parse(row.state_json);
}

export function dbGetAllExecutions() {
  const db = getDb();
  return db.prepare('SELECT state_json FROM executions').all()
    .map(r => JSON.parse(r.state_json));
}

export function dbGetExecutionsByWorkflow(workflow_id) {
  const db = getDb();
  return db.prepare('SELECT state_json FROM executions WHERE workflow_id = ?').all(workflow_id)
    .map(r => JSON.parse(r.state_json));
}

export function dbGetExecutionsByStatus(status) {
  const db = getDb();
  return db.prepare('SELECT state_json FROM executions WHERE status = ?').all(status)
    .map(r => JSON.parse(r.state_json));
}

// ─── Step logging ─────────────────────────────────────────────────

export function dbLogStep({ execution_id, step_name, status, input, output, started_at, ended_at, error }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO steps (execution_id, step_name, status, input_json, output_json, started_at, ended_at, error)
    VALUES (@execution_id, @step_name, @status, @input_json, @output_json, @started_at, @ended_at, @error)
  `).run({
    execution_id,
    step_name,
    status,
    input_json: JSON.stringify(input || {}),
    output_json: JSON.stringify(output || {}),
    started_at: started_at || null,
    ended_at: ended_at || null,
    error: error || null,
  });
}

export function dbGetStepsForExecution(execution_id) {
  const db = getDb();
  return db.prepare('SELECT * FROM steps WHERE execution_id = ? ORDER BY id ASC').all(execution_id);
}

// ─── Test helper ──────────────────────────────────────────────────

export function _resetDb() {
  const db = getDb();
  db.exec('DELETE FROM steps; DELETE FROM executions; DELETE FROM workflows;');
}
