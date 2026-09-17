// Golden frames: every shared/fixtures/frames/<name>.frame.json painted into a grid must render
// exactly <name>.txt (README in that directory). Skips cleanly when the fixtures are not present.
import FlowKit
import XCTest

final class GridFixtureTests: XCTestCase {
    /// ios/FlowKit/Tests/FlowKitTests/<file> → repo root → shared/fixtures/frames
    static let fixturesURL: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appending(path: "shared/fixtures/frames")
    }()

    private func fixtureNames() throws -> [String] {
        let dir = GridFixtureTests.fixturesURL
        guard FileManager.default.fileExists(atPath: dir.path) else {
            throw XCTSkip("fixture directory missing: \(dir.path)")
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".frame.json") }
            .map { String($0.dropLast(".frame.json".count)) }
            .sorted()
        if names.isEmpty { throw XCTSkip("no fixtures in \(dir.path)") }
        return names
    }

    private func load(_ name: String) throws -> (Frame, String) {
        let dir = GridFixtureTests.fixturesURL
        let frameData = try Data(contentsOf: dir.appending(path: "\(name).frame.json"))
        guard case .frame(let frame) = try ServerMessage.decode(frameData) else {
            throw XCTSkip("\(name).frame.json is not a frame message")
        }
        let text = try String(contentsOf: dir.appending(path: "\(name).txt"), encoding: .utf8)
        return (frame, text)
    }

    private func trimmedLines(_ text: String) -> [String] {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        return lines
    }

    func testEveryFixtureRendersItsGoldenText() throws {
        for name in try fixtureNames() {
            let (frame, expected) = try load(name)
            var grid = TerminalGrid()
            let dirty = grid.apply(frame: frame)
            XCTAssertEqual(grid.cols, frame.cols, name)
            XCTAssertEqual(grid.rows, frame.rows, name)
            XCTAssertEqual(trimmedLines(grid.plainText()), trimmedLines(expected), "plain text mismatch in \(name)")
            XCTAssertEqual(trimmedLines(grid.fixtureText()), trimmedLines(expected), "fixtureText mismatch in \(name)")
            XCTAssertFalse(dirty.isEmpty, "\(name): a full frame with content must dirty rows")
        }
    }

    func testFixtureInvariants() throws {
        for name in try fixtureNames() {
            let (frame, _) = try load(name)
            XCTAssertTrue(frame.full, "\(name): watch-start frames are full")
            var seen = Set<Int>()
            for line in frame.lines {
                XCTAssertTrue(seen.insert(line.y).inserted, "\(name): duplicate row \(line.y)")
                XCTAssertTrue((0..<frame.rows).contains(line.y), "\(name): row \(line.y) outside grid")
                var cursor = 0
                for run in line.runs {
                    XCTAssertGreaterThanOrEqual(run.c, cursor, "\(name) y=\(line.y): runs must be ordered and non-overlapping")
                    XCTAssertLessThanOrEqual(run.c + run.w, frame.cols, "\(name) y=\(line.y): run past cols")
                    if run.w == 2, run.t.count == 1 {
                        // one wide grapheme
                    } else {
                        XCTAssertEqual(run.t.count, run.w, "\(name) y=\(line.y) c=\(run.c): narrow run must have one grapheme per cell: \(run.t)")
                    }
                    if run.s != 0 {
                        XCTAssertNotNil(frame.styles[String(run.s)], "\(name): style \(run.s) missing from a fresh-connection frame")
                    }
                    cursor = run.c + run.w
                }
            }
        }
    }

    func testWideGraphemesOccupyTwoCells() throws {
        let names = try fixtureNames()
        guard names.contains("unicode-styles") else { throw XCTSkip("unicode-styles fixture missing") }
        let (frame, _) = try load("unicode-styles")
        var grid = TerminalGrid()
        grid.apply(frame: frame)
        // Row 1 starts with 日本語: each is one cell of width 2 followed by a continuation cell.
        XCTAssertEqual(grid.cells[1][0], Cell(text: "日", width: 2, styleId: 0))
        XCTAssertEqual(grid.cells[1][1], .continuation)
        XCTAssertEqual(grid.cells[1][2].text, "本")
        // Row 6 keeps styled trailing blanks (blue background).
        XCTAssertEqual(grid.cells[6][28].styleId, 10)
        XCTAssertEqual(grid.style(10).background, .palette(4))
        // Row 7: combining marks stay attached to their base character (one cell each).
        XCTAssertEqual(grid.cells[7][11].text, "e\u{0301}")
        XCTAssertEqual(grid.cells[7][12].text, " ")
    }
}
