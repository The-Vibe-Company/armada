import Foundation

/// Short relative ages with the dashboard's wording (`apps/dashboard/src/lib/relative-time.ts`):
/// "just now", "5 min ago", "2 hours ago", "3 days ago", "4 months ago", "2 years ago". A time in
/// the future (clock skew) reads "just now", never a negative age.
enum RelativeTime {
    static func age(of date: Date, now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        let minute = 60.0
        let hour = 60 * minute
        let day = 24 * hour
        if elapsed < minute { return "just now" }
        if elapsed < hour { return "\(Int(elapsed / minute)) min ago" }
        if elapsed < day { return ago(Int(elapsed / hour), "hour") }
        let days = Int(elapsed / day)
        if days < 30 { return ago(days, "day") }
        if days < 365 { return ago(days / 30, "month") }
        return ago(days / 365, "year")
    }

    /// How long until `date`: "in 12 min", "in 2 hours". Past dates read "now".
    static func until(_ date: Date, now: Date) -> String {
        let remaining = date.timeIntervalSince(now)
        if remaining < 60 { return "now" }
        if remaining < 3_600 { return "in \(Int(remaining / 60)) min" }
        let hours = Int(remaining / 3_600)
        return hours == 1 ? "in 1 hour" : "in \(hours) hours"
    }

    private static func ago(_ count: Int, _ unit: String) -> String {
        "\(count) \(unit)\(count == 1 ? "" : "s") ago"
    }
}
