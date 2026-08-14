import { useEffect, useMemo, useState } from "react";

import { Waveform } from "./Waveform";

type Step = { label: string; value: string; detail: string };
type Scenario = { id: string; tab: string; prompt: string; intro: string; steps: Step[] };

const scenarios: Scenario[] = [
  {
    id: "usb",
    tab: "Set → USB",
    prompt:
      "Import this set. Reuse anything I own, acquire what’s missing, analyze it, and sync the finished playlist to my USB.",
    intro: "I’ll carry the set through the complete pipeline and verify the export before I call it done.",
    steps: [
      { label: "Inspecting source", value: "1001Tracklists · 58:42", detail: "Found an ordered public tracklist." },
      { label: "Resolving tracklist", value: "21 / 21", detail: "Created ordered library state." },
      { label: "Matching recordings", value: "12 reused · 9 missing", detail: "Matched by recording identity." },
      { label: "Acquiring audio", value: "9 verified", detail: "Retained source provenance." },
      { label: "Analyzing tracks", value: "21 / 21", detail: "BPM, key, grids and waveforms ready." },
      { label: "Creating playlist", value: "Friday — Main Room", detail: "Committed to master.db." },
      { label: "Synchronizing USB", value: "2 libraries", detail: "Reconciled media and ANLZ." },
      { label: "Workflow complete", value: "Safe to eject", detail: "Everything verified." },
    ],
  },
  {
    id: "crate",
    tab: "Build a crate",
    prompt:
      "Find 24 hypnotic late-night tracks I own. Build a rising-energy set and open it for transition practice.",
    intro: "I’ll search the playable library, shape a coherent arc, and open the result in the workstation.",
    steps: [
      { label: "Reading library", value: "8,412 tracks", detail: "Scoped to playable recordings." },
      { label: "Finding candidates", value: "163 matches", detail: "Combined mood, BPM and key." },
      { label: "Shaping the arc", value: "112 → 128 BPM", detail: "Built a gradual energy rise." },
      { label: "Checking transitions", value: "23 pairs", detail: "Compared phrases and keys." },
      { label: "Creating playlist", value: "Afterhours Geometry", detail: "Wrote 24 recording IDs." },
      { label: "Opening workbench", value: "Two decks", detail: "Ready to audition." },
    ],
  },
  {
    id: "decks",
    tab: "Load the decks",
    prompt: "Serve my library to the CDJs and load ‘Apathy’ on player 3. Leave it cued.",
    intro: "I’ll verify the network and library source, then load the player without starting playback.",
    steps: [
      { label: "Discovering players", value: "3 online", detail: "Found CDJs and mixer." },
      { label: "Checking library", value: "RemoteDB ready", detail: "Validated audio and analysis." },
      { label: "Matching track", value: "Apathy · 124 BPM", detail: "Found one playable recording." },
      { label: "Loading player 3", value: "Mounted", detail: "Served metadata and media." },
      { label: "Ready on deck", value: "Cued · stopped", detail: "Playback remains physical." },
    ],
  },
];

export function WorkflowDemo() {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const scenario = useMemo(
    () => scenarios.find((candidate) => candidate.id === scenarioId) ?? scenarios[0],
    [scenarioId],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () => setStep((current) => (current + 1) % scenario.steps.length),
      2200,
    );
    return () => window.clearInterval(timer);
  }, [playing, scenario.steps.length]);

  function selectScenario(id: string) {
    setScenarioId(id);
    setStep(0);
  }

  return (
    <div className="workflow-demo">
      <div className="demo-bar">
        <span className="traffic"><i /><i /><i /></span>
        <strong>⌁ Codex <b>/</b> djbooth.ai</strong>
        <span className="local"><i /> local</span>
      </div>
      <div className="demo-tabs">
        {scenarios.map((candidate) => (
          <button
            key={candidate.id}
            className={candidate.id === scenarioId ? "active" : ""}
            type="button"
            onClick={() => selectScenario(candidate.id)}
          >
            {candidate.tab}
          </button>
        ))}
      </div>
      <div className="demo-body">
        <div className="conversation">
          <div className="message user-message">
            <span className="avatar">G</span>
            <div><small>You</small><p>{scenario.prompt}</p></div>
          </div>
          <div className="message agent-message">
            <span className="avatar agent-avatar">⌁</span>
            <div>
              <small>Codex</small>
              <p>{scenario.intro}</p>
              <ol className="demo-log">
                {scenario.steps.map((item, index) => (
                  <li
                    key={item.label}
                    className={index < step ? "done" : index === step ? "current" : ""}
                  >
                    <span>{index < step ? "✓" : index === step ? "◐" : "○"}</span>
                    <strong>{item.label}</strong>
                    <small>{item.value}</small>
                    <p>{item.detail}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
        <aside className="workflow-state">
          <header><span>Live workflow</span><strong>{scenario.tab}</strong></header>
          <Waveform />
          <ol>
            {scenario.steps.map((item, index) => (
              <li key={item.label} className={index < step ? "done" : index === step ? "current" : ""}>
                <i /><span>{item.label}</span><small>{item.value}</small>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <div className="demo-controls">
        <button type="button" onClick={() => setStep((step - 1 + scenario.steps.length) % scenario.steps.length)}>←</button>
        <button type="button" onClick={() => setPlaying((current) => !current)}>{playing ? "Pause" : "Play"}</button>
        <span><i style={{ width: `${((step + 1) / scenario.steps.length) * 100}%` }} /></span>
        <small>{step + 1} / {scenario.steps.length}</small>
        <button type="button" onClick={() => setStep((step + 1) % scenario.steps.length)}>→</button>
      </div>
    </div>
  );
}
