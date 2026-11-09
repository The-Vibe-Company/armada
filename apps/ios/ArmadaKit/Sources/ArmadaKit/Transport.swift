import Foundation

public enum ArmadaError: Error, Sendable, Equatable, LocalizedError {
    case signedOut, forbidden, conflict, unavailable, invalidResponse, secureStorage, invalidOrigin, invalidRequest
    case http(Int)
    public var errorDescription: String? {
        switch self {
        case .signedOut: "Sign in to Armada again."
        case .forbidden: "You do not have access to this resource."
        case .conflict: "Armada could not confirm this operation. Refresh its status before retrying."
        case .invalidRequest: "Armada refused this request."
        case .unavailable: "Armada is temporarily unavailable."
        case .invalidResponse: "Armada returned an unsupported response."
        case .secureStorage: "Secure storage is unavailable."
        case .invalidOrigin: "A secure Armada origin is required."
        case .http: "The request could not be completed."
        }
    }
}

public protocol ArmadaTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Ephemeral session: no cookies, credential cache or response cache. Never follows redirects
/// with an Armada bearer (including redirects back to the same host).
public final class URLSessionTransport: NSObject, ArmadaTransport, URLSessionTaskDelegate, Sendable {
    public override init() { super.init() }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ArmadaError.invalidResponse }
        return (data, http)
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct OK: Codable, Sendable { let ok: Bool }
struct Empty: Encodable, Sendable {}
