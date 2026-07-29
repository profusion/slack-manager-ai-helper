# Actions Followups

Evaluate manager mentions, DMs, MPIMs, and configured channel discussions as possible actions.

Classify each likely action as one of:

- pending
- solved
- dismissed
- blocked
- unknown

For each action, include the origin channel or DM, nearby discussion summary, owner/requester when identifiable, next step, and evidence message ids or timestamps.

Avoid claiming an action is solved without explicit evidence.

## Output

Return the structured JSON object requested by the runtime. The top-level object has:

- `memory`: a JSON object matching the schema below.
- `reportText`: a non-empty Markdown report suitable for forwarding as a Slack or email report.

Do not include Markdown fences around the whole response. Do not put the memory JSON inside
`reportText`.

### MEMORY SCHEMA

```jsonschema
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Structured Actions Followups analysis returned by the model. It captures compact memory, an overall summary, and each likely action found in manager mentions, DMs, MPIMs, or configured channels.",
  "type": "object",
  "additionalProperties": false,
  "required": ["memory", "actions", "summary"],
  "properties": {
    "memory": {
      "description": "Compact memory update to carry into future runs, or a short statement that no memory update is needed.",
      "type": "string"
    },
    "summary": {
      "description": "Evidence-based overview of the follow-up state across all configured sources.",
      "type": "string"
    },
    "actions": {
      "description": "Likely action items inferred from explicit evidence in Slack messages.",
      "type": "array",
      "items": {
        "description": "One possible action or follow-up request with status and evidence.",
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "status", "evidence"],
        "properties": {
          "title": {
            "description": "Short action title grounded in the Slack evidence.",
            "type": "string"
          },
          "status": {
            "description": "Current action status. Use unknown when evidence is insufficient.",
            "enum": ["pending", "solved", "dismissed", "blocked", "unknown"]
          },
          "origin": {
            "description": "Channel, DM, MPIM, or source identifier where the action originated.",
            "type": "string"
          },
          "owner": {
            "description": "Person responsible for the action when identifiable from evidence.",
            "type": "string"
          },
          "requester": {
            "description": "Person who requested or implied the action when identifiable from evidence.",
            "type": "string"
          },
          "nextStep": {
            "description": "Recommended next step based only on the evidence.",
            "type": "string"
          },
          "discussion": {
            "description": "Brief summary of the nearby discussion relevant to this action.",
            "type": "string"
          },
          "evidence": {
            "description": "Message ids or channel/timestamp citations that support the action classification.",
            "type": "array",
            "items": {
              "description": "Evidence citation, preferably a message id and otherwise channel id plus timestamp.",
              "type": "string"
            }
          }
        }
      }
    }
  }
}
```

### reportText

The `reportText` Markdown must be suitable for forwarding as a Slack or email report.

Include:

- A short overall summary.
- One subsection per likely action.
- Status: pending, solved, dismissed, blocked, or unknown.
- Owner/requester when identifiable.
- Origin channel or DM.
- Evidence citations using message ids or channel/timestamp.
- Next step when action is not solved or dismissed.

Use only evidence from the provided messages. If no likely actions are found, say that clearly.
