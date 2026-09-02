import Foundation

/// Fixed sets of selectable tags that give the AI assistant context about
/// the problem, so its feedback isn't generic. One catalog per question.
enum ProblemTagCatalog {
    static let problemType: [String] = [
        "New Feature", "Feature Integration", "Enhancement", "Bug"
    ]

    static let context: [String] = [
        "Customer Feedback", "Usage Data", "Support Tickets", "Market/Competitive", "Strategic Initiative"
    ]

    static let timing: [String] = [
        "Always/Ongoing", "Recurring", "One-Time Incident", "Seasonal", "Recently Started", "Trending Up"
    ]

    static let whoIsAffected: [String] = [
        "All Users", "New Users", "Power Users", "Enterprise", "Internal Team"
    ]

    static let whyItMatters: [String] = [
        "Revenue", "Retention", "Growth", "Compliance", "Brand/Trust"
    ]

    static let impact: [String] = [
        "Revenue Risk", "Churn Risk", "Compliance Risk", "Critical", "Low Urgency"
    ]

    static let successCriteria: [String] = [
        "Quantitative Metric", "Qualitative Feedback", "Adoption", "Satisfaction"
    ]
}
