// Reference solution for the chess tasks. It exists to prove the verifier right (every check must
// pass against it) and to seed the tasks that start from working code. Agents never see this file:
// their workspace is a temp directory that only receives what a task's setup() copies in.

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FILES = "abcdefgh";
const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

const index = (file, rank) => rank * 8 + file;
const fileOf = (square) => square % 8;
const rankOf = (square) => square >> 3;
const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
const name = (square) => FILES[fileOf(square)] + (rankOf(square) + 1);
const colorOf = (piece) => (piece === piece.toUpperCase() ? "w" : "b");
const uci = (move) => name(move.from) + name(move.to) + (move.promotion ?? "");

function parseSquare(text) {
  const file = FILES.indexOf(text[0]);
  const rank = Number(text[1]) - 1;
  if (text.length !== 2 || file < 0 || !(rank >= 0 && rank < 8)) throw new Error(`Invalid square: ${text}`);
  return index(file, rank);
}

function parseFen(fen) {
  const fields = String(fen).trim().split(/\s+/);
  if (fields.length !== 6) throw new Error("Invalid FEN: expected 6 fields");
  const [placement, turn, castling, enPassant, halfmove, fullmove] = fields;

  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error("Invalid FEN: expected 8 ranks");
  const board = new Array(64).fill(null);
  rows.forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) file += Number(char);
      else if (/[pnbrqkPNBRQK]/.test(char)) {
        if (file > 7) throw new Error("Invalid FEN: rank too long");
        board[index(file++, 7 - rowIndex)] = char;
      } else throw new Error(`Invalid FEN: unexpected "${char}"`);
    }
    if (file !== 8) throw new Error("Invalid FEN: rank does not have 8 squares");
  });
  for (const king of ["K", "k"]) {
    if (board.filter((piece) => piece === king).length !== 1) throw new Error("Invalid FEN: each side needs exactly one king");
  }
  if (turn !== "w" && turn !== "b") throw new Error("Invalid FEN: side to move");
  if (!/^(-|K?Q?k?q?)$/.test(castling) || castling === "") throw new Error("Invalid FEN: castling rights");
  if (!/^(-|[a-h][36])$/.test(enPassant)) throw new Error("Invalid FEN: en passant square");
  if (!/^\d+$/.test(halfmove) || !/^[1-9]\d*$/.test(fullmove)) throw new Error("Invalid FEN: move counters");

  return {
    board,
    turn,
    castling: castling === "-" ? "" : castling,
    enPassant: enPassant === "-" ? -1 : parseSquare(enPassant),
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
}

function isAttacked(board, square, by) {
  const file = fileOf(square);
  const rank = rankOf(square);
  const is = (f, r, kinds) => {
    if (!onBoard(f, r)) return false;
    const piece = board[index(f, r)];
    return piece !== null && colorOf(piece) === by && kinds.includes(piece.toLowerCase());
  };
  // A white pawn attacks upwards, so it sits one rank below the square it attacks.
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  if (is(file - 1, pawnRank, "p") || is(file + 1, pawnRank, "p")) return true;
  if (KNIGHT_STEPS.some(([df, dr]) => is(file + df, rank + dr, "n"))) return true;
  if (KING_STEPS.some(([df, dr]) => is(file + df, rank + dr, "k"))) return true;
  for (const [dirs, kinds] of [[ROOK_DIRS, "rq"], [BISHOP_DIRS, "bq"]]) {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r) && board[index(f, r)] === null) {
        f += df;
        r += dr;
      }
      if (is(f, r, kinds)) return true;
    }
  }
  return false;
}

const kingSquare = (board, color) => board.indexOf(color === "w" ? "K" : "k");
const inCheck = (state, color) => isAttacked(state.board, kingSquare(state.board, color), color === "w" ? "b" : "w");

function pseudoLegalMoves(state) {
  const { board, turn } = state;
  const enemy = turn === "w" ? "b" : "w";
  const moves = [];
  const push = (from, to, extra) => moves.push({ from, to, ...extra });

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === null || colorOf(piece) !== turn) continue;
    const file = fileOf(from);
    const rank = rankOf(from);
    const kind = piece.toLowerCase();

    if (kind === "p") {
      const forward = turn === "w" ? 1 : -1;
      const startRank = turn === "w" ? 1 : 6;
      const lastRank = turn === "w" ? 7 : 0;
      const pushPawn = (to, extra) => {
        if (rankOf(to) === lastRank) for (const promotion of "qrbn") push(from, to, { ...extra, promotion });
        else push(from, to, extra);
      };
      const one = index(file, rank + forward);
      if (board[one] === null) {
        pushPawn(one);
        const two = index(file, rank + 2 * forward);
        if (rank === startRank && board[two] === null) push(from, two, { doublePush: true });
      }
      for (const df of [-1, 1]) {
        if (!onBoard(file + df, rank + forward)) continue;
        const to = index(file + df, rank + forward);
        if (board[to] !== null && colorOf(board[to]) === enemy) pushPawn(to);
        else if (to === state.enPassant) push(from, to, { enPassant: true });
      }
    } else if (kind === "n" || kind === "k") {
      for (const [df, dr] of kind === "n" ? KNIGHT_STEPS : KING_STEPS) {
        if (!onBoard(file + df, rank + dr)) continue;
        const to = index(file + df, rank + dr);
        if (board[to] === null || colorOf(board[to]) === enemy) push(from, to);
      }
    } else {
      const dirs = kind === "r" ? ROOK_DIRS : kind === "b" ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [df, dr] of dirs) {
        let f = file + df;
        let r = rank + dr;
        while (onBoard(f, r)) {
          const to = index(f, r);
          if (board[to] === null) push(from, to);
          else {
            if (colorOf(board[to]) === enemy) push(from, to);
            break;
          }
          f += df;
          r += dr;
        }
      }
    }
  }

  // Castling: the king may not be in check, pass through an attacked square, or land on one; the
  // squares between king and rook must be empty (b1/b8 may be attacked, it only has to be empty).
  const home = turn === "w" ? 0 : 7;
  const king = index(4, home);
  if (board[king] === (turn === "w" ? "K" : "k") && !isAttacked(board, king, enemy)) {
    const rook = turn === "w" ? "R" : "r";
    const sides = [
      { right: turn === "w" ? "K" : "k", rookFile: 7, empty: [5, 6], safe: [5, 6], to: 6 },
      { right: turn === "w" ? "Q" : "q", rookFile: 0, empty: [1, 2, 3], safe: [2, 3], to: 2 },
    ];
    for (const side of sides) {
      if (!state.castling.includes(side.right) || board[index(side.rookFile, home)] !== rook) continue;
      if (side.empty.some((f) => board[index(f, home)] !== null)) continue;
      if (side.safe.some((f) => isAttacked(board, index(f, home), enemy))) continue;
      push(king, index(side.to, home), { castle: side.rookFile });
    }
  }
  return moves;
}

function applyMove(state, move) {
  const board = state.board.slice();
  const piece = board[move.from];
  const captured = move.enPassant ? "p" : board[move.to];
  board[move.from] = null;
  board[move.to] = move.promotion ? (state.turn === "w" ? move.promotion.toUpperCase() : move.promotion) : piece;
  if (move.enPassant) board[index(fileOf(move.to), rankOf(move.from))] = null;
  if (move.castle !== undefined) {
    const home = rankOf(move.from);
    board[index(move.castle === 7 ? 5 : 3, home)] = board[index(move.castle, home)];
    board[index(move.castle, home)] = null;
  }

  // A right is lost when its king or rook moves, and when its rook is captured at home.
  let castling = state.castling;
  const lose = (rights) => (castling = castling.replace(new RegExp(`[${rights}]`, "g"), ""));
  if (piece === "K") lose("KQ");
  if (piece === "k") lose("kq");
  for (const square of [move.from, move.to]) {
    if (square === index(0, 0)) lose("Q");
    if (square === index(7, 0)) lose("K");
    if (square === index(0, 7)) lose("q");
    if (square === index(7, 7)) lose("k");
  }

  return {
    board,
    turn: state.turn === "w" ? "b" : "w",
    castling,
    // Always recorded after a double push, whether or not a pawn can actually capture there.
    enPassant: move.doublePush ? index(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2) : -1,
    halfmove: piece.toLowerCase() === "p" || captured ? 0 : state.halfmove + 1,
    fullmove: state.fullmove + (state.turn === "b" ? 1 : 0),
  };
}

function legalMoves(state) {
  return pseudoLegalMoves(state).filter((move) => !inCheck(applyMove(state, move), state.turn));
}

function toFen(state) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = state.board[index(file, rank)];
      if (piece === null) empty++;
      else {
        row += (empty || "") + piece;
        empty = 0;
      }
    }
    rows.push(row + (empty || ""));
  }
  const enPassant = state.enPassant < 0 ? "-" : name(state.enPassant);
  return `${rows.join("/")} ${state.turn} ${state.castling || "-"} ${enPassant} ${state.halfmove} ${state.fullmove}`;
}

/** What repeats in a threefold repetition: the position, not the move counters. */
const positionKey = (state) => toFen(state).split(" ").slice(0, 4).join(" ");

export class Chess {
  #state;
  #seen = new Map();
  // <san>
  #history = [];
  // </san>

  constructor(fen = START_FEN) {
    this.#state = parseFen(fen);
    this.#remember();
  }

  #remember() {
    const key = positionKey(this.#state);
    this.#seen.set(key, (this.#seen.get(key) ?? 0) + 1);
  }

  fen() {
    return toFen(this.#state);
  }

  turn() {
    return this.#state.turn;
  }

  moves() {
    return legalMoves(this.#state).map(uci);
  }

  move(text) {
    const move = legalMoves(this.#state).find((candidate) => uci(candidate) === text);
    if (!move) return false;
    // <san>
    this.#history.push(this.san(text));
    // </san>
    this.#state = applyMove(this.#state, move);
    this.#remember();
    return true;
  }

  isCheck() {
    return inCheck(this.#state, this.#state.turn);
  }

  isCheckmate() {
    return this.isCheck() && legalMoves(this.#state).length === 0;
  }

  isStalemate() {
    return !this.isCheck() && legalMoves(this.#state).length === 0;
  }

  isInsufficientMaterial() {
    const pieces = [];
    this.#state.board.forEach((piece, square) => {
      if (piece !== null && piece.toLowerCase() !== "k") pieces.push({ kind: piece.toLowerCase(), square });
    });
    if (pieces.length === 0) return true;
    if (pieces.length === 1) return pieces[0].kind === "n" || pieces[0].kind === "b";
    // Any number of bishops that all stand on the same colour of square can never mate.
    const shade = (square) => (fileOf(square) + rankOf(square)) % 2;
    return pieces.every((piece) => piece.kind === "b" && shade(piece.square) === shade(pieces[0].square));
  }

  isThreefoldRepetition() {
    return (this.#seen.get(positionKey(this.#state)) ?? 0) >= 3;
  }

  isDraw() {
    return this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition() || this.#state.halfmove >= 100;
  }

  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  // <san>
  san(text) {
    const legal = legalMoves(this.#state);
    const move = legal.find((candidate) => uci(candidate) === text);
    if (!move) throw new Error(`Illegal move: ${text}`);

    const after = applyMove(this.#state, move);
    const suffix = !inCheck(after, after.turn) ? "" : legalMoves(after).length === 0 ? "#" : "+";
    if (move.castle !== undefined) return (move.castle === 7 ? "O-O" : "O-O-O") + suffix;

    const kind = this.#state.board[move.from].toLowerCase();
    const capture = move.enPassant || this.#state.board[move.to] !== null;
    const promotion = move.promotion ? "=" + move.promotion.toUpperCase() : "";
    if (kind === "p") return (capture ? FILES[fileOf(move.from)] + "x" : "") + name(move.to) + promotion + suffix;

    // Disambiguate only as much as needed: by file, else by rank, else by both.
    const rivals = legal.filter(
      (other) => other.to === move.to && other.from !== move.from && this.#state.board[other.from].toLowerCase() === kind,
    );
    let origin = "";
    if (rivals.length) {
      if (!rivals.some((other) => fileOf(other.from) === fileOf(move.from))) origin = FILES[fileOf(move.from)];
      else if (!rivals.some((other) => rankOf(other.from) === rankOf(move.from))) origin = String(rankOf(move.from) + 1);
      else origin = name(move.from);
    }
    return kind.toUpperCase() + origin + (capture ? "x" : "") + name(move.to) + suffix;
  }

  moveSan(text) {
    const wanted = String(text).replace(/[+#!?]+$/, "");
    const match = this.moves().find((candidate) => this.san(candidate).replace(/[+#]$/, "") === wanted);
    return match ? this.move(match) : false;
  }

  history() {
    return this.#history.slice();
  }
  // </san>
}
