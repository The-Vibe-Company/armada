import Foundation
import Testing
@testable import ArmadaKit

// Only this reserved host is intercepted. No sockets or production session inspection.
// URLSession ignores URLProtocol.registerClass (that API only reaches NSURLConnection),
// so the protocol is installed on the session configuration instead.
private final class TransportProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (TransportProtocol) -> Void)?

    static func handle(_ value: (@Sendable (TransportProtocol) -> Void)?) {
        lock.withLock { handler = value }
    }
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "transport.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let callback = Self.lock.withLock { Self.handler }
        callback?(self)
    }
    override func stopLoading() {}

    func reply() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Set-Cookie": "session=fixture_cookie; Path=/"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        // Echo what actually reached the URL loading boundary, not the input request.
        let headers = [request.value(forHTTPHeaderField: "Authorization") ?? "none",
                       request.value(forHTTPHeaderField: "Cookie") ?? "none"]
        client?.urlProtocol(self, didLoad: Data(headers.joined(separator: "|").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// Resumes exactly once, whichever of the signal and the timeout arrives first.
private final class FirstSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var settled = false

    func arm(_ continuation: CheckedContinuation<Bool, Never>) {
        lock.withLock { self.continuation = continuation }
    }

    func settle(_ value: Bool) {
        let pending = lock.withLock { () -> CheckedContinuation<Bool, Never>? in
            guard !settled, let continuation else { return nil }
            settled = true
            self.continuation = nil
            return continuation
        }
        pending?.resume(returning: value)
    }
}

@Suite(.serialized)
struct URLSessionTransportTests {
    private func transport() -> URLSessionTransport {
        let configuration = URLSessionTransport.ephemeralConfiguration()
        configuration.protocolClasses = [TransportProtocol.self]
        return URLSessionTransport(configuration: configuration)
    }

    private func request(_ path: String, bearer: String? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://transport.invalid/\(path)")!)
        request.timeoutInterval = 5
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        return request
    }

    /// Fails the test instead of hanging the job if the expected signal never arrives.
    private func awaitFirst(_ stream: AsyncStream<Void>) async {
        let gate = FirstSignal()
        let arrived = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            gate.arm(continuation)
            Task {
                for await _ in stream {
                    gate.settle(true)
                    return
                }
                gate.settle(false)
            }
            Task {
                try? await Task.sleep(for: .seconds(5))
                gate.settle(false)
            }
        }
        #expect(arrived, "Timed out waiting for the transport to start the request")
    }

    @Test func concurrentAndSubsequentRequestsDoNotShareAuthentication() async throws {
        defer { TransportProtocol.handle(nil) }
        TransportProtocol.handle { $0.reply() }
        let transport = transport()
        async let first = transport.send(request("first", bearer: "fixture_first"))
        async let second = transport.send(request("second", bearer: "fixture_second"))
        let (a, b) = try await (first, second)
        #expect(String(decoding: a.0, as: UTF8.self) == "Bearer fixture_first|none")
        #expect(String(decoding: b.0, as: UTF8.self) == "Bearer fixture_second|none")
        let anonymous = try await transport.send(request("anonymous"))
        #expect(String(decoding: anonymous.0, as: UTF8.self) == "none|none")
    }

    @Test func cancellingOneRequestLeavesOtherRequestsUsable() async throws {
        defer { TransportProtocol.handle(nil) }
        let (started, signal) = AsyncStream<Void>.makeStream()
        TransportProtocol.handle { fixture in
            if fixture.request.url?.path == "/held" { signal.yield(()) }
            else { fixture.reply() }
        }
        defer { signal.finish() }
        let transport = transport()
        let held = Task { try await transport.send(request("held")) }
        await awaitFirst(started)
        let other = try await transport.send(request("other"))
        #expect(other.1.statusCode == 200)
        held.cancel()
        do {
            _ = try await held.value
            Issue.record("Cancelled request unexpectedly completed")
        } catch {
            #expect((error as? URLError)?.code == .cancelled || error is CancellationError)
        }
        let later = try await transport.send(request("later"))
        #expect(later.1.statusCode == 200)
    }
}
