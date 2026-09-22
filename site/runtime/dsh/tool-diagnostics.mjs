const codes = new Set([
  'invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of',
  'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom',
]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

/** Only paths through schema-owned properties/array positions may cross the broker boundary. */
function publicPath(path, root) {
  if (path === '$') return '$';
  if (typeof path !== 'string' || path.length > 100 || !record(root)) return '$';
  const segments = path.split('.');
  if (segments.length > 12) return '$';
  let candidates = [root];
  const accepted = [];
  for (const part of segments) {
    const pending = [...candidates], expanded = [], seen = new Set();
    for (let visits = 0; pending.length && visits < 256; visits += 1) {
      const schema = pending.pop();
      if (!record(schema) || seen.has(schema)) continue;
      seen.add(schema); expanded.push(schema);
      if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
        let referenced = root;
        for (const key of schema.$ref.slice(2).split('/').map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
          referenced = record(referenced) && Object.hasOwn(referenced, key) ? referenced[key] : undefined;
        }
        if (record(referenced)) pending.push(referenced);
      }
      for (const variant of ['oneOf', 'anyOf', 'allOf']) {
        if (Array.isArray(schema[variant])) pending.push(...schema[variant].slice(0, 64));
      }
    }
    const next = [];
    for (const schema of expanded) {
      if (record(schema.properties) && Object.hasOwn(schema.properties, part)) {
        next.push(schema.properties[part]);
      }
      if (schema.type === 'array' && /^(?:0|[1-9]\d{0,3})$/.test(part)) {
        if (record(schema.items)) next.push(schema.items);
        if (Array.isArray(schema.prefixItems) && Number(part) < schema.prefixItems.length) next.push(schema.prefixItems[Number(part)]);
      }
    }
    if (!next.length) break; // Dynamic dictionary keys/unknown properties are never emitted.
    accepted.push(part);
    candidates = next;
  }
  return accepted.length ? accepted.join('.') : '$';
}

/** Input is the trusted exception's summaries, never arbitrary error.message or rejected values. */
export function sanitizeToolArgumentIssues(summaries, parameters) {
  const issues = [];
  if (Array.isArray(summaries)) for (const summary of summaries.slice(0, 6)) {
    if (typeof summary !== 'string') continue;
    const parsed = /^([^:]{1,100}):([a-z_]+)(?:；|$)/u.exec(summary);
    if (!parsed || !codes.has(parsed[2])) continue;
    const issue = { path: publicPath(parsed[1], parameters), code: parsed[2] };
    if (!issues.some((item) => item.path === issue.path && item.code === issue.code)) issues.push(issue);
  }
  return issues.length ? issues : [{ path: '$', code: 'custom' }];
}

/** Reject an unrecognized error DTO completely; never append broker messages/body fragments. */
export function toolArgumentFailureMessage(body, parameters) {
  if (!hasKeys(body, ['error']) || !hasKeys(body.error, ['code', 'issues'])
    || body.error.code !== 'invalid_tool_arguments' || !Array.isArray(body.error.issues)
    || body.error.issues.length < 1 || body.error.issues.length > 6) return;
  const issues = body.error.issues;
  if (!issues.every((issue) => hasKeys(issue, ['path', 'code']) && codes.has(issue.code)
    && typeof issue.path === 'string' && issue.path.length <= 100
    && publicPath(issue.path, parameters) === issue.path)) return;
  return `invalid_tool_arguments: ${issues.map((issue) => `${issue.path}: ${issue.code}`).join('; ')}. Correct the arguments using the declared tool schema.`;
}

const searchFailures = Object.freeze({
  notebook_search_anchor_not_found: '指定单元或输出变量不存在。先用 {} 或 query 检索，再使用返回的实际 cellId / variable，不要猜测标识。',
  notebook_search_anchor_required: '遍历依赖需要实际 cellId 或 variable。先用 {} 获取索引；没有定位目标时省略 direction 或使用 self。',
  notebook_search_version_stale: '草稿版本已变化。重新用 {} 检索，并使用结果中的 editVersion，不要使用文档 revision。',
  notebook_search_run_stale: '指定运行回执已过期或不可用。省略 runId 重新检索当前状态；未获允许运行时不要启动计算。',
  notebook_search_budget_exceeded: '检索结果超过当前工具预算。缩小 query、指定一个实际 cellId，或使用 summary / 分页；不要提高执行预算。',
});

/** The model and UI share the same finite business diagnostic; no supplied message is used. */
export function notebookSearchFailureMessage(body, toolName) {
  if (toolName !== 'cellSearch' || !hasKeys(body, ['error']) || !hasKeys(body.error, ['code'])
    || typeof body.error.code !== 'string' || !Object.hasOwn(searchFailures, body.error.code)) return;
  return `cellSearch 检索失败（${body.error.code}）：${searchFailures[body.error.code]}`;
}
