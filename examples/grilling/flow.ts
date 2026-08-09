import { Type } from "@sinclair/typebox";
import { agent, flow, gate } from "../../src/index.ts";

/**
 * The second proof flow. It stresses the gate: a round of questions goes to a
 * person, and the run stops until they answer. It runs the process that
 * designed Orchy.
 */
export default flow("grilling", {
  workspace: { kind: "git", path: "." },
  steps: [
    agent({
      id: "ask",
      prompt: "prompts/ask.md",
      tools: ["read", "grep", "find", "ls"],
      changes: false,
      returns: Type.Object({
        questions: Type.Array(Type.String()),
        frontierEmpty: Type.Boolean(),
      }),
    }),

    gate({
      id: "answers",
      needs: ["ask"],
      question: "Answer the questions above. Give one answer for each number.",
      returns: Type.Object({ answers: Type.Array(Type.String()) }),
    }),

    agent({
      id: "record",
      needs: ["ask", "answers"],
      prompt: "prompts/record.md",
      tools: ["read", "write", "edit", "grep", "find", "ls"],
      returns: Type.Object({
        updated: Type.Array(Type.String()),
        frontierEmpty: Type.Boolean(),
      }),
      cycle: { to: "ask", when: { frontierEmpty: false }, limit: 6, policy: "escalate" },
    }),

    agent({
      id: "review",
      needs: ["record"],
      prompt: "prompts/review.md",
      tools: ["read", "grep", "find", "ls"],
      changes: false,
      returns: Type.Object({
        approved: Type.Boolean(),
        findings: Type.Array(Type.String()),
      }),
      cycle: { to: "record", when: { approved: false }, limit: 2, policy: "accept" },
    }),
  ],
});
