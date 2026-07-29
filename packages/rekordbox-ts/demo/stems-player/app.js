const manifest = await fetch("/manifest.json").then((response) => {
  if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
  return response.json();
});

const elements = {
  backend: document.querySelector("#backend"),
  duration: document.querySelector("#duration"),
  mixer: document.querySelector("#mixer"),
  play: document.querySelector("#play"),
  position: document.querySelector("#position"),
  reset: document.querySelector("#reset"),
  status: document.querySelector("#status"),
  subtitle: document.querySelector("#subtitle"),
  timeline: document.querySelector("#timeline"),
  title: document.querySelector("#title"),
};

elements.title.textContent = manifest.title;
elements.subtitle.textContent = `${manifest.excerpt} excerpt · float32 WAV · local only`;
elements.backend.textContent = manifest.backend;

const context = new AudioContext({ latencyHint: "interactive" });
const master = context.createGain();
master.connect(context.destination);

const channels = new Map();
for (const track of manifest.tracks) {
  const fragment = document.querySelector("#channel-template").content.cloneNode(true);
  const card = fragment.querySelector(".channel");
  const fader = fragment.querySelector(".fader");
  const gainLabel = fragment.querySelector(".gain");
  const mute = fragment.querySelector(".mute");
  const solo = fragment.querySelector(".solo");
  card.dataset.track = track.id;
  fragment.querySelector(".channel-kind").textContent =
    track.role === "reference" ? "A · REFERENCE" : "B · SOURCE";
  fragment.querySelector(".channel-name").textContent = track.label;
  elements.mixer.append(fragment);

  const gain = context.createGain();
  gain.connect(master);
  channels.set(track.id, {
    buffer: undefined,
    card,
    fader,
    gain,
    gainLabel,
    id: track.id,
    muted: false,
    role: track.role,
    solo: false,
    source: undefined,
    url: track.url,
  });

  fader.addEventListener("input", () => {
    gainLabel.value = formatGain(Number(fader.value));
    selectPreset("custom");
    applyGains();
  });
  mute.addEventListener("click", () => {
    const channel = channels.get(track.id);
    channel.muted = !channel.muted;
    mute.classList.toggle("active", channel.muted);
    selectPreset("custom");
    applyGains();
  });
  solo.addEventListener("click", () => toggleSolo(track.id));
}

let duration = 45;
let offset = 0;
let startedAt = 0;
let playing = false;
let activePreset = "original";

let loadedChannels = 0;
await Promise.all(
  [...channels.values()].map(async (channel) => {
    const data = await fetch(channel.url).then((response) => {
      if (!response.ok) throw new Error(`${channel.id} request failed: ${response.status}`);
      return response.arrayBuffer();
    });
    channel.buffer = await context.decodeAudioData(data);
    loadedChannels += 1;
    elements.status.textContent = `Loading ${loadedChannels} / ${channels.size}`;
  }),
);

duration = Math.min(...[...channels.values()].map(({ buffer }) => buffer.duration));
elements.duration.textContent = formatTime(duration);
elements.timeline.max = String(duration);
elements.timeline.disabled = false;
elements.play.disabled = false;
elements.status.textContent = "Ready";
setPreset("original");
requestAnimationFrame(render);

function dbToGain(db) {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

function formatGain(db) {
  return db <= -60 ? "−∞ dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

function formatTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = (safe % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

function currentPosition() {
  if (!playing) return offset;
  return Math.min(duration, offset + context.currentTime - startedAt);
}

function stopSources() {
  for (const channel of channels.values()) {
    if (!channel.source) continue;
    channel.source.onended = null;
    try {
      channel.source.stop();
    } catch {
      // A source can already be stopped by the audio clock.
    }
    channel.source.disconnect();
    channel.source = undefined;
  }
}

async function play() {
  if (playing) return;
  await context.resume();
  if (offset >= duration - 0.01) offset = 0;
  stopSources();
  const startAt = context.currentTime + 0.025;
  for (const channel of channels.values()) {
    const source = context.createBufferSource();
    source.buffer = channel.buffer;
    source.connect(channel.gain);
    source.start(startAt, offset);
    channel.source = source;
  }
  startedAt = startAt;
  playing = true;
  elements.play.classList.add("playing");
  elements.play.querySelector(".play-icon").textContent = "Ⅱ";
  elements.play.setAttribute("aria-label", "Pause");
  elements.status.textContent = activePreset === "custom" ? "Custom mix" : "Playing";
}

function pause() {
  if (!playing) return;
  offset = currentPosition();
  playing = false;
  stopSources();
  elements.play.classList.remove("playing");
  elements.play.querySelector(".play-icon").textContent = "▶";
  elements.play.setAttribute("aria-label", "Play");
  elements.status.textContent = "Paused";
}

function seek(next) {
  const wasPlaying = playing;
  if (wasPlaying) pause();
  offset = Math.max(0, Math.min(duration, next));
  elements.timeline.value = String(offset);
  elements.position.textContent = formatTime(offset);
  if (wasPlaying) void play();
}

function selectPreset(name) {
  activePreset = name;
  for (const button of document.querySelectorAll(".preset")) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
}

function setPreset(name) {
  selectPreset(name);
  for (const channel of channels.values()) {
    channel.muted = false;
    channel.solo = false;
    channel.card.querySelector(".mute").classList.remove("active");
    channel.card.querySelector(".solo").classList.remove("active");
    const enabled = name === "original" ? channel.role === "reference" : channel.role === "stem";
    channel.fader.value = enabled ? "0" : "-60";
    channel.gainLabel.value = formatGain(Number(channel.fader.value));
  }
  applyGains();
}

function toggleSolo(id) {
  const selected = channels.get(id);
  const shouldSolo =
    !selected.solo || [...channels.values()].some((item) => item.solo && item.id !== id);
  for (const channel of channels.values()) {
    channel.solo = shouldSolo && channel.id === id;
    channel.card.querySelector(".solo").classList.toggle("active", channel.solo);
  }
  selectPreset("custom");
  applyGains();
}

function applyGains() {
  const hasSolo = [...channels.values()].some(({ solo }) => solo);
  for (const channel of channels.values()) {
    const audible = !channel.muted && (!hasSolo || channel.solo);
    const value = audible ? dbToGain(Number(channel.fader.value)) : 0;
    channel.gain.gain.setTargetAtTime(value, context.currentTime, 0.008);
    channel.card.classList.toggle("silent", value === 0);
    channel.card.classList.toggle("soloed", channel.solo);
  }
}

function render() {
  const position = currentPosition();
  elements.timeline.value = String(position);
  elements.position.textContent = formatTime(position);
  document.documentElement.style.setProperty("--progress", `${(position / duration) * 100}%`);
  if (playing && position >= duration - 0.01) {
    pause();
    offset = duration;
    elements.status.textContent = "Finished";
  }
  requestAnimationFrame(render);
}

elements.play.addEventListener("click", () => (playing ? pause() : void play()));
elements.timeline.addEventListener("input", () => seek(Number(elements.timeline.value)));
elements.reset.addEventListener("click", () => setPreset("original"));
for (const button of document.querySelectorAll(".preset")) {
  button.addEventListener("click", () => setPreset(button.dataset.preset));
}

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    playing ? pause() : void play();
    return;
  }
  if (event.key === "1") setPreset("original");
  if (event.key === "2") setPreset("separated");
  const solos = { b: "bass", d: "drums", o: "other", v: "vocals" };
  if (solos[event.key.toLowerCase()]) toggleSolo(solos[event.key.toLowerCase()]);
});
