// Contrast of terminal colours and the Light theme's readability nudge (shared/design/DESIGN.md §1).
import FlowKit
import XCTest

final class ContrastTests: XCTestCase {
    private let white = RGB(255, 255, 255)
    private let black = RGB(0, 0, 0)

    func testRatio() {
        XCTAssertEqual(Contrast.ratio(black, white), 21, accuracy: 0.01)
        XCTAssertEqual(Contrast.ratio(white, black), 21, accuracy: 0.01)
        XCTAssertEqual(Contrast.ratio(white, white), 1, accuracy: 0.0001)
        // #767676 is the classic lightest grey that reaches 4.5 : 1 on white.
        XCTAssertEqual(Contrast.ratio(RGB(0x76, 0x76, 0x76), white), 4.54, accuracy: 0.01)
    }

    func testReadableColoursAreKept() {
        let navy = RGB(0x16, 0x18, 0x1D)
        XCTAssertEqual(Contrast.readable(navy, on: white, minimum: 4.5), navy)
        XCTAssertEqual(Contrast.readable(white, on: white, minimum: 1), white, "1 turns the floor off")
    }

    func testWhiteTextOnALightBackgroundDarkens() {
        let out = Contrast.readable(white, on: white, minimum: 4.5)
        XCTAssertGreaterThanOrEqual(Contrast.ratio(out, white), 4.5)
        XCTAssertNotEqual(out, black, "stops at the first tenth that reads, not at black")
    }

    func testPaleTextKeepsItsHue() {
        // Claude Code's orange on the Light theme: darker, still orange (red above green above blue).
        let out = Contrast.readable(RGB(215, 119, 87), on: white, minimum: 4.5)
        XCTAssertGreaterThanOrEqual(Contrast.ratio(out, white), 4.5)
        XCTAssertGreaterThan(out.r, out.g)
        XCTAssertGreaterThan(out.g, out.b)
    }

    func testDarkTextOnADarkBackgroundLightens() {
        let bg = RGB(0x1E, 0x1E, 0x2E)
        let out = Contrast.readable(RGB(0x20, 0x20, 0x30), on: bg, minimum: 4.5)
        XCTAssertGreaterThanOrEqual(Contrast.ratio(out, bg), 4.5)
        XCTAssertGreaterThan(Contrast.luminance(out), Contrast.luminance(bg))
    }

    func testThemeAnsiColours() {
        let ansi = (0..<16).map { RGB(UInt8($0), 0, 0) }
        XCTAssertEqual(TerminalColor.palette(3).rgb(ansi: ansi), RGB(3, 0, 0))
        XCTAssertEqual(TerminalColor.palette(15).rgb(ansi: ansi), RGB(15, 0, 0))
        XCTAssertEqual(TerminalColor.palette(16).rgb(ansi: ansi), TerminalPalette.rgb(16), "the cube is the same in every theme")
        XCTAssertEqual(TerminalColor.rgb(RGB(1, 2, 3)).rgb(ansi: ansi), RGB(1, 2, 3))
        XCTAssertNil(TerminalColor.default.rgb(ansi: ansi))
        XCTAssertEqual(TerminalColor.palette(3).rgb(ansi: []), TerminalPalette.rgb(3), "no table: the built-in one")
        XCTAssertEqual(TerminalColor.palette(-1).rgb(ansi: ansi), TerminalPalette.rgb(-1), "out of range: the built-in lookup")
    }
}
