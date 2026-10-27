// UIKit grid renderer. The pane's history rows (the bridge's scrollback copy, wrapped to the grid's columns) sit above
// the live grid in one column of rows: history row i is row i, live row y is row history + y. The view spans the
// whole content but draws nothing itself: tiles of about 256 points of rows (subviews) are drawn once and kept for the
// rows on screen and a tile's height above and below, so the scroll view moves them like any native list. A frame of
// scrolling draws nothing; a tile coming into view, or rows whose cells change, are drawn. Tiles are keyed by row number
// (`WrappedHistory.firstRowNumber` on), so lines appended or dropped at the front keep what was drawn for the rows that
// stay. No backing store is ever the size of the content (Core Animation stops showing those past the GPU's texture
// limit). Text: one NSAttributedString draw per same-style stretch of characters the font draws exactly one cell wide
// (ASCII, box drawing, …), one per other or wide character (centred in its cell box so fallback fonts cannot drift the
// columns).
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
    private let cellFit: CellFit

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
        cellFit = CellFit()
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
            .kern: 0, // no kerning pairs, even in a fallback font: a stretch drawn at once keeps to its cells
        ]
        if a.contains(.underline) { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if a.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        return attrs
    }

    /// Whether `text` (one cell's character) is drawn by `font` exactly one cell wide, so it can share one draw with its
    /// neighbours and still land on the grid: printable ASCII always; otherwise one character from a script that neither
    /// joins nor reshapes (Latin, Greek, Cyrillic, punctuation, arrows, box drawing, blocks, shapes, braille…), measured
    /// once per font.
    func fitsCell(_ text: String, font: UIFont) -> Bool {
        let utf8 = text.utf8
        if utf8.count == 1, let byte = utf8.first, (0x20...0x7E).contains(byte) { return true }
        return cellFit.fits(text, font: font, cellWidth: cellWidth)
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

/// `TerminalMetrics.fitsCell`'s measurements.
@MainActor
fileprivate final class CellFit {
    private var known: [UIFont: [String: Bool]] = [:]

    func fits(_ text: String, font: UIFont, cellWidth: CGFloat) -> Bool {
        if let hit = known[font]?[text] { return hit }
        let fits = CellFit.stays(text) && abs((text as NSString).size(withAttributes: [.font: font]).width - cellWidth) < 0.01
        if known[font, default: [:]].count > 4096 { known[font] = [:] }
        known[font, default: [:]][text] = fits
        return fits
    }

    /// One Unicode scalar from a block whose characters keep their shape next to any neighbour (no joining, no marks, no
    /// zero-width or direction controls).
    private static func stays(_ text: String) -> Bool {
        let scalars = text.unicodeScalars
        guard scalars.count == 1, let v = scalars.first?.value else { return false }
        switch v {
        case 0x00A1...0x024F, 0x0370...0x03FF, 0x0400...0x04FF, 0x2010...0x2027, 0x2030...0x205E, 0x2070...0x209F,
             0x20A0...0x20BF, 0x2100...0x23FF, 0x2460...0x27BF, 0x2800...0x28FF, 0x2900...0x2BFF:
            return true
        default:
            return false
        }
    }
}

/// A tile of the content: `rowsPerTile` rows from a row number that is a multiple of it, by one column band; drawn once,
/// then moved by the scroll view with the rest of the content.
private struct TileKey: Hashable {
    let band: Int
    let column: Int
}

private final class TerminalTile: UIView {
    weak var owner: TerminalGridUIView?
    var key = TileKey(band: 0, column: 0)

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
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    override func draw(_ rect: CGRect) {
        guard let owner, let ctx = UIGraphicsGetCurrentContext() else { return }
        owner.drawContent(rect.offsetBy(dx: frame.minX, dy: frame.minY), origin: frame.origin, in: ctx)
    }
}

final class TerminalGridUIView: UIView {
    private(set) var grid = TerminalGrid(cols: 80, rows: 24)
    var theme = TerminalTheme.of(ThemeStore.shared.choice) {
        didSet {
            guard theme !== oldValue else { return }
            painted = [:]
            for view in selectionViews { view.backgroundColor = theme.selection }
            for tile in spareTiles { tile.backgroundColor = theme.background }
            for tile in tiles.values {
                tile.backgroundColor = theme.background
                tile.setNeedsDisplay()
            }
        }
    }
    /// History rows above the live grid, oldest first (none while swipes go to the program).
    private(set) var history = WrappedHistory()
    /// Styles of the history rows' runs (their ids outlive the connection; the live grid's do not).
    var historyStyles = HistoryStyles() {
        didSet { if historyStyles.styles.count < oldValue.styles.count { redrawTiles() } } // a new table: ids name other styles
    }
    var metrics = TerminalMetrics(size: 12) {
        didSet {
            guard metrics.size != oldValue.size else { return }
            painted = [:]
            redrawTiles() // and `layoutTiles` gives them the new row height
            showSelection()
        }
    }
    /// The part of the content on screen (this view spans the whole content: content coordinates are its own). The
    /// scroll view sets it as it scrolls; the tiles follow.
    var visibleRect: CGRect = .zero {
        didSet { if visibleRect != oldValue { layoutTiles() } }
    }
    /// Long-press selection (anchor, focus cells) shown as a translucent overlay; nil when nothing is selected.
    var selection: (anchor: GridPosition, focus: GridPosition)? {
        didSet { showSelection() }
    }

    var selectionText: String? {
        selection.map { text(from: $0.anchor, to: $0.focus) }
    }

    /// History rows, then the live grid's.
    var totalRows: Int { history.rowCount + grid.rows }

    /// Top of the live grid in content coordinates.
    var liveTop: CGFloat { CGFloat(history.rowCount) * metrics.lineHeight }

    /// The row number (`WrappedHistory.firstRowNumber` on) of live row 0.
    private var liveBase: Int { history.firstRowNumber + history.rowCount }

    func setHistory(_ newHistory: WrappedHistory) {
        let old = history
        history = newHistory
        if newHistory.generation != old.generation || newHistory.cols != old.cols { madeRows = [:] }
        if newHistory.numbering != old.numbering || newHistory.cols != old.cols {
            redrawTiles() // counted afresh: a row number names another row now
        } else {
            // Lines appended (or a shorter copy): the live rows below the history took other numbers.
            let oldEnd = old.firstRowNumber + old.rowCount
            let newEnd = liveBase
            if newEnd != oldEnd { invalidate(rows: min(oldEnd, newEnd)..<Int.max) }
            // Lines dropped at the front: the tiles stay with their rows; the rows that left are blank now.
            if newHistory.firstRowNumber != old.firstRowNumber {
                invalidate(rows: min(old.firstRowNumber, newHistory.firstRowNumber)..<max(old.firstRowNumber, newHistory.firstRowNumber))
                placeTiles()
            }
        }
        setNeedsLayout()
    }

    /// The rows of the history lines drawn lately, by line number: a line's rows are made once, not for each of its rows
    /// in every tile (they stay the same until the lines are replaced or wrapped at another width).
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

    /// Each style's text attributes and background under the current theme and text size.
    private var painted: [Style: (attributes: [NSAttributedString.Key: Any], background: UIColor?)] = [:]

    private func paint(_ style: Style) -> (attributes: [NSAttributedString.Key: Any], background: UIColor?) {
        if let hit = painted[style] { return hit }
        let colors = theme.colors(for: style)
        let look = (attributes: metrics.attributes(for: style, foreground: colors.foreground), background: colors.background)
        if painted.count > 1024 { painted = [:] }
        painted[style] = look
        return look
    }

    // MARK: Tiles

    private struct TileGeometry: Equatable {
        var rows: Int
        var lineHeight: CGFloat
        var width: CGFloat
        var gridWidth: CGFloat
    }

    private var tiles: [TileKey: TerminalTile] = [:]
    private var spareTiles: [TerminalTile] = []
    private var tileGeometry: TileGeometry?

    /// Tiles about 256 points tall and up to 512 wide (bands of columns on a grid wider than that): at 3× one is under 5 MB.
    private var currentGeometry: TileGeometry {
        let line = metrics.lineHeight
        let gridWidth = CGFloat(grid.cols) * metrics.cellWidth
        return TileGeometry(rows: max(4, Int(256 / max(1, line))), lineHeight: line, width: min(gridWidth, 512), gridWidth: gridWidth)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutTiles()
    }

    /// Tiles for the rows on screen and a tile's height above and below them; the others go.
    private func layoutTiles() {
        let geometry = currentGeometry
        if geometry != tileGeometry {
            tileGeometry = geometry
            repaintTiles()
        }
        var wanted = Set<TileKey>()
        let line = geometry.lineHeight
        if line > 0, geometry.width > 0, totalRows > 0, visibleRect.width > 0, visibleRect.height > 0 {
            let area = visibleRect.insetBy(dx: 0, dy: -CGFloat(geometry.rows) * line)
            let firstRow = max(0, Int(floor(area.minY / line)))
            let lastRow = min(totalRows - 1, Int(ceil(area.maxY / line)))
            let firstColumn = max(0, Int(floor(area.minX / geometry.width)))
            let lastColumn = min(Int(ceil(geometry.gridWidth / geometry.width)) - 1, Int(floor(area.maxX / geometry.width)))
            if firstRow <= lastRow, firstColumn <= lastColumn {
                let base = history.firstRowNumber
                for band in (base + firstRow) / geometry.rows...(base + lastRow) / geometry.rows {
                    for column in firstColumn...lastColumn { wanted.insert(TileKey(band: band, column: column)) }
                }
            }
        }
        UIView.performWithoutAnimation {
            for (key, tile) in tiles where !wanted.contains(key) {
                tiles[key] = nil
                if spareTiles.count < 2 {
                    tile.isHidden = true
                    spareTiles.append(tile)
                } else {
                    tile.removeFromSuperview()
                }
            }
            for key in wanted where tiles[key] == nil {
                let tile = spareTiles.popLast() ?? TerminalTile()
                tile.owner = self
                tile.key = key
                tile.backgroundColor = theme.background
                tile.frame = tileFrame(key)
                tile.setNeedsDisplay()
                if tile.superview !== self { addSubview(tile) }
                tile.isHidden = false
                tiles[key] = tile
            }
        }
    }

    /// Where tile `key` sits now: its rows keep their numbers while the history's first row number changes.
    private func tileFrame(_ key: TileKey) -> CGRect {
        let geometry = tileGeometry ?? currentGeometry
        let x = CGFloat(key.column) * geometry.width
        return CGRect(x: x, y: CGFloat(key.band * geometry.rows - history.firstRowNumber) * geometry.lineHeight,
                      width: max(0, min(geometry.width, geometry.gridWidth - x)), height: CGFloat(geometry.rows) * geometry.lineHeight)
    }

    private func placeTiles() {
        UIView.performWithoutAnimation {
            for (key, tile) in tiles { tile.frame = tileFrame(key) }
        }
    }

    /// Every tile placed and drawn afresh (its rows are other rows now, or are drawn otherwise), then the tiles laid out
    /// for what is on screen.
    private func redrawTiles() {
        repaintTiles()
        setNeedsLayout()
    }

    private func repaintTiles() {
        placeTiles()
        for tile in tiles.values { tile.setNeedsDisplay() }
    }

    /// Rows `rows` (row numbers, as the tiles count them) drawn again where tiles hold them.
    private func invalidate(rows: Range<Int>) {
        guard let geometry = tileGeometry, !rows.isEmpty else { return }
        for (key, tile) in tiles {
            let first = key.band * geometry.rows
            let lo = max(rows.lowerBound, first)
            let hi = min(rows.upperBound, first + geometry.rows)
            guard lo < hi else { continue }
            tile.setNeedsDisplay(CGRect(x: 0, y: CGFloat(lo - first) * geometry.lineHeight, width: tile.bounds.width,
                                        height: CGFloat(hi - lo) * geometry.lineHeight))
        }
    }

    // MARK: Selection overlay

    /// The selection's first row, its full rows between, and its last row: plain coloured views above the tiles.
    private var selectionViews: [UIView] = []

    private func showSelection() {
        UIView.performWithoutAnimation {
            var rects: [CGRect] = []
            // Hidden while a slide moves the rows under it (as it was never drawn mid-slide).
            if let selection, grid.cols > 0, slideOffset == 0 || slideMovingRows == 0 {
                let (start, end) = ordered(selection)
                let w = metrics.cellWidth
                let h = metrics.lineHeight
                func add(rows r0: Int, _ r1: Int, cols c0: Int, _ c1: Int) {
                    guard r1 >= r0, c1 >= c0 else { return }
                    rects.append(CGRect(x: CGFloat(c0) * w, y: CGFloat(r0) * h, width: CGFloat(c1 - c0 + 1) * w,
                                        height: CGFloat(r1 - r0 + 1) * h))
                }
                if start.row == end.row {
                    add(rows: start.row, start.row, cols: start.col, end.col)
                } else {
                    add(rows: start.row, start.row, cols: start.col, grid.cols - 1)
                    add(rows: start.row + 1, end.row - 1, cols: 0, grid.cols - 1)
                    add(rows: end.row, end.row, cols: 0, end.col)
                }
            }
            for (i, view) in selectionViews.enumerated() {
                view.isHidden = i >= rects.count
                if i < rects.count { view.frame = rects[i] }
            }
        }
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
        invalidate(rows: liveBase..<liveBase + max(slideMovingRows, m))
        slideMovingRows = m
        slideVelocity = abs(slideOffset) / max(0.03, duration)
        if displayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(slideTick(_:)))
            link.add(to: .main, forMode: .common)
            displayLink = link
            lastSlideTick = 0
        }
        showSelection()
    }

    func endSlide() {
        displayLink?.invalidate()
        displayLink = nil
        guard slideOffset != 0 || !leavingRows.isEmpty else { return }
        invalidate(rows: liveBase..<liveBase + slideMovingRows)
        slideOffset = 0
        leavingRows = []
        showSelection()
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
        invalidate(rows: liveBase..<liveBase + slideMovingRows)
    }

    /// Bounding box of the selection in this view's (content) coordinates (full width when it spans rows).
    func selectionRect() -> CGRect? {
        guard let selection else { return nil }
        let (start, end) = ordered(selection)
        let single = start.row == end.row
        let x0 = single ? CGFloat(start.col) * metrics.cellWidth : 0
        let x1 = single ? CGFloat(end.col + 1) * metrics.cellWidth : CGFloat(grid.cols) * metrics.cellWidth
        return CGRect(x: x0, y: CGFloat(start.row) * metrics.lineHeight, width: x1 - x0,
                      height: CGFloat(end.row - start.row + 1) * metrics.lineHeight)
    }

    /// Cell (history and live rows counted together) under a point in this view's (content) coordinates; columns clamp
    /// to the grid, rows outside the content are nil.
    func cell(at point: CGPoint) -> GridPosition? {
        guard metrics.cellWidth > 0, metrics.lineHeight > 0, totalRows > 0, grid.cols > 0 else { return nil }
        let row = Int(floor(point.y / metrics.lineHeight))
        guard row >= 0, row < totalRows else { return nil }
        let col = Int(floor(point.x / metrics.cellWidth))
        return GridPosition(row: row, col: min(max(col, 0), grid.cols - 1))
    }

    /// Centre of a cell in this view's (content) coordinates.
    func cellCenter(_ p: GridPosition) -> CGPoint {
        CGPoint(x: (CGFloat(p.col) + 0.5) * metrics.cellWidth, y: (CGFloat(p.row) + 0.5) * metrics.lineHeight)
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
        let first = max(0, Int(ceil(visibleRect.minY / line - 0.5)))
        let last = min(totalRows - 1, Int(floor(visibleRect.maxY / line - 0.5)))
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
        // No drawing of its own (no backing store the size of the content): the scroll view's background shows where no
        // tile is, the tiles and the selection views draw the rest.
        isOpaque = false
        backgroundColor = nil
        selectionViews = (0..<3).map { _ in
            let view = UIView()
            view.isUserInteractionEnabled = false
            view.isHidden = true
            view.backgroundColor = theme.selection
            view.layer.zPosition = 1 // above the tiles
            addSubview(view)
            return view
        }
    }

    /// The live grid's size (the history rows above it take `liveTop`).
    var gridSize: CGSize {
        CGSize(width: CGFloat(grid.cols) * metrics.cellWidth, height: CGFloat(grid.rows) * metrics.lineHeight)
    }

    /// Replaces the grid and draws again only the rows that differ.
    func update(grid newGrid: TerminalGrid) {
        let old = grid
        grid = newGrid
        let base = liveBase
        if old.cols != newGrid.cols || old.rows != newGrid.rows {
            endSlide()
            invalidate(rows: base..<Int.max)
            setNeedsLayout() // other rows (and, for other columns, other tiles)
            showSelection()
            return
        }
        // Style ids that name another style now (a reconnect empties the table and the next frame fills it again, under
        // the same cells): rows using them are drawn again too.
        var restyled = Set<Int>()
        if old.styles != newGrid.styles {
            for (id, style) in old.styles where newGrid.styles[id] != style { restyled.insert(id) }
            for id in newGrid.styles.keys where old.styles[id] == nil { restyled.insert(id) }
        }
        for y in 0..<newGrid.rows {
            let row = newGrid.cells[y]
            guard old.cells[y] != row || (!restyled.isEmpty && row.contains(where: { restyled.contains($0.styleId) })) else { continue }
            // with the rows beside it: a glyph reaching past its row box is drawn into them
            invalidate(rows: base + y - 1..<base + y + 2)
        }
    }

    /// Draws the content within `rect` (content coordinates) into a tile's context, whose top-left is content point
    /// `origin`. Rows are drawn from one above `rect` (a glyph reaching below its row shows as it would anywhere else).
    fileprivate func drawContent(_ rect: CGRect, origin: CGPoint, in ctx: CGContext) {
        ctx.setFillColor(theme.background.cgColor)
        ctx.fill(rect.offsetBy(dx: -origin.x, dy: -origin.y))
        let lineHeight = metrics.lineHeight
        guard lineHeight > 0 else { return }
        let visibleX = rect.minX...rect.maxX
        ctx.saveGState()
        ctx.translateBy(x: -origin.x, y: -origin.y)
        let historyCount = history.rowCount
        if historyCount > 0 {
            // Only the rows in the tile, straight from their runs: the cost of a tile does not grow with the history.
            let first = max(0, Int(floor(rect.minY / lineHeight)) - 1)
            let last = min(historyCount - 1, Int(ceil(rect.maxY / lineHeight)))
            if first <= last {
                for y in first...last { drawRuns(historyRow(y), top: CGFloat(y) * lineHeight, in: ctx, visibleX: visibleX) }
            }
        }
        // The live grid below them, in its own coordinates (live row y at y × lineHeight).
        let top = liveTop
        ctx.translateBy(x: 0, y: top)
        drawLive(gridRect: rect.offsetBy(dx: 0, dy: -top), in: ctx, visibleX: visibleX)
        ctx.restoreGState()
    }

    /// The live grid's rows within `gridRect` (live-grid coordinates; the context is translated to match).
    private func drawLive(gridRect: CGRect, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let lineHeight = metrics.lineHeight
        guard grid.rows > 0 else { return }
        let first = max(0, Int(floor(gridRect.minY / lineHeight)) - 1)
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

    private func drawRow(_ y: Int, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        drawCells(grid.cells[y], top: CGFloat(y) * metrics.lineHeight, in: ctx, visibleX: visibleX)
    }

    /// One row of cells with its top edge at `top` (grid coordinates): a same-style stretch of characters that fit their
    /// cells (`TerminalMetrics.fitsCell`) in one draw, any other character centred in its cell box.
    private func drawCells(_ row: [Cell], top: CGFloat, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let cols = row.count
        let cellWidth = metrics.cellWidth
        var x = 0
        while x < cols {
            let cell = row[x]
            if cell.width == 0 { x += 1; continue }
            let style = grid.style(cell.styleId)
            let font = metrics.font(for: style.attributes)
            var end = x + max(cell.width, 1)
            let grouped = cell.width == 1 && metrics.fitsCell(cell.text, font: font)
            if grouped {
                while end < cols, row[end].width == 1, row[end].styleId == cell.styleId, metrics.fitsCell(row[end].text, font: font) {
                    end += 1
                }
            }
            let originX = CGFloat(x) * cellWidth
            let width = CGFloat(end - x) * cellWidth
            if originX + width < visibleX.lowerBound || originX > visibleX.upperBound { x = end; continue } // off-screen columns
            let look = paint(style)
            if let bg = look.background {
                ctx.setFillColor(bg.cgColor)
                ctx.fill(CGRect(x: originX, y: top, width: width, height: metrics.lineHeight))
            }
            let text = grouped ? row[x..<end].map(\.text).joined() : cell.text
            if !text.allSatisfy({ $0 == " " }) {
                let attributed = NSAttributedString(string: text, attributes: look.attributes)
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
    /// straight from the runs, so a row costs no cell array: a stretch of characters that fit their cells in one draw,
    /// any other narrow character centred in its cell, a run with wide characters centred in its cells.
    private func drawRuns(_ runs: [WireRun], top: CGFloat, in ctx: CGContext, visibleX: ClosedRange<CGFloat>) {
        let cellWidth = metrics.cellWidth
        for run in runs where run.w > 0 {
            let originX = CGFloat(run.c) * cellWidth
            let width = CGFloat(run.w) * cellWidth
            if originX + width < visibleX.lowerBound || originX > visibleX.upperBound { continue } // off-screen columns
            let style = historyStyles.style(run.s)
            let look = paint(style)
            if let bg = look.background {
                ctx.setFillColor(bg.cgColor)
                ctx.fill(CGRect(x: originX, y: top, width: width, height: metrics.lineHeight))
            }
            if run.t.allSatisfy({ $0 == " " }) { continue }
            let utf8 = run.t.utf8
            if utf8.count == run.w, utf8.allSatisfy({ (0x20...0x7E).contains($0) }) {
                NSAttributedString(string: run.t, attributes: look.attributes).draw(at: CGPoint(x: originX, y: top))
            } else if run.t.count == run.w {
                let font = metrics.font(for: style.attributes)
                var stretch = ""
                var stretchX = originX
                var x = originX
                func drawStretch() {
                    if !stretch.allSatisfy({ $0 == " " }) {
                        NSAttributedString(string: stretch, attributes: look.attributes).draw(at: CGPoint(x: stretchX, y: top))
                    }
                    stretch = ""
                }
                for character in run.t {
                    let text = String(character)
                    if metrics.fitsCell(text, font: font) {
                        if stretch.isEmpty { stretchX = x }
                        stretch += text
                    } else {
                        drawStretch()
                        let glyph = NSAttributedString(string: text, attributes: look.attributes)
                        glyph.draw(at: CGPoint(x: x + max(0, (cellWidth - glyph.size().width) / 2), y: top))
                    }
                    x += cellWidth
                }
                drawStretch()
            } else {
                let glyph = NSAttributedString(string: run.t, attributes: look.attributes)
                glyph.draw(at: CGPoint(x: originX + max(0, (width - glyph.size().width) / 2), y: top))
            }
        }
    }
}
