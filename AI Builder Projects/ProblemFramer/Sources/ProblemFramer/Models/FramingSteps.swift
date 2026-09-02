import Foundation

/// A single problem-framing question: its wizard copy, which ProblemFrame
/// field it edits, and its tag catalog. Shared by the step-by-step wizard
/// and the full-document view so both stay in sync from one definition.
struct FramingStep {
    let key: String
    let title: String
    let prompt: String
    let keyPath: WritableKeyPath<ProblemFrame, String>
    let tagsKeyPath: WritableKeyPath<ProblemFrame, [String]>
    let tagCatalog: [String]
}

let framingSteps: [FramingStep] = [
    FramingStep(
        key: "context",
        title: "The Context",
        prompt: "What's the current situation that's leading to this problem? Walk me through the background.",
        keyPath: \.currentState,
        tagsKeyPath: \.currentStateTags,
        tagCatalog: ProblemTagCatalog.context
    ),
    FramingStep(
        key: "timing",
        title: "When It's Happening",
        prompt: "When does this happen? Is it constant, seasonal, or tied to a specific event?",
        keyPath: \.timing,
        tagsKeyPath: \.timingTags,
        tagCatalog: ProblemTagCatalog.timing
    ),
    FramingStep(
        key: "whoIsAffected",
        title: "Who Is Affected",
        prompt: "Which users or segments experience this? How many, how often?",
        keyPath: \.whoIsAffected,
        tagsKeyPath: \.whoIsAffectedTags,
        tagCatalog: ProblemTagCatalog.whoIsAffected
    ),
    FramingStep(
        key: "whyItMatters",
        title: "Why It Matters",
        prompt: "Why does this matter now, to users and to the business?",
        keyPath: \.whyItMatters,
        tagsKeyPath: \.whyItMattersTags,
        tagCatalog: ProblemTagCatalog.whyItMatters
    ),
    FramingStep(
        key: "impact",
        title: "Impact of Not Solving This",
        prompt: "What's the cost of leaving this alone for another quarter?",
        keyPath: \.impactOfNotSolving,
        tagsKeyPath: \.impactOfNotSolvingTags,
        tagCatalog: ProblemTagCatalog.impact
    ),
    FramingStep(
        key: "successCriteria",
        title: "Success Criteria",
        prompt: "How will you know this problem is actually solved?",
        keyPath: \.successCriteria,
        tagsKeyPath: \.successCriteriaTags,
        tagCatalog: ProblemTagCatalog.successCriteria
    )
]
