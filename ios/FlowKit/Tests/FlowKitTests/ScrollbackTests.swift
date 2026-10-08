// The scrollback mirror (shared/protocol/remotly-protocol.md §4/§6 `scrollback`): the wire messages, the phone's copy of
// a pane's lines, and the wrapping of those lines to the live grid's width.
import FlowKit
import XCTest

final class ScrollbackTests: XCTestCase {
    // MARK: Helpers

    private func run(_ text: String, c: Int = 0, w: Int? = nil, s: Int = 0) -> WireRun {
        WireRun(c: c, w: w ?? text.count, s: s, t: text)
    }

    private func line(_ text: String) -> HistoryLine {
        HistoryLine(runs: text.isEmpty ? [] : [run(text)])
    }

    private func message(epoch: String = "e1", start: Int, _ texts: [String], reset: Bool = false) -> ScrollbackMessage {
        ScrollbackMessage(pane: "p", epoch: epoch, start: start, lines: texts.map { line($0) }, reset: reset)
    }

    private func texts(_ store: ScrollbackStore) -> [String] {
        store.lines.map { $0.map(\.t).joined() }
    }

    private func numbered(_ from: Int, _ count: Int) -> [String] {
        (from..<(from + count)).map { "L\($0)" }
    }

    /// Every row of the copy, made one by one.
    private func allRows(_ wrapped: WrappedHistory) -> [[WireRun]] {
        (0..<wrapped.rowCount).map { wrapped.row($0) }
    }

    /// Rows of each line held, oldest first.
    private func rowCounts(_ wrapped: WrappedHistory) -> [Int] {
        (wrapped.firstLine..<(wrapped.firstLine + wrapped.lineCount)).map { wrapped.rowCount(ofLine: $0) }
    }

    /// Each row's text with its runs' columns checked to be contiguous from 0.
    private func rowTexts(_ rows: [[WireRun]], file: StaticString = #filePath, line: UInt = #line) -> [String] {
        rows.map { row in
            var x = 0
            var text = ""
            for r in row {
                XCTAssertGreaterThanOrEqual(r.c, x, "runs overlap", file: file, line: line)
                text += String(repeating: " ", count: r.c - x) + r.t
                x = r.c + r.w
            }
            return text
        }
    }

    // MARK: Wire

    func testDecodeScrollbackAndItsOK() throws {
        let json = #"""
        {"t":"scrollback","pane":"pane_7","epoch":"9c1e04a2b7f3","start":0,"reset":true,
         "lines":[{"runs":[{"c":0,"w":1,"s":1,"t":"$"},{"c":2,"w":8,"s":0,"t":"npm test"}]},{"runs":[]},
                  {"runs":[{"c":0,"w":11,"s":3,"t":"433 passing"}]}],
         "styles":{"3":{"fg":"p2","bg":"d","a":0}}}
        """#
        guard case .scrollback(let m) = try ServerMessage.decode(Data(json.utf8)) else { return XCTFail("expected scrollback") }
        XCTAssertEqual(m.pane, "pane_7")
        XCTAssertEqual(m.epoch, "9c1e04a2b7f3")
        XCTAssertEqual(m.start, 0)
        XCTAssertTrue(m.reset)
        XCTAssertEqual(m.lines.count, 3)
        XCTAssertEqual(m.lines[0].runs, [WireRun(c: 0, w: 1, s: 1, t: "$"), WireRun(c: 2, w: 8, s: 0, t: "npm test")])
        XCTAssertEqual(m.lines[1].runs, [])
        XCTAssertEqual(m.styles["3"]?.foreground, .palette(2))

        let push = #"{"t":"scrollback","pane":"pane_7","epoch":"9c1e04a2b7f3","start":3,"lines":[{"runs":[{"c":0,"w":1,"s":1,"t":"$"}]}],"styles":{}}"#
        guard case .scrollback(let p) = try ServerMessage.decode(Data(push.utf8)) else { return XCTFail("expected scrollback") }
        XCTAssertFalse(p.reset, "absent reset continues the copy")
        XCTAssertEqual(p.start, 3)

        let ok = #"{"t":"ok","id":"4","epoch":"9c1e04a2b7f3","next":3,"max_lines":10000}"#
        guard case .ok(let o) = try ServerMessage.decode(Data(ok.utf8)) else { return XCTFail("expected ok") }
        XCTAssertEqual(o.id, "4")
        XCTAssertEqual(o.epoch, "9c1e04a2b7f3")
        XCTAssertEqual(o.next, 3)
        XCTAssertEqual(o.maxLines, 10000)

        guard case .ok(let plain) = try ServerMessage.decode(Data(#"{"t":"ok","id":"5"}"#.utf8)) else { return XCTFail("expected ok") }
        XCTAssertNil(plain.epoch)
        XCTAssertNil(plain.next)
        XCTAssertNil(plain.maxLines)
    }

    func testEncodeScrollbackRequest() throws {
        func object(_ message: ClientMessage) throws -> [String: Any] {
            try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(message.encoded().utf8)) as? [String: Any])
        }
        let first = try object(.scrollback(id: "4", pane: "pane_7", epoch: nil, from: nil))
        XCTAssertEqual(first["t"] as? String, "scrollback")
        XCTAssertEqual(first["id"] as? String, "4")
        XCTAssertEqual(first["pane"] as? String, "pane_7")
        XCTAssertNil(first["epoch"])
        XCTAssertNil(first["from"])
        let resume = try object(.scrollback(id: "9", pane: "pane_7", epoch: "9c1e04a2b7f3", from: 4))
        XCTAssertEqual(resume["epoch"] as? String, "9c1e04a2b7f3")
        XCTAssertEqual(resume["from"] as? Int, 4)
    }

    // MARK: Store

    func testResetReplacesEverythingAndKeepsTheNewestMaxLines() {
        var store = ScrollbackStore(maxLines: 5)
        XCTAssertEqual(store.apply(message(start: 0, numbered(0, 3), reset: true)), .reset)
        XCTAssertEqual(store.epoch, "e1")
        XCTAssertEqual(store.next, 3)
        XCTAssertEqual(store.apply(message(epoch: "e2", start: 10, numbered(10, 8), reset: true)), .reset)
        XCTAssertEqual(store.epoch, "e2")
        XCTAssertEqual(store.base, 13)
        XCTAssertEqual(store.next, 18)
        XCTAssertEqual(texts(store), numbered(13, 5))
    }

    func testOverlapIsSkippedAndOnlyNewLinesAppended() {
        var store = ScrollbackStore()
        _ = store.apply(message(start: 0, numbered(0, 4), reset: true))
        XCTAssertEqual(store.apply(message(start: 2, numbered(2, 5))), .changed(appended: 3, dropped: 0))
        XCTAssertEqual(texts(store), numbered(0, 7))
        XCTAssertEqual(store.apply(message(start: 3, numbered(3, 4))), .changed(appended: 0, dropped: 0), "all held already")
        XCTAssertEqual(store.apply(message(start: 7, [])), .changed(appended: 0, dropped: 0))
        XCTAssertEqual(store.next, 7)
    }

    func testEpochMismatchOrGapAsksForResync() {
        var store = ScrollbackStore()
        XCTAssertEqual(store.apply(message(start: 0, ["a"])), .resync, "no copy yet: only a reset can start one")
        _ = store.apply(message(start: 0, numbered(0, 3), reset: true))
        XCTAssertEqual(store.apply(message(epoch: "other", start: 3, ["x"])), .resync)
        XCTAssertEqual(store.apply(message(start: 4, ["x"])), .resync, "line 3 was missed")
        XCTAssertEqual(texts(store), numbered(0, 3), "a resync changes nothing")
        XCTAssertEqual(store.apply(message(start: 3, ["L3"])), .changed(appended: 1, dropped: 0))
    }

    func testMaxLinesDropsTheOldest() {
        var store = ScrollbackStore(maxLines: 4)
        _ = store.apply(message(start: 0, numbered(0, 3), reset: true))
        XCTAssertEqual(store.apply(message(start: 3, numbered(3, 3))), .changed(appended: 3, dropped: 2))
        XCTAssertEqual(texts(store), numbered(2, 4))
        XCTAssertEqual(store.base, 2)
        XCTAssertEqual(store.next, 6)
        // more new lines than fit: every old one goes and only the newest new ones stay
        XCTAssertEqual(store.apply(message(start: 6, numbered(6, 6))), .changed(appended: 4, dropped: 4))
        XCTAssertEqual(texts(store), numbered(8, 4))
        XCTAssertEqual(store.next, 12)
        XCTAssertEqual(store.setMaxLines(2), 2)
        XCTAssertEqual(texts(store), numbered(10, 2))
        XCTAssertEqual(store.next, 12)
    }

    func testAnAnswerLargerThanTheLastLimitIsKeptUntilItsOK() {
        // the bridge keeps 50 000 lines; the store last heard 10 000 (another bridge, or a smaller setting then)
        var store = ScrollbackStore(maxLines: 10_000)
        store.raiseMaxLinesForAnswer()
        XCTAssertEqual(store.apply(message(start: 0, numbered(0, 8_000), reset: true)), .reset)
        XCTAssertEqual(store.apply(message(start: 8_000, numbered(8_000, 8_000))), .changed(appended: 8_000, dropped: 0))
        XCTAssertEqual(store.setMaxLines(50_000), 0)
        XCTAssertEqual(store.base, 0)
        XCTAssertEqual(store.next, 16_000)
        XCTAssertTrue(store.agrees(epoch: "e1", next: 16_000))
    }

    func testOKMustDescribeTheCopy() {
        var store = ScrollbackStore()
        _ = store.apply(message(start: 5, numbered(5, 3), reset: true))
        XCTAssertTrue(store.agrees(epoch: "e1", next: 8))
        XCTAssertFalse(store.agrees(epoch: "e1", next: 9), "lines missing")
        XCTAssertFalse(store.agrees(epoch: "e2", next: 8), "the copy restarted")
        XCTAssertTrue(store.agrees(epoch: nil, next: nil), "absent fields do not disagree")
    }

    func testStoresKeepTheEightMostRecentPanes() {
        var stores = ScrollbackStores()
        for i in 0..<9 {
            _ = stores.update("p\(i)") { $0.apply(ScrollbackMessage(pane: "p\(i)", epoch: "e", start: 0, lines: [line("x")], reset: true)) }
        }
        XCTAssertNil(stores["p0"])
        XCTAssertNotNil(stores["p1"])
        _ = stores.update("p1") { $0.next } // used again: now the most recent
        _ = stores.update("p9") { $0.next }
        XCTAssertNotNil(stores["p1"])
        XCTAssertNil(stores["p2"])
        XCTAssertEqual(stores.panes.count, 8)
        stores.removeAll()
        XCTAssertNil(stores["p1"])
    }

    func testPastTheLineBudgetThePanesUsedLongestAgoGiveWay() {
        var stores = ScrollbackStores(capacity: 8, lineBudget: 10)
        func lines(_ prefix: String, _ from: Int, _ count: Int) -> [HistoryLine] { (from..<(from + count)).map { line("\(prefix)\($0)") } }
        _ = stores.update("a") { $0.apply(ScrollbackMessage(pane: "a", epoch: "e", start: 0, lines: lines("a", 0, 6), reset: true)) }
        _ = stores.update("b") { $0.apply(ScrollbackMessage(pane: "b", epoch: "e", start: 0, lines: lines("b", 0, 3), reset: true)) }
        XCTAssertNotNil(stores["a"], "9 lines together: within the budget")
        _ = stores.update("c") { $0.apply(ScrollbackMessage(pane: "c", epoch: "e", start: 0, lines: lines("c", 0, 4), reset: true)) }
        XCTAssertNil(stores["a"], "13 lines: the pane used longest ago goes")
        XCTAssertNotNil(stores["b"])
        _ = stores.update("c") { $0.apply(ScrollbackMessage(pane: "c", epoch: "e", start: 4, lines: lines("c", 4, 20), reset: false)) }
        XCTAssertEqual(stores.panes, ["c"], "the pane in use stays, even past the budget alone")
        XCTAssertEqual(stores["c"]?.lines.count, 24)
    }

    func testHistoryStylesOutliveTheConnectionsIds() {
        var styles = HistoryStyles()
        let red = Style(fg: "p1")
        let bold = Style(a: 1)
        let first = styles.localize([run("a", s: 3), run("b", c: 1, s: 0)]) { $0 == 3 ? red : Style.default }
        // the next connection numbers the same style differently
        let second = styles.localize([run("c", s: 1), run("d", c: 1, s: 2)]) { $0 == 1 ? red : bold }
        XCTAssertEqual(first[0].s, second[0].s)
        XCTAssertEqual(first[1].s, 0, "the default style stays 0")
        XCTAssertEqual(styles.style(first[0].s), red)
        XCTAssertEqual(styles.style(second[1].s), bold)
    }

    // MARK: Wrapping

    func testNarrowRunsSplitAtTheRowEdge() {
        let rows = ScrollbackWrap.rows([run("abcdef", s: 1), run("ghij", c: 6, s: 2)], cols: 4)
        XCTAssertEqual(rowTexts(rows), ["abcd", "efgh", "ij"])
        XCTAssertEqual(rows[1], [WireRun(c: 0, w: 2, s: 1, t: "ef"), WireRun(c: 2, w: 2, s: 2, t: "gh")])
        XCTAssertEqual(ScrollbackWrap.rows([run("abcd")], cols: 4).count, 1, "a line that fills the row exactly adds no blank row")
        XCTAssertEqual(rowTexts(ScrollbackWrap.rows([run("$"), run("npm test", c: 2)], cols: 6)), ["$ npm ", "test"], "gaps are blank cells")
    }

    func testWideCharacterThatDoesNotFitMovesDown() {
        let rows = ScrollbackWrap.rows([run("abc"), WireRun(c: 3, w: 2, s: 0, t: "日"), run("d", c: 5)], cols: 4)
        XCTAssertEqual(rowTexts(rows), ["abc", "日d"])
        XCTAssertEqual(rows[1].first, WireRun(c: 0, w: 2, s: 0, t: "日"))
        XCTAssertEqual(rows[1].last, WireRun(c: 2, w: 1, s: 0, t: "d"))
    }

    func testEmptyLineIsOneBlankRow() {
        XCTAssertEqual(ScrollbackWrap.rows([], cols: 10), [[]])
    }

    func testCombiningCharacterStaysWithItsBase() {
        // "e" + COMBINING ACUTE ACCENT is one Character and one cell
        let rows = ScrollbackWrap.rows([run("abce\u{301}fg", w: 6)], cols: 4)
        XCTAssertEqual(rows.map { $0.map(\.t) }, [["abce\u{301}"], ["fg"]])
        XCTAssertEqual(rows[0][0].w, 4)
    }

    func testWrappedHistoryFollowsTheStoreAndRewrapsOnAWidthChange() {
        var store = ScrollbackStore(maxLines: 3)
        var wrapped = WrappedHistory(cols: 4)
        _ = store.apply(message(start: 0, ["abcdef", "", "xy"], reset: true))
        wrapped.reset(from: store, cols: 4)
        let generation = wrapped.generation
        XCTAssertEqual(rowTexts(allRows(wrapped)), ["abcd", "ef", "", "xy"])
        XCTAssertEqual(rowCounts(wrapped), [2, 1, 1])
        XCTAssertEqual(wrapped.line(atRow: 1)?.line, 0)
        XCTAssertEqual(wrapped.line(atRow: 1)?.rowInLine, 1)
        XCTAssertEqual(wrapped.line(atRow: 3)?.line, 2)

        // one appended, one dropped (maxLines 3): only the new line is wrapped, the first line's two rows go
        guard case .changed(let appended, let dropped) = store.apply(message(start: 3, ["123456789"])) else { return XCTFail("expected changed") }
        XCTAssertEqual(appended, 1)
        XCTAssertEqual(dropped, 1)
        let revision = wrapped.revision
        wrapped.follow(store, appended: appended, dropped: dropped)
        XCTAssertEqual(rowTexts(allRows(wrapped)), ["", "xy", "1234", "5678", "9"])
        XCTAssertEqual(rowCounts(wrapped), [1, 1, 3])
        XCTAssertEqual(wrapped.firstLine, 1)
        XCTAssertEqual(wrapped.firstRow(ofLine: 3), 2)
        XCTAssertNil(wrapped.firstRow(ofLine: 0), "dropped")
        XCTAssertNotEqual(wrapped.revision, revision)
        XCTAssertEqual(wrapped.generation, generation, "continued, not replaced")

        wrapped.rewrap(from: store, cols: 5)
        XCTAssertEqual(rowTexts(allRows(wrapped)), ["", "xy", "12345", "6789"])
        XCTAssertEqual(rowCounts(wrapped), [1, 1, 2])
        XCTAssertEqual(wrapped.cols, 5)
        XCTAssertEqual(wrapped.generation, generation, "the same lines at another width")

        wrapped.setUnwrapped([[run("as is, wider than five")]], cols: 5)
        XCTAssertEqual(wrapped.rowCount, 1)
        XCTAssertTrue(wrapped.isUnwrapped)
        XCTAssertNotEqual(wrapped.generation, generation)
        wrapped.follow(store, appended: 1, dropped: 0)
        XCTAssertEqual(wrapped.rowCount, 1, "the history fallback gets no additions")
    }

    func testRowCountMatchesTheRowsMade() {
        // narrow, wide, combining, a run whose characters take more cells than they are, gaps, overlaps, empty text
        let pieces: [(String, Int)] = [("abc", 3), ("日", 2), ("e\u{301}x", 2), ("ab", 5), ("", 1), ("😀", 2), ("wxyz", 4), ("a", 1)]
        var seed: UInt64 = 7
        func next(_ bound: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(bound))
        }
        for _ in 0..<2000 {
            var runs: [WireRun] = []
            var c = 0
            for _ in 0..<next(6) {
                let (t, w) = pieces[next(pieces.count)]
                c += next(4) - (next(5) == 0 ? 2 : 0)
                runs.append(WireRun(c: max(0, c), w: next(9) == 0 ? 0 : w, s: 0, t: t))
                c = max(0, c) + w
            }
            let cols = 1 + next(7)
            XCTAssertEqual(ScrollbackWrap.rowCount(runs, cols: cols), ScrollbackWrap.rows(runs, cols: cols).count, "\(runs) at \(cols)")
        }
    }

    func testFrontTrimmedKeepsOrderAcrossChunksAndCopies() {
        var held = FrontTrimmed(0..<3000)
        let before = held
        held.removeFirst(1500)
        XCTAssertEqual(held.count, 1500)
        XCTAssertEqual(held.first, 1500)
        XCTAssertEqual(held[1499], 2999)
        held.append(contentsOf: 3000..<3100)
        held.removeFirst(600)
        XCTAssertEqual(Array(held), Array(2100..<3100))
        XCTAssertEqual(Array(before), Array(0..<3000), "a copy taken before is not changed")
        held.removeFirst(held.count)
        XCTAssertTrue(held.isEmpty)
        held.append(5)
        XCTAssertEqual(Array(held), [5])
    }

    func testWrappedHistoryCountsAgainWhenItMissedAChange() {
        var store = ScrollbackStore(maxLines: 10)
        var wrapped = WrappedHistory(cols: 4)
        _ = store.apply(message(start: 0, ["abcdef"], reset: true))
        wrapped.reset(from: store, cols: 4)
        _ = store.apply(message(start: 1, ["x"])) // not followed
        guard case .changed(let appended, let dropped) = store.apply(message(start: 2, ["123456789"])) else { return XCTFail("expected changed") }
        wrapped.follow(store, appended: appended, dropped: dropped)
        XCTAssertEqual(rowTexts(allRows(wrapped)), ["abcd", "ef", "x", "1234", "5678", "9"])
        XCTAssertEqual(wrapped.line(atRow: 4)?.line, 2)
        XCTAssertEqual(wrapped.line(atRow: 4)?.rowInLine, 1)
        XCTAssertEqual(wrapped.rows(ofLine: 2).count, wrapped.rowCount(ofLine: 2))
    }
}
