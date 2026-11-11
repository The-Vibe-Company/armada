import Foundation
import Testing
import ObjectiveC
@testable import ArmadaKit

// Custom URLSession instances use configuration-scoped protocols, not the shared
// session's global registry. Interpose the public factory only in this test process,
// once, before transport creation; production needs no testing initializer/API.
private extension URLSessionConfiguration {
    @objc class func transportFixtureEphemeral() -> URLSessionConfiguration {
        let configuration = transportFixtureEphemeral() // Original getter after exchange.
        configuration.protocolClasses = [TransportProtocol.self] + (configuration.protocolClasses ?? [])
        return configuration
    }
}

/// Only claims the fixture's unique hosts; all other package traffic is unchanged.
private final class TransportProtocol: URLProtocol, @unchecked Sendable {
    static let routes = Routes()
    static let installed: Bool = {
        guard let original = class_getClassMethod(URLSessionConfiguration.self,
                                                 #selector(getter: URLSessionConfiguration.ephemeral)),
              let fixture = class_getClassMethod(URLSessionConfiguration.self,
                                                #selector(URLSessionConfiguration.transportFixtureEphemeral)) else { return false }
        method_exchangeImplementations(original, fixture)
        return true
    }()

    final class Routes: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [URL: Route] = [:]
        func add(_ route: Route, at url: URL) { lock.withLock { values[url] = route } }
        func get(_ url: URL?) -> Route? { lock.withLock { url.flatMap { values[$0] } } }
        func remove(_ url: URL) { lock.withLock { values[url] = nil } }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".transport.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let route = Self.routes.get(request.url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        route.start(self)
    }
    override func stopLoading() { Self.routes.get(request.url)?.stop() }

    func reply(status: Int = 200, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .allowed)
        client?.urlProtocol(self, didLoad: Data("fixture".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    func redirect(to url: URL) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 302,
                                       httpVersion: "HTTP/1.1", headerFields: ["Location": url.absoluteString])!
        client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: url), redirectResponse: response)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class Route: @unchecked Sendable {
    private let lock = NSLock()
    private var loader: TransportProtocol?
    private var started: CheckedContinuation<TransportProtocol, Never>?
    private var stopped: CheckedContinuation<Void, Never>?
    private var didStop = false
    private var count = 0
    var starts: Int { lock.withLock { count } }

    func start(_ value: TransportProtocol) {
        let waiter = lock.withLock {
            loader = value
            count += 1
            let waiter = started
            started = nil
            return waiter
        }
        waiter?.resume(returning: value)
    }
    func waitForStart() async -> TransportProtocol {
        await withCheckedContinuation { continuation in
            let value = lock.withLock {
                if let loader { return loader }
                started = continuation
                return nil as TransportProtocol?
            }
            if let value { continuation.resume(returning: value) }
        }
    }
    func stop() {
        let waiter = lock.withLock {
            didStop = true
            let waiter = stopped
            stopped = nil
            return waiter
        }
        waiter?.resume()
    }
    func waitForStop() async {
        await withCheckedContinuation { continuation in
            let done = lock.withLock {
                if didStop { return true }
                stopped = continuation
                return false
            }
            if done { continuation.resume() }
        }
    }
}

private final class TransportFixture {
    let origin = "https://\(UUID().uuidString.lowercased()).transport.test"
    private var urls: [URL] = []
    init() { precondition(TransportProtocol.installed) }
    func route(_ path: String) -> (URLRequest, Route) {
        let url = URL(string: origin + path)!
        let route = Route()
        urls.append(url)
        TransportProtocol.routes.add(route, at: url)
        return (URLRequest(url: url), route)
    }
    deinit { for url in urls { TransportProtocol.routes.remove(url) } }
}

@Test func transportConcurrentCancellationIsIsolated() async throws {
    let fixture = TransportFixture()
    let transport = URLSessionTransport()
    let (first, firstRoute) = fixture.route("/cancel")
    let (second, secondRoute) = fixture.route("/complete")
    let cancelled = Task { try await transport.send(first) }
    let completed = Task { try await transport.send(second) }
    _ = await firstRoute.waitForStart()
    let secondLoader = await secondRoute.waitForStart()
    cancelled.cancel()
    await firstRoute.waitForStop()
    secondLoader.reply()
    do {
        _ = try await cancelled.value
        Issue.record("Cancelled request unexpectedly completed")
    } catch {
        #expect((error as? URLError)?.code == .cancelled)
    }
    let (data, response) = try await completed.value
    #expect(response.statusCode == 200)
    #expect(data == Data("fixture".utf8))
}

@Test func transportDoesNotCarryCookiesBearerOrCachedResponses() async throws {
    let fixture = TransportFixture()
    var transport: URLSessionTransport? = URLSessionTransport()
    weak var released = transport
    let (request, route) = fixture.route("/isolation")
    var authenticated = request
    authenticated.setValue("Bearer fixture-only", forHTTPHeaderField: "Authorization")
    let first = Task { [transport = transport!] in try await transport.send(authenticated) }
    let firstLoader = await route.waitForStart()
    #expect(firstLoader.request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-only")
    firstLoader.reply(headers: ["Set-Cookie": "fixture=value; Path=/; Secure", "Cache-Control": "max-age=3600"])
    _ = try await first.value

    // Re-register the same URL: a cached response must not bypass the protocol.
    let (_, nextRoute) = fixture.route("/isolation")
    let second = Task { [transport = transport!] in try await transport.send(request) }
    let nextLoader = await nextRoute.waitForStart()
    #expect(nextLoader.request.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(nextLoader.request.value(forHTTPHeaderField: "Authorization") == nil)
    nextLoader.reply()
    _ = try await second.value
    transport = nil
    #expect(released == nil)
}

// Apple URLProtocol delivers redirects through URLSession's real task delegate.
// Run on macOS (Apple Quality); FoundationNetworking on Linux cannot model this.
@Test(arguments: [false, true]) func transportDeniesRedirects(sameHost: Bool) async throws {
    let fixture = TransportFixture()
    let transport = URLSessionTransport()
    var (request, route) = fixture.route("/redirect")
    let (sameHostTarget, targetRoute) = fixture.route("/target")
    let destination = sameHost ? sameHostTarget.url! : URL(string: "https://other.transport.test/target")!
    request.setValue("Bearer fixture-only", forHTTPHeaderField: "Authorization")
    let task = Task { try await transport.send(request) }
    let loader = await route.waitForStart()
    loader.redirect(to: destination)
    let (_, response) = try await task.value
    #expect(response.statusCode == 302)
    #expect(targetRoute.starts == 0)
}
