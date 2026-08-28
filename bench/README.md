# Performance benchmarks

Repeatable harnesses behind the numbers quoted in commit messages. They are not
part of `npm test` — they read the operator's real transcript store and the real
database, so they measure a machine rather than the code's contract.

Build once, then run any harness:

    npx tsc -p tsconfig.test.json
    node bench/scan.js            # transcript walk + scan
    node bench/queries.js         # EXPLAIN QUERY PLAN + timings

Both take the corpus from `CLAUDE_HOME` (default `~/.claude`), so point them at
a copy if you do not want to read the live one.
