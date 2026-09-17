// UIKit grid renderer: one NSAttributedString draw per same-style run of ASCII cells, one per
// non-ASCII or wide cell (centred in its cell box so fallback fonts cannot drift the columns).
// Redraws only rows whose cells changed. The view is only ever viewport-sized: the scroll view
// pins it to the visible area and sets `origin`, so a 999-row scrollback never becomes one giant
// layer (Core Animation stops rendering backing stores beyond the GPU texture limit — the screen
// would simply go blank).
import FlowKit
import UIKit

@MainActor
enum TerminalTheme {
    // shared/design/DESIGN.md §1: the terminal is flush on the screen's `bg`, text in `fg`, selection in `selection`.
    static let background = UIColor(rgb: 0x0B0C0E)
    static let foreground = UIColor(rgb: 0xE0E2E5)
    static let selection = UIColor(rgb: 0x7AA2F7).withAlphaComponent(0.35)

    static func uiColor(_ rgb: RGB) -> UIColor {
        UIColor(red: CGFloat(rgb.r) / 255, green: CGFloat(rgb.g) / 255, blue: CGFloat(rgb.b) / 255, alpha: 1)
    }

    /// Foreground/background after applying inverse and dim. `background == nil` means "theme default".
    static func colors(for style: Style) -> (foreground: UIColor, background: UIColor?) {
        // Closure literals, not `.map(uiColor)`: passing the main-actor static method as a bare function
        // value would drop its global actor in the conversion.
        var fg = style.foreground.rgb.map { uiColor($0) } ?? foreground
        var bg = style.background.rgb.map { uiColor($0) }
        let attributes = style.attributes
        if attributes.contains(.inverse) {
            let newBackground = fg
            fg = bg ?? background
            bg = newBackground
        }
        if attributes.contains(.dim) { fg = fg.withAlphaComponent(0.55) }
        return (fg, bg)
    }
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
    var metrics = TerminalMetrics(size: 12) {
        didSet { if metrics.size != oldValue.size { setNeedsDisplay() } }
    }
    /// Grid point (in grid coordinates: cols × cellWidth, rows × lineHeight) shown at this view's top-left.
    var origin: CGPoint = .zero {
        didSet { if origin != oldValue { setNeedsDisplay() } }
    }
    /// Long-press selection (anchor, focus cells) drawn as a translucent overlay; nil when nothing is selected.
    var selection: (anchor: GridPosition, focus: GridPosition)? {
        didSet { setNeedsDisplay() }
    }

    var selectionText: String? {
        selection.map { grid.text(from: $0.anchor, to: $0.focus) }
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
        let region = CGRect(x: 0, y: -origin.y, width: bounds.width, height: CGFloat(slideMovingRows) * metrics.lineHeight)
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

    /// Cell under a point in this view's coordinates; columns clamp to the grid, rows outside it are nil.
    func cell(at point: CGPoint) -> GridPosition? {
        guard metrics.cellWidth > 0, metrics.lineHeight > 0, grid.rows > 0, grid.cols > 0 else { return nil }
        let row = Int(floor((point.y + origin.y) / metrics.lineHeight))
        guard row >= 0, row < grid.rows else { return nil }
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
        backgroundColor = TerminalTheme.background
        contentMode = .redraw
    }

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

    /// Row `y` in this view's coordinates.
    private func rowRect(_ y: Int) -> CGRect {
        CGRect(x: 0, y: CGFloat(y) * metrics.lineHeight - origin.y, width: bounds.width, height: metrics.lineHeight)
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setFillColor(TerminalTheme.background.cgColor)
        ctx.fill(rect)
        let lineHeight = metrics.lineHeight
        guard lineHeight > 0, grid.rows > 0 else { return }
        // Work in grid coordinates: shift the context so row y sits at y × lineHeight.
        let gridRect = rect.offsetBy(dx: origin.x, dy: origin.y)
        let first = max(0, Int(floor(gridRect.minY / lineHeight)))
        let last = min(grid.rows - 1, Int(ceil(gridRect.maxY / lineHeight)))
        guard first <= last else { return }
        ctx.saveGState()
        ctx.translateBy(x: -origin.x, y: -origin.y)
        let visibleX = gridRect.minX...gridRect.maxX
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
            drawSelection(first: first, last: last, in: ctx)
        }
        ctx.restoreGState()
    }

    private func drawSelection(first: Int, last: Int, in ctx: CGContext) {
        guard let selection else { return }
        let (start, end) = ordered(selection)
        let lo = max(first, start.row)
        let hi = min(last, end.row)
        guard lo <= hi else { return }
        ctx.setFillColor(TerminalTheme.selection.cgColor)
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
            let colors = TerminalTheme.colors(for: style)
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

    /// One printable ASCII character: safe to concatenate because SF Mono advances are uniform.
    private static func isPlainASCII(_ text: String) -> Bool {
        let utf8 = text.utf8
        guard utf8.count == 1, let byte = utf8.first else { return false }
        return (0x20...0x7E).contains(byte)
    }
}
