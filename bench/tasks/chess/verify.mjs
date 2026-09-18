#!/usr/bin/env node
// Hidden verifier for the chess tasks: node verify.mjs <workspace> [--san]
//
// Prints one JSON line per check as it goes ({"total": n} first), so a solution that hangs still
// gets credit for what it passed before the runner's timeout kills this process. Chess has an
// unusually objective yardstick: perft, the number of move sequences of a given length from a
// position. One wrong rule anywhere (en passant, castling, pins, promotion) changes the count.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = resolve(process.argv[2] ?? ".");
const withSan = process.argv.includes("--san");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Standard perft positions and their published node counts.
const PERFT = [
  ["start position", START, [20, 400, 8902, 197281]],
  ["kiwipete (castling, pins, en passant)", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
  ["endgame (en passant discovered check)", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["promotions and castling rights", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["promotion with check", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ["middlegame", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", [46, 2079, 89890]],
];

let Chess;
const checks = [];
const check = (name, run) => checks.push({ name, run });
const equal = (actual, expected, what = "value") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};
const play = (game, moves) => {
  for (const move of moves) if (game.move(move) !== true) throw new Error(`legal move ${move} was refused`);
  return game;
};

/** Counts leaves through the public API only; the last ply is counted, not played. */
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

check("has no third-party dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  equal(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }), [], "dependencies");
  if (existsSync(join(workspace, "node_modules"))) throw new Error("node_modules exists");
});

for (const [name, fen, counts] of PERFT) {
  counts.forEach((expected, i) => check(`perft ${i + 1}: ${name}`, () => equal(perft(fen, i + 1), expected, "nodes")));
}

check("starts from the standard position by default", () => {
  equal(new Chess().fen(), START, "fen()");
  equal(new Chess().turn(), "w", "turn()");
});
check("round-trips FEN", () => {
  for (const [, fen] of PERFT) equal(new Chess(fen).fen(), fen, "fen()");
});
check("rejects invalid FEN", () => {
  for (const bad of ["", "not a fen", "8/8/8/8/8/8/8/8 w - - 0 1", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]) {
    let threw = false;
    try {
      new Chess(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
});
check("moves() returns UCI strings", () => {
  equal(new Chess().moves().slice().sort(), ["a2a3", "a2a4", "b1a3", "b1c3", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4", "e2e3", "e2e4", "f2f3", "f2f4", "g1f3", "g1h3", "g2g3", "g2g4", "h2h3", "h2h4"], "moves()");
});
check("refuses illegal moves without changing the position", () => {
  const game = new Chess();
  for (const bad of ["e2e5", "e7e5", "e1g1", "zz", "e2e4q"]) equal(game.move(bad), false, `move(${bad})`);
  equal(game.fen(), START, "fen()");
});
check("updates every FEN field as the game goes on", () => {
  const game = play(new Chess(), ["e2e4"]);
  equal(game.fen(), "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", "after e2e4");
  play(game, ["c7c5", "g1f3"]);
  equal(game.fen(), "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2", "after c7c5 g1f3");
});
check("captures en passant", () => {
  const game = play(new Chess(), ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]);
  equal(game.fen(), "rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3", "fen()");
});
check("castles and updates rights", () => {
  const game = play(new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), ["e1g1", "e8c8"]);
  equal(game.fen(), "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2", "fen()");
});
check("loses a castling right when its rook is captured", () => {
  const game = play(new Chess("r3k2r/8/8/8/8/8/6B1/R3K2R w KQkq - 0 1"), ["g2a8"]);
  equal(game.fen().split(" ")[2], "KQk", "castling field");
});
check("promotes to the chosen piece", () => {
  const game = new Chess("8/P6k/8/8/8/8/8/K7 w - - 0 1");
  equal(game.moves().filter((move) => move.startsWith("a7a8")).sort(), ["a7a8b", "a7a8n", "a7a8q", "a7a8r"], "promotions");
  play(game, ["a7a8n"]);
  equal(game.fen(), "N7/7k/8/8/8/8/8/K7 b - - 0 1", "fen()");
});
check("detects check, checkmate and game over", () => {
  const game = play(new Chess(), ["f2f3", "e7e5", "g2g4"]);
  equal([game.isCheck(), game.isCheckmate(), game.isGameOver()], [false, false, false], "before mate");
  play(game, ["d8h4"]);
  equal([game.isCheck(), game.isCheckmate(), game.isStalemate(), game.isGameOver(), game.moves()], [true, true, false, true, []], "after mate");
});
check("detects stalemate as a draw", () => {
  const game = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  equal([game.isCheck(), game.isStalemate(), game.isCheckmate(), game.isDraw(), game.isGameOver()], [false, true, false, true, true], "flags");
});
check("detects insufficient material", () => {
  const cases = [
    ["8/8/8/8/8/8/8/K6k w - - 0 1", true],
    ["8/8/8/8/8/8/8/KN5k w - - 0 1", true],
    ["8/8/8/8/8/8/8/KB5k w - - 0 1", true],
    ["8/8/8/8/8/8/8/KB3b1k w - - 0 1", true],
    ["8/8/8/8/8/8/8/KB4bk w - - 0 1", false],
    ["8/8/8/8/8/8/P7/K6k w - - 0 1", false],
    ["8/8/8/8/8/8/8/KR5k w - - 0 1", false],
  ];
  for (const [fen, expected] of cases) equal(new Chess(fen).isInsufficientMaterial(), expected, fen);
});
check("applies the fifty-move rule", () => {
  equal(new Chess("8/8/8/8/8/8/R7/K6k w - - 99 80").isDraw(), false, "at 99 half-moves");
  equal(play(new Chess("8/8/8/8/8/8/R7/K6k w - - 99 80"), ["a2b2"]).isDraw(), true, "at 100 half-moves");
});
check("detects threefold repetition", () => {
  const game = new Chess();
  const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
  play(game, shuffle);
  equal(game.isThreefoldRepetition(), false, "after the second occurrence");
  play(game, shuffle);
  equal([game.isThreefoldRepetition(), game.isDraw()], [true, true], "after the third occurrence");
});

if (withSan) {
  // Morphy's Opera Game, 1858: captures, castling both ways, checks, a disambiguation and a mate.
  const OPERA = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");
  check("san: plays a whole game from SAN", () => {
    const game = new Chess();
    for (const san of OPERA) if (game.moveSan(san) !== true) throw new Error(`legal move ${san} was refused`);
    equal(game.fen(), "1n1Rkb1r/p4ppp/4q3/4p1B1/4P3/8/PPP2PPP/2K5 b k - 1 17", "fen()");
    equal(game.isCheckmate(), true, "isCheckmate()");
  });
  check("san: history() reports the moves played, in SAN", () => {
    const game = new Chess();
    for (const san of OPERA) game.moveSan(san);
    equal(game.history(), OPERA, "history()");
    equal(play(new Chess(), ["e2e4", "e7e5", "g1f3"]).history(), ["e4", "e5", "Nf3"], "history() after UCI moves");
  });
  check("san: disambiguates by file, then rank, then both", () => {
    equal(new Chess("1k6/8/8/8/8/8/4K3/R6R w - - 0 1").san("a1d1"), "Rad1", "two rooks on a rank");
    equal(new Chess("R7/7k/8/8/8/8/8/R3K3 w - - 0 1").san("a1a4"), "R1a4", "two rooks on a file");
    equal(new Chess("1k6/8/8/8/4Q2Q/8/8/K6Q w - - 0 1").san("h4e1"), "Qh4e1", "three queens");
    equal(new Chess("1k6/8/8/8/8/8/4K3/R6R w - - 0 1").san("h1h5"), "Rh5", "no rival for the square");
  });
  check("san: leaves pinned pieces out of disambiguation", () => {
    equal(new Chess("4r2k/8/8/8/8/2N5/4N3/4K3 w - - 0 1").san("c3d5"), "Nd5", "the e2 knight is pinned");
  });
  check("san: writes promotions, en passant and castling", () => {
    equal(new Chess("1n5k/P7/8/8/8/8/8/K7 w - - 0 1").san("a7b8q"), "axb8=Q+", "capture-promotion with check");
    equal(new Chess("8/P6k/8/8/8/8/8/K7 w - - 0 1").san("a7a8n"), "a8=N", "under-promotion");
    equal(new Chess("rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3").san("e5d6"), "exd6", "en passant");
    equal(new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").san("e1g1"), "O-O", "kingside");
    equal(new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").san("e1c1"), "O-O-O", "queenside");
  });
  check("san: refuses what it cannot play", () => {
    const game = new Chess();
    equal([game.moveSan("Nf6"), game.moveSan("e5"), game.moveSan("O-O")], [false, false, false], "moveSan()");
    equal(game.fen(), START, "fen()");
    let threw = false;
    try {
      game.san("e2e5");
    } catch {
      threw = true;
    }
    equal(threw, true, "san() throws on an illegal move");
  });
}

console.log(JSON.stringify({ total: checks.length }));
try {
  ({ Chess } = await import(pathToFileURL(join(workspace, "src/chess.js")).href));
  if (typeof Chess !== "function") throw new Error("src/chess.js does not export a Chess class");
} catch (error) {
  console.log(JSON.stringify({ name: "loads src/chess.js", ok: false, error: String(error?.message ?? error).slice(0, 300) }));
  process.exit(0);
}
for (const { name, run } of checks) {
  try {
    run();
    console.log(JSON.stringify({ name, ok: true }));
  } catch (error) {
    console.log(JSON.stringify({ name, ok: false, error: String(error?.message ?? error).slice(0, 300) }));
  }
}
