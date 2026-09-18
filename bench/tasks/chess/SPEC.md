# Chess rules engine

`src/chess.js` is an ES module with no dependencies. It exports one class:

```js
import { Chess } from "./src/chess.js";

const game = new Chess();          // standard starting position
const other = new Chess(fen);      // any position; throws an Error if the FEN is invalid
```

| Member | Returns |
| --- | --- |
| `fen()` | The position as a FEN string with all six fields |
| `turn()` | `"w"` or `"b"` |
| `moves()` | Every legal move, as UCI strings, in any order |
| `move(uci)` | `true` after playing a legal move. `false`, leaving the position untouched, for anything else |
| `isCheck()` | Is the side to move in check? |
| `isCheckmate()` | In check with no legal move |
| `isStalemate()` | Not in check, with no legal move |
| `isInsufficientMaterial()` | Neither side can ever mate: king v king, king and one minor piece v king, or only bishops that all stand on the same colour of square |
| `isThreefoldRepetition()` | The current position has now occurred three times in this game |
| `isDraw()` | Stalemate, insufficient material, threefold repetition, or 100 half-moves without a pawn move or capture |
| `isGameOver()` | Checkmate or draw |

Details that are easy to get wrong:

- **UCI moves** are the origin and target squares, plus the promotion piece in lower case:
  `e2e4`, `e7e8q`, `a7b8n`. Castling is the king's move: `e1g1`, `e1c1`, `e8g8`, `e8c8`.
- **All the rules count:** pins, check evasion, castling (not out of, through, or into check; the
  squares between king and rook must be empty), en passant, and promotion to queen, rook, bishop or
  knight.
- **FEN en passant field:** set to the square behind the pawn after every double pawn push, whether
  or not an enemy pawn can capture there. `-` otherwise.
- **FEN castling field:** a right is lost when its king or rook moves, and when its rook is
  captured on its home square. `-` when nobody has any.
- **FEN counters:** the half-move clock resets on pawn moves and captures. The full-move number
  starts at 1 and goes up after Black moves.
- **Invalid FEN** includes: not six fields, not eight ranks, a rank that does not add up to eight
  squares, an unknown piece letter, a side to move other than `w` or `b`, and a side without exactly
  one king.
- **Repetition:** two positions are the same when the first four FEN fields match.
