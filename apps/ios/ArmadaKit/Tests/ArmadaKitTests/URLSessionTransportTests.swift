import Foundation
import Testing
@testable import ArmadaKit

// Only this reserved host is intercepted. No sockets or production session inspection.
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

@Suite(.serialized)
struct URLSessionTransportTests {
    private func request(_ path: String, bearer: String? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://transport.invalid/\(path)")!)
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        return request
    }

    @Test func concurrentAndSubsequentRequestsDoNotShareAuthentication() async throws {
        #expect(URLProtocol.registerClass(TransportProtocol.self))
        defer {
            URLProtocol.unregisterClass(TransportProtocol.self)
            TransportProtocol.handle(nil)
        }
        TransportProtocol.handle { $0.reply() }
        let transport = URLSessionTransport()
        async let first = transport.send(request("first", bearer: "fixture_first"))
        async let second = transport.send(request("second", bearer: "fixture_second"))
        let (a, b) = try await (first, second)
        #expect(String(decoding: a.0, as: UTF8.self) == "Bearer fixture_first|none")
        #expect(String(decoding: b.0, as: UTF8.self) == "Bearer fixture_second|none")
        let anonymous = try await transport.send(request("anonymous"))
        #expect(String(decoding: anonymous.0, as: UTF8.self) == "none|none")
    }

    @Test func cancellingOneRequestLeavesOtherRequestsUsable() async throws {
        #expect(URLProtocol.registerClass(TransportProtocol.self))
        defer {
            URLProtocol.unregisterClass(TransportProtocol.self)
            TransportProtocol.handle(nil)
        }
        let (started, signal) = AsyncStream<Void>.makeStream()
        TransportProtocol.handle { fixture in
            if fixture.request.url?.path == "/held" { signal.yield(()) }
            else { fixture.reply() }
        }
        let transport = URLSessionTransport()
        let heldRequest = request("held")
        let held = Task { try await transport.send(heldRequest) }
        for await _ in started { break }
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
        signal.finish()
    }
}
