# Architecture and privacy model

## Source layout

ThunderbirdAI follows upstream Thunderbird's two-repository layout:

```text
mozilla-unified/          Gecko platform source
└── comm/                 Thunderbird source
```

The `comm` checkout must be nested at exactly that path. It is not a duplicate
of Gecko and no alternate `parallel/` checkout participates in configuration,
compilation, packaging, or runtime.

## Assistant ownership boundary

Thunderbird owns the mail-facing pipeline:

1. resolve the selected message, folder, account, or analyzed-mail scope;
2. parse canonical MIME content and trust/authentication evidence;
3. enrich security, attachment, sender, and URL data;
4. perform deterministic extraction, classification, PII handling, and local
   retrieval/reranking where configured;
5. redact and compress evidence into a bounded request with provenance;
6. call the selected endpoint for final synthesis;
7. retain conversation and generated-analysis state in the profile.

The configured endpoint may be Ollama, LiteLLM, or another compatible source.
Private network endpoints do not imply cloud permission; non-private endpoints
must be explicitly allowed. API credentials are stored through Thunderbird's
credential facilities rather than committed configuration files.

## Generated data

Mailbox content remains owned by the Thunderbird profile. Generated analysis,
retrieval indexes, traces, settings, and legacy model artifacts are managed
separately so governance actions can inspect or clear generated state without
silently deleting mail.

## Security posture

The project includes deterministic phishing/authentication evidence,
attachment-scanning integration, compose data-loss-prevention controls, prompt
redaction, bounded context, and diagnostic trace filtering. These controls are
defense in depth, not a guarantee that model output is correct or safe.

Never use model output as the sole basis for security, legal, medical, or
financial decisions. Review citations against the original messages.
