// Three agentic coding tasks around one chess rules engine: build it, debug it, extend it. They
// stress an agent differently (long generation, exploration, a focused change), which is the point:
// routing may pay off on one kind of turn and not on another.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(HERE, file), "utf8");

const SPEC = read("SPEC.md");
const SPEC_SAN = read("SPEC-SAN.md");

/** The reference engine, optionally without its SAN section, for tasks that start from working code. */
function engine({ san }) {
  const source = read("reference/chess.js").replace(/^\/\/ Reference solution[\s\S]*?\n\n/, "");
  return san ? source.replace(/^[ \t]*\/\/ <\/?san>\n/gm, "") : source.replace(/^[ \t]*\/\/ <san>\n[\s\S]*?\/\/ <\/san>\n/gm, "");
}

// Each is a small, local, plausible slip; alone, each breaks at least one hidden check.
export const BUGS = [
  ["en passant removes the wrong square", "board[index(fileOf(move.to), rankOf(move.from))] = null;", "board[index(fileOf(move.from), rankOf(move.to))] = null;"],
  ["kingside castling through an attacked square", "empty: [5, 6], safe: [5, 6]", "empty: [5, 6], safe: [6]"],
  ["a knight step is off by one", "[-2, 1], [-1, 2]]", "[-2, 2], [-1, 2]]"],
  ["no promotion to bishop", 'of "qrbn")', 'of "qrn")'],
  ["castling right survives the rook's capture", "for (const square of [move.from, move.to]) {", "for (const square of [move.from]) {"],
];

export function inject(source, bugs = BUGS) {
  for (const [what, from, to] of bugs) {
    if (source.split(from).length !== 2) throw new Error(`bug "${what}" no longer matches the reference exactly once`);
    source = source.replace(from, to);
  }
  return source;
}

const manifest = (name) =>
  JSON.stringify({ name, version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n";

const SMOKE_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "../src/chess.js";

test("the starting position has 20 legal moves", () => {
  assert.equal(new Chess().moves().length, 20);
});

test("FEN round-trips", () => {
  const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
  assert.equal(new Chess(fen).fen(), fen);
});
`;

const PERFT_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "../src/chess.js";

// perft(n) counts every sequence of n legal moves from a position. The expected numbers are the
// published ones, so any rule the engine gets wrong shows up as a different count.
function perft(fen, depth) {
  const moves = new Chess(fen).moves();
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    const next = new Chess(fen);
    next.move(move);
    nodes += perft(next.fen(), depth - 1);
  }
  return nodes;
}

const POSITIONS = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [20, 400, 8902]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039]],
  ["endgame", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812]],
  ["promotions", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264]],
  ["promotion with check", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486]],
];

for (const [name, fen, counts] of POSITIONS) {
  counts.forEach((expected, i) => {
    test(\`perft \${i + 1} from \${name}\`, () => assert.equal(perft(fen, i + 1), expected));
  });
}

test("capturing a rook on its home square removes that castling right", () => {
  const game = new Chess("r3k2r/8/8/8/8/8/6B1/R3K2R w KQkq - 0 1");
  game.move("g2a8");
  assert.equal(game.fen().split(" ")[2], "KQk");
});
`;

function write(workspace, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), content);
  }
}

const verifier = join(HERE, "verify.mjs");

export const tasks = [
  {
    id: "chess-engine",
    title: "Build a chess rules engine from a spec",
    timeoutMinutes: 30,
    prompt:
      "Implement the chess rules engine described in README.md as src/chess.js. It must follow the API and the " +
      "details in README.md exactly, use no dependencies, and make `npm test` pass. Add tests of your own as you " +
      "see fit, and keep going until you are confident every rule is right.",
    setup: (workspace) =>
      write(workspace, {
        "package.json": manifest("chess-engine"),
        "README.md": SPEC,
        "src/chess.js": "// Implement the Chess class described in README.md.\n",
        "test/smoke.test.js": SMOKE_TEST,
      }),
    verify: (workspace) => [verifier, workspace],
  },
  {
    id: "chess-bugfix",
    title: "Find and fix the bugs in a chess engine",
    timeoutMinutes: 20,
    prompt:
      "`npm test` fails in this project. src/chess.js is a chess rules engine that is supposed to implement " +
      "README.md, and it has several bugs. Find and fix all of them. Do not change the tests, the public API, or " +
      "package.json, and do not add dependencies.",
    setup: (workspace) =>
      write(workspace, {
        "package.json": manifest("chess-bugfix"),
        "README.md": SPEC,
        "src/chess.js": inject(engine({ san: false })),
        "test/perft.test.js": PERFT_TEST,
      }),
    verify: (workspace) => [verifier, workspace],
  },
  {
    id: "chess-san",
    title: "Add algebraic notation to a working chess engine",
    timeoutMinutes: 20,
    prompt:
      "src/chess.js is a working chess rules engine. Add the three members described under \"Standard Algebraic " +
      "Notation\" in README.md: san(uci), moveSan(san) and history(). Everything that works today must keep " +
      "working, `npm test` must pass, and no dependencies may be added. Add tests for the new behaviour.",
    setup: (workspace) =>
      write(workspace, {
        "package.json": manifest("chess-san"),
        "README.md": SPEC + SPEC_SAN,
        "src/chess.js": engine({ san: false }),
        "test/perft.test.js": PERFT_TEST,
      }),
    verify: (workspace) => [verifier, workspace, "--san"],
  },
];

/** What a perfect run leaves behind; used by the self-test and the fake agent. */
export const solution = () => engine({ san: true });
export const engineWithoutSan = () => engine({ san: false });
