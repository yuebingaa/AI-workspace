import assert from 'node:assert/strict';
import test from 'node:test';
import { notebookSearchFailureMessage, sanitizeToolArgumentIssues, toolArgumentFailureMessage } from './tool-diagnostics.mjs';

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
