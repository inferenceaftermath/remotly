// Client-side terminal grid fed by `frame` messages (shared/protocol/remotly-protocol.md §7).
//
// Rendering rules: a run covers `w` cells from column `c`; narrow runs hold one grapheme per cell,
// a wide grapheme is one run with `w == 2` (its second cell is a continuation); default-styled
// trailing blanks are trimmed by the bridge, so untouched cells are blank. Rows absent from a
// `full` frame are blank; rows absent from a partial frame are unchanged.
import Foundation

public struct Cell: Hashable, Sendable {
    public var text: String
    /// 1 for a narrow cell, 2 for the first cell of a wide grapheme, 0 for a continuation cell.
    public var width: Int
    public var styleId: Int

    public init(text: String, width: Int, styleId: Int) {
        self.text = text
        self.width = width
        self.styleId = styleId
    }

    public static let blank = Cell(text: " ", width: 1, styleId: 0)
    public static let continuation = Cell(text: "", width: 0, styleId: 0)
    public var isBlank: Bool { width == 1 && text == " " && styleId == 0 }
}

public struct TerminalGrid: Hashable, Sendable {
    public private(set) var cols: Int
    public private(set) var rows: Int
    /// `rows` arrays of exactly `cols` cells.
    public private(set) var cells: [[Cell]]
    /// Per-connection style cache; id 0 is the implicit default and never stored.
    public private(set) var styles: [Int: Style]
    public private(set) var rev: Int
    public private(set) var pane: String?

    public init(cols: Int = 80, rows: Int = 24, styles: [Int: Style] = [:]) {
        self.cols = max(cols, 1)
        self.rows = max(rows, 0)
        self.cells = Array(repeating: Array(repeating: .blank, count: self.cols), count: self.rows)
        self.styles = styles
        self.rev = 0
        self.pane = nil
    }

    /// A grid holding `history` lines (one row per line) that shares the connection's style cache.
    public init(historyLines: [HistoryLine], cols: Int, styles: [Int: Style]) {
        self.init(cols: cols, rows: historyLines.count, styles: styles)
        let width = self.cols // read before the inout access to `cells` below (exclusivity)
        for (y, line) in historyLines.enumerated() {
            TerminalGrid.paint(runs: line.runs, into: &cells[y], cols: width)
        }
    }

    // MARK: Styles

    public func style(_ id: Int) -> Style {
        if id == 0 { return .default }
        return styles[id] ?? .default
    }

    /// Adds the styles of a `frame` or `history` message (keys are strings on the wire).
    public mutating func mergeStyles(_ wire: [String: Style]) {
        for (key, style) in wire {
            if let id = Int(key), id != 0 { styles[id] = style }
        }
    }

    /// Style ids start over on every new socket.
    public mutating func resetStyles() {
        styles.removeAll()
    }

    // MARK: Geometry and content

    /// Changes the size; contents are dropped (the bridge always follows a resize with a full frame).
    public mutating func resize(cols newCols: Int, rows newRows: Int) {
        let c = max(newCols, 1)
        let r = max(newRows, 0)
        guard c != cols || r != rows else { return }
        cols = c
        rows = r
        cells = Array(repeating: Array(repeating: .blank, count: c), count: r)
    }

    /// Blanks every row but keeps the style cache and size (used when switching panes).
    public mutating func clearContents() {
        cells = Array(repeating: Array(repeating: .blank, count: cols), count: rows)
        rev = 0
        pane = nil
    }

    /// Applies a frame and returns the rows whose cells changed.
    @discardableResult
    public mutating func apply(frame: Frame) -> IndexSet {
        var dirty = IndexSet()
        if frame.cols != cols || frame.rows != rows {
            resize(cols: frame.cols, rows: frame.rows)
            if rows > 0 { dirty.insert(integersIn: 0..<rows) }
        }
        mergeStyles(frame.styles)
        let blankRow = Array(repeating: Cell.blank, count: cols)

        if frame.full {
            var byRow: [Int: [WireRun]] = [:]
            for line in frame.lines where line.y >= 0 && line.y < rows { byRow[line.y] = line.runs }
            for y in 0..<rows {
                var row = blankRow
                if let runs = byRow[y] { TerminalGrid.paint(runs: runs, into: &row, cols: cols) }
                if row != cells[y] {
                    cells[y] = row
                    dirty.insert(y)
                }
            }
        } else {
            for line in frame.lines where line.y >= 0 && line.y < rows {
                var row = blankRow
                TerminalGrid.paint(runs: line.runs, into: &row, cols: cols)
                if row != cells[line.y] {
                    cells[line.y] = row
                    dirty.insert(line.y)
                }
            }
        }
        rev = frame.rev
        pane = frame.pane
        return dirty
    }

    /// Paints runs into a row of `cols` cells. Runs past `cols` are clipped.
    public static func paint(runs: [WireRun], into row: inout [Cell], cols: Int) {
        for run in runs {
            guard run.w > 0, run.c >= 0, run.c < cols else { continue }
            let end = min(run.c + run.w, cols)
            let graphemes = Array(run.t)
            if graphemes.count == run.w {
                // Narrow run: one grapheme (Character = extended grapheme cluster) per cell.
                for (i, g) in graphemes.enumerated() where run.c + i < end {
                    row[run.c + i] = Cell(text: String(g), width: 1, styleId: run.s)
                }
            } else {
                // Wide grapheme (w == 2), or a run whose cell count does not match its graphemes:
                // keep the whole text in the first cell so nothing is lost.
                row[run.c] = Cell(text: run.t, width: end - run.c, styleId: run.s)
                var x = run.c + 1
                while x < end {
                    row[x] = .continuation
                    x += 1
                }
            }
        }
    }

    // MARK: Text

    /// Row text with trailing spaces trimmed (continuation cells contribute nothing).
    public func rowText(_ y: Int) -> String {
        guard y >= 0, y < rows else { return "" }
        var text = ""
        for cell in cells[y] where cell.width > 0 { text += cell.text }
        while text.hasSuffix(" ") { text.removeLast() }
        return text
    }

    /// One line per row (`rows` lines), each trimmed of trailing spaces, joined by `\n`.
    public func plainText() -> String {
        (0..<rows).map(rowText).joined(separator: "\n")
    }

    /// Index of the last row holding anything but default blanks (a styled blank, e.g. a status bar, counts); nil when the grid is empty.
    public var lastContentRow: Int? {
        cells.lastIndex { row in row.contains { !$0.isBlank } }
    }

    // MARK: Selection

    /// Text of the cells from `a` to `b` inclusive (either order) in reading order: full rows in
    /// between, trailing spaces trimmed per row, rows joined by `\n`. A position on the right half
    /// of a wide character selects the whole character.
    public func text(from a: GridPosition, to b: GridPosition) -> String {
        guard rows > 0, cols > 0 else { return "" }
        let (start, end) = a <= b ? (clamp(a), clamp(b)) : (clamp(b), clamp(a))
        var lines: [String] = []
        for y in start.row...end.row {
            let row = cells[y]
            var from = y == start.row ? start.col : 0
            let to = y == end.row ? end.col : cols - 1
            if from > 0, row[from].width == 0 { from -= 1 }
            var text = ""
            for x in from...max(from, to) where row[x].width > 0 { text += row[x].text }
            while text.hasSuffix(" ") { text.removeLast() }
            lines.append(text)
        }
        return lines.joined(separator: "\n")
    }

    /// The whitespace-delimited word around `p` (a blank cell selects just itself); nil off the grid.
    public func wordRange(at p: GridPosition) -> ClosedRange<GridPosition>? {
        guard p.row >= 0, p.row < rows, p.col >= 0, p.col < cols else { return nil }
        let row = cells[p.row]
        func isInk(_ x: Int) -> Bool { row[x].width == 0 || (row[x].text != " " && !row[x].text.isEmpty) }
        guard isInk(p.col) else { return GridPosition(row: p.row, col: p.col)...GridPosition(row: p.row, col: p.col) }
        var from = p.col
        while from > 0, isInk(from - 1) { from -= 1 }
        var to = p.col
        while to + 1 < cols, isInk(to + 1) { to += 1 }
        return GridPosition(row: p.row, col: from)...GridPosition(row: p.row, col: to)
    }

    private func clamp(_ p: GridPosition) -> GridPosition {
        GridPosition(row: min(max(p.row, 0), rows - 1), col: min(max(p.col, 0), cols - 1))
    }

    /// Like `plainText()` but without trailing blank rows and with a trailing newline, matching
    /// the golden `.txt` fixtures in `shared/fixtures/frames/`.
    public func fixtureText() -> String {
        var lines = (0..<rows).map(rowText)
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        return lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
    }
}

/// A cell address; ordered by row, then column (reading order).
public struct GridPosition: Hashable, Comparable, Sendable {
    public var row: Int
    public var col: Int
    public init(row: Int, col: Int) {
        self.row = row
        self.col = col
    }
    public static func < (lhs: GridPosition, rhs: GridPosition) -> Bool {
        lhs.row != rhs.row ? lhs.row < rhs.row : lhs.col < rhs.col
    }
}
