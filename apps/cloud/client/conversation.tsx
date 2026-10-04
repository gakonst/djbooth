import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import {
  AgentProvider,
  AgentMessages,
  AgentComposer,
  AgentStatus,
  useAgentEmbed,
} from "nanocodex-connect-embed/primitives";
import type { Agent } from "nanocodex-connect-embed/headless";

/** The app owns layout and colors; the SDK owns conversation state and controls. */
export function mountConversation(element: HTMLElement, agent: Agent): Root {
  const root = createRoot(element);
  root.render(
    <AgentProvider agent={agent}>
      <MusicConversation />
    </AgentProvider>,
  );
  return root;
}

function MusicConversation() {
  const { controller } = useAgentEmbed();
  const [draft, setDraft] = useState("");
  return (
    <div className="music-conversation" data-running={controller.running}>
      <AgentMessages
        aria-label="Conversation with Booth"
        empty={null}
        renderEntry={(entry) => (
          <p data-role={entry.kind} key={entry.id}>
            {`${entry.kind === "user" ? "You" : entry.kind === "error" ? "Status" : "DJ Booth"}
${"text" in entry ? entry.text : ""}`}
          </p>
        )}
      />
      <AgentStatus>
        {({ controller }) =>
          controller.running ? (
            <p>Your agent is working…</p>
          ) : controller.status === "Cancelled" ? (
            <p>Stopped.</p>
          ) : null
        }
      </AgentStatus>
      <AgentComposer
        aria-label="Ask your agent"
        draft={draft}
        onDraftChange={setDraft}
        promptIntent="queue"
        placeholder="Look at my saved music and suggest an opening for a late-night set…"
        submitLabel="Send"
        cancelLabel="Stop"
        label="Ask your agent"
        submitDisabled={controller.running || controller.pendingTurns > 0 || draft.length > 16000}
      />
      {draft.length > 16000 && <p role="alert">Enter a message of up to 16,000 characters.</p>}
    </div>
  );
}
