import Testing
@testable import ArmadaKit

@Test func detailPollingBacksOffNetworkFailuresAndResetsAfterSuccess() {
    var policy = ConversationDetailPolling()
    #expect(policy.delay(busy: true) == .seconds(3))
    #expect(policy.delay(busy: false) == .seconds(15))
    policy.failed()
    #expect(policy.delay(busy: true) == .seconds(6))
    #expect(policy.delay(busy: false) == .seconds(30))
    policy.failed()
    #expect(policy.delay(busy: true) == .seconds(12))
    policy.failed()
    #expect(policy.delay(busy: true) == .seconds(24))
    for _ in 0..<100 { policy.failed() }
    #expect(policy.delay(busy: true) == .seconds(30))
    #expect(policy.delay(busy: false) == .seconds(30))
    policy.succeeded()
    #expect(policy.delay(busy: true) == .seconds(3))
    #expect(policy.delay(busy: false) == .seconds(15))
}
