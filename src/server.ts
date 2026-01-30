import express from "express";
import { v4 as uuidv4 } from "uuid";
import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

const AGENT_URL = process.env.AGENT_URL;
if (!AGENT_URL) {
  throw new Error("AGENT_URL environment variable is required");
}

// 1. Define your agent's identity card.
const langdockA2aAgentCard: AgentCard = {
  name: "Langdock API A2A Agent",
  description:
    "A simple agent that can be used to test the Langdock A2A implementation.",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: AGENT_URL,
  skills: [
    {
      id: "Ask Langdock Agent",
      name: "Ask Langdock Agent",
      description: "Ask the Langdock Agent a question.",
      tags: ["prompt"],
    },
  ],
  capabilities: {
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

// 2. Implement the agent's logic.
class LangdockA2aAgentExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    // Create a direct message response.
    const responseMessage: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [
        {
          kind: "text",
          text: "I'm a simple agent that can be used to test the Langdock A2A implementation.",
        },
      ],
      // Associate the response with the incoming request's context.
      contextId: requestContext.contextId,
    };

    // Publish the message and signal that the interaction is finished.
    eventBus.publish(responseMessage);
    eventBus.finished();
  }

  // cancelTask is not needed for this simple, non-stateful agent.
  cancelTask = async (): Promise<void> => {};
}

// 3. Set up and run the server.
const agentExecutor = new LangdockA2aAgentExecutor();
const requestHandler = new DefaultRequestHandler(
  langdockA2aAgentCard,
  new InMemoryTaskStore(),
  agentExecutor
);

const appBuilder = new A2AExpressApp(requestHandler);
const expressApp = appBuilder.setupRoutes(express());

expressApp.listen(3333, () => {
  console.log(`🚀 Server started on http://localhost:3333`);
});
