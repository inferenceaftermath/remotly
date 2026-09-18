import XCTest

/// Run on a clean dedicated simulator; exercises the same public demo entry used by store reviewers.
@MainActor
final class DemoModeUITests: XCTestCase {
    func testDemoReviewAndReset() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Try demo"].waitForExistence(timeout: 10))
        app.buttons["Try demo"].tap()
        XCTAssertTrue(app.staticTexts["Demo mode · Sample data"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Review a change"].waitForExistence(timeout: 5))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Notifications and photo uploads require a paired host."].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["Demo mode · Sample data"].waitForExistence(timeout: 5))
        capture("01-demo-sessions", app)
        app.staticTexts["Review a change"].tap()
        let approve = app.buttons["Option 1: Approve, marked on the desktop"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        capture("02-demo-approval", app)
        approve.tap()
        XCTAssertTrue(approve.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Attach a photo"].isEnabled)
        capture("03-demo-terminal", app)
        // Background/resume must retain demo and never fall through to a real connection.
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["Exit demo"].waitForExistence(timeout: 5))
        app.buttons["Exit demo"].tap()
        XCTAssertTrue(app.buttons["Try demo"].waitForExistence(timeout: 5))
        app.buttons["Try demo"].tap()
        app.staticTexts["Choose an approach"].tap()
        let choice = app.buttons["Option 2: A small web app"]
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        choice.tap()
        XCTAssertTrue(choice.waitForNonExistence(timeout: 5))
        app.buttons["Exit demo"].tap()
        XCTAssertTrue(app.buttons["Try demo"].waitForExistence(timeout: 5))
    }

    func testCreateAndCloseSample() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        app.buttons["Try demo"].tap()
        app.buttons["New terminal"].tap()
        XCTAssertTrue(app.staticTexts["Demo mode · Sample data"].waitForExistence(timeout: 5))
        let name = app.textFields["Name (optional)"]
        name.tap(); name.typeText("My sample")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["My sample"].waitForExistence(timeout: 5))
        capture("04-new-sample", app)
        app.buttons["More"].tap()
        app.buttons["Close terminal"].tap()
        XCTAssertTrue(app.staticTexts["Removes this local sample session. Your real host is unchanged."].waitForExistence(timeout: 5))
        app.buttons["Close terminal"].tap()
        XCTAssertTrue(app.buttons["New terminal"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["My sample"].exists)
        app.buttons["Exit demo"].tap()
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        _ = app.staticTexts["Fitting…"].waitForNonExistence(timeout: 5)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
