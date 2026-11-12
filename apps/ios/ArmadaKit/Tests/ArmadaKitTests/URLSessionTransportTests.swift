import Foundation
import CoreFoundation
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
        // Supply the supported system store; fixture credentials are scoped to
        // a unique test host and removed at teardown. Production must clear it.
        configuration.urlCredentialStorage = TransportProtocol.credentials
        return configuration
    }
}

/// Only claims the fixture's unique hosts; all other package traffic is unchanged.
private final class TransportProtocol: URLProtocol, URLAuthenticationChallengeSender, @unchecked Sendable {
    static let credentials = URLCredentialStorage.shared
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
    private let runLoopLock = NSLock()
    private var loadingRunLoop: CFRunLoop?

    override func startLoading() {
        runLoopLock.withLock { loadingRunLoop = CFRunLoopGetCurrent() }
        guard let route = Self.routes.get(request.url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        route.start(self)
    }
    override func stopLoading() { Self.routes.get(request.url)?.stop() }

    // Tests release responses from Swift tasks. URLProtocolClient callbacks must
    // return to the loading thread, not execute on an arbitrary test executor.
    private func onLoadingThread(_ action: @escaping @Sendable () -> Void) {
        let loop = runLoopLock.withLock { loadingRunLoop! }
        CFRunLoopPerformBlock(loop, kCFRunLoopDefaultMode, action)
        CFRunLoopWakeUp(loop)
    }
    func reply(status: Int = 200, headers: [String: String] = [:]) {
        onLoadingThread { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .allowed)
            client?.urlProtocol(self, didLoad: Data("fixture".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    func challenge(in space: URLProtectionSpace) {
        onLoadingThread { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: 401,
                                           httpVersion: "HTTP/1.1", headerFields: ["WWW-Authenticate": "Basic realm=fixture"])!
            let challenge = URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil,
                                                        previousFailureCount: 0, failureResponse: response,
                                                        error: nil, sender: self)
            client?.urlProtocol(self, didReceive: challenge)
        }
    }
    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {
        finishChallenge(credential)
    }
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) { finishChallenge(nil) }
    func cancel(_ challenge: URLAuthenticationChallenge) {
        onLoadingThread { [self] in
            client?.urlProtocol(self, didFailWithError: URLError(.userCancelledAuthentication))
        }
    }
    func performDefaultHandling(for challenge: URLAuthenticationChallenge) { finishChallenge(nil) }
    func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) { finishChallenge(nil) }
    private func finishChallenge(_ credential: URLCredential?) {
        Self.routes.get(request.url)?.recordChallenge(credential)
        reply(status: credential == nil ? 401 : 200)
    }
    func redirect(to url: URL) {
        onLoadingThread { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: 302,
                                           httpVersion: "HTTP/1.1", headerFields: ["Location": url.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: url), redirectResponse: response)
            // The redirection callback transfers control to URLSession. Do not
            // issue a second terminal didFinishLoading on the redirected loader.
        }
    }

}

private final class Route: @unchecked Sendable {
    private let lock = NSLock()
    private var loader: TransportProtocol?
    private var started: CheckedContinuation<TransportProtocol, Never>?
    private var stopped: CheckedContinuation<Void, Never>?
    private var didStop = false
    private var count = 0
    private var challenges: [URLCredential?] = []
    var challengeCredentials: [URLCredential?] { lock.withLock { challenges } }
    func recordChallenge(_ credential: URLCredential?) { lock.withLock { challenges.append(credential) } }
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
            let value = lock.withLock { () -> TransportProtocol? in
                if let loader { return loader }
                started = continuation
                return nil
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

@Suite(.serialized)
struct URLSessionTransportTests {
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

@Test func transportDoesNotReuseStoredCredentialsForAuthenticationChallenges() async throws {
    let fixture = TransportFixture()
    let (firstRequest, firstRoute) = fixture.route("/before-challenge")
    let (secondRequest, secondRoute) = fixture.route("/challenge")
    let space = URLProtectionSpace(host: secondRequest.url!.host!, port: 443,
                                   protocol: "https", realm: "fixture",
                                   authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
    let credential = URLCredential(user: "fixture-user", password: "fixture-password", persistence: .forSession)
    let store = TransportProtocol.credentials
    store.setDefaultCredential(credential, for: space)
    defer { store.remove(credential, for: space) }
    // Negative-control input: the configured factory store really contains a
    // credential for this host/realm. Production must disconnect that store.
    try #require(store.defaultCredential(for: space)?.user == "fixture-user")
    // Positive control at the same URLSession/URLProtocol boundary: without the
    // transport's no-storage policy, this challenge really selects the credential.
    let (controlRequest, controlRoute) = fixture.route("/control-challenge")
    let controlSession = URLSession(configuration: .ephemeral)
    defer { controlSession.invalidateAndCancel() }
    let control = Task { try await controlSession.data(for: controlRequest) }
    let controlLoader = await controlRoute.waitForStart()
    controlLoader.challenge(in: space)
    let (_, controlResponse) = try await control.value
    try #require((controlResponse as? HTTPURLResponse)?.statusCode == 200)
    try #require(controlRoute.challengeCredentials.count == 1)
    try #require(controlRoute.challengeCredentials.first.flatMap { $0 }?.user == "fixture-user")

    let transport = URLSessionTransport()
    let first = Task { try await transport.send(firstRequest) }
    let firstLoader = await firstRoute.waitForStart()
    firstLoader.reply()
    _ = try await first.value

    let second = Task { try await transport.send(secondRequest) }
    let secondLoader = await secondRoute.waitForStart()
    secondLoader.challenge(in: space)
    let (_, response) = try await second.value
    #expect(response.statusCode == 401)
    // Proves URLSession actually resolved the challenge, not just an absent
    // Authorization header on the initial request.
    let selected = secondRoute.challengeCredentials
    #expect(selected.count == 1)
    #expect(selected.allSatisfy { $0 == nil })
}

}
