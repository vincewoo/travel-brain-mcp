import assert from 'node:assert/strict';

class ScriptedQuery {
  constructor(step, call) {
    this.step = step;
    this.call = call;
  }

  select(value) { this.call.select = value; return this; }
  insert(value) { this.call.operation = 'insert'; this.call.value = value; return this; }
  upsert(value, options) { this.call.operation = 'upsert'; this.call.value = value; this.call.options = options; return this; }
  update(value) { this.call.operation = 'update'; this.call.value = value; return this; }
  eq(column, value) { this.call.filters.push(['eq', column, value]); return this; }
  gte(column, value) { this.call.filters.push(['gte', column, value]); return this; }
  in(column, value) { this.call.filters.push(['in', column, value]); return this; }
  ilike(column, value) { this.call.filters.push(['ilike', column, value]); return this; }
  or(value) { this.call.filters.push(['or', value]); return this; }
  order(column, options) { this.call.order = [column, options]; return this; }
  limit(value) { this.call.limit = value; return this; }
  single() { this.call.cardinality = 'single'; return this; }
  maybeSingle() { this.call.cardinality = 'maybeSingle'; return this; }

  then(resolve, reject) {
    return Promise.resolve({ data: this.step.data ?? null, error: this.step.error ?? null }).then(resolve, reject);
  }
}

export function createScriptedSupabase(steps) {
  const remaining = [...steps];
  const calls = [];
  return {
    calls,
    from(table) {
      const step = remaining.shift();
      assert.ok(step, `Unexpected Supabase call for ${table}`);
      assert.equal(table, step.table, `Expected Supabase table ${step.table}, received ${table}`);
      const call = { table, operation: 'select', filters: [] };
      calls.push(call);
      return new ScriptedQuery(step, call);
    },
    rpc(name, args) {
      const step = remaining.shift();
      assert.ok(step, `Unexpected Supabase RPC call for ${name}`);
      assert.equal(name, step.rpc, `Expected Supabase RPC ${step.rpc}, received ${name}`);
      calls.push({ rpc: name, args, operation: 'rpc', filters: [] });
      return Promise.resolve({ data: step.data ?? null, error: step.error ?? null });
    },
    assertComplete() {
      assert.equal(remaining.length, 0, `Expected ${remaining.length} more Supabase call(s).`);
    }
  };
}
