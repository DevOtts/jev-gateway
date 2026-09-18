
## Standard Algebraic Notation

| Member | Returns |
| --- | --- |
| `san(uci)` | The SAN of a legal move in the current position. Throws an Error if the move is not legal |
| `moveSan(san)` | Plays the move written in SAN. `true` if it was legal, otherwise `false` and nothing changes |
| `history()` | The SAN of every move played so far on this object, however it was played |

- Piece letters are `K Q R B N`. Pawn moves have none: `e4`. Captures use `x`: `Nxb5`. A pawn
  capture starts with the pawn's file: `exd5`, and en passant is written the same way.
- Castling is `O-O` and `O-O-O`, with capital letter O.
- Promotion is `=` and the piece: `e8=Q`, `axb8=N`.
- Append `+` for check and `#` for checkmate.
- **Disambiguation:** when another piece of the same kind could also legally move to the target,
  add the origin file (`Nbd7`). If the file does not tell them apart, add the rank (`R1a4`). If
  neither does, add both (`Qh4e1`). Pieces that cannot legally make the move, for example because
  they are pinned, do not count.
- `moveSan` ignores a trailing `+`, `#`, `!` or `?`.
