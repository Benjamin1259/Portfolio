import Foundation

/// Canonical order of the problem-framing wizard's steps, derived from
/// `framingSteps` — used to restrict a "revise" pass to only the sections
/// the AI actually flagged, in the order the wizard shows them.
enum WizardStepOrder {
    static let keys = framingSteps.map(\.key)

    /// All flagged sections, in wizard order — used to restrict a "revise"
    /// pass to only the cards that actually need work.
    static func problemKeys(in sectionFeedback: [String: String]) -> [String] {
        keys.filter { sectionFeedback[$0] != nil }
    }
}
