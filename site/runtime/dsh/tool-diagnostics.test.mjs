import assert from 'node:assert/strict';
import test from 'node:test';
import { notebookSearchFailureMessage, notebookToolFailureMessage, sanitizeToolArgumentIssues, toolArgumentFailureMessage } from './tool-diagnostics.mjs';

const parameters = { type: 'object', properties: {
  query: { type: 'string' }, bindings: { type: 'object', additionalProperties: { type: 'string' } },
  cells: { type: 'array', items: { $ref: '#/$defs/cell' } },
}, $defs: { cell: { anyOf: [{ type: 'object', properties: { code: { type: 'string' } } }] } } };

test('schema paths handle arrays/unions/local refs without dynamic keys or diagnostic values', () => {
  assert.deepEqual(sanitizeToolArgumentIssues([
    'query:invalid_type；要求 SYNTHETIC_PRIVATE_VALUE',
    'bindings.SYNTHETIC_PRIVATE_KEY:custom',
    'cells.2.code:invalid_format；要求 SYNTHETIC_PRIVATE_PATTERN',
  ], parameters), [
    { path: 'query', code: 'invalid_type' }, { path: 'bindings', code: 'custom' }, { path: 'cells.2.code', code: 'invalid_format' },
  ]);
  assert.deepEqual(sanitizeToolArgumentIssues(['invalid-synthetic-message'], parameters), [{ path: '$', code: 'custom' }]);
});

test('plugin formats only exact bounded error DTO with schema-owned paths and known codes', () => {
  const body = { error: { code: 'invalid_tool_arguments', issues: [{ path: 'query', code: 'invalid_type' }] } };
  assert.equal(toolArgumentFailureMessage(body, parameters),
    'invalid_tool_arguments: query: invalid_type. Correct the arguments using the declared tool schema.');
  for (const unsafe of [
    { ...body, message: 'SYNTHETIC_PRIVATE_MESSAGE' },
    { error: { ...body.error, message: 'SYNTHETIC_PRIVATE_MESSAGE' } },
    { error: { code: 'invalid_tool_arguments', issues: [{ path: 'bindings.SYNTHETIC_PRIVATE_KEY', code: 'custom' }] } },
    { error: { code: 'invalid_tool_arguments', issues: [{ path: 'query', code: 'SYNTHETIC_PRIVATE_CODE' }] } },
    { error: { code: 'invalid_tool_arguments', issues: [{ path: 'query', code: 'custom', value: 'SYNTHETIC_PRIVATE_VALUE' }] } },
    { error: { code: 'invalid_tool_arguments', issues: Array.from({ length: 7 }, () => ({ path: 'query', code: 'custom' })) } },
    { error: { code: 'invalid_tool_arguments', issues: [] } },
  ]) assert.equal(toolArgumentFailureMessage(unsafe, parameters), undefined);
});

test('search business DTO permits only five finite codes and never caller messages or extra fields', () => {
  for (const code of ['notebook_search_anchor_not_found', 'notebook_search_anchor_required',
    'notebook_search_version_stale', 'notebook_search_run_stale', 'notebook_search_budget_exceeded']) {
    const body = { error: { code } };
    assert.ok(notebookSearchFailureMessage(body, 'cellSearch').includes(code));
    assert.equal(notebookSearchFailureMessage(body, 'editNotebookCells'), undefined);
    assert.equal(notebookSearchFailureMessage({ error: { code, message: 'SYNTHETIC_PRIVATE' } }, 'cellSearch'), undefined);
    assert.equal(notebookSearchFailureMessage({ ...body, source: 'SYNTHETIC_PRIVATE' }, 'cellSearch'), undefined);
  }
  for (const code of ['unknown', 'constructor', '__proto__', 'SYNTHETIC_PRIVATE', null, 1]) {
    assert.equal(notebookSearchFailureMessage({ error: { code } }, 'cellSearch'), undefined);
  }
});

test('submission diagnostics accept exactly four codes for the submit tool and reject all extra fields', () => {
  for (const code of ['notebook_submit_version_stale', 'notebook_submit_no_changes',
    'notebook_submit_run_required', 'notebook_submit_receipt_mismatch']) {
    const body = { error: { code } };
    assert.ok(notebookToolFailureMessage(body, 'submitNotebookDraft').includes(code));
    for (const name of ['cellSearch', 'runNotebookCells', 'editNotebookCells', 'unknown']) {
      assert.equal(notebookToolFailureMessage(body, name), undefined);
    }
    assert.equal(notebookSearchFailureMessage(body, 'cellSearch'), undefined);
    for (const unsafe of [
      { error: { code, message: 'SYNTHETIC_PRIVATE' } },
      { error: { code, issues: [] } },
      { error: { code, editVersion: 0 } },
      { ...body, message: 'SYNTHETIC_PRIVATE' },
      { code },
    ]) assert.equal(notebookToolFailureMessage(unsafe, 'submitNotebookDraft'), undefined);
  }
  for (const code of ['notebook_search_version_stale', 'unknown', 'constructor', '__proto__', null, 1]) {
    assert.equal(notebookToolFailureMessage({ error: { code } }, 'submitNotebookDraft'), undefined);
  }
  const search = { error: { code: 'notebook_search_version_stale' } };
  assert.equal(notebookToolFailureMessage(search, 'cellSearch'), notebookSearchFailureMessage(search, 'cellSearch'));
});
