// UIKit grid renderer: one NSAttributedString draw per same-style run of ASCII cells, one per
// non-ASCII or wide cell (centred in its cell box so fallback fonts cannot drift the columns).
// The pane's history rows (the bridge's scrollback copy, wrapped to the grid's columns) sit above
// the live grid in one column of rows: history row i is row i, live row y is row history + y.
// Redraws only live rows whose cells changed, and only ever the rows on screen. The view is only
// ever viewport-sized: the scroll view pins it to the visible area and sets `origin`, so a
// 10 000-line history never becomes one giant layer (Core Animation stops rendering backing stores
// beyond the GPU texture limit — the screen would simply go blank).
import FlowKit
import UIKit

/// The terminal's colours under one theme (shared/design/DESIGN.md §1): flush on the screen's `bg`, text in `fg`,
/// selection in `selection`, ANSI 0–15 from the theme, and the theme's contrast floor for text.
@MainActor
final class TerminalTheme {
    let background: UIColor
    let selection: UIColor
    private let defaultForeground: RGB
    private let defaultBackground: RGB
    private let ansi: [RGB]
    private let minimumContrast: Double
    /// Text colour after the contrast floor, per (foreground, background) pair.
    private var readable: [UInt64: RGB] = [:]

    private init(_ palette: Palette) {
        background = UIColor(rgb: palette.bg)
        selection = UIColor(rgb: palette.interactive).withAlphaComponent(0.35)
        defaultForeground = RGB(hex: palette.fg)
        defaultBackground = RGB(hex: palette.bg)
        ansi = palette.ansi.map { RGB(hex: $0) }
        minimumContrast = palette.minimumContrast
    }

    private static var themes: [ThemeChoice: TerminalTheme] = [:]

    /// One instance per theme, so a view can tell a change by identity.
    static func of(_ choice: ThemeChoice) -> TerminalTheme {
        if let theme = themes[choice] { return theme }
        let theme = TerminalTheme(choice.palette)
        themes[choice] = theme
        return theme
    }

    static func uiColor(_ rgb: RGB) -> UIColor {
        UIColor(red: CGFloat(rgb.r) / 255, green: CGFloat(rgb.g) / 255, blue: CGFloat(rgb.b) / 255, alpha: 1)
    }

    /// Foreground/background after applying inverse, the contrast floor and dim. `background == nil` means "theme
    /// default".
    func colors(for style: Style) -> (foreground: UIColor, background: UIColor?) {
        var fg = style.foreground.rgb(ansi: ansi) ?? defaultForeground
        var bg = style.background.rgb(ansi: ansi)
        let attributes = style.attributes
        if attributes.contains(.inverse) {
            let newBackground = fg
            fg = bg ?? defaultBackground
            bg = newBackground
        }
        fg = readableForeground(fg, on: bg ?? defaultBackground)
        var foreground = TerminalTheme.uiColor(fg)
        if attributes.contains(.dim) { foreground = foreground.withAlphaComponent(0.55) }
        // Closure literal, not `.map(uiColor)`: passing the main-actor static method as a bare function value would
        // drop its global actor in the conversion.
        return (foreground, bg.map { TerminalTheme.uiColor($0) })
    }

    private func readableForeground(_ fg: RGB, on bg: RGB) -> RGB {
        guard minimumContrast > 1 else { return fg }
        let key = UInt64(fg.hex) << 24 | UInt64(bg.hex)
        if let hit = readable[key] { return hit }
        if readable.count > 4096 { readable.removeAll(keepingCapacity: true) }
        let out = Contrast.readable(fg, on: bg, minimum: minimumContrast)
        readable[key] = out
        return out
    }
}

extension RGB {
    init(hex: UInt32) { self.init(UInt8((hex >> 16) & 0xFF), UInt8((hex >> 8) & 0xFF), UInt8(hex & 0xFF)) }
    var hex: UInt32 { UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b) }
}

@MainActor
struct TerminalMetrics {
    let size: CGFloat
    let regular: UIFont
    let bold: UIFont
    let italic: UIFont
    let boldItalic: UIFont
    let cellWidth: CGFloat
    let lineHeight: CGFloat

    init(size: CGFloat) {
        let pointSize = max(4, size)
        self.size = pointSize
        // JetBrains Mono (bundled, DESIGN.md §2); the system monospaced font if the resource is missing.
        regular = DesignTokens.monoUIFont(pointSize)
        bold = DesignTokens.monoUIFont(pointSize, bold: true)
        italic = TerminalMetrics.italicVariant(of: regular)
        boldItalic = TerminalMetrics.italicVariant(of: bold)
        cellWidth = ("M" as NSString).size(withAttributes: [.font: regular]).width
        lineHeight = ceil(regular.lineHeight)
    }

    /// A true italic when the family has one; JetBrains Mono ships here as Regular and Bold only, so its slant is
    /// synthesised with a font matrix (a 0.2 skew) instead of falling into another family's italic.
    private static func italicVariant(of font: UIFont) -> UIFont {
        let traits = font.fontDescriptor.symbolicTraits.union(.traitItalic)
        if let descriptor = font.fontDescriptor.withSymbolicTraits(traits),
           descriptor.symbolicTraits.contains(.traitItalic),
           (descriptor.object(forKey: .family) as? String) == font.familyName {
            return UIFont(descriptor: descriptor, size: font.pointSize)
        }
        let skew = CGAffineTransform(a: 1, b: 0, c: 0.2, d: 1, tx: 0, ty: 0)
        let descriptor = font.fontDescriptor.addingAttributes([.matrix: NSValue(cgAffineTransform: skew)])
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }

    func font(for attributes: StyleAttributes) -> UIFont {
        switch (attributes.contains(.bold), attributes.contains(.italic)) {
        case (true, true): return boldItalic
        case (true, false): return bold
        case (false, true): return italic
        case (false, false): return regular
        }
    }

    func attributes(for style: Style, foreground: UIColor) -> [NSAttributedString.Key: Any] {
        let a = style.attributes
        var attrs: [NSAttributedString.Key: Any] = [
            .font: font(for: a),
            .foregroundColor: foreground,
            .ligature: 0,
        ]
        if a.contains(.underline) { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if a.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        return attrs
    }

    /// Font used in fit mode when no explicit size is set: the phone's body text size (Dynamic Type; 17 pt
    /// at the default setting), so the terminal reads like the rest of the phone. A− / A+ step from here.
    static var fitDefaultSize: CGFloat { UIFont.preferredFont(forTextStyle: .body).pointSize }

    /// Largest half-point size (7…14 pt) at which `cols` columns fit in `width` points.
    static func fittingSize(cols: Int, width: CGFloat) -> CGFloat {
        guard cols > 0, width > 0 else { return 12 }
        let probe = TerminalMetrics(size: 10)
        let advancePerPoint = probe.cellWidth / 10
        guard advancePerPoint > 0 else { return 12 }
        let raw = width / CGFloat(cols) / advancePerPoint
        return min(14, max(7, floor(raw * 2) / 2))
    }
}

final class TerminalGridUIView: UIView {
    private(set) var grid = TerminalGrid(cols: 80, rows: 24)
    var theme = TerminalTheme.of(ThemeStore.shared.choice) {
        didSet {
            guard theme !== oldValue else { return }
            backgroundColor = theme.background
            setNeedsDisplay()
        }
    }
    /// History rows above the live grid, oldest first (none while swipes go to the program).
    private(set) var history = WrappedHistory()
    /// Styles of the history rows' runs (their ids outlive the connection; the live grid's do not).
    var historyStyles = HistoryStyles()
    var metrics = TerminalMetrics(size: 12) {
        didSet { if metrics.size != oldValue.size { setNeedsDisplay() } }
    }
    /// Content point (cols × cellWidth wide; history rows, then live rows, each lineHeight tall) shown at this view's top-left.
    var origin: CGPoint = .zero {
        didSet { if origin != oldValue { setNeedsDisplay() } }
    }
    /// Long-press selection (anchor, focus cells) drawn as a translucent overlay; nil when nothing is selected.
    var selection: (anchor: GridPosition, focus: GridPosition)? {
        didSet { setNeedsDisplay() }
    }

    var selectionText: String? {
        selection.map { text(from: $0.anchor, to: $0.focus) }
    }

    /// History rows, then the live grid's.
    var totalRows: Int { history.rowCount + grid.rows }

    /// Top of the live grid in content coordinates.
    var liveTop: CGFloat { CGFloat(history.rowCount) * metrics.lineHeight }

    func setHistory(_ newHistory: WrappedHistory) {
        if newHistory.generation != history.generation || newHistory.cols != history.cols { madeRows = [:] }
        history = newHistory
        setNeedsDisplay()
    }

    /// The rows of the history lines drawn lately, by line number: a line's rows are made once, not for each of its rows
    /// in every frame (they stay the same until the lines are replaced or wrapped at another width).
    private var madeRows: [Int: [[WireRun]]] = [:]

    /// History row `y`'s runs (placed from its column 0).
    private func historyRow(_ y: Int) -> [WireRun] {
        guard let at = history.line(atRow: y) else { return [] }
        let rows: [[WireRun]]
        if let made = madeRows[at.line] {
            rows = made
        } else {
            if madeRows.count >= 256 { madeRows = [:] }
            rows = history.rows(ofLine: at.line)
            madeRows[at.line] = rows
        }
        return at.rowInLine < rows.count ? rows[at.rowInLine] : []
    }

    // MARK: Slide (a scrolled frame glides into place instead of jumping)

    /// Points the moving region is displaced from its final place while a slide lasts (positive = drawn lower).
    private(set) var slideOffset: CGFloat = 0
    private var slideMovingRows = 0
    /// Rows that scrolled out of the moving region, still drawn next to it while it slides: above row 0
    /// when the content moved up (last one nearest the grid), below the region when it moved down.
    private var leavingRows: [[Cell]] = []
    private var leavingAbove = true
    private var slideVelocity: CGFloat = 0 // points per second toward 0
    private var displayLink: CADisplayLink?
    private var lastSlideTick: CFTimeInterval = 0

    /// Call before `update(grid:)` with the frame `shift` describes: the new rows start `shift` rows away
    /// from their final place and glide there over `duration`. A slide already running is extended, so
    /// frames arriving every 60–80 ms during a scroll become one continuous motion.
    func beginSlide(_ shift: RowShift, from old: TerminalGrid, duration: TimeInterval) {
        let line = metrics.lineHeight
        let m = min(shift.movingRows, old.rows)
        guard line > 0, m > 0, shift.shift != 0 else { return }
        let k = min(abs(shift.shift), m)
        if shift.shift > 0 {
            let gone = Array(old.cells[0..<k])
            leavingRows = (leavingAbove && slideOffset > 0 ? leavingRows : []) + gone
            leavingAbove = true
            slideOffset = max(0, slideOffset) + CGFloat(k) * line
        } else {
            let gone = Array(old.cells[(m - k)..<m])
            leavingRows = gone + (!leavingAbove && slideOffset < 0 ? leavingRows : [])
            leavingAbove = false
            slideOffset = min(0, slideOffset) - CGFloat(k) * line
        }
        if leavingRows.count > m { leavingRows = leavingAbove ? Array(leavingRows.suffix(m)) : Array(leavingRows.prefix(m)) }
        slideMovingRows = m
        slideVelocity = abs(slideOffset) / max(0.03, duration)
        if displayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(slideTick(_:)))
            link.add(to: .main, forMode: .common)
            displayLink = link
            lastSlideTick = 0
        }
        setNeedsDisplay()
    }

    func endSlide() {
        displayLink?.invalidate()
        displayLink = nil
        guard slideOffset != 0 || !leavingRows.isEmpty else { return }
        slideOffset = 0
        leavingRows = []
        setNeedsDisplay()
    }

    @objc private func slideTick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastSlideTick == 0 ? link.duration : min(0.1, now - lastSlideTick)
        lastSlideTick = now
        let step = slideVelocity * CGFloat(dt)
        if abs(slideOffset) <= step {
            endSlide()
            return
        }
        slideOffset -= slideOffset > 0 ? step : -step
        let region = CGRect(x: 0, y: liveTop - origin.y, width: bounds.width, height: CGFloat(slideMovingRows) * metrics.lineHeight)
        setNeedsDisplay(region.intersection(bounds))
    }

    /// Bounding box of the selection in this view's coordinates (full width when it spans rows).
    func selectionRect() -> CGRect? {
        guard let selection else { return nil }
        let (start, end) = ordered(selection)
        let single = start.row == end.row
        let x0 = single ? CGFloat(start.col) * metrics.cellWidth : 0
        let x1 = single ? CGFloat(end.col + 1) * metrics.cellWidth : CGFloat(grid.cols) * metrics.cellWidth
        return CGRect(x: x0 - origin.x, y: CGFloat(start.row) * metrics.lineHeight - origin.y, width: x1 - x0,
                      height: CGFloat(end.row - start.row + 1) * metrics.lineHeight)
    }

    /// Cell (history and live rows counted together) under a point in this view's coordinates; columns clamp to the
    /// grid, rows outside the content are nil.
    func cell(at point: CGPoint) -> GridPosition? {
        guard metrics.cellWidth > 0, metrics.lineHeight > 0, totalRows > 0, grid.cols > 0 else { return nil }
        let row = Int(floor((point.y + origin.y) / metrics.lineHeight))
        guard row >= 0, row < totalRows else { return nil }
        let col = Int(floor((point.x + origin.x) / metrics.cellWidth))
        return GridPosition(row: row, col: min(max(col, 0), grid.cols - 1))
    }

    /// Centre of a cell in this view's coordinates.
    func cellCenter(_ p: GridPosition) -> CGPoint {
        CGPoint(x: (CGFloat(p.col) + 0.5) * metrics.cellWidth - origin.x, y: (CGFloat(p.row) + 0.5) * metrics.lineHeight - origin.y)
    }

    private func ordered(_ s: (anchor: GridPosition, focus: GridPosition)) -> (GridPosition, GridPosition) {
        s.anchor <= s.focus ? (s.anchor, s.focus) : (s.focus, s.anchor)
    }

    // MARK: Text (history and live rows together)

    /// Row `y` as cells; a history row is laid out here on demand (selection and copying only, never while drawing).
    private func rowCells(_ y: Int) -> [Cell] {
        let historyCount = history.rowCount
        if y >= 0, y < historyCount {
            let cols = max(grid.cols, 1)
            var row = Array(repeating: Cell.blank, count: cols)
            TerminalGrid.paint(runs: historyRow(y), into: &row, cols: cols)
            return row
        }
        let live = y - historyCount
        return live >= 0 && live < grid.rows ? grid.cells[live] : []
    }

    /// Text of the cells from `a` to `b` inclusive (either order) in reading order, as `TerminalGrid.text(from:to:)`.
    func text(from a: GridPosition, to b: GridPosition) -> String {
        let total = totalRows
        let cols = grid.cols
        guard total > 0, cols > 0 else { return "" }
        func clamp(_ p: GridPosition) -> GridPosition {
            GridPosition(row: min(max(p.row, 0), total - 1), col: min(max(p.col, 0), cols - 1))
        }
        let (start, end) = a <= b ? (clamp(a), clamp(b)) : (clamp(b), clamp(a))
        var lines: [String] = []
        for y in start.row...end.row {
            let row = rowCells(y)
            var from = y == start.row ? start.col : 0
            let to = min(y == end.row ? end.col : cols - 1, row.count - 1)
            if from > 0, from < row.count, row[from].width == 0 { from -= 1 }
            var text = ""
            if from <= to {
                for x in from...to where row[x].width > 0 { text += row[x].text }
            }
            while text.hasSuffix(" ") { text.removeLast() }
            lines.append(text)
        }
        return lines.joined(separator: "\n")
    }

    /// The whitespace-delimited word around `p` (a blank cell selects just itself); nil off the content.
    func wordRange(at p: GridPosition) -> ClosedRange<GridPosition>? {
        guard p.row >= 0, p.row < totalRows, p.col >= 0, p.col < grid.cols else { return nil }
        let row = rowCells(p.row)
        guard p.col < row.count else { return nil }
        func isInk(_ x: Int) -> Bool { row[x].width == 0 || (row[x].text != " " && !row[x].text.isEmpty) }
        guard isInk(p.col) else { return p...p }
        var from = p.col
        while from > 0, isInk(from - 1) { from -= 1 }
        var to = p.col
        while to + 1 < row.count, isInk(to + 1) { to += 1 }
        return GridPosition(row: p.row, col: from)...GridPosition(row: p.row, col: to)
    }

    /// The rows on screen now (history and/or live), one per line, trailing blanks trimmed ("Copy screen").
    func visibleText() -> String {
        let line = metrics.lineHeight
        guard line > 0, totalRows > 0, grid.cols > 0 else { return "" }
        // rows at least half in view
        let first = max(0, Int(ceil(origin.y / line - 0.5)))
        let last = min(totalRows - 1, Int(floor((origin.y + bounds.height) / line - 0.5)))
        guard first <= last else { return "" }
        // trailing blank rows dropped, as on Android
        var lines = text(from: GridPosition(row: first, col: 0), to: GridPosition(row: last, col: grid.cols - 1)).components(separatedBy: "\n")
        while lines.last?.isEmpty == true { lines.removeLast() }
        return lines.joined(separator: "\n")
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        isOpaque = true
        backgroundColor = theme.background
        contentMode = .redraw
    }

    /// The live grid's size (the history rows above it take `liveTop`).
    var gridSize: CGSize {
        CGSize(width: CGFloat(grid.cols) * metrics.cellWidth, height: CGFloat(grid.rows) * metrics.lineHeight)
    }

    /// Replaces the grid and invalidates only the rows that differ.
    func update(grid newGrid: TerminalGrid) {
        let old = grid
        grid = newGrid
        if old.cols != newGrid.cols || old.rows != newGrid.rows {
            endSlide()
            setNeedsDisplay()
            return
        }
        for y in 0..<newGrid.rows where old.cells[y] != newGrid.cells[y] {
            let rect = rowRect(y)
            if rect.intersects(bounds) { setNeedsDisplay(rect) }
        }
    }

    /// Live row `y` in this view's coordinates.
    private func rowRect(_ y: Int) -> CGRect {
        CGRect(x: 0, y: liveTop + CGFloat(y) * metrics.lineHeight - origin.y, width: bounds.width, height: metrics.lineHeight)
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setFillColor(theme.background.cgColor)
        ctx.fill(rect)
        let lineHeight = metrics.lineHeight
        guard lineHeight > 0 else { return }
        // Work in content coordinates: shift the context so content row y sits at y × lineHeight.
        let contentRect = rect.offsetBy(dx: origin.x, dy: origin.y)
        let visibleX = contentRect.minX...contentRect.maxX
        ctx.saveGState()
        ctx.translateBy(x: -origin.x, y: -origin.y)
        let historyCount = history.rowCount
        if historyCount > 0 {
            // Only the rows on screen, straight from their runs: the cost of a frame does not grow with the history.
            let first = max(0, Int(floor(contentRect.minY / lineHeight)))
            let last = min(historyCount - 1, Int(ceil(contentRect.maxY / lineHeight)))
            if first <= last {
                for y in first...last { drawRuns(historyRow(y), top: CGFloat(y) * lineHeight, in: ctx, visibleX: visibleX) }
            }
        }
        // The live grid below them, in its own coordinates (live row y at y × lineHeight).
        let top = liveTop
        ctx.saveGState()
        ctx.translateBy(x: 0, y: top)
        drawLive(gridRect: contentRect.offsetBy(dx: 0, dy: -top), in: ctx, visibleX: visibleX)
        ctx.restoreGState()
        if slideOffset == 0 || slideMovingRows == 0 {
            let first = max(0, Int(floor(contentRect.minY / lineHeight)))
            let last = min(totalRows - 1, Int(ceil(contentRect.maxY / lineHeight)))
            if first <= last { drawSelection(first: first, last: last, in: ctx) }
        }
        ctx.restoreGState()
    }

    /// The live grid's rows within `gridRect` (live-grid coordinates; the context is translated to match).
    private func drawLive(gridRect: CGRect, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let lineHeight = metrics.lineHeight
        guard grid.rows > 0 else { return }
        let first = max(0, Int(floor(gridRect.minY / lineHeight)))
        let last = min(grid.rows - 1, Int(ceil(gridRect.maxY / lineHeight)))
        guard first <= last else { return }
        if slideOffset != 0, slideMovingRows > 0 {
            // The moving region (rows 0..<m) is drawn displaced by slideOffset and clipped to its own box, with
            // the rows that scrolled out still showing next to it; the rows below it stay put.
            let m = min(slideMovingRows, grid.rows)
            for y in first...last where y >= m { drawRow(y, in: ctx, visibleX: visibleX) }
            ctx.saveGState()
            ctx.clip(to: CGRect(x: gridRect.minX, y: 0, width: gridRect.width, height: CGFloat(m) * lineHeight))
            ctx.translateBy(x: 0, y: slideOffset)
            let shown = (gridRect.minY - slideOffset - lineHeight)...(gridRect.maxY - slideOffset)
            for y in 0..<m where shown.contains(CGFloat(y) * lineHeight) { drawRow(y, in: ctx, visibleX: visibleX) }
            for (i, cells) in leavingRows.enumerated() {
                let top = (leavingAbove ? CGFloat(i - leavingRows.count) : CGFloat(m + i)) * lineHeight
                if shown.contains(top) { drawCells(cells, top: top, in: ctx, visibleX: visibleX) }
            }
            ctx.restoreGState()
        } else {
            for y in first...last { drawRow(y, in: ctx, visibleX: visibleX) }
        }
    }

    private func drawSelection(first: Int, last: Int, in ctx: CGContext) {
        guard let selection else { return }
        let (start, end) = ordered(selection)
        let lo = max(first, start.row)
        let hi = min(last, end.row)
        guard lo <= hi else { return }
        ctx.setFillColor(theme.selection.cgColor)
        for y in lo...hi {
            let c0 = y == start.row ? start.col : 0
            let c1 = y == end.row ? end.col : grid.cols - 1
            guard c1 >= c0 else { continue }
            ctx.fill(CGRect(x: CGFloat(c0) * metrics.cellWidth, y: CGFloat(y) * metrics.lineHeight,
                            width: CGFloat(c1 - c0 + 1) * metrics.cellWidth, height: metrics.lineHeight))
        }
    }

    private func drawRow(_ y: Int, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        drawCells(grid.cells[y], top: CGFloat(y) * metrics.lineHeight, in: ctx, visibleX: visibleX)
    }

    /// One row of cells with its top edge at `top` (grid coordinates).
    private func drawCells(_ row: [Cell], top: CGFloat, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let cols = row.count
        let cellWidth = metrics.cellWidth
        var x = 0
        while x < cols {
            let cell = row[x]
            if cell.width == 0 { x += 1; continue }
            var end = x + max(cell.width, 1)
            let grouped = cell.width == 1 && TerminalGridUIView.isPlainASCII(cell.text)
            if grouped {
                while end < cols, row[end].width == 1, row[end].styleId == cell.styleId,
                      TerminalGridUIView.isPlainASCII(row[end].text) {
                    end += 1
                }
            }
            let originX = CGFloat(x) * cellWidth
            let width = CGFloat(end - x) * cellWidth
            if originX + width < visibleX.lowerBound || originX > visibleX.upperBound { x = end; continue } // off-screen columns
            let style = grid.style(cell.styleId)
            let colors = theme.colors(for: style)
            if let bg = colors.background {
                ctx.setFillColor(bg.cgColor)
                ctx.fill(CGRect(x: originX, y: top, width: width, height: metrics.lineHeight))
            }
            let text = grouped ? row[x..<end].map(\.text).joined() : cell.text
            if !text.allSatisfy({ $0 == " " }) {
                let attributed = NSAttributedString(string: text, attributes: metrics.attributes(for: style, foreground: colors.foreground))
                if grouped {
                    attributed.draw(at: CGPoint(x: originX, y: top))
                } else {
                    let glyphWidth = attributed.size().width
                    attributed.draw(at: CGPoint(x: originX + max(0, (width - glyphWidth) / 2), y: top))
                }
            }
            x = end
        }
    }

    /// One history row (runs placed from its column 0) with its top edge at `top`, drawn as `drawCells` draws cells but
    /// straight from the runs, so a row on screen costs no cell array: printable ASCII in one draw, other narrow
    /// characters each centred in its cell, a wide character centred in its two.
    private func drawRuns(_ runs: [WireRun], top: CGFloat, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let cellWidth = metrics.cellWidth
        for run in runs where run.w > 0 {
            let originX = CGFloat(run.c) * cellWidth
            let width = CGFloat(run.w) * cellWidth
            if originX + width < visibleX.lowerBound || originX > visibleX.upperBound { continue } // off-screen columns
            let style = historyStyles.style(run.s)
            let colors = theme.colors(for: style)
            if let bg = colors.background {
                ctx.setFillColor(bg.cgColor)
                ctx.fill(CGRect(x: originX, y: top, width: width, height: metrics.lineHeight))
            }
            if run.t.allSatisfy({ $0 == " " }) { continue }
            let attributes = metrics.attributes(for: style, foreground: colors.foreground)
            let utf8 = run.t.utf8
            if utf8.count == run.w, utf8.allSatisfy({ (0x20...0x7E).contains($0) }) {
                NSAttributedString(string: run.t, attributes: attributes).draw(at: CGPoint(x: originX, y: top))
            } else if run.t.count == run.w {
                var x = originX
                for character in run.t {
                    if character != " " {
                        let glyph = NSAttributedString(string: String(character), attributes: attributes)
                        glyph.draw(at: CGPoint(x: x + max(0, (cellWidth - glyph.size().width) / 2), y: top))
                    }
                    x += cellWidth
                }
            } else {
                let glyph = NSAttributedString(string: run.t, attributes: attributes)
                glyph.draw(at: CGPoint(x: originX + max(0, (width - glyph.size().width) / 2), y: top))
            }
        }
    }

    /// One printable ASCII character: safe to concatenate because SF Mono advances are uniform.
    private static func isPlainASCII(_ text: String) -> Bool {
        let utf8 = text.utf8
        guard utf8.count == 1, let byte = utf8.first else { return false }
        return (0x20...0x7E).contains(byte)
    }
}
