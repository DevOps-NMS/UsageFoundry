# Performance benchmarks

The harnesses behind the numbers quoted in this branch's commit messages. They
are deliberately **not** part of `npm test`: they measure a machine, not a
contract, and two of them want a fixture that takes a minute to build.

Build the library once first — every harness loads the compiled output, so a
source change is invisible until this is re-run:

    npx tsc -p tsconfig.test.json

Every harness takes `BUILD=` to point at a second compile. That is how the
before/after figures were taken: build the older tree into its own directory,
then alternate the two runs rather than trusting one ordering on a machine that
has other work on it.

    git stash && npx tsc -p tsconfig.test.json && cp -r .test-build /tmp/before
    git stash pop && npx tsc -p tsconfig.test.json
    BUILD=/tmp/before/lib node bench/scan.js   # …then without BUILD, alternating

## Transcript path — needs no fixture

    node bench/scan.js        # the walk, a cold scan, a warm scan
    node bench/context.js     # apiContextTokens over every transcript

Both read `CLAUDE_HOME` (default `~/.claude`). **Point them at a copy.** A live
transcript store is appended to while you measure, and on this machine that
moved a warm scan from 70 ms to 165 ms — the difference was other agents
writing, not the code. `cp -r ~/.claude/projects /tmp/corpus/projects` once,
then `CLAUDE_HOME=/tmp/corpus`, and the numbers stop moving.

`BENCH_RUNS` sets the sample count (default 20). The filesystem matters more
than anything else here: the same walk measured 7.7 ms on an overlay mount and
70 ms on the mount the container actually binds, so quote which one you used.

## Database and pricing — needs a fixture

The app's own database on a developer machine has no runs in it, so these mean
nothing until a fixture exists:

    export DATA_DIR=/tmp/ufbench CLAUDE_HOME=/tmp/ufbench/claude
    node bench/populate-db.js           # 5,000 runs, 250,000 events, ~280 MB
    node bench/populate-transcripts.js  # 240 transcripts the pricing can price
    node --max-old-space-size=4096 node bench/queries.js

`populate-transcripts.js` deletes the projects tree it is about to write, so it
refuses any `CLAUDE_HOME` under your home directory and any non-empty projects
directory it did not write itself. Do not disable that.

Both fixtures are seeded, so a rerun rebuilds the same shape — but the two
scripts are independent, so rebuild both together if you rebuild either.

To reproduce the `ANALYZE` figures you need both halves, because `db()` runs
`migrate()` and `migrate()` now re-analyses — dropping the statistics inside the
harness puts them straight back, which is why there is no flag for it:

    node -e 'new (require("better-sqlite3"))(process.env.DATA_DIR+"/usagefoundry.db")
               .exec("DROP TABLE IF EXISTS sqlite_stat1; DROP TABLE IF EXISTS sqlite_stat4")'
    BUILD=/tmp/before/lib node bench/queries.js   # a build predating the ANALYZE
    node bench/queries.js                         # HEAD, which re-analyses

The filtered run-list pages move; the unfiltered first page — the only one of
them on the four-second poll — does not.
