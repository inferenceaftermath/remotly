// Recognises a frame that is the previous screen scrolled by whole rows: an alternate-screen program
// (Claude Code, less, vim) redrawing after a wheel report. The terminal view then slides the picture
// into place instead of jumping. Only the rows above the program's fixed chrome (input box, status
// line) move, so the match reports where it stops (`movingRows`).
import Foundation

public struct RowShift: Hashable, Sendable {
    /// Rows the content moved: positive = up (new row r shows what old row r+shift showed), negative = down.
    public var shift: Int
    /// The top `movingRows` rows took part; the rows below stayed where they were.
    public var movingRows: Int

    public init(shift: Int, movingRows: Int) {
        self.shift = shift
        self.movingRows = movingRows
    }

    /// The shift that explains most of the change from `old` to `new`, or nil when the frame is not a scroll
    /// (same size required; at least three inked rows must line up, of at least two different kinds, and
    /// the moving region must have changed at all).
    public static func detect(from old: TerminalGrid, to new: TerminalGrid) -> RowShift? {
        let rows = new.rows
        guard rows >= 4, old.rows == rows, old.cols == new.cols else { return nil }
        let oldHash = old.cells.map(rowHash)
        let newHash = new.cells.map(rowHash)
        guard oldHash != newHash else { return nil }
        let blank = new.cells.map { row in row.allSatisfy(\.isBlank) }
        var best: (shift: Int, moving: Int, inked: Int)?
        for k in 1...(rows - 3) {
            for sign in [1, -1] {
                // Content moved up by k: new[r] == old[r + k]; down: new[r] == old[r - k].
                let range = sign > 0 ? 0..<(rows - k) : k..<rows
                var matched = 0
                var inked = 0
                var last = -1
                var kinds = Set<Int>()
                for r in range where newHash[r] == oldHash[r + k * sign] {
                    matched += 1
                    last = r
                    if !blank[r] {
                        inked += 1
                        kinds.insert(newHash[r])
                    }
                }
                var moving = last + 1
                let overlap = sign > 0 ? moving : moving - k
                guard inked >= 3, kinds.count >= 2, overlap >= 3, matched * 5 >= overlap * 3 else { continue }
                if sign > 0 {
                    // The (changed) rows right below the matched run scrolled in from under the region's bottom edge.
                    var extra = 0
                    while extra < k, moving < rows, newHash[moving] != oldHash[moving] {
                        moving += 1
                        extra += 1
                    }
                }
                guard (0..<moving).contains(where: { newHash[$0] != oldHash[$0] }) else { continue } // nothing scrolled
                if best == nil || inked > best!.inked { best = (k * sign, moving, inked) } // ties: the smaller shift (k ascends)
            }
        }
        guard let b = best else { return nil }
        return RowShift(shift: b.shift, movingRows: b.moving)
    }

    private static func rowHash(_ row: [Cell]) -> Int {
        var hasher = Hasher()
        hasher.combine(row)
        return hasher.finalize()
    }
}
