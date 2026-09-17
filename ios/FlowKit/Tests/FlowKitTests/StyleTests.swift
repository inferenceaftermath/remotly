// Style bitmask → attributes and colour parsing (shared/protocol/remotly-protocol.md §7).
import FlowKit
import XCTest

final class StyleTests: XCTestCase {
    func testBitmaskToAttributes() {
        XCTAssertEqual(Style(a: 0).attributes, [])
        XCTAssertEqual(Style(a: 1).attributes, .bold)
        XCTAssertEqual(Style(a: 2).attributes, .dim)
        XCTAssertEqual(Style(a: 4).attributes, .italic)
        XCTAssertEqual(Style(a: 8).attributes, .underline)
        XCTAssertEqual(Style(a: 16).attributes, .inverse)
        XCTAssertEqual(Style(a: 32).attributes, .strikethrough)
        XCTAssertEqual(Style(a: 64).attributes, .blink)
        let combined = Style(a: 1 | 8 | 16).attributes
        XCTAssertTrue(combined.contains(.bold))
        XCTAssertTrue(combined.contains(.underline))
        XCTAssertTrue(combined.contains(.inverse))
        XCTAssertFalse(combined.contains(.dim))
    }

    func testColourParsing() {
        XCTAssertEqual(TerminalColor(wire: "d"), .default)
        XCTAssertEqual(TerminalColor(wire: "p0"), .palette(0))
        XCTAssertEqual(TerminalColor(wire: "p255"), .palette(255))
        XCTAssertEqual(TerminalColor(wire: "p256"), .default, "out of range palette → default")
        XCTAssertEqual(TerminalColor(wire: "#0ac878"), .rgb(RGB(0x0A, 0xC8, 0x78)))
        XCTAssertEqual(TerminalColor(wire: "#FFFFFF"), .rgb(RGB(255, 255, 255)))
        XCTAssertEqual(TerminalColor(wire: "#fff"), .default, "malformed → default")
        XCTAssertEqual(TerminalColor(wire: "garbage"), .default)
        XCTAssertNil(TerminalColor.default.rgb)
    }

    func testPaletteValues() {
        XCTAssertEqual(TerminalPalette.rgb(27), RGB(0, 95, 255))
        XCTAssertEqual(TerminalPalette.rgb(208), RGB(255, 135, 0))
        XCTAssertEqual(TerminalPalette.rgb(16), RGB(0, 0, 0))
        XCTAssertEqual(TerminalPalette.rgb(231), RGB(255, 255, 255))
        XCTAssertEqual(TerminalPalette.rgb(232), RGB(8, 8, 8))
        XCTAssertEqual(TerminalPalette.rgb(255), RGB(238, 238, 238))
        // ANSI 0–15 follow shared/design/DESIGN.md §1 (Tokyo Night-derived); the cube and greys stay xterm's.
        XCTAssertEqual(TerminalPalette.rgb(0), RGB(0x1B, 0x22, 0x30))
        XCTAssertEqual(TerminalPalette.rgb(1), RGB(0xF7, 0x76, 0x8E))
        XCTAssertEqual(TerminalPalette.rgb(15), RGB(0xC0, 0xCA, 0xF5))
        XCTAssertEqual(TerminalColor(wire: "p4").rgb, TerminalPalette.rgb(4))
    }

    func testStyleDecodingDefaultsMissingFields() throws {
        let style = try JSONDecoder().decode(Style.self, from: Data(#"{"fg":"p2"}"#.utf8))
        XCTAssertEqual(style, Style(fg: "p2", bg: "d", a: 0))
        XCTAssertEqual(Style.default, Style(fg: "d", bg: "d", a: 0))
    }
}
