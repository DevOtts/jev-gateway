# Benchmark

Does routing tool choices through Jev make a coding agent cheaper without making it worse? This
folder measures it: the same task, done by a real agent, with routing on and with routing off.

```bash
pnpm bench:selftest                                   # prove the tasks measure what they claim (no agent, ~20 s)
pnpm bench -- --list                                  # tasks and options
pnpm bench -- --agent codex --tasks chess-bugfix      # one run with routing on, one with it off
pnpm bench -- --agent codex --reps 5 --prices 1.25,0.125,10
```

**Real agents spend real quota.** Every run is a full agent session. Start with one task and
`--reps 1`, look at the numbers, and scale up from there.

## How a run works

1. A fresh workspace is created in a temp directory from the task's starting files and committed to
   a git repository of its own.
2. A fresh gateway is started just for this run, on its own port (`--port`, default 8890), with
   routing on or off. Your everyday gateways on 8789 and 8790 are not touched, and nothing another
   session does can leak into the numbers.
3. The agent is started unattended inside the workspace, pointed at that gateway exactly the way
   `jev-codex` and `jev-claude` do it, with edits and test runs allowed. It gets the task prompt
   and a time limit.
4. The gateway's own metering gives the totals for the run: LLM requests, input tokens (and how
   many were cached), output tokens (and how many were reasoning), Jev calls and tokens, and how
   each request was handled.
5. A hidden verifier scores the workspace. The agent never sees it.

Modes alternate within a repetition and swap order between repetitions, so neither one always goes
first.

Results land in `bench/results/<timestamp>/`: `runs.jsonl` (one line per run), `summary.md`, and
per run the agent's output, the gateway log, the verifier's output and a diff summary. Rebuild the
summary any time with `node bench/report.mjs <dir> [--prices in,cached,out]`.

## Reading the summary

- **Solved** means every hidden check passed. A cheaper run that is not solved is not a saving.
- **Cost per solved task** divides everything spent, failed runs included, by the runs that were
  solved. It needs `--prices` (USD per million input, cached input and output tokens for your
  model) and adds Jev's own cost. This is the number to decide on.
- **Requests Jev steered** is the share of LLM requests that were not plain passthrough. If it is
  low, routing had little chance to matter: look at the passthrough reasons on the dashboard.
- **Failed LLM requests** and **agent timeouts** catch the expensive failure: a wrongly forced tool
  can derail a turn, and one derailment can cost more than many routed turns save.
- With fewer than five runs per mode the summary says so. Agents vary a lot between runs.

## The chess tasks

All three are about one chess rules engine with a small, exact API ([SPEC.md](tasks/chess/SPEC.md)).
Chess was chosen because it has an unusually objective yardstick: **perft**, the number of move
sequences of a given length from a position. The counts are published, and one wrong rule anywhere
(en passant, castling, pins, promotion) changes them. The verifier runs perft through the public
API on six standard positions, plus targeted checks for FEN handling, draws and game endings.

| Task | The agent has to | Kind of work |
| --- | --- | --- |
| `chess-engine` | Build the whole engine from the spec | Long generation, many test runs |
| `chess-bugfix` | Find and fix five injected bugs, with failing perft tests as the only clue | Exploration and debugging |
| `chess-san` | Add algebraic notation (`san`, `moveSan`, `history`) to a working engine | A focused feature |

They differ on purpose. Routing may pay off on the mechanical middle turns of one kind of task and
not on another, and an average over one kind of work would hide that.

`tasks/chess/reference/chess.js` is a complete solution. It never reaches a workspace: it exists to
prove the verifier right, and the bugfix and SAN tasks are generated from it. `pnpm bench:selftest`
checks that the reference passes every check, that no starting workspace already passes, and that
each injected bug is caught on its own.

## Testing the benchmark without an agent

`--agent fake` replaces the agent with a script that sends a few requests through the gateway and
then writes the reference solution. Together with the fake provider and the mock Jev, the whole
pipeline runs in seconds and costs nothing:

```bash
node bench/dev/fake-upstream.mjs &
MOCK_JEV_SCRIPT=exec_command node scripts/mock-jev.mjs &
TYPESAFE_API_KEY=mock TYPESAFE_BASE_URL=http://127.0.0.1:8799 pnpm bench -- --agent fake --reps 2
```

## Adding a task

A task is an object with an `id`, a `title`, a `prompt`, a `timeoutMinutes`, a `setup(workspace)`
that writes the starting files, and a `verify(workspace)` that returns the command line of a
verifier. The verifier prints `{"total": n}` and then one `{"name", "ok"}` JSON line per check, as
it goes, so a solution that hangs keeps the credit it earned before the timeout. Add the task to
`TASKS` in `run.mjs`.
