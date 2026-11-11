import Foundation
import CryptoKit

public struct ArmadaSession: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresAt: String
    public init(accessToken: String, refreshToken: String, expiresAt: String) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt
    }
}

public struct Organization: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let role: String
}
private struct Organizations: Decodable, Sendable { let orgs: [Organization] }
private struct ArmadaFailureEnvelope: Decodable {
    struct Detail: Decodable { let code: String; let message: String? }
    let error: Detail
}
private struct StoredSession: Codable {
    let origin: String
    let session: ArmadaSession
    let selectedOrgID: String?
    let operations: [PendingOrchestratorOperation]?
}

/// API-only authority owner. No Supabase configuration, provider key or browser callback.
/// Keep one instance per UI session. Mutations are never automatically retried.
public actor ArmadaClient {
    public static let productionOrigin = URL(string: "https://armada.thevibecompany.co")!
    private let origin: URL
    private let transport: any ArmadaTransport
    private let storage: any SessionStorage
    private var session: ArmadaSession?
    private var generation = 0
    // Only concurrent submissions need receipts older than the durable retention window.
    var activeSubmissions: [UUID: Int] = [:]
    var activeTerminalReceipts: [UUID: OrchestratorOperation] = [:]
    private var refreshing: Task<ArmadaSession, Error>?
    private var refreshID: UUID?
    public private(set) var pendingOperations: [PendingOrchestratorOperation] = []
    public private(set) var selectedOrgID: String?

    public init(origin: URL = productionOrigin, transport: any ArmadaTransport = URLSessionTransport(),
                storage: any SessionStorage = KeychainSessionStorage()) throws {
        guard origin.scheme == "https", origin.host != nil, origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/" else {
            throw ArmadaError.invalidOrigin
        }
        self.origin = origin; self.transport = transport; self.storage = storage
    }

    /// Safe UI state; bearer/session values never leave the authority owner.
    public var isSignedIn: Bool { session != nil }

    public func restore() throws {
        guard session == nil, refreshing == nil else { return }
        do {
            guard let data = try storage.load() else { return }
            let stored = try JSONDecoder().decode(StoredSession.self, from: data)
            guard stored.origin == origin.absoluteString else { return }
            let operations = Self.boundedOperations(stored.operations ?? [])
            try persist(stored.session, org: stored.selectedOrgID, operations: operations)
            session = stored.session; selectedOrgID = stored.selectedOrgID; pendingOperations = operations; generation += 1
        } catch { throw ArmadaError.secureStorage }
    }

    /// Code-only login uses the server's accepted loopback redirect shape. No listener,
    /// browser launch or custom scheme is claimed. Users must type the emailed code.
    public func startEmailLogin(email: String) async throws {
        struct Start: Encodable {
            let email: String
            let redirect_uri: String
            let code_challenge: String
            let state: String
        }
        let random = UUID().uuidString + UUID().uuidString
        let challenge = Data(SHA256.hash(data: Data(random.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let _: OK = try await post("auth/email/start", Start(email: email, redirect_uri: "http://127.0.0.1:49152/callback",
                                                            code_challenge: challenge, state: UUID().uuidString), authenticated: false)
    }
    public func verifyEmail(email: String, code: String) async throws {
        struct Verify: Encodable { let email: String; let code: String }
        let fence = generation
        let next: ArmadaSession = try await post("auth/email/verify", Verify(email: email, code: code), authenticated: false)
        guard generation == fence else { throw CancellationError() }
        try persist(next, org: nil, operations: [])
        refreshing?.cancel(); refreshing = nil; refreshID = nil; generation += 1
        session = next; selectedOrgID = nil; pendingOperations = []; activeTerminalReceipts = [:]
    }
    public func organizations() async throws -> [Organization] {
        let result: Organizations = try await post("org/list", Empty())
        return result.orgs
    }
    public func selectOrganization(_ id: String) async throws {
        let fence = generation
        let organizations = try await organizations()
        guard fence == generation, let current = session else { throw ArmadaError.signedOut }
        guard organizations.contains(where: { $0.id == id }) else { throw ArmadaError.forbidden }
        try persist(current, org: id); selectedOrgID = id
    }
    /// Local authority is cleared even if remote revocation fails. Failure is surfaced,
    /// so the UI must not claim remote sign-out succeeded while offline.
    public func signOut() async throws {
        let token = session?.accessToken
        generation += 1; refreshing?.cancel(); refreshing = nil; refreshID = nil; session = nil; selectedOrgID = nil; pendingOperations = []; activeTerminalReceipts = [:]
        do { try storage.remove() } catch { throw ArmadaError.secureStorage }
        if let token { let _: OK = try await wire("account/logout", Empty(), token: token) }
    }
    private func persist(_ next: ArmadaSession, org: String?, operations: [PendingOrchestratorOperation]? = nil) throws {
        do { try storage.save(JSONEncoder().encode(StoredSession(origin: origin.absoluteString, session: next, selectedOrgID: org, operations: operations ?? pendingOperations))) }
        catch { throw ArmadaError.secureStorage }
    }
    func authority() async throws -> String {
        try Task.checkCancellation()
        guard let current = session else { throw ArmadaError.signedOut }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expiry = formatter.date(from: current.expiresAt) ?? ISO8601DateFormatter().date(from: current.expiresAt)
        guard let expiry else { throw ArmadaError.invalidResponse }
        if expiry.timeIntervalSinceNow > 60 { return current.accessToken }
        let fence = generation
        if refreshing == nil {
            struct Refresh: Encodable, Sendable { let refreshToken: String }
            refreshID = UUID()
            refreshing = Task { try await self.wire("auth/refresh", Refresh(refreshToken: current.refreshToken), token: nil) }
        }
        guard let task = refreshing, let flightID = refreshID else { throw ArmadaError.signedOut }
        do {
            let next = try await task.value
            // Multiple waiters may observe the same task; only the first persists rotation.
            guard generation == fence else {
                guard let session, session.refreshToken == next.refreshToken else { throw CancellationError() }
                return session.accessToken
            }
            if refreshID == flightID {
                try persist(next, org: selectedOrgID); session = next; refreshing = nil; refreshID = nil
            } else if session?.refreshToken != next.refreshToken {
                throw CancellationError()
            }
            try Task.checkCancellation()
            return next.accessToken
        } catch {
            if generation == fence, refreshID == flightID { refreshing = nil; refreshID = nil }
            throw error
        }
    }
    func post<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ route: String, _ body: Body, authenticated: Bool = true
    ) async throws -> Response {
        let fence = generation
        let token = authenticated ? try await authority() : nil
        try Task.checkCancellation()
        let result: Response = try await wire(route, body, token: token)
        if authenticated, generation != fence { throw CancellationError() }
        return result
    }
    private func wire<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ route: String, _ body: Body, token: String?
    ) async throws -> Response {
        return try await request(route, method: "POST", body: JSONEncoder().encode(body), token: token)
    }
    func authenticatedRequest<Response: Decodable & Sendable>(
        _ route: String, method: String, query: [URLQueryItem] = [], body: Data? = nil, key: String? = nil
    ) async throws -> Response {
        let fence = generation
        let token = try await authority()
        let response: Response = try await request(route, method: method, query: query, body: body, token: token, key: key)
        guard fence == generation else { throw CancellationError() }
        return response
    }
    func saveOperations(_ operations: [PendingOrchestratorOperation]) throws {
        guard let session else { throw ArmadaError.signedOut }
        let bounded = Self.boundedOperations(operations)
        try persist(session, org: selectedOrgID, operations: bounded)
        pendingOperations = bounded
    }
    /// Keep the latest 32 terminal records; unresolved commands are never evicted.
    static func boundedOperations(_ operations: [PendingOrchestratorOperation]) -> [PendingOrchestratorOperation] {
        let retained = Set(operations.filter { $0.state == .succeeded || $0.state == .failed }.suffix(32).map(\.id))
        return operations.filter { $0.state == .pending || $0.state == .uncertain || retained.contains($0.id) }
    }
    /// Sandbox route codes that refuse before anything reaches the agent. Older servers answer 400 for
    /// other codes too, including `unknown` after a provider already accepted a prompt, so a bare
    /// 400 never proves that a prompt was not delivered.
    static let sandboxRefusalCodes: Set<String> = [
        "invalid", "invalid_request", "sandbox_not_ready", "unsupported", "payment_required", "rate_limited",
        "missing_credential", "unauthorized",
    ]
    private func request<Response: Decodable & Sendable>(
        _ route: String, method: String, query: [URLQueryItem] = [], body: Data?, token: String?, key: String? = nil
    ) async throws -> Response {
        var components = URLComponents(url: origin.appendingPathComponent("api/v1/" + route), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw ArmadaError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = route == SandboxLaunchRequest.route ? SandboxLaunchRequest.timeout : 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        request.httpBody = body
        let data: Data; let response: HTTPURLResponse
        do { (data, response) = try await transport.send(request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch let error as URLError where route == SandboxLaunchRequest.route && SandboxLaunchFailure.neverConnected(error) {
            throw SandboxLaunchFailure.notSent
        }
        catch { throw ArmadaError.unavailable }
        try Task.checkCancellation()
        if route == SandboxLaunchRequest.route, response.statusCode != 401, !(200..<300).contains(response.statusCode) {
            throw SandboxLaunchFailure.classify(status: response.statusCode, body: data)
        }
        switch response.statusCode {
        case 200..<300: break
        case 401:
            if route == "auth/email/verify" { throw ArmadaError.emailCodeRefused }
            throw ArmadaError.signedOut
        case 403: throw ArmadaError.forbidden
        case 400:
            let code = (try? JSONDecoder().decode(ArmadaFailureEnvelope.self, from: data))?.error.code
            if route == "orchestrators" || route.hasPrefix("orchestrators/") {
                if code == "invalid_request" { throw ArmadaError.invalidRequest }
                // The orchestrator handler answers a 4xx only before admission (an unknown outcome is
                // `outcome_unknown`, a 503), so a code this build does not know is still a refusal.
                if let code, OrchestratorExplanation.isClosedCode(code) { throw orchestratorRefusal(code: code, data: data) }
            } else if route.hasPrefix("sandbox/"), let code, Self.sandboxRefusalCodes.contains(code) {
                throw ArmadaError.invalidRequest
            }
            throw ArmadaError.http(400)
        case 409: throw ArmadaError.conflict
        case 500...599: throw ArmadaError.unavailable
        case 402...499 where response.statusCode != 404 && response.statusCode != 429
            && (route == "orchestrators" || route.hasPrefix("orchestrators/")):
            // Keep the server's closed reason (422 `credential_refused`) so it can be explained.
            if let code = (try? JSONDecoder().decode(ArmadaFailureEnvelope.self, from: data))?.error.code,
               OrchestratorExplanation.isClosedCode(code) {
                throw orchestratorRefusal(code: code, data: data)
            }
            throw ArmadaError.http(response.statusCode)
        default: throw ArmadaError.http(response.statusCode)
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw ArmadaError.invalidResponse }
    }
}

/// Preserve a future refusal's human-readable reason, never raw multiline/unbounded server text.
private func orchestratorRefusal(code: String, data: Data) -> ArmadaError {
    let message = (try? JSONDecoder().decode(ArmadaFailureEnvelope.self, from: data))?.error.message
    let detail = OrchestratorExplanation.known[code] == nil ? message.flatMap(SandboxLaunchFailure.oneLine) : nil
    return .refused(code: code, message: detail)
}
