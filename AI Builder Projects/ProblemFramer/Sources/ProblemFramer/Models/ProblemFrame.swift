import Foundation

struct ProblemFrame: Identifiable, Codable, Equatable {
    var id: UUID
    var title: String
    var tags: [String]
    var problemStatement: String
    var currentState: String
    var currentStateTags: [String]
    var timing: String
    var timingTags: [String]
    var whoIsAffected: String
    var whoIsAffectedTags: [String]
    var whyItMatters: String
    var whyItMattersTags: [String]
    var impactOfNotSolving: String
    var impactOfNotSolvingTags: [String]
    var successCriteria: String
    var successCriteriaTags: [String]
    var chatHistory: [ChatMessage]
    var lastQualityScore: Int?
    /// Keyed by WizardStepOrder.keys; a key present means that section has
    /// an unresolved critique from the AI's most recent review.
    var sectionFeedback: [String: String]
    var createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        title: String = "Untitled Problem",
        tags: [String] = [],
        problemStatement: String = "",
        currentState: String = "",
        currentStateTags: [String] = [],
        timing: String = "",
        timingTags: [String] = [],
        whoIsAffected: String = "",
        whoIsAffectedTags: [String] = [],
        whyItMatters: String = "",
        whyItMattersTags: [String] = [],
        impactOfNotSolving: String = "",
        impactOfNotSolvingTags: [String] = [],
        successCriteria: String = "",
        successCriteriaTags: [String] = [],
        chatHistory: [ChatMessage] = [],
        lastQualityScore: Int? = nil,
        sectionFeedback: [String: String] = [:],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.tags = tags
        self.problemStatement = problemStatement
        self.currentState = currentState
        self.currentStateTags = currentStateTags
        self.timing = timing
        self.timingTags = timingTags
        self.whoIsAffected = whoIsAffected
        self.whoIsAffectedTags = whoIsAffectedTags
        self.whyItMatters = whyItMatters
        self.whyItMattersTags = whyItMattersTags
        self.impactOfNotSolving = impactOfNotSolving
        self.impactOfNotSolvingTags = impactOfNotSolvingTags
        self.successCriteria = successCriteria
        self.successCriteriaTags = successCriteriaTags
        self.chatHistory = chatHistory
        self.lastQualityScore = lastQualityScore
        self.sectionFeedback = sectionFeedback
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        problemStatement = try container.decode(String.self, forKey: .problemStatement)
        currentState = try container.decode(String.self, forKey: .currentState)
        currentStateTags = try container.decodeIfPresent([String].self, forKey: .currentStateTags) ?? []
        timing = try container.decodeIfPresent(String.self, forKey: .timing) ?? ""
        timingTags = try container.decodeIfPresent([String].self, forKey: .timingTags) ?? []
        whoIsAffected = try container.decode(String.self, forKey: .whoIsAffected)
        whoIsAffectedTags = try container.decodeIfPresent([String].self, forKey: .whoIsAffectedTags) ?? []
        whyItMatters = try container.decode(String.self, forKey: .whyItMatters)
        whyItMattersTags = try container.decodeIfPresent([String].self, forKey: .whyItMattersTags) ?? []
        impactOfNotSolving = try container.decode(String.self, forKey: .impactOfNotSolving)
        impactOfNotSolvingTags = try container.decodeIfPresent([String].self, forKey: .impactOfNotSolvingTags) ?? []
        successCriteria = try container.decode(String.self, forKey: .successCriteria)
        successCriteriaTags = try container.decodeIfPresent([String].self, forKey: .successCriteriaTags) ?? []
        chatHistory = try container.decodeIfPresent([ChatMessage].self, forKey: .chatHistory) ?? []
        lastQualityScore = try container.decodeIfPresent(Int.self, forKey: .lastQualityScore)
        sectionFeedback = try container.decodeIfPresent([String: String].self, forKey: .sectionFeedback) ?? [:]
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    /// Renders the frame as a clean Markdown document, ready to share with anyone building on it.
    func asMarkdown() -> String {
        func section(_ heading: String, _ body: String, _ sectionTags: [String]) -> String {
            let tagLine = sectionTags.isEmpty ? "" : "\n_Tags: \(sectionTags.joined(separator: ", "))_"
            return "## \(heading)\(tagLine)\n\(body.isEmpty ? "_Not yet written_" : body)"
        }

        return """
        # \(title)
        \(tags.isEmpty ? "" : "**Tags:** " + tags.joined(separator: ", "))

        ## Problem Statement
        \(problemStatement.isEmpty ? "_Not yet written_" : problemStatement)

        \(section("The Context", currentState, currentStateTags))

        \(section("When It's Happening", timing, timingTags))

        \(section("Who Is Affected", whoIsAffected, whoIsAffectedTags))

        \(section("Why It Matters", whyItMatters, whyItMattersTags))

        \(section("Impact of Not Solving This", impactOfNotSolving, impactOfNotSolvingTags))

        \(section("Success Criteria", successCriteria, successCriteriaTags))
        """
    }
}
