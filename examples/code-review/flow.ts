import { Type } from "@sinclair/typebox";
import { agent, flow } from "../../src/index.ts";

/**
 * The first proof flow. It stresses the cycle: review sends the work back to
 * code until it approves, or until the limit sends the decision to a person.
 */
export default flow("code-and-review", {
  harness: "claude",
  model: "sonnet",
  steps: [
    agent({
      id: "code",
      prompt: "prompts/code.md",
      tools: ["read", "write", "edit", "grep", "find", "ls"],
      returns: Type.Object({
        summary: Type.String(),
        files: Type.Array(Type.String()),
      }),
    }),

    agent({
      id: "review",
      needs: ["code"],
      prompt: "prompts/review.md",
      tools: ["read", "grep", "find", "ls"],
      returns: Type.Object({
        approved: Type.Boolean(),
        findings: Type.Array(Type.String()),
      }),
      cycle: { to: "code", when: { approved: false }, limit: 3, policy: "escalate" },
    }),
  ],
});
