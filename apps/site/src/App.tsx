import { useEffect, useMemo, useState, type ComponentType } from "react";

import { BrandMark } from "./components/BrandMark";
import { Waveform } from "./components/Waveform";
import { WorkflowDemo } from "./components/WorkflowDemo";

type Topic = "Agents" | "Audio engineering" | "Reverse engineering" | "Performance";
type PostMetadata = {
  title: string;
  description: string;
  publishedAt: string;
  topic: Topic;
  tags: string[];
  featured?: boolean;
  readingTime: string;
};
type PostModule = { default: ComponentType; metadata: PostMetadata };
type Post = PostModule & { slug: string };

const postModules = import.meta.glob<PostModule>("./data/blog/*.mdx", { eager: true });
const posts: Post[] = Object.entries(postModules)
  .map(([path, module]) => ({
    ...module,
    slug: path.split("/").at(-1)?.replace(/\.mdx$/u, "") ?? "",
  }))
  .sort((left, right) => right.metadata.publishedAt.localeCompare(left.metadata.publishedAt));

const overview = [
  [
    "Complete workflows, not isolated tools.",
    "Resolve sets, acquire recordings, enrich metadata, analyze audio, build playlists and deliver them to the booth in one resumable system.",
  ],
  [
    "Local-first by design.",
    "Your library, music and derived artifacts stay on your machine. Rekordbox master.db remains the durable source of truth.",
  ],
  [
    "Works with the booth you already use.",
    "Generate compatible databases, waveforms and analysis for USB export, or serve the same library directly to connected CDJs.",
  ],
  [
    "Built for Codex and Claude Code.",
    "Install djbooth into the agent you already use. Typed tools expose the full workflow without adding another shallow chat interface.",
  ],
];

const pipeline = [
  ["01", "Resolve", "A set URL, playlist, file or description becomes ordered library state."],
  ["02", "Acquire", "Exact recordings are matched, reused when owned and acquired when missing."],
  ["03", "Understand", "Metadata, BPM, key, grids, phrases, waveforms and stems become available."],
  ["04", "Organize", "The agent builds crates, playlists, cues and complete set arcs."],
  ["05", "Perform", "The same library is synchronized to USB or served to connected CDJs."],
];

export function App() {
  const pathname = normalizePath(window.location.pathname);
  const articleSlug = pathname.startsWith("/blog/") ? pathname.slice("/blog/".length) : undefined;

  if (pathname === "/") return <HomePage />;
  if (pathname === "/blog") return <BlogIndex />;
  if (articleSlug) {
    const post = posts.find((candidate) => candidate.slug === articleSlug);
    if (post) return <ArticlePage post={post} />;
  }
  return <NotFound />;
}

function HomePage() {
  usePageMetadata(
    "djbooth.ai — Give your agent a DJ booth",
    "Complete, local-first DJ workflows for Codex and Claude Code.",
  );
  const [installAgent, setInstallAgent] = useState<"codex" | "claude">("codex");
  const install =
    installAgent === "codex"
      ? ["codex plugin marketplace add gakonst/djbooth", "codex plugin add djbooth@djbooth-ai"]
      : [
          "claude plugin marketplace add gakonst/djbooth",
          "claude plugin install djbooth@djbooth-ai",
        ];

  return (
    <Page>
      <main>
        <section className="home-hero">
          <div className="wide hero-layout">
            <div className="hero-copy">
              <a className="hero-brand" href="/">
                <BrandMark size={54} /> <span>djbooth.ai</span>
              </a>
              <h1>Give your agent<br />a DJ booth.</h1>
              <p>
                Complete, local-first DJ workflows for Codex and Claude Code—from finding the
                music to playing it on real decks.
              </p>
              <div className="actions">
                <a className="primary" href="#install">Get Started</a>
                <a className="secondary" href="https://github.com/gakonst/djbooth">GitHub</a>
              </div>
              <CopyPrompt />
              <div className="built-for">
                <small>BUILT FOR</small>
                <strong>⌁ Codex</strong>
                <strong>Claude Code</strong>
              </div>
            </div>
            <div className="hero-product" id="workflow">
              <WorkflowDemo />
              <small>Captured-style workflows from Codex and djbooth.ai</small>
            </div>
          </div>
        </section>

        <section className="overview section">
          <div className="medium">
            <h2>Overview</h2>
            <div className="overview-grid">
              {overview.map(([title, description]) => (
                <article key={title}>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="pipeline section">
          <div className="medium">
            <header className="section-intro">
              <h2>The whole life of a track.</h2>
              <p>
                DJ software usually starts after you have the file. djbooth begins with intent and
                carries durable state all the way to the booth.
              </p>
            </header>
            <ol>
              {pipeline.map(([number, title, description]) => (
                <li key={number}>
                  <small>{number}</small><h3>{title}</h3><p>{description}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="workbench section">
          <div className="medium centered-section">
            <h2>When the work becomes visual.</h2>
            <p>
              Codex and Claude handle intent and execution. The workstation opens when you need to
              see the library, hear a transition or touch the decks yourself.
            </p>
            <WorkbenchPreview />
          </div>
        </section>

        <section className="journal section">
          <div className="medium">
            <header className="section-intro">
              <h2>Engineering field notes.</h2>
              <p>
                Reverse-engineering the formats behind the booth and rebuilding audio tools with
                modern models.
              </p>
            </header>
            <PostList posts={posts.slice(0, 4)} />
            <a className="text-link" href="/blog/">All field notes →</a>
          </div>
        </section>

        <section className="install section" id="install">
          <div className="medium install-layout">
            <div>
              <h2>Install it.<br />Ask for the outcome.</h2>
              <p>Your music, library and credentials stay local.</p>
            </div>
            <div className="install-box">
              <div className="install-tabs">
                <button className={installAgent === "codex" ? "active" : ""} onClick={() => setInstallAgent("codex")}>Codex</button>
                <button className={installAgent === "claude" ? "active" : ""} onClick={() => setInstallAgent("claude")}>Claude Code</button>
              </div>
              {install.map((command) => <code key={command}>$ {command}</code>)}
              <small>Requires the djbooth runtime during the current preview.</small>
            </div>
          </div>
        </section>
      </main>
    </Page>
  );
}

function BlogIndex() {
  usePageMetadata(
    "Engineering field notes — djbooth.ai",
    "Reverse engineering, audio engineering, agentic workflows and the protocols behind the booth.",
  );
  return (
    <Page header>
      <main>
        <header className="blog-hero medium">
          <small>DJBOOTH LABS / FIELD NOTES</small>
          <h1>Music software,<br />opened up.</h1>
          <p>
            Reverse-engineering the formats behind the booth, rebuilding audio tools with modern
            models, and making complete music workflows legible to agents and humans.
          </p>
        </header>
        <section className="blog-list medium">
          <div className="list-count">{String(posts.length).padStart(2, "0")} field notes</div>
          <PostList posts={posts} />
        </section>
      </main>
    </Page>
  );
}

function ArticlePage({ post }: { post: Post }) {
  usePageMetadata(`${post.metadata.title} — djbooth.ai`, post.metadata.description);
  const Content = post.default;
  return (
    <Page header>
      <main className="article-page">
        <article className="article medium">
          <a className="back" href="/blog/">← Engineering field notes</a>
          <header>
            <div className="article-meta">
              <span>{post.metadata.topic}</span>
              <time>{formatDate(post.metadata.publishedAt)}</time>
              <span>{post.metadata.readingTime}</span>
            </div>
            <h1>{post.metadata.title}</h1>
            <p>{post.metadata.description}</p>
          </header>
          <div className="article-wave"><Waveform /></div>
          <div className="prose"><Content /></div>
          <footer className="article-tags">
            {post.metadata.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          </footer>
        </article>
      </main>
    </Page>
  );
}

function PostList({ posts: items }: { posts: Post[] }) {
  return (
    <div className="post-list">
      {items.map((post) => (
        <article key={post.slug}>
          <a href={`/blog/${post.slug}/`}>
            <div className="post-meta"><span>{post.metadata.topic}</span><time>{formatDate(post.metadata.publishedAt)}</time></div>
            <h3>{post.metadata.title}</h3>
            <p>{post.metadata.description}</p>
            <b aria-hidden="true">↗</b>
          </a>
        </article>
      ))}
    </div>
  );
}

function CopyPrompt() {
  const [copied, setCopied] = useState(false);
  const prompt = "Install djbooth.ai, then prepare this set for my USB.";
  return (
    <button
      className={`copy-prompt ${copied ? "copied" : ""}`}
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(prompt);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <code>{prompt}</code><span>{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

function WorkbenchPreview() {
  const tracks = [
    ["Ritual", "Mita Gami", "122.0"],
    ["Apathy", "Adam Ten", "124.0"],
    ["Surrender", "Tal Fussman", "125.0"],
    ["The Night", "Sahar Z", "126.0"],
  ];
  return (
    <div className="workbench-preview">
      <header><span><BrandMark size={20} /> djbooth.ai</span><strong>Friday — Main Room</strong><small>library online</small></header>
      <div className="workbench-body">
        <aside><small>PLAYLISTS</small><span>Warm up</span><span className="active">Friday — Main Room</span><span>Afterhours</span></aside>
        <div className="tracks">
          {tracks.map((track, index) => <div className={index === 1 ? "active" : ""} key={track[0]}><small>0{index + 1}</small><strong>{track[0]}</strong><span>{track[1]}</span><code>{track[2]}</code></div>)}
          <section><strong>DECK A · Apathy — Adam Ten</strong><Waveform /></section>
        </div>
      </div>
    </div>
  );
}

function Page({ header = false, children }: { header?: boolean; children: React.ReactNode }) {
  return (
    <>
      {header ? <SiteHeader /> : null}
      {children}
      <footer className="site-footer medium"><a href="/"><BrandMark size={26} /> djbooth.ai</a><span>Give your agent a DJ booth.</span><a href="https://github.com/gakonst/djbooth">GitHub ↗</a></footer>
    </>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="medium">
        <a href="/"><BrandMark size={30} /> <strong>djbooth.ai</strong></a>
        <nav><a href="/#workflow">Workflow</a><a href="/blog/">Field notes</a><a href="https://github.com/gakonst/djbooth">GitHub</a></nav>
      </div>
    </header>
  );
}

function NotFound() {
  return <Page header><main className="not-found medium"><h1>Nothing on this deck.</h1><a href="/">Return home →</a></main></Page>;
}

function usePageMetadata(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
    window.scrollTo(0, 0);
  }, [description, title]);
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function normalizePath(value: string) {
  const withoutTrailingSlash = value.length > 1 ? value.replace(/\/+$/u, "") : value;
  return withoutTrailingSlash || "/";
}
