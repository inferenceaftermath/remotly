import Foundation
import Network
import XCTest
@testable import FlowKit

final class ConnectionLifetimeTests: XCTestCase {
    func testDemoEntryCancelsApproveAndReplyAwaitingWelcome() async throws {
        for approve in [true, false] {
            let peer = try DelayedWelcomePeer()
            defer { peer.stop() }
            let host = try await peer.start()
            let lifetime = ConnectionLifetime()
            let action = Task { await runAction(approve: approve, host: host, lifetime: lifetime) }
            try await peer.waitForHello()
            lifetime.cancel() // Same synchronous invalidation used before AppModel switches its visible mode.
            peer.welcome()
            let result = try await withTimeout(.seconds(5)) { await action.value }
            XCTAssertFalse(result.sent)
            XCTAssertEqual(peer.receivedTypes, ["hello"])
            // Creating another client with the old lifetime must remain harmless after leaving demo.
            let stale = await runAction(approve: approve, host: host, lifetime: lifetime)
            XCTAssertFalse(stale.sent)
            XCTAssertEqual(peer.receivedTypes, ["hello"])
        }
    }

    func testFreshLifetimeSendsBothNotificationActions() async throws {
        for approve in [true, false] {
            let peer = try DelayedWelcomePeer()
            defer { peer.stop() }
            let host = try await peer.start()
            let action = Task { await runAction(approve: approve, host: host, lifetime: ConnectionLifetime()) }
            try await peer.waitForHello()
            peer.welcome()
            let result = try await withTimeout(.seconds(5)) { await action.value }
            XCTAssertTrue(result.sent)
            XCTAssertTrue(peer.receivedTypes.contains(approve ? "approve" : "prompt"))
        }
    }
}

private func runAction(approve: Bool, host: PairedHost, lifetime: ConnectionLifetime) async -> ApprovalOutcomeSummary {
    let client = ClientInfo(appVersion: "test", deviceName: "test")
    if approve {
        let payload = PushPayload(kind: .approval, host: "Test", pane: "test-pane", promptId: "test-pane@1", agent: "claude")
        return await ApprovalActionClient.perform(action: .approve, payload: payload, host: host, client: client,
                                                  timeout: .seconds(5), lifetime: lifetime)
    }
    return await ApprovalActionClient.reply(text: "sample reply", notify: false, pane: "test-pane", agent: "claude",
                                            host: host, client: client, timeout: .seconds(5), lifetime: lifetime)
}

/// A loopback-only real WebSocket peer. Tests control welcome delivery instead of sleeping or mocking the send gate.
private final class DelayedWelcomePeer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "remotly.test.delayed-welcome")
    private let lock = NSLock()
    private var connection: NWConnection?
    private var types: [String] = []
    private let ready: AsyncStream<UInt16>
    private let readySink: AsyncStream<UInt16>.Continuation
    private let hello: AsyncStream<Void>
    private let helloSink: AsyncStream<Void>.Continuation
    var receivedTypes: [String] { lock.withLock { types } }

    init() throws {
        (ready, readySink) = AsyncStream.makeStream()
        (hello, helloSink) = AsyncStream.makeStream()
        let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        listener = try NWListener(using: parameters)
    }

    func start() async throws -> PairedHost {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state, let port = self.listener.port { self.readySink.yield(port.rawValue) }
            if case .failed = state { self.readySink.finish() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.lock.withLock { self.connection = connection }
            connection.start(queue: self.queue)
            self.receive(connection)
        }
        listener.start(queue: queue)
        let port = try await withTimeout(.seconds(5)) { [ready] in
            for await port in ready { return port }
            throw FlowError.closed
        }
        return PairedHost(name: "Test", url: URL(string: "ws://127.0.0.1:\(port)")!, fingerprint: nil, token: "test-token", deviceId: "test")
    }

    func waitForHello() async throws {
        try await withTimeout(.seconds(5)) { [hello] in
            for await _ in hello { return }
            throw FlowError.closed
        }
    }

    func welcome() {
        send(#"{"t":"welcome","protocol":1,"host":{"name":"Test","flow_version":"test"},"device":{"id":"test","name":"Test"},"notify_done":[]}"#)
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = message["t"] as? String {
                self.lock.withLock { self.types.append(type) }
                if type == "hello" { self.helloSink.yield(()) }
                else if let id = message["id"] as? String {
                    self.send("{\"t\":\"ok\",\"id\":\"\(id)\"}")
                    if type == "approve" {
                        self.send(#"{"t":"approval.result","pane":"test-pane","prompt_id":"test-pane@1","outcome":"sent"}"#)
                    }
                }
            }
            if error == nil { self.receive(connection) }
        }
    }

    private func send(_ text: String) {
        let connection = lock.withLock { self.connection }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "test-message", metadata: [metadata])
        connection?.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    func stop() {
        listener.cancel()
        lock.withLock { connection }?.cancel()
        readySink.finish(); helloSink.finish()
    }
}
