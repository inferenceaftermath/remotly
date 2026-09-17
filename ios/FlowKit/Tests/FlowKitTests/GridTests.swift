// Grid semantics: full vs partial frames, style caching across messages, resize, history grids.
import FlowKit
import XCTest

final class GridTests: XCTestCase {
    private func frame(_ rev: Int, full: Bool, cols: Int = 10, rows: Int = 3, lines: [WireLine], styles: [String: Style] = [:]) -> Frame {
        Frame(pane: "p", rev: rev, cols: cols, rows: rows, full: full, lines: lines, styles: styles)
    }

    func testFullFrameBlanksAbsentRows() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, lines: [
            WireLine(y: 0, runs: [WireRun(c: 0, w: 5, s: 0, t: "hello")]),
            WireLine(y: 1, runs: [WireRun(c: 2, w: 3, s: 0, t: "abc")]),
            WireLine(y: 2, runs: [WireRun(c: 0, w: 3, s: 0, t: "old")]),
        ]))
        XCTAssertEqual(grid.plainText(), "hello\n  abc\nold")
        XCTAssertEqual(grid.rev, 1)
        XCTAssertEqual(grid.pane, "p")

        let dirty = grid.apply(frame: frame(2, full: true, lines: [
            WireLine(y: 1, runs: [WireRun(c: 0, w: 3, s: 0, t: "new")]),
        ]))
        XCTAssertEqual(grid.plainText(), "\nnew\n", "rows absent from a full frame are blank")
        XCTAssertEqual(dirty, IndexSet([0, 1, 2]))
        XCTAssertEqual(grid.rev, 2)
    }

    func testSelectionTextAndWordRange() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, cols: 10, rows: 3, lines: [
            WireLine(y: 0, runs: [WireRun(c: 0, w: 9, s: 0, t: "ls -la /x")]),
            WireLine(y: 1, runs: [WireRun(c: 0, w: 2, s: 0, t: "漢"), WireRun(c: 2, w: 3, s: 0, t: "abc")]),
            WireLine(y: 2, runs: [WireRun(c: 4, w: 3, s: 0, t: "end")]),
        ]))
        // Either order, full middle rows, trailing spaces trimmed.
        XCTAssertEqual(grid.text(from: GridPosition(row: 0, col: 3), to: GridPosition(row: 2, col: 5)), "-la /x\n漢abc\n    en")
        XCTAssertEqual(grid.text(from: GridPosition(row: 2, col: 5), to: GridPosition(row: 0, col: 3)), "-la /x\n漢abc\n    en")
        // Starting on the right half of a wide character includes the character.
        XCTAssertEqual(grid.text(from: GridPosition(row: 1, col: 1), to: GridPosition(row: 1, col: 2)), "漢a")
        XCTAssertEqual(grid.text(from: GridPosition(row: 0, col: 0), to: GridPosition(row: 0, col: 1)), "ls")
        // Words are whitespace-delimited; a blank cell selects itself; wide cells count as ink.
        XCTAssertEqual(grid.wordRange(at: GridPosition(row: 0, col: 4)), GridPosition(row: 0, col: 3)...GridPosition(row: 0, col: 5))
        XCTAssertEqual(grid.wordRange(at: GridPosition(row: 0, col: 2)), GridPosition(row: 0, col: 2)...GridPosition(row: 0, col: 2))
        XCTAssertEqual(grid.wordRange(at: GridPosition(row: 1, col: 3)), GridPosition(row: 1, col: 0)...GridPosition(row: 1, col: 4))
        XCTAssertNil(grid.wordRange(at: GridPosition(row: 3, col: 0)))
        XCTAssertTrue(GridPosition(row: 0, col: 9) < GridPosition(row: 1, col: 0))
    }

    func testPartialFrameReplacesOnlyListedRows() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, lines: [
            WireLine(y: 0, runs: [WireRun(c: 0, w: 3, s: 0, t: "one")]),
            WireLine(y: 1, runs: [WireRun(c: 0, w: 3, s: 0, t: "two")]),
            WireLine(y: 2, runs: [WireRun(c: 0, w: 5, s: 0, t: "three")]),
        ]))
        let dirty = grid.apply(frame: frame(2, full: false, lines: [
            WireLine(y: 1, runs: [WireRun(c: 0, w: 3, s: 0, t: "TWO")]),
            WireLine(y: 2, runs: []),
        ]))
        XCTAssertEqual(grid.plainText(), "one\nTWO\n", "row 0 unchanged, row 1 replaced, row 2 (runs: []) blank")
        XCTAssertEqual(dirty, IndexSet([1, 2]))
        // A partial frame that re-sends identical rows dirties nothing.
        let none = grid.apply(frame: frame(3, full: false, lines: [WireLine(y: 0, runs: [WireRun(c: 0, w: 3, s: 0, t: "one")])]))
        XCTAssertTrue(none.isEmpty)
        XCTAssertEqual(grid.rev, 3)
    }

    func testPartialRowReplacesWholeRowNotJustRuns() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, lines: [WireLine(y: 0, runs: [WireRun(c: 0, w: 9, s: 0, t: "abcdefghi")])]))
        grid.apply(frame: frame(2, full: false, lines: [WireLine(y: 0, runs: [WireRun(c: 4, w: 1, s: 0, t: "X")])]))
        XCTAssertEqual(grid.rowText(0), "    X")
    }

    func testStylesAreCachedAcrossFramesAndHistory() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, lines: [WireLine(y: 0, runs: [WireRun(c: 0, w: 1, s: 1, t: "a")])],
                                styles: ["1": Style(fg: "p1", bg: "d", a: 1)]))
        // Second frame uses style 1 without re-sending it and introduces style 2.
        grid.apply(frame: frame(2, full: false, lines: [WireLine(y: 1, runs: [WireRun(c: 0, w: 1, s: 1, t: "b"), WireRun(c: 1, w: 1, s: 2, t: "c")])],
                                styles: ["2": Style(fg: "d", bg: "p27", a: 16)]))
        XCTAssertEqual(grid.style(1), Style(fg: "p1", bg: "d", a: 1))
        XCTAssertEqual(grid.style(2).attributes, .inverse)
        XCTAssertEqual(grid.style(0), .default)
        XCTAssertEqual(grid.style(99), .default, "unknown ids fall back to the default style")
        XCTAssertEqual(grid.cells[1][1].styleId, 2)

        let history = TerminalGrid(historyLines: [HistoryLine(runs: [WireRun(c: 0, w: 2, s: 2, t: "hi")]), HistoryLine(runs: [])],
                                   cols: grid.cols, styles: grid.styles)
        XCTAssertEqual(history.rows, 2)
        XCTAssertEqual(history.rowText(0), "hi")
        XCTAssertEqual(history.style(2).background, .palette(27))

        grid.resetStyles()
        XCTAssertEqual(grid.style(1), .default)
    }

    func testResizeOnFrameWithDifferentGeometryClearsAndDirtiesEverything() {
        var grid = TerminalGrid(cols: 4, rows: 2)
        grid.apply(frame: frame(1, full: true, cols: 4, rows: 2, lines: [WireLine(y: 0, runs: [WireRun(c: 0, w: 4, s: 0, t: "abcd")])]))
        let dirty = grid.apply(frame: frame(2, full: false, cols: 6, rows: 3, lines: [WireLine(y: 2, runs: [WireRun(c: 0, w: 1, s: 0, t: "z")])]))
        XCTAssertEqual(grid.cols, 6)
        XCTAssertEqual(grid.rows, 3)
        XCTAssertEqual(dirty, IndexSet(integersIn: 0..<3))
        XCTAssertEqual(grid.plainText(), "\n\nz")
        grid.resize(cols: 2, rows: 1)
        XCTAssertEqual(grid.cells, [[.blank, .blank]])
    }

    func testRunsPastColsAreClippedAndWideRunsUseTwoCells() {
        var row = Array(repeating: Cell.blank, count: 5)
        TerminalGrid.paint(runs: [
            WireRun(c: 0, w: 2, s: 3, t: "日"),
            WireRun(c: 3, w: 4, s: 0, t: "abcd"),
        ], into: &row, cols: 5)
        XCTAssertEqual(row[0], Cell(text: "日", width: 2, styleId: 3))
        XCTAssertEqual(row[1], .continuation)
        XCTAssertEqual(row[2], .blank)
        XCTAssertEqual(row[3].text, "a")
        XCTAssertEqual(row[4].text, "b")
        XCTAssertEqual(row.count, 5)
    }

    func testClearContentsKeepsStyles() {
        var grid = TerminalGrid()
        grid.apply(frame: frame(1, full: true, lines: [WireLine(y: 0, runs: [WireRun(c: 0, w: 1, s: 1, t: "a")])], styles: ["1": Style(a: 1)]))
        grid.clearContents()
        XCTAssertEqual(grid.plainText(), "\n\n")
        XCTAssertEqual(grid.style(1).attributes, .bold)
        XCTAssertNil(grid.pane)
    }

    func testLastContentRow() {
        var grid = TerminalGrid(cols: 4, rows: 5)
        XCTAssertNil(grid.lastContentRow, "an all-blank grid has no content row")
        grid.apply(frame: frame(1, full: true, cols: 4, rows: 5, lines: [WireLine(y: 1, runs: [WireRun(c: 0, w: 2, s: 0, t: "hi")])]))
        XCTAssertEqual(grid.lastContentRow, 1)
        grid.apply(frame: frame(2, full: false, cols: 4, rows: 5, lines: [WireLine(y: 3, runs: [WireRun(c: 0, w: 1, s: 7, t: " ")])]))
        XCTAssertEqual(grid.lastContentRow, 3, "a styled blank (a status bar) is content")
    }
}
