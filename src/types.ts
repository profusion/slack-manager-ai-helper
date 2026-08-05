export type PositiveMatcherConfig =
  | {
      readonly id: string;
      readonly type: 'regex';
      readonly pattern: string;
      readonly flags?: string | undefined;
    }
  | {
      readonly id: string;
      readonly type: 'text';
      readonly terms: readonly string[];
      readonly caseInsensitive?: boolean;
    }
  | {
      readonly id: string;
      readonly type: 'mention';
      readonly userId: string;
    }
  | {
      readonly id: string;
      readonly type: 'scored';
      readonly question: string;
      readonly thresholds?: ScoreThresholds | undefined;
      readonly scoring?:
        | {
            readonly semanticSimilarityWeight?: number | undefined;
            readonly questionSimilarityWeight?: number | undefined;
            readonly keywordWeight?: number | undefined;
            readonly phraseWeight?: number | undefined;
            readonly patternWeight?: number | undefined;
          }
        | undefined;
      readonly heuristics?:
        | {
            readonly keywords?: readonly string[] | undefined;
            readonly phrases?: readonly string[] | undefined;
            readonly patterns?: readonly string[] | undefined;
          }
        | undefined;
      readonly embeddings?: EmbeddingsConfig | undefined;
      readonly classifier?: ClassifierConfig | undefined;
    }
  | {
      readonly id: string;
      readonly type: 'and';
      readonly matchers: readonly PositiveMatcherConfig[];
    }
  | {
      readonly id: string;
      readonly type: 'or';
      readonly matchers: readonly PositiveMatcherConfig[];
    };

export type MatcherConfig =
  | PositiveMatcherConfig
  | {
      readonly id: string;
      readonly type: 'exclude';
      readonly matcher: PositiveMatcherConfig;
    };

export type ChannelSourceKind = 'channel' | 'dm' | 'mpim' | 'unknown';

export type AlsoChannelConfig = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly kind?: ChannelSourceKind | undefined;
};

export type ChannelConfig = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly kind?: ChannelSourceKind | undefined;
  readonly alsoChannels?: readonly AlsoChannelConfig[] | undefined;
  readonly users?: readonly ConfiguredUser[] | undefined;
  readonly matchers?: readonly MatcherConfig[] | undefined;
};

export type ConfiguredUser = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly role?: string | undefined;
};

export type KnownUser = {
  readonly id: string;
  readonly name?: string | undefined;
};

export type SyntheticThreadsConfig = {
  readonly enabled?: boolean;
  readonly candidateWindowMinutes?: number;
  readonly thresholds?: ScoreThresholds;
  readonly scoring?: {
    readonly semanticSimilarityWeight?: number;
    readonly lexicalOverlapWeight?: number;
    readonly sameAuthorOrMentionWeight?: number;
    readonly temporalProximityWeight?: number;
    readonly channelTopicMatchWeight?: number;
  };
  readonly heuristics?: {
    readonly keywords?: readonly string[];
    readonly messageHasReplyMarkers?: readonly string[];
  };
  readonly embeddings?: EmbeddingsConfig;
  readonly classifier?: ClassifierConfig;
};

export type EmbeddingsConfig = {
  readonly enabled?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly cache?: boolean;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

export type ClassifierConfig = {
  readonly enabled?: boolean;
  readonly useForRanges?: readonly SyntheticScoreRange[];
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxInputMessages?: number;
};

export type ProviderScoringConfig = {
  readonly embeddings?: EmbeddingsConfig | undefined;
  readonly classifier?: ClassifierConfig | undefined;
};

export type RedactionPatternConfig = {
  readonly id: string;
  readonly pattern: string;
  readonly flags?: string | undefined;
};

export type RedactionConfig = {
  readonly enabled?: boolean | undefined;
  readonly replacement?: string | undefined;
  readonly additionalPatterns?: readonly RedactionPatternConfig[] | undefined;
};

export type ScoreThresholds = {
  readonly unrelatedBelow?: number;
  readonly ambiguousFrom?: number;
  readonly ambiguousBelow?: number;
  readonly relatedFrom?: number;
};

export type SyntheticScoreRange = 'unrelated' | 'ambiguous' | 'related';

export type AnalysisModelConfig = {
  readonly provider: string;
  readonly model: string;
  readonly fallback?: AnalysisModelConfig | undefined;
  readonly retries?: number | undefined;
  readonly baseUrl?: string | undefined;
  readonly temperature?: number | undefined;
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
  readonly minReportWords?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly contextWindowTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly openrouter?:
    | {
        readonly includeReasoning?: boolean | undefined;
        readonly order?: readonly string[] | undefined;
        readonly allowFallbacks?: boolean | undefined;
      }
    | undefined;
  readonly failOnInvalidOutput?: boolean | undefined;
};

export type ModelCallRecord = {
  readonly segmentId?: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly attempts: number;
};

export type AppConfig = {
  readonly workspaceUrl: string;
  readonly storage?:
    | {
        readonly slacrawlDatabasePath?: string | undefined;
        readonly statePath?: string | undefined;
      }
    | undefined;
  readonly prompts: string | readonly string[];
  readonly model: AnalysisModelConfig;
  readonly channels?: readonly ChannelConfig[] | undefined;
  readonly globalMatchers?: readonly MatcherConfig[] | undefined;
  readonly scoredMatcherDefaults?: ProviderScoringConfig | undefined;
  readonly redaction?: RedactionConfig | undefined;
  readonly context?:
    | {
        readonly includeRealThread?: boolean;
        readonly nearbyMessagesBeforeMinutes?: number;
        readonly nearbyMessagesAfterMinutes?: number;
        readonly maxMessages?: number;
        readonly syntheticThreads?: SyntheticThreadsConfig | undefined;
      }
    | undefined;
};

export type ResolvedConfig = {
  readonly config: ResolvedAppConfig;
  readonly configPath: string;
  readonly configHash: string;
  readonly topicId: string;
};

export type ResolvedAppConfig = Omit<AppConfig, 'storage' | 'prompts' | 'channels' | 'context'> & {
  readonly storage: {
    readonly slacrawlDatabasePath: string;
    readonly statePath: string;
  };
  readonly prompts: readonly string[];
  readonly channels: readonly ChannelConfig[];
  readonly context: {
    readonly includeRealThread?: boolean;
    readonly nearbyMessagesBeforeMinutes?: number;
    readonly nearbyMessagesAfterMinutes?: number;
    readonly maxMessages?: number;
    readonly syntheticThreads?: SyntheticThreadsConfig | undefined;
  };
};

export type SlackMessage = {
  readonly channelId: string;
  readonly messageId?: string | undefined;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly userId?: string | undefined;
  readonly text: string;
  readonly type?: string | undefined;
  readonly subtype?: string | undefined;
};

export type MatchResult = {
  readonly message: SlackMessage;
  readonly channel: ChannelConfig;
  readonly matcherId: string;
  readonly matcherType: PositiveMatcherConfig['type'] | 'channel';
};

export type MatchDiagnostic =
  | {
      readonly message: SlackMessage;
      readonly matched: true;
      readonly channel: ChannelConfig;
      readonly matcherId: string;
      readonly matcherType: PositiveMatcherConfig['type'] | 'channel';
      readonly evaluatedMatcherCount: number;
    }
  | {
      readonly message: SlackMessage;
      readonly matched: false;
      readonly channel?: ChannelConfig | undefined;
      readonly reason:
        | 'unconfigured_channel'
        | 'user_filter'
        | 'exclude_matcher'
        | 'no_positive_match';
      readonly matcherId?: string | undefined;
      readonly matcherType?: MatcherConfig['type'] | undefined;
      readonly evaluatedMatcherCount: number;
    };

export type EvidenceMessage = SlackMessage & {
  readonly source: 'match' | 'thread' | 'nearby' | 'synthetic_related';
};

export type SyntheticRelation = {
  readonly message: SlackMessage;
  readonly score: number;
  readonly reason: string;
  readonly method: 'heuristic' | 'embedding' | 'classifier';
};

export type CompiledPrompts = {
  readonly system: string;
  readonly prompt: string;
  readonly outputSchema: unknown | undefined;
  readonly structuredOutputSchema: unknown | undefined;
};

export type RunState = {
  readonly topicId: string;
  readonly generatedAt: string;
  readonly users: readonly ConfiguredUser[];
  readonly timeline: readonly {
    readonly date: string;
    readonly dayOfWeek: string;
    readonly users: readonly (
      | (ConfiguredUser & {
          readonly status: 'absent';
        })
      | (ConfiguredUser & {
          readonly status: 'present';
          readonly firstMessageAt: string;
          readonly channelMessages: number;
          readonly repliesToOthers: number;
          readonly totalMessages: number;
          readonly authoredTopLevelMessages: readonly string[];
          readonly authoredReplies: readonly string[];
          readonly ownedEvidence: readonly string[];
        })
    )[];
    readonly channels: readonly {
      readonly id: string;
      readonly name?: string | undefined;
      readonly kind: 'channel' | 'dm' | 'mpim' | 'unknown';
      readonly threads: readonly {
        readonly messages: readonly {
          readonly time: string;
          readonly messageId?: string | undefined;
          readonly userId?: string | undefined;
          readonly userName?: string | undefined;
          readonly userRole?: string | undefined;
          readonly externalAuthor?: true | undefined;
          readonly evidenceScope: 'owned' | 'context';
          readonly anchor?: true | undefined;
          readonly href: string;
          readonly text: string;
        }[];
      }[];
    }[];
  }[];
  readonly previousMemory: {
    readonly content: string | null;
  };
};
