// Generates docs/topology.svg and docs/database.svg for DMAIC Studio.
// Usage (from the repository root): node docs/generate-diagrams.js docs
const fs = require("fs");
const path = require("path");
const outDir = process.argv[2];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLE = `
  <style>
    .bg { fill: #ffffff; }
    .ink { fill: #18283f; }
    .muted { fill: #5f6f84; }
    .box { fill: #f6f8fb; stroke: #c3cdd9; stroke-width: 1.2; }
    .group { fill: #f2f7f4; stroke: #173f35; stroke-width: 1.4; }
    .group-soft { fill: #f7f9fc; stroke: #b9c4d1; stroke-width: 1.2; stroke-dasharray: 5 4; }
    .edge { stroke: #5f6f84; stroke-width: 1.4; fill: none; }
    .edge-strong { stroke: #18283f; stroke-width: 1.8; fill: none; }
    .edge-dash { stroke: #5f6f84; stroke-width: 1.4; fill: none; stroke-dasharray: 5 4; }
    .arrow { fill: #5f6f84; }
    .arrow-strong { fill: #18283f; }
    .label-bg { fill: #ffffff; }
    .row-alt { fill: #eef2f7; }
    .badge-pk { fill: #f3c64a; }
    .badge-fk { fill: #9cc2ec; }
    .badge-text { fill: #18283f; }
    .acc-green { fill: #173f35; } .stroke-green { stroke: #173f35; }
    .acc-blue { fill: #347fce; } .stroke-blue { stroke: #347fce; }
    .acc-purple { fill: #7957c8; } .stroke-purple { stroke: #7957c8; }
    .acc-orange { fill: #d87735; } .stroke-orange { stroke: #d87735; }
    .acc-teal { fill: #27966f; } .stroke-teal { stroke: #27966f; }
    .acc-gray { fill: #3d4a5c; } .stroke-gray { stroke: #3d4a5c; }
    .on-acc { fill: #ffffff; }
    text { font-family: "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0f1720; }
      .ink, .badge-text { fill: #e6edf3; }
      .muted { fill: #9aa7b5; }
      .box { fill: #17212b; stroke: #3a4756; }
      .group { fill: #12211c; stroke: #4fae85; }
      .group-soft { fill: #141c25; stroke: #3a4756; }
      .edge, .edge-dash { stroke: #9aa7b5; }
      .edge-strong { stroke: #e6edf3; }
      .arrow { fill: #9aa7b5; }
      .arrow-strong { fill: #e6edf3; }
      .label-bg { fill: #0f1720; }
      .row-alt { fill: #1c2733; }
      .badge-pk { fill: #b8912a; }
      .badge-fk { fill: #3b6ea8; }
      .acc-green { fill: #2f7a5e; } .stroke-green { stroke: #4fae85; }
      .acc-blue { fill: #2f6fb4; } .stroke-blue { stroke: #6aa6e6; }
      .acc-purple { fill: #6a4cb5; } .stroke-purple { stroke: #a58be6; }
      .acc-orange { fill: #b8642c; } .stroke-orange { stroke: #ea9a63; }
      .acc-teal { fill: #23805f; } .stroke-teal { stroke: #5cc39d; }
      .acc-gray { fill: #4a586b; } .stroke-gray { stroke: #8795a8; }
    }
  </style>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="arrow"/>
    </marker>
    <marker id="arrow-strong" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="arrow-strong"/>
    </marker>
  </defs>`;

function svgDoc(width, height, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">
  <title id="t">${esc(title)}</title>
  <desc id="d">${esc(desc)}</desc>${STYLE}
  <rect class="bg" width="${width}" height="${height}"/>
${body}
</svg>
`;
}

// A box with a colored header strip and lines of text.
function card({ x, y, w, h, accent, title, subtitle, lines = [], mono = [] }) {
  let s = `  <g>
    <rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/>
    <path class="acc-${accent}" d="M${x} ${y + 9} a9 9 0 0 1 9 -9 h${w - 18} a9 9 0 0 1 9 9 v${subtitle ? 37 : 23} h-${w} z"/>
    <text class="on-acc" x="${x + 14}" y="${y + 21}" font-size="14" font-weight="700">${esc(title)}</text>
`;
  if (subtitle) s += `    <text class="on-acc" x="${x + 14}" y="${y + 38}" font-size="11.5" opacity="0.9">${esc(subtitle)}</text>\n`;
  let ty = y + (subtitle ? 66 : 52);
  for (const line of lines) {
    const isMono = mono.includes(line);
    s += `    <text class="${isMono ? "ink mono" : "ink"}" x="${x + 14}" y="${ty}" font-size="12.5">${esc(line)}</text>\n`;
    ty += 19;
  }
  return s + "  </g>\n";
}

// A cylinder for a Docker volume.
function volume({ x, y, w, h, accent, title, lines }) {
  const ry = 9;
  let s = `  <g>
    <path class="box stroke-${accent}" d="M${x} ${y + ry} v${h - 2 * ry} a${w / 2} ${ry} 0 0 0 ${w} 0 v-${h - 2 * ry}"/>
    <ellipse class="box stroke-${accent}" cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}"/>
    <text class="ink" x="${x + w / 2}" y="${y + ry + 26}" font-size="13" font-weight="700" text-anchor="middle">${esc(title)}</text>
`;
  let ty = y + ry + 45;
  for (const line of lines) {
    s += `    <text class="muted mono" x="${x + w / 2}" y="${ty}" font-size="11.5" text-anchor="middle">${esc(line)}</text>\n`;
    ty += 17;
  }
  return s + "  </g>\n";
}

function edge(d, { strong = false, dash = false, both = false } = {}) {
  const cls = strong ? "edge-strong" : dash ? "edge-dash" : "edge";
  const marker = strong ? "url(#arrow-strong)" : "url(#arrow)";
  return `  <path class="${cls}" d="${d}" marker-end="${marker}"${both ? ` marker-start="${marker}"` : ""}/>\n`;
}

// Edge label with a background so it stays readable over lines.
function label(x, y, text, { anchor = "middle", size = 11.5, cls = "muted", bold = false } = {}) {
  const width = text.length * size * 0.56 + 10;
  const bx = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x - 5;
  return `  <rect class="label-bg" x="${bx.toFixed(1)}" y="${y - size}" width="${width.toFixed(1)}" height="${size + 6}" rx="3"/>
  <text class="${cls}" x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}"${bold ? ' font-weight="700"' : ""}>${esc(text)}</text>\n`;
}

// ---------------------------------------------------------------------------
// Site topology

function topology() {
  const W = 1240, H = 800;
  let b = "";
  b += `  <text class="ink" x="40" y="44" font-size="22" font-weight="700">DMAIC Studio · site topology</text>\n`;
  b += `  <text class="muted" x="40" y="66" font-size="13">How a request reaches the app, where data lives, and how new versions get to the server.</text>\n`;

  // Server boundary
  b += `  <rect class="group" x="360" y="96" width="840" height="430" rx="14"/>\n`;
  b += `  <text class="ink" x="382" y="124" font-size="15" font-weight="700">Server 83.136.219.141</text>\n`;
  b += `  <text class="muted" x="382" y="143" font-size="12">Docker Compose project "dmaic" (DMAIC/deploy) · only ports 80 and 443 are open to the internet</text>\n`;

  // Internet side
  b += card({ x: 40, y: 150, w: 250, h: 132, accent: "blue", title: "Users' browsers", subtitle: "Web app: HTML, CSS, JavaScript",
    lines: ["Projects, phases, BPMN.js editor", "Session cookie: HttpOnly, Secure", "Calls /api with X-DMAIC header"] });
  b += card({ x: 40, y: 330, w: 250, h: 96, accent: "teal", title: "Let's Encrypt", subtitle: "Certificate authority",
    lines: ["Issues and renews the HTTPS", "certificate for the domain"] });
  b += card({ x: 40, y: 452, w: 250, h: 76, accent: "gray", title: "Google Fonts", lines: ["Web font loaded by the browser"] });

  // Inside the server
  b += card({ x: 395, y: 172, w: 260, h: 168, accent: "green", title: "caddy", subtitle: "caddy:2.10-alpine · ports 80, 443",
    lines: ["Automatic HTTPS for dmaic.gadea.ai", "Redirects HTTP to HTTPS", "Adds HSTS, compresses responses", "Reverse proxy to app:8124"] });
  b += card({ x: 790, y: 172, w: 380, h: 206, accent: "blue", title: "app", subtitle: "ghcr.io/deg333/dmaic · Rust (axum) · port 8124, internal only",
    lines: ["/        static files from web/", "/api/*   REST API (projects, admin, auth)", "Accounts: Argon2id passwords, sessions", "Sign-in throttling, CSRF header check", "Health check: dmaic-studio healthcheck", "Runs as unprivileged user 10001"],
    mono: ["/        static files from web/", "/api/*   REST API (projects, admin, auth)"] });
  b += volume({ x: 840, y: 410, w: 280, h: 98, accent: "purple", title: "dmaic-data volume (/data)",
    lines: ["dmaic.sqlite  (SQLite, WAL mode)", "backups/  last 10, one per deploy"] });
  b += volume({ x: 430, y: 410, w: 190, h: 82, accent: "purple", title: "caddy-data volume", lines: ["certificates and keys"] });

  // Request path
  b += edge("M290 216 H395", { strong: true });
  b += label(342, 206, "HTTPS 443", { cls: "ink", bold: true });
  b += label(342, 236, "dmaic.gadea.ai", {});
  b += edge("M655 256 H790", { strong: true });
  b += label(722, 246, "HTTP", { cls: "ink", bold: true });
  b += label(722, 276, "internal network", {});
  b += edge("M980 378 V410", { strong: true, both: true });
  b += label(970, 398, "rusqlite (SQLite bundled)", { anchor: "end", size: 11 });
  b += edge("M525 340 V410", { both: true });
  b += edge("M290 378 H340 V300 H395", { dash: true, both: true });
  b += label(318, 312, "ACME", {});
  b += edge("M40 490 H26 V230 H40", { dash: true });

  // Delivery pipeline
  const py = 590;
  b += `  <text class="ink" x="40" y="${py - 18}" font-size="15" font-weight="700">Delivering a new version</text>\n`;
  b += card({ x: 40, y: py, w: 230, h: 120, accent: "gray", title: "Developer PC", subtitle: "C:\\dmaic\\claude\\DMAIC",
    lines: ["git push origin main", "ssh … deploy/deploy.sh"], mono: ["git push origin main", "ssh … deploy/deploy.sh"] });
  b += card({ x: 330, y: py, w: 240, h: 120, accent: "gray", title: "GitHub repository", subtitle: "github.com/deg333/DMAIC",
    lines: ["Source code, web/, deploy/", "Workflow: Docker image"] });
  b += card({ x: 630, y: py, w: 250, h: 120, accent: "orange", title: "GitHub Actions", subtitle: "~4 min per build",
    lines: ["Builds the Docker image", "on every push to main"] });
  b += card({ x: 940, y: py, w: 260, h: 120, accent: "orange", title: "GitHub Container Registry", subtitle: "ghcr.io/deg333/dmaic",
    lines: [":latest   newest main build", ":sha-…    every build (rollback)"], mono: [":latest   newest main build", ":sha-…    every build (rollback)"] });
  b += edge("M270 650 H330");
  b += label(300, 640, "push", {});
  b += edge("M570 650 H630");
  b += label(600, 640, "trigger", {});
  b += edge("M880 650 H940");
  b += label(910, 640, "publish", {});
  b += edge("M1070 590 V526", { strong: true });
  b += label(1070, 562, "docker compose pull", { cls: "ink" });
  b += edge("M245 590 V560 H720 V526", { dash: true });
  b += label(482, 552, "ssh: deploy.sh backs up the database, pulls the image, restarts, checks health", { anchor: "middle", size: 11 });
  return svgDoc(W, H, "DMAIC Studio site topology",
    "Browsers reach Caddy over HTTPS at dmaic.gadea.ai on the server 83.136.219.141. Caddy gets certificates from Let's Encrypt and proxies to the Rust app on an internal port. The app stores data in SQLite on the dmaic-data volume. New versions are pushed to GitHub, built by GitHub Actions, published to ghcr.io, and pulled onto the server by deploy.sh.",
    b);
}

// ---------------------------------------------------------------------------
// Database schema

const T = (name, cols) => ({ name, cols: cols.map(([c, type, flag, ref]) => ({ c, type, flag, ref })) });
const tables = {
  users: T("users", [["id", "TEXT", "PK"], ["username", "TEXT", "UQ"], ["password_hash", "TEXT"], ["created_at", "TEXT"], ["is_admin", "INTEGER"], ["disabled", "INTEGER"], ["last_login_at", "TEXT"]]),
  sessions: T("sessions", [["token_hash", "TEXT", "PK"], ["user_id", "TEXT", "FK"], ["created_at", "TEXT"], ["expires_at", "TEXT"]]),
  user_settings: T("user_settings", [["user_id", "TEXT", "PK FK"], ["key", "TEXT", "PK"], ["value", "TEXT"]]),
  site_settings: T("site_settings", [["key", "TEXT", "PK"], ["value", "TEXT"]]),
  projects: T("projects", [["id", "TEXT", "PK"], ["owner_user_id", "TEXT", "FK"], ["name", "TEXT"], ["problem", "TEXT"], ["owner", "TEXT"], ["status", "TEXT"], ["current_phase", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]]),
  project_members: T("project_members", [["project_id", "TEXT", "PK FK"], ["user_id", "TEXT", "PK FK"], ["added_at", "TEXT"]]),
  phase_entries: T("phase_entries", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["phase", "TEXT"], ["tab", "TEXT"], ["title", "TEXT"], ["detail", "TEXT"], ["owner", "TEXT"], ["status", "TEXT"], ["due_date", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]]),
  phase_notes: T("phase_notes", [["project_id", "TEXT", "PK FK"], ["phase", "TEXT", "PK"], ["tab", "TEXT", "PK"], ["note", "TEXT"], ["updated_at", "TEXT"]]),
  process_maps: T("process_maps", [["project_id", "TEXT", "PK FK"], ["xml", "TEXT"], ["updated_at", "TEXT"]]),
  define_evidence: T("define_evidence", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["title", "TEXT"], ["detail", "TEXT"], ["file_name", "TEXT"], ["mime_type", "TEXT"], ["file_data", "BLOB"], ["created_at", "TEXT"]]),
  define_charters: T("define_charters", [["project_id", "TEXT", "PK FK"], ["problem", "TEXT"], ["business_case", "TEXT"], ["goal", "TEXT"], ["in_scope", "TEXT"], ["out_scope", "TEXT"], ["constraints", "TEXT"], ["assumptions", "TEXT"], ["sponsor", "TEXT"], ["start_date", "TEXT"], ["end_date", "TEXT"], ["budget", "TEXT"], ["updated_at", "TEXT"]]),
  define_risks: T("define_risks", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["description", "TEXT"], ["impact", "INTEGER"], ["probability", "INTEGER"], ["mitigation", "TEXT"], ["status", "TEXT"], ["created_at", "TEXT"]]),
  define_stakeholders: T("define_stakeholders", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["name", "TEXT"], ["role", "TEXT"], ["power", "INTEGER"], ["interest", "INTEGER"], ["strategy", "TEXT"], ["engagement", "TEXT"], ["created_at", "TEXT"]]),
  define_communications: T("define_communications", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["audience", "TEXT"], ["purpose", "TEXT"], ["channel", "TEXT"], ["cadence", "TEXT"], ["owner", "TEXT"], ["created_at", "TEXT"]]),
  define_sipoc: T("define_sipoc", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["stage", "TEXT"], ["value", "TEXT"], ["sort_order", "INTEGER"]]),
  define_voc_segments: T("define_voc_segments", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["name", "TEXT"], ["created_at", "TEXT"]]),
  define_voc_items: T("define_voc_items", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["segment_id", "TEXT", "FK"], ["voice", "TEXT"], ["issue", "TEXT"], ["need", "TEXT"], ["kano", "TEXT"], ["created_at", "TEXT"]]),
  define_affinity_groups: T("define_affinity_groups", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["name", "TEXT"], ["sort_order", "INTEGER"]]),
  define_affinity_cards: T("define_affinity_cards", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["group_id", "TEXT", "FK"], ["text", "TEXT"], ["created_at", "TEXT"]]),
  define_ctq_nodes: T("define_ctq_nodes", [["id", "TEXT", "PK"], ["project_id", "TEXT", "FK"], ["parent_id", "TEXT", "FK"], ["node_type", "TEXT"], ["title", "TEXT"], ["sort_order", "INTEGER"]]),
};

const TW = 210, HEAD = 28, ROW = 18, PAD = 8;
const tableHeight = (t) => HEAD + t.cols.length * ROW + PAD;
const placed = {};
const rowY = (name, col) => { const p = placed[name]; return p.y + HEAD + p.t.cols.findIndex((c) => c.c === col) * ROW + ROW / 2 + 2; };

function drawTable(name, x, y, accent) {
  const t = tables[name];
  placed[name] = { x, y, t };
  const h = tableHeight(t);
  let s = `  <g>
    <rect class="box" x="${x}" y="${y}" width="${TW}" height="${h}" rx="7"/>
    <path class="acc-${accent}" d="M${x} ${y + 7} a7 7 0 0 1 7 -7 h${TW - 14} a7 7 0 0 1 7 7 v${HEAD - 7} h-${TW} z"/>
    <text class="on-acc mono" x="${x + 10}" y="${y + 19}" font-size="12.5" font-weight="700">${esc(t.name)}</text>
`;
  t.cols.forEach((col, i) => {
    const ry = y + HEAD + i * ROW;
    if (i % 2 === 1) s += `    <rect class="row-alt" x="${x + 1}" y="${ry}" width="${TW - 2}" height="${ROW}"/>\n`;
    let bx = x + 8;
    for (const flag of (col.flag || "").split(" ").filter(Boolean)) {
      const cls = flag === "PK" ? "badge-pk" : flag === "FK" ? "badge-fk" : "badge-fk";
      s += `    <rect class="${cls}" x="${bx}" y="${ry + 3.5}" width="20" height="11" rx="2.5"/>
    <text class="badge-text" x="${bx + 10}" y="${ry + 12}" font-size="8" font-weight="700" text-anchor="middle">${flag}</text>\n`;
      bx += 23;
    }
    const nameX = x + 8 + 46;
    s += `    <text class="ink mono" x="${nameX}" y="${ry + 13}" font-size="11.5">${esc(col.c)}</text>
    <text class="muted mono" x="${x + TW - 9}" y="${ry + 13}" font-size="10" text-anchor="end">${col.type}</text>\n`;
  });
  return s + "  </g>\n";
}

function database() {
  let b = "";
  b += `  <text class="ink" x="40" y="44" font-size="22" font-weight="700">DMAIC Studio · database tables</text>\n`;
  b += `  <text class="muted" x="40" y="66" font-size="13">SQLite file /data/dmaic.sqlite · schema version 2 · foreign keys enforced · arrows point from the referencing column to the referenced key</text>\n`;

  // Legend
  const lx = 1290;
  b += `  <rect class="badge-pk" x="${lx}" y="33" width="20" height="11" rx="2.5"/><text class="badge-text" x="${lx + 10}" y="41.5" font-size="8" font-weight="700" text-anchor="middle">PK</text>
  <text class="muted" x="${lx + 27}" y="42" font-size="12">primary key</text>
  <rect class="badge-fk" x="${lx + 115}" y="33" width="20" height="11" rx="2.5"/><text class="badge-text" x="${lx + 125}" y="41.5" font-size="8" font-weight="700" text-anchor="middle">FK</text>
  <text class="muted" x="${lx + 142}" y="42" font-size="12">foreign key</text>
  <rect class="badge-fk" x="${lx + 230}" y="33" width="20" height="11" rx="2.5"/><text class="badge-text" x="${lx + 240}" y="41.5" font-size="8" font-weight="700" text-anchor="middle">UQ</text>
  <text class="muted" x="${lx + 257}" y="42" font-size="12">unique (case-insensitive)</text>\n`;

  // Group backgrounds
  const top = 100;
  b += `  <rect class="group-soft" x="20" y="${top}" width="290" height="700" rx="12"/>
  <text class="ink" x="40" y="${top + 26}" font-size="14" font-weight="700">Accounts and settings</text>\n`;
  b += `  <rect class="group-soft" x="350" y="${top}" width="290" height="700" rx="12"/>
  <text class="ink" x="370" y="${top + 26}" font-size="14" font-weight="700">Projects and sharing</text>\n`;
  const gx = 680, gw = 5 * TW + 4 * 22 + 40;
  const W = gx + gw + 20;
  b += `  <rect class="group-soft" x="${gx}" y="${top}" width="${gw}" height="700" rx="12"/>
  <text class="ink" x="${gx + 20}" y="${top + 26}" font-size="14" font-weight="700">Project records</text>
  <text class="muted" x="${gx + 20}" y="${top + 45}" font-size="12">Every table here has project_id → projects.id and is deleted with its project (ON DELETE CASCADE).</text>\n`;

  // Accounts column
  const cy = top + 50;
  b += drawTable("users", 55, cy, "blue");
  b += drawTable("sessions", 55, cy + tableHeight(tables.users) + 50, "blue");
  b += drawTable("user_settings", 55, placed.sessions.y + tableHeight(tables.sessions) + 50, "blue");
  b += drawTable("site_settings", 55, placed.user_settings.y + tableHeight(tables.user_settings) + 50, "gray");
  b += `  <text class="muted" x="55" y="${placed.site_settings.y + tableHeight(tables.site_settings) + 22}" font-size="11.5">Server-wide sign-up rules, set in</text>
  <text class="muted" x="55" y="${placed.site_settings.y + tableHeight(tables.site_settings) + 38}" font-size="11.5">Administration → Site settings.</text>\n`;

  // Projects column
  b += drawTable("projects", 385, cy, "green");
  b += drawTable("project_members", 385, cy + tableHeight(tables.projects) + 80, "green");
  b += `  <text class="muted" x="385" y="${placed.project_members.y + tableHeight(tables.project_members) + 22}" font-size="11.5">Users the owner shared the project with.</text>\n`;

  // Project records grid (columns arranged so related tables sit together)
  const columns = [
    ["phase_entries", "phase_notes", "process_maps"],
    ["define_charters", "define_risks"],
    ["define_stakeholders", "define_communications", "define_sipoc"],
    ["define_voc_segments", "define_voc_items", "define_evidence"],
    ["define_affinity_groups", "define_affinity_cards", "define_ctq_nodes"],
  ];
  const accentFor = (name) => (name.startsWith("define_") ? "purple" : "orange");
  columns.forEach((names, ci) => {
    let y = top + 64;
    const x = gx + 20 + ci * (TW + 22);
    for (const name of names) {
      b += drawTable(name, x, y, accentFor(name));
      y += tableHeight(tables[name]) + 34;
    }
  });
  b += `  <text class="muted" x="${gx + 20}" y="${top + 685}" font-size="11.5">Orange: work items, notes, and process maps for every phase tab · Purple: Define phase tools</text>\n`;

  // Relationships. References to the same key share one line and one arrowhead.
  const line = (d) => `  <path class="edge" d="${d}"/>\n`;
  const dot = (x, y) => `  <circle class="arrow" cx="${x}" cy="${y}" r="2.6"/>\n`;
  const uL = placed.users.x, uR = uL + TW;
  const idY = rowY("users", "id");
  // sessions.user_id and user_settings.user_id → users.id (left gutter)
  const sY = rowY("sessions", "user_id"), usY = rowY("user_settings", "user_id");
  b += line(`M${uL} ${usY} H36 V${sY}`) + line(`M${uL} ${sY} H36`) + dot(36, sY);
  b += edge(`M36 ${sY} V${idY} H${uL}`);
  // projects.owner_user_id and project_members.user_id → users.id (between columns)
  const pL = placed.projects.x;
  const oY = rowY("projects", "owner_user_id"), mY = rowY("project_members", "user_id");
  b += line(`M${pL} ${mY} H326 V${oY}`) + line(`M${pL} ${oY} H326`) + dot(326, oY);
  b += edge(`M326 ${oY} V${idY} H${uR}`);
  // project_members.project_id and every project record table → projects.id (right gutter)
  const pR = pL + TW, pidY = rowY("projects", "id"), busX = pR + 22, busY = top + 360;
  b += line(`M${pR} ${rowY("project_members", "project_id")} H${busX} V${busY}`);
  b += line(`M${gx} ${busY} H${busX}`) + dot(busX, busY);
  b += edge(`M${busX} ${busY} V${pidY} H${pR}`);
  b += label((busX + gx) / 2, busY - 8, "project_id", { cls: "ink", size: 11 });

  // Relationships within the Define tables
  const side = (name, col, right = true) => ({ x: placed[name].x + (right ? TW : 0), y: rowY(name, col) });
  const a = side("define_voc_items", "segment_id", false), bTo = side("define_voc_segments", "id", false);
  b += edge(`M${a.x} ${a.y} H${a.x - 10} V${bTo.y} H${bTo.x}`, { dash: true });
  const c1 = side("define_affinity_cards", "group_id", false), c2 = side("define_affinity_groups", "id", false);
  b += edge(`M${c1.x} ${c1.y} H${c1.x - 10} V${c2.y} H${c2.x}`, { dash: true });
  const q1 = side("define_ctq_nodes", "parent_id"), q2 = side("define_ctq_nodes", "id");
  b += edge(`M${q1.x} ${q1.y} H${q1.x + 12} V${q2.y} H${q2.x}`, { dash: true });
  const noteY = placed.define_ctq_nodes.y + tableHeight(tables.define_ctq_nodes) + 18;
  b += `  <text class="muted" x="${placed.define_ctq_nodes.x}" y="${noteY}" font-size="11">Dashed: segment and group links are cleared</text>
  <text class="muted" x="${placed.define_ctq_nodes.x}" y="${noteY + 15}" font-size="11">when deleted; child CTQ nodes are deleted</text>
  <text class="muted" x="${placed.define_ctq_nodes.x}" y="${noteY + 30}" font-size="11">with their parent.</text>\n`;

  const H = top + 720;
  return svgDoc(W, H, "DMAIC Studio database tables",
    "Twenty SQLite tables in three groups. Accounts and settings: users, sessions, user_settings, site_settings. Projects and sharing: projects, owned by a user, and project_members. Project records: fifteen tables keyed by project_id, including phase entries, notes, process maps, and the Define phase tools.",
    b);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "topology.svg"), topology());
fs.writeFileSync(path.join(outDir, "database.svg"), database());
console.log("wrote topology.svg and database.svg");
