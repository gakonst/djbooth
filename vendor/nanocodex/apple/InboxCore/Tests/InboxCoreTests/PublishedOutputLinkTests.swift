import Foundation
import XCTest
@testable import InboxCore

final class PublishedOutputLinkTests: XCTestCase {
    func testParsesVideoAndBundleLinksInOrderWithoutDuplicates() {
        let source = """
        [Main launch video](sandbox:/brain/outputs/frontiers-next/frontiers-merch-launch-actual-character.mp4)
        [Download bundle](sandbox:/brain/outputs/frontiers-next/frontiers-launch-and-drops.zip)
        [Repeat](sandbox:/brain/outputs/frontiers-next/frontiers-merch-launch-actual-character.mp4)
        [Ordinary website](https://www.paradigm.xyz/frontiers-2026/merch)
        """
        let links = PublishedOutputLink.parse(source)
        XCTAssertEqual(links.map(\.title), ["Main launch video", "Download bundle"])
        XCTAssertTrue(links[0].isVideo)
        XCTAssertEqual(links[0].filename, "frontiers-merch-launch-actual-character.mp4")
        XCTAssertFalse(links[1].isVideo)
    }

    func testLinkLookingTextInCodeDoesNotBecomeAFileCard() {
        let source = """
        `[inline](sandbox:/brain/outputs/inline.mp4)`
        ```md
        [fenced](sandbox:/brain/outputs/fenced.mp4)
        ```
        [real](sandbox:/brain/outputs/real.mp4)
        """
        XCTAssertEqual(PublishedOutputLink.parse(source).map(\.filename), ["real.mp4"])
    }

    func testRejectsOtherHandsAndPathTraversal() {
        for source in ["sandbox:/etc/passwd", "sandbox:/brain/tmp/private.mp4", "sandbox:/brain/outputs/../secret.mp4",
                       "sandbox:/brain/outputs/%2e%2e/secret.mp4", "sandbox:/brain/outputs//x.mp4",
                       "sandbox:/brain/outputs/x.mp4?token=secret", "sandbox://foreign/brain/outputs/x.mp4"] {
            XCTAssertNil(URL(string: source).flatMap { PublishedOutputLink(url: $0) }, source)
        }
        XCTAssertTrue(PublishedOutputLink.parse("[bad](sandbox:/brain/outputs/../secret.mp4) [good](sandbox:/brain/outputs/good.mp4)").map(\.filename) == ["good.mp4"])
    }
}
