// Row-shift detection: a frame that is the previous screen scrolled by whole rows, with or without fixed chrome.
import FlowKit
import XCTest

private let chrome = ["────────────────────", "❯ type a message", "? for shortcuts"]
private func transcript(_ from: Int, _ count: Int) -> [String] { (from..<(from + count)).map { "line \($0) of the transcript" } }
private func edited(_ rows: [String], row: Int) -> [String] { var r = rows; r[row] = "something else entirely"; return r }
private func sparse(_ texts: [String], at rows: [Int], height: Int = 20) -> [String] {
    var r = Array(repeating: "", count: height)
    for (t, y) in zip(texts, rows) { r[y] = t }
    return r
}
private func grid(_ rows: [String], cols: Int = 24) -> TerminalGrid {
    var g = TerminalGrid(cols: cols, rows: rows.count)
    let lines = rows.enumerated().compactMap { y, text -> WireLine? in
        text.isEmpty ? nil : WireLine(y: y, runs: [WireRun(c: 0, w: text.count, s: 0, t: text)])
    }
    _ = g.apply(frame: Frame(pane: "p", rev: 1, cols: cols, rows: rows.count, full: true, lines: lines))
    return g
}

final class RowShiftTests: XCTestCase {
    func test_scrollUpKeepsChromeStill() {
        XCTAssertEqual(RowShift.detect(from: grid(transcript(0, 17) + chrome), to: grid(transcript(2, 17) + chrome)), RowShift(shift: 2, movingRows: 17))
    }

    func test_scrollDownKeepsChromeStill() {
        XCTAssertEqual(RowShift.detect(from: grid(transcript(2, 17) + chrome), to: grid(transcript(0, 17) + chrome)), RowShift(shift: -2, movingRows: 17))
    }

    func test_fullScreenScrollMovesEveryRow() {
        XCTAssertEqual(RowShift.detect(from: grid(transcript(0, 20)), to: grid(transcript(3, 20))), RowShift(shift: 3, movingRows: 20))
    }

    func test_editedRowIsNotAScroll() {
        XCTAssertNil(RowShift.detect(from: grid(transcript(0, 20)), to: grid(edited(transcript(0, 20), row: 5))))
    }

    func test_identicalScreensAreNotAScroll() {
        XCTAssertNil(RowShift.detect(from: grid(transcript(0, 20)), to: grid(transcript(0, 20))))
    }

    func test_repeatedRowsDoNotCount() {
        XCTAssertNil(RowShift.detect(from: grid(Array(repeating: "same", count: 19) + ["a"]), to: grid(Array(repeating: "same", count: 19) + ["b"])))
    }

    func test_twoInkedRowsAreNotEnough() {
        XCTAssertNil(RowShift.detect(from: grid(sparse(["alpha", "beta"], at: [3, 5])), to: grid(sparse(["alpha", "beta"], at: [2, 4]))))
    }

    func test_differentSizesNeverMatch() {
        XCTAssertNil(RowShift.detect(from: grid(transcript(0, 20)), to: grid(transcript(2, 19))))
        XCTAssertNil(RowShift.detect(from: grid(transcript(0, 20), cols: 30), to: grid(transcript(2, 20))))
    }

    func test_sparseScreenWithThreeInkedRows() {
        let shift = RowShift.detect(from: grid(sparse(["alpha", "beta", "gamma"], at: [3, 5, 7])), to: grid(sparse(["alpha", "beta", "gamma"], at: [2, 4, 6])))
        XCTAssertEqual(shift?.shift, 1)
        XCTAssertGreaterThanOrEqual(shift?.movingRows ?? 0, 7)
    }
}
