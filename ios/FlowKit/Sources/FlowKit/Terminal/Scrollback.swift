// The phone's copy of a pane's history (protocol §4/§6 `scrollback`): the logical lines the bridge has sent, numbered as
// the bridge numbers them within an epoch, and those lines wrapped to the width the live grid is shown at. Pure value
// types: the app owns one store per recently viewed pane and one wrapped copy for the pane on screen.
import Foundation

// MARK: - Store

/// One pane's history lines, oldest first: `lines[0]` is line number `base` of `epoch`.
public struct ScrollbackStore: Sendable {
    /// The most lines a bridge keeps per pane (`scrollback.max_lines` at its highest): what a store holds until an `ok`
    /// says how many this bridge keeps, so the lines of an answer that arrive before it are never cut short.
    public static let protocolMaxLines = 100_000
    public static let defaultMaxLines = protocolMaxLines

    public private(set) var epoch: String?
    public private(set) var base = 0
    /// The runs of each logical line held.
    public private(set) var lines = FrontTrimmed<[WireRun]>()
    /// At most this many lines are held (the `ok`'s `max_lines`); the oldest go first.
    public private(set) var maxLines: Int
    /// The number the next line will have: the `from` of the next request.
    public var next: Int { base + lines.count }

    public enum Outcome: Equatable, Sendable {
        /// Every line was replaced (`reset`).
        case reset
        /// `appended` new lines now end `lines`; the `dropped` oldest lines held before were let go to stay within `maxLines`.
        case changed(appended: Int, dropped: Int)
        /// Lines were missed (another epoch, or a gap before `start`): ask again without an epoch. Nothing was changed.
        case resync
    }

    public init(maxLines: Int = ScrollbackStore.defaultMaxLines) {
        self.maxLines = max(1, maxLines)
    }

    public mutating func apply(_ message: ScrollbackMessage) -> Outcome {
        if message.reset {
            epoch = message.epoch
            let overflow = max(0, message.lines.count - maxLines)
            base = message.start + overflow
            lines = FrontTrimmed(message.lines.dropFirst(overflow).lazy.map(\.runs))
            return .reset
        }
        guard let epoch, epoch == message.epoch, message.start <= next else { return .resync }
        // Numbers already held are the same lines again.
        let fresh = message.lines.dropFirst(next - message.start)
        guard !fresh.isEmpty else { return .changed(appended: 0, dropped: 0) }
        let held = lines.count
        let overflow = max(0, held + fresh.count - maxLines)
        let droppedOld = min(overflow, held)
        let droppedNew = overflow - droppedOld
        if droppedNew > 0 {
            lines = FrontTrimmed(fresh.dropFirst(droppedNew).lazy.map(\.runs))
        } else {
            if droppedOld > 0 { lines.removeFirst(droppedOld) }
            lines.append(contentsOf: fresh.lazy.map(\.runs))
        }
        base += overflow
        return .changed(appended: fresh.count - droppedNew, dropped: droppedOld)
    }

    /// Before a request: hold up to `protocolMaxLines` until the answer's `ok` says the bridge's own limit.
    public mutating func raiseMaxLinesForAnswer() {
        maxLines = max(maxLines, ScrollbackStore.protocolMaxLines)
    }

    /// Takes the `ok`'s `max_lines`; returns how many of the oldest lines were dropped to fit it.
    @discardableResult
    public mutating func setMaxLines(_ value: Int) -> Int {
        maxLines = max(1, value)
        let overflow = max(0, lines.count - maxLines)
        if overflow > 0 {
            lines.removeFirst(overflow)
            base += overflow
        }
        return overflow
    }

    /// Whether the `ok` that closed an answer describes this copy; a field the bridge left out does not disagree.
    public func agrees(epoch okEpoch: String?, next okNext: Int?) -> Bool {
        if let okEpoch, okEpoch != epoch { return false }
        if let okNext, okNext != next { return false }
        return true
    }
}

/// The stores of the panes viewed most recently in this app session: the least recently used ones go past `capacity`
/// panes, or while the lines they hold together pass `lineBudget` (the one used last always stays), so a bridge keeping
/// long histories costs the phone one pane's worth, not eight.
public struct ScrollbackStores: Sendable {
    public static let defaultCapacity = 8
    public static let defaultLineBudget = ScrollbackStore.protocolMaxLines

    public let capacity: Int
    public let lineBudget: Int
    private var stores: [String: ScrollbackStore] = [:]
    /// Least recently used first.
    private var order: [String] = []

    public init(capacity: Int = ScrollbackStores.defaultCapacity, lineBudget: Int = ScrollbackStores.defaultLineBudget) {
        self.capacity = max(1, capacity)
        self.lineBudget = max(1, lineBudget)
    }

    public subscript(pane: String) -> ScrollbackStore? { stores[pane] }

    public var panes: [String] { order }

    /// Runs `body` on the pane's store (a new one if there is none) in place, marking it the most recently used.
    public mutating func update<R>(_ pane: String, _ body: (inout ScrollbackStore) throws -> R) rethrows -> R {
        if let i = order.firstIndex(of: pane) { order.remove(at: i) }
        order.append(pane)
        let result = try body(&stores[pane, default: ScrollbackStore()])
        var held = stores.values.reduce(0) { $0 + $1.lines.count }
        while order.count > 1, order.count > capacity || held > lineBudget {
            held -= stores.removeValue(forKey: order.removeFirst())?.lines.count ?? 0
        }
        return result
    }

    public mutating func removeAll() {
        stores.removeAll()
        order.removeAll()
    }
}

// MARK: - Styles

/// History lines keep their styles under ids of their own: wire style ids are per connection and start over with every
/// socket, while a pane's copy outlives reconnects. Id 0 is the default style, as on the wire.
public struct HistoryStyles: Sendable {
    private var ids: [Style: Int] = [Style.default: 0]
    public private(set) var styles: [Int: Style] = [0: Style.default]

    public init() {}

    public func style(_ id: Int) -> Style { styles[id] ?? .default }

    /// `runs` with each wire style id (`wire` looks it up among the connection's styles) replaced by this table's id.
    public mutating func localize(_ runs: [WireRun], wire: (Int) -> Style) -> [WireRun] {
        var out = runs
        for i in out.indices {
            out[i].s = id(for: out[i].s == 0 ? Style.default : wire(out[i].s))
        }
        return out
    }

    /// The message with its lines' style ids localized.
    public mutating func localize(_ message: ScrollbackMessage, wire: (Int) -> Style) -> ScrollbackMessage {
        var out = message
        for i in out.lines.indices {
            out.lines[i].runs = localize(out.lines[i].runs, wire: wire)
        }
        return out
    }

    private mutating func id(for style: Style) -> Int {
        if let id = ids[style] { return id }
        let id = styles.count
        ids[style] = id
        styles[id] = style
        return id
    }
}

// MARK: - Wrapping

public enum ScrollbackWrap {
    /// A logical line's runs cut into rows of `cols` cells, each row's runs placed from its column 0. Narrow runs split at
    /// the row edge between Characters (a combining mark stays with its base); a wide character, or a run whose
    /// characters do not take one cell each, that does not fit the rest of a row starts the next one, as a terminal
    /// does. An empty line is one blank row; gaps between runs are blank cells.
    public static func rows(_ runs: [WireRun], cols: Int) -> [[WireRun]] {
        let cols = max(1, cols)
        var rows: [[WireRun]] = []
        var row: [WireRun] = []
        var x = 0 // the next column in `row`
        var reached = 0 // the next column of the logical line
        func newRow() {
            rows.append(row)
            row = []
            x = 0
        }
        for run in runs where run.w > 0 {
            var gap = run.c - reached
            while gap > 0 {
                if x >= cols { newRow() }
                let take = min(gap, cols - x)
                x += take
                gap -= take
            }
            reached = max(reached, run.c + run.w)
            let characters = Array(run.t)
            if characters.count == run.w {
                var i = 0
                while i < characters.count {
                    if x >= cols { newRow() }
                    let take = min(characters.count - i, cols - x)
                    row.append(WireRun(c: x, w: take, s: run.s, t: String(characters[i..<(i + take)])))
                    x += take
                    i += take
                }
            } else {
                if x > 0, x + run.w > cols { newRow() }
                row.append(WireRun(c: x, w: run.w, s: run.s, t: run.t))
                x += run.w
            }
        }
        rows.append(row)
        return rows
    }

    /// How many rows `rows` makes of the line at `cols`, without making them (the same placement, run by run).
    public static func rowCount(_ runs: [WireRun], cols: Int) -> Int {
        let cols = max(1, cols)
        var count = 1
        var x = 0
        var reached = 0
        for run in runs where run.w > 0 {
            var gap = run.c - reached
            while gap > 0 {
                if x >= cols { count += 1; x = 0 }
                let take = min(gap, cols - x)
                x += take
                gap -= take
            }
            reached = max(reached, run.c + run.w)
            let characters = characterCount(run.t)
            if characters == run.w {
                var left = characters
                while left > 0 {
                    if x >= cols { count += 1; x = 0 }
                    let take = min(left, cols - x)
                    x += take
                    left -= take
                }
            } else {
                if x > 0, x + run.w > cols { count += 1; x = 0 }
                x += run.w
            }
        }
        return count
    }

    /// `text.count`, taken from the bytes when they are all printable ASCII (one Character each).
    private static func characterCount(_ text: String) -> Int {
        let bytes = text.utf8
        return bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) ? bytes.count : text.count
    }
}

/// The history rows shown above the live grid: a store's lines wrapped to `cols`, kept in step with it. Only the rows
/// each line takes are counted (for appended lines only; those of lines dropped at the front are let go; all of them
/// again only when `cols` changes); the rows themselves are made when asked for (`rows(ofLine:)`), for the lines drawn:
/// a long history is mostly never looked at, and its rows would take far more memory than its lines. As on Android.
/// Rows from a bridge without `scrollback` (one `history` read) are taken as they come, one line per row.
public struct WrappedHistory: Sendable {
    public private(set) var cols: Int
    /// The lines held, oldest first (the store's own, shared with it).
    private var lines = FrontTrimmed<[WireRun]>()
    /// Per line held, its first row, counted from the first row of these lines (rows dropped at the front included).
    private var starts = FrontTrimmed<Int>()
    /// That count for the first row held, and for the row after the last.
    private var rowBase = 0
    private var rowEnd = 0
    /// The store number of the line the first rows belong to.
    public private(set) var firstLine = 0
    /// Changes when the lines are replaced rather than continued (a reset, another pane, the `history` fallback):
    /// line numbers of an older generation say nothing about these rows.
    public private(set) var generation = 0
    /// Changes with every change, so a view can tell new rows from the ones it drew without comparing them.
    public private(set) var revision = 0
    /// The rows are the `history` fallback's, not wrapped here (a width change leaves them as they are).
    public private(set) var isUnwrapped = false
    /// Changes whenever the rows are counted afresh (`reset`, `rewrap`, `setUnwrapped`, `clear`, and `follow` when it
    /// missed a change): a row number (`firstRowNumber` + the row) names the same row only while this stays the same.
    public private(set) var numbering = 0
    /// An answer to a `scrollback` request is still arriving: lines added now are older output, not lines that just
    /// left the screen.
    public var answering = false

    public init(cols: Int = 80) {
        self.cols = max(1, cols)
    }

    /// Rows held, oldest first.
    public var rowCount: Int { rowEnd - rowBase }
    /// The number of the first row held. Rows keep their numbers while lines are appended and dropped at the front (a view
    /// can keep what it drew for them), until `numbering` changes.
    public var firstRowNumber: Int { rowBase }
    /// Lines held (store numbers `firstLine` on).
    public var lineCount: Int { starts.count }
    public var isEmpty: Bool { rowEnd == rowBase }

    /// Wraps the whole store at `cols`, as new lines (`generation` changes).
    public mutating func reset(from store: ScrollbackStore, cols: Int) {
        generation += 1
        rewrap(from: store, cols: cols)
    }

    /// Wraps the whole store again at a new width; the lines are the same ones (`generation` stays).
    public mutating func rewrap(from store: ScrollbackStore, cols: Int) {
        self.cols = max(1, cols)
        isUnwrapped = false
        numbering += 1
        lines = store.lines
        starts = FrontTrimmed()
        rowBase = 0
        rowEnd = 0
        for line in lines { count(line) }
        firstLine = store.base
        revision += 1
    }

    /// Follows `store` after its `apply` (or `setMaxLines`) reported `appended` new lines and `dropped` old ones.
    public mutating func follow(_ store: ScrollbackStore, appended: Int, dropped: Int) {
        guard !isUnwrapped, appended > 0 || dropped > 0 else { return }
        let gone = min(dropped, starts.count)
        guard starts.count - gone + appended == store.lines.count else {
            // not the lines this copy followed (it missed a change): count them all again
            return rewrap(from: store, cols: cols)
        }
        if gone > 0 {
            rowBase = gone < starts.count ? starts[gone] : rowEnd
            starts.removeFirst(gone)
        }
        lines = store.lines
        for line in lines.suffix(appended) { count(line) }
        firstLine = store.base
        revision += 1
    }

    /// The `history` fallback: these rows as they are, one line each (no wrapping, nothing added later).
    public mutating func setUnwrapped(_ newRows: [[WireRun]], cols: Int) {
        generation += 1
        numbering += 1
        self.cols = max(1, cols)
        isUnwrapped = true
        lines = FrontTrimmed(newRows)
        starts = FrontTrimmed(0..<newRows.count)
        rowBase = 0
        rowEnd = newRows.count
        firstLine = 0
        revision += 1
    }

    public mutating func clear() {
        generation += 1
        numbering += 1
        isUnwrapped = false
        answering = false
        lines = FrontTrimmed()
        starts = FrontTrimmed()
        rowBase = 0
        rowEnd = 0
        firstLine = 0
        revision += 1
    }

    /// The store number of the line row `row` belongs to and the row's place within that line; nil past the rows.
    public func line(atRow row: Int) -> (line: Int, rowInLine: Int)? {
        guard row >= 0, row < rowCount else { return nil }
        let target = rowBase + row
        var lo = 0
        var hi = starts.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if starts[mid] <= target { lo = mid } else { hi = mid - 1 }
        }
        return (firstLine + lo, target - starts[lo])
    }

    /// The first row of the line with store number `line`; nil when it is not held.
    public func firstRow(ofLine line: Int) -> Int? {
        let index = line - firstLine
        guard index >= 0, index < starts.count else { return nil }
        return starts[index] - rowBase
    }

    /// Rows of the line with store number `line` (0 when it is not held).
    public func rowCount(ofLine line: Int) -> Int {
        let index = line - firstLine
        guard index >= 0, index < starts.count else { return 0 }
        return (index + 1 < starts.count ? starts[index + 1] : rowEnd) - starts[index]
    }

    /// The rows of the line with store number `line`, made now (none when it is not held). A view keeps those of the
    /// lines it draws for as long as `generation` and `cols` stay the same: they do not change until then.
    public func rows(ofLine line: Int) -> [[WireRun]] {
        let index = line - firstLine
        guard index >= 0, index < lines.count else { return [] }
        return isUnwrapped ? [lines[index]] : ScrollbackWrap.rows(lines[index], cols: cols)
    }

    /// Row `row`, made now (empty past the rows).
    public func row(_ row: Int) -> [WireRun] {
        guard let at = line(atRow: row) else { return [] }
        let made = rows(ofLine: at.line)
        return at.rowInLine < made.count ? made[at.rowInLine] : []
    }

    private mutating func count(_ line: [WireRun]) {
        starts.append(rowEnd)
        rowEnd += ScrollbackWrap.rowCount(line, cols: cols)
    }
}

// MARK: - Front-trimmed storage

/// Elements held in chunks, oldest first: the oldest leave without the rest moving, and a copy shares the chunks, so
/// changing one copy after another was taken (the view keeps the one it drew; the app's own goes on changing) copies
/// the chunk changed and the list of chunks, not every element.
public struct FrontTrimmed<Element: Sendable>: RandomAccessCollection, Sendable {
    private static var chunkSize: Int { 1024 }
    /// Every chunk but the last is full.
    private var chunks: [[Element]] = []
    /// Elements at the start of `chunks[0]` already let go.
    private var head = 0
    public private(set) var count = 0

    public init() {}

    public init<S: Sequence>(_ elements: S) where S.Element == Element {
        append(contentsOf: elements)
    }

    public var startIndex: Int { 0 }
    public var endIndex: Int { count }

    public subscript(position: Int) -> Element {
        precondition(position >= 0 && position < count, "Index out of range")
        let at = head + position
        return chunks[at / Self.chunkSize][at % Self.chunkSize]
    }

    public mutating func append(_ element: Element) {
        if let last = chunks.indices.last, chunks[last].count < Self.chunkSize {
            chunks[last].append(element)
        } else {
            var chunk: [Element] = []
            chunk.reserveCapacity(Self.chunkSize)
            chunk.append(element)
            chunks.append(chunk)
        }
        count += 1
    }

    public mutating func append<S: Sequence>(contentsOf elements: S) where S.Element == Element {
        for element in elements { append(element) }
    }

    /// Lets the first `k` elements go.
    public mutating func removeFirst(_ k: Int) {
        precondition(k >= 0 && k <= count, "Can't remove more items than the collection has")
        guard k > 0 else { return }
        count -= k
        guard count > 0 else {
            chunks = []
            head = 0
            return
        }
        head += k
        let spent = head / Self.chunkSize
        if spent > 0 {
            chunks.removeFirst(spent)
            head -= spent * Self.chunkSize
        }
    }
}
