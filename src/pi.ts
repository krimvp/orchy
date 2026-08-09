import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export interface AgentRequest {
  prompt: string;
  tools: string[];
  returns: TSchema;
  cwd: string;
}

export interface AgentResult {
  value: unknown;
  trajectory?: string;
}

/**
 * ADR 0002 caps this at one method. More members mean the abstraction failed,
 * and the answer then is to delete it, not to grow it.
 */
export interface Harness {
  run(request: AgentRequest): Promise<AgentResult>;
}

const SUBMIT = "submit_result";

export const pi: Harness = {
  async run(request) {
    let value: unknown;

    const submit = defineTool({
      name: SUBMIT,
      label: "Submit result",
      description: "Report the result of this step. Call this once, when the work is complete.",
      parameters: request.returns,
      execute: async (_id: string, params: unknown) => {
        value = params;
        return { content: [{ type: "text" as const, text: "Recorded." }], details: undefined };
      },
    });

    // Orchy must load the resources itself. Without this, the extensions of the
    // user never load, so a custom provider is unknown and Pi falls back to
    // another model without a word.
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(request.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd: request.cwd, agentDir, settingsManager });
    await resourceLoader.reload();

    // Invariant 1: the step reaches the declared tools and nothing else.
    const sessionManager = SessionManager.create(request.cwd);
    const { session } = await createAgentSession({
      cwd: request.cwd,
      tools: [...request.tools, SUBMIT],
      customTools: [submit],
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    try {
      await session.prompt(request.prompt);
    } finally {
      session.dispose();
    }

    if (value === undefined) throw new Error(`the step ended without a call to ${SUBMIT}`);
    return { value, trajectory: sessionManager.getSessionFile() };
  },
};
