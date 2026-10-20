(() => {
  "use strict";

  const PHASES = [
    { key: "define", name: "Define", letter: "D", color: "#347fce", soft: "#edf5ff", tagline: "Align on the problem, customer, and project goals.", tabs: [
      ["charter", "Project Charter"], ["stakeholders", "Stakeholders"], ["sipoc", "SIPOC"], ["voc", "VOC"], ["affinity", "Affinity"], ["ctq", "CTQ Tree"], ["risks", "Risks"], ["evidence", "Evidence"], ["report", "Phase Report"]
    ] },
    { key: "measure", name: "Measure", letter: "M", color: "#287fb4", soft: "#eaf6fc", tagline: "Map the process and establish a trusted baseline.", tabs: [
      ["process-map", "Process Map"], ["metrics", "Metrics Plan"], ["collect-data", "Collect Data"], ["review-data", "Review Data"], ["distribution", "Distribution"], ["capability", "Process Capability"], ["viz-canvas", "Viz Canvas"], ["msa", "Validation (MSA)"], ["evidence", "Evidence"], ["report", "Phase Report"]
    ] },
    { key: "analyze", name: "Analyze", letter: "A", color: "#7957c8", soft: "#f1edfb", tagline: "Use evidence to identify and verify root causes.", tabs: [
      ["viz-canvas", "Viz Canvas"], ["timwoods", "TIMWOODS Wastes"], ["fishbone", "Fishbone"], ["5-whys", "5 Whys"], ["pareto", "Pareto"], ["ce-matrix", "C&E Matrix"], ["correlation", "Correlation"], ["regression", "Regression"], ["hypothesis", "Hypothesis"], ["fmea", "FMEA"], ["evidence", "Evidence"], ["report", "Phase Report"]
    ] },
    { key: "improve", name: "Improve", letter: "I", color: "#d87735", soft: "#fff2e8", tagline: "Select, test, and implement durable improvements.", tabs: [
      ["solution-selection", "Solution Selection"], ["brainstorming", "Brainstorming"], ["doe", "DOE"], ["optimizer", "Process Optimizer"], ["future-state", "Future State Map"], ["implementation", "Implementation Plan"], ["fmea", "Risk (FMEA)"], ["evidence", "Evidence"], ["report", "Phase Report"]
    ] },
    { key: "control", name: "Control", letter: "C", color: "#27966f", soft: "#e9f7f1", tagline: "Sustain the gain with clear ownership and response plans.", tabs: [
      ["control-plan", "Control Plan"], ["reaction-plans", "Reaction Plans"], ["control-charts", "Control Charts"], ["mistake-proofing", "Mistake Proofing"], ["closeout", "Closeout Report"]
    ] }
  ];
  const METRICS_SUBTABS = [
    { key: "data-collection", label: "Data Collection Plan" },
    { key: "sampling-power", label: "Sampling Power" }
  ];
  const DEFAULT_PROCESS_MAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_ProcessMap" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_Map" name="Process Map" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Start"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_1" name="Process step"><bpmn:incoming>Flow_1</bpmn:incoming><bpmn:outgoing>Flow_2</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="EndEvent_1" name="End"><bpmn:incoming>Flow_2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_Map">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="160" y="122" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1"><dc:Bounds x="260" y="100" width="120" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1"><dc:Bounds x="444" y="122" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="196" y="140" /><di:waypoint x="260" y="140" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2"><di:waypoint x="380" y="140" /><di:waypoint x="444" y="140" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const PHASE_COPY = {
    define: "Charter, Scope, Goals", measure: "Data Collection, Baseline", analyze: "Root Cause, Hypothesis", improve: "Solutions, Pilot", control: "Sustain, Monitoring"
  };
  let currentUser = null;
  let authStatus = null;
  let authMode = null;
  let settings = {};
  // Every record of the open project, as returned by GET /api/projects/:id.
  let snapshot = null;
  const noteSaveTimers = new Map();
  let currentProjectId = null;
  let currentPhase = "define";
  let currentTab = "charter";
  let currentMetricsSubTab = "data-collection";
  let activeFilters = { search: "", phase: "all", status: "all" };
  let pendingSaves = 0;
  let projectCache = [];
  let settingsActive = false;
  let settingsTab = "profile";
  let pendingProfilePhoto = null;
  let bpmnModeler = null;
  let bpmnProjectId = null;
  let bpmnSaveTimer = null;
  let bpmnSaveQueue = Promise.resolve();
  const bpmnEditorReady = new WeakMap();

  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const dateLabel = (value) => {
    if (!value) return "Not set";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))
      : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const format = getSetting("date-format", "locale");
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    if (format === "yyyy-mm-dd") return `${year}-${month}-${day}`;
    if (format === "dd/mm/yyyy") return `${day}/${month}/${year}`;
    if (format === "mm/dd/yyyy") return `${month}/${day}/${year}`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  const phaseColor = (phase) => {
    const savedColor = getSetting(`phase-color-${phase.key}`, phase.color);
    return /^#[\da-f]{6}$/i.test(savedColor) ? savedColor : phase.color;
  };
  const getPhases = () => PHASES.map((phase) => ({ ...phase, color: phaseColor(phase) }));
  const getPhase = (key) => {
    const phase = PHASES.find((item) => item.key === key) || PHASES[0];
    return { ...phase, color: phaseColor(phase) };
  };
  const getSetting = (key, fallback = "") => settings[key] ?? fallback;
  const projectUrl = (path = "") => `/api/projects/${encodeURIComponent(currentProjectId)}${path}`;
  const evidenceFileUrl = (id, inline = false) => projectUrl(`/evidence/${encodeURIComponent(id)}/file${inline ? "?inline=1" : ""}`);

  function setSaveStatus(saving) {
    $("#save-status").textContent = saving ? "Saving…" : "All changes saved";
    $(".save-status").classList.toggle("saving", saving);
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // Calls the DMAIC Studio API. `body` is sent as JSON, or as-is when it is FormData.
  async function api(path, { method = "GET", body } = {}) {
    const headers = { "X-DMAIC": "1" };
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    const mutating = method !== "GET";
    if (mutating) { pendingSaves++; setSaveStatus(true); }
    try {
      const response = await fetch(path, {
        method, headers, credentials: "same-origin",
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
      });
      const isJson = response.headers.get("content-type")?.includes("application/json");
      const data = isJson ? await response.json() : await response.text();
      if (response.status === 401 && !path.startsWith("/api/auth/")) {
        showAuthScreen("Your session has ended. Sign in again to continue.");
        throw new ApiError("Sign in to continue.", 401);
      }
      if (!response.ok) throw new ApiError((isJson ? data.error : data) || `The server returned an error (${response.status}).`, response.status);
      return data;
    } catch (error) {
      if (error instanceof TypeError) throw new Error("Could not reach the DMAIC Studio server. Check your connection and try again.");
      throw error;
    } finally {
      if (mutating && --pendingSaves === 0) setSaveStatus(false);
    }
  }

  async function saveSettings(values) {
    settings = await api("/api/settings", { method: "PUT", body: values });
  }

  async function loadProjects() {
    projectCache = await api("/api/projects");
  }

  async function loadSnapshot() {
    snapshot = currentProjectId ? await api(projectUrl()) : null;
  }

  // Refreshes server data for the current view, then renders it.
  async function reload() {
    await loadProjects();
    if (currentProjectId && !projectCache.some((project) => project.id === currentProjectId)) {
      currentProjectId = null;
      currentTab = null;
    }
    await loadSnapshot();
    render();
  }

  async function openProject(id) {
    currentProjectId = id;
    currentTab = null;
    await loadSnapshot();
    renderOverview();
  }

  const noteFor = (phase, tab) => snapshot?.notes.find((item) => item.phase === phase && item.tab === tab)?.note || "";

  function setSidebarExpanded(expanded) {
    document.body.classList.toggle("sidebar-expanded", expanded);
    const toggle = $("#sidebar-toggle");
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} sidebar`);
    toggle.querySelector("span").textContent = expanded ? "‹" : "›";
  }

  function updateProfileAvatar() {
    const avatar = $(".avatar");
    const name = getSetting("profile-name").trim();
    const initials = name && name !== "Workspace owner" ? name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() : "W";
    const photo = getSetting("profile-photo");
    avatar.innerHTML = /^data:image\/(?:png|jpeg|gif);base64,/.test(photo)
      ? `<img src="${escapeHtml(photo)}" alt="">`
      : escapeHtml(initials || "W");
    avatar.setAttribute("aria-label", name || "Workspace owner");
  }

  function currentProject() {
    if (snapshot?.project?.id === currentProjectId) return snapshot.project;
    return projectCache.find((project) => project.id === currentProjectId) || null;
  }

  function refreshProjects() {
    if (currentProjectId && !currentProject()) currentProjectId = null;
    $("#top-project-name").textContent = currentProject()?.name || "All projects";
  }

  function renderHome() {
    disposeBpmnEditor().catch(showError);
    settingsActive = false;
    document.body.classList.remove("settings-active");
    $(".settings-link").classList.remove("active");
    $(".workspace-button").classList.remove("active");
    $(".sidebar-section-label").textContent = "Project phases";
    refreshProjects();
    const filtered = projectCache.filter((project) => {
      const matchesSearch = `${project.name} ${project.problem} ${project.owner}`.toLowerCase().includes(activeFilters.search.toLowerCase());
      return matchesSearch && (activeFilters.phase === "all" || project.current_phase === activeFilters.phase) &&
        (activeFilters.status === "all" || project.status === activeFilters.status);
    });
    const view = $("#view-container");
    view.innerHTML = `
      <div class="page-heading">
        <div><span class="eyebrow">Continuous improvement workspace</span><h1>My projects</h1><p class="subtitle">One workspace for every step from problem definition to sustained results.</p></div>
        <div class="heading-actions"><button class="button button-quiet" data-action="import">Import database</button><button class="button button-primary" data-action="new-project">＋ New project</button></div>
      </div>
      <div class="filters">
        <label class="search-wrap"><span class="search-icon">⌕</span><input class="input" id="project-search" type="search" placeholder="Search projects…" value="${escapeHtml(activeFilters.search)}" aria-label="Search projects"></label>
        <select class="select filter-select" id="phase-filter" aria-label="Filter by phase"><option value="all">All phases</option>${PHASES.map((phase) => `<option value="${phase.key}" ${activeFilters.phase === phase.key ? "selected" : ""}>${phase.name}</option>`).join("")}</select>
        <select class="select filter-select" id="status-filter" aria-label="Filter by status"><option value="all">All statuses</option>${["In progress", "On hold", "Completed"].map((status) => `<option ${activeFilters.status === status ? "selected" : ""}>${status}</option>`).join("")}</select>
        <span class="record-count">${filtered.length} ${filtered.length === 1 ? "project" : "projects"}</span>
      </div>
      ${filtered.length ? `<div class="project-grid">${filtered.map(projectCard).join("")}</div>` : `<div class="empty-state"><span class="empty-icon">▦</span><h3>${projectCache.length ? "No projects match these filters" : "Your improvement work starts here"}</h3><p>${projectCache.length ? "Try changing your search or filters." : "Create a project to organize your DMAIC work, evidence, and action plans."}</p>${projectCache.length ? "" : '<button class="button button-primary" data-action="new-project">＋ Create your first project</button>'}</div>`}`;
    $("#phase-rail").innerHTML = "";
  }

  function projectCard(project) {
    const phase = getPhase(project.current_phase);
    const count = project.entry_count || 0;
    const sharing = !project.is_owner ? `<span class="badge badge-shared">Shared by ${escapeHtml(project.owner_username)}</span>` :
      project.member_count ? `<span class="badge badge-shared">Shared · ${project.member_count + 1} people</span>` : "";
    return `<article class="project-card" data-project="${escapeHtml(project.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(project.name)}">
      <div class="project-card-top"><div><h2 class="project-title">${escapeHtml(project.name)}</h2><div class="project-meta"><span class="badge badge-phase">${phase.name}</span><span class="badge badge-status">${escapeHtml(project.status)}</span>${sharing}</div></div><span class="card-open">Open →</span></div>
      <p class="project-desc">${escapeHtml(project.problem || "Add a problem statement to give your team a clear starting point.")}</p>
      <div class="project-card-footer"><span>${escapeHtml(project.owner || "No project owner")} · ${count} ${count === 1 ? "work item" : "work items"}</span><span>${dateLabel(project.updated_at)}</span></div>
    </article>`;
  }

  function renderOverview() {
    disposeBpmnEditor().catch(showError);
    refreshProjects();
    $(".workspace-button").classList.add("active");
    $(".sidebar-section-label").textContent = "Project phases";
    const project = currentProject();
    if (!project || !snapshot) return renderHome();
    $("#phase-rail").innerHTML = phaseRailMarkup(null);
    const counts = {};
    snapshot.entries.forEach((entry) => { counts[entry.phase] = (counts[entry.phase] || 0) + 1; });
    $("#view-container").innerHTML = `
      <div class="page-heading"><div><span class="eyebrow">Project workspace</span><h1>${escapeHtml(project.name)} <span class="project-active-tag">${escapeHtml(project.status)}</span></h1><p class="subtitle">Your DMAIC roadmap, progress, and project work in one place.</p></div><div class="heading-actions"><button class="button" data-action="edit-project">Edit project</button><button class="button button-primary" data-action="open-phase" data-phase="${project.current_phase}">Continue ${getPhase(project.current_phase).name} →</button></div></div>
      <div class="overview-grid">
        <section class="panel overview-summary"><div><span class="field-label">Problem statement</span><p>${escapeHtml(project.problem || "No problem statement yet. Add one to clarify the opportunity.")}</p></div><div><span class="field-label">Project owner</span><p>${escapeHtml(project.owner || "Not assigned")}</p><span class="field-label" style="margin-top:14px">Last updated</span><p>${dateLabel(project.updated_at)}</p></div></section>
        <section class="panel status-card"><span class="field-label">Project status</span><div class="status-title"><i class="status-dot"></i>${getPhase(project.current_phase).name} phase in progress</div><div class="status-date">${Object.values(counts).reduce((sum, count) => sum + count, 0)} work items across all phases</div></section>
      </div>
      <div class="section-heading"><div><h2>Project phases</h2><p class="subtitle">Select a phase to open its tools and working tabs.</p></div><button class="button button-small" data-action="backup">⇩ Export backup</button></div>
      <div class="phase-grid">${getPhases().map((phase) => `<article class="phase-card ${phase.key === project.current_phase ? "active" : ""}" style="--phase-color:${phase.color}" data-action="open-phase" data-phase="${phase.key}" tabindex="0" role="button">
        <div class="phase-card-header"><span class="phase-card-title">${phase.name}</span>${(counts[phase.key] || 0) > 0 ? '<span class="phase-check">✓</span>' : ""}</div>
        <p class="phase-card-desc">${PHASE_COPY[phase.key]}</p>
        <div class="phase-card-meta"><span>${phase.tabs.length} tabs</span><span>${counts[phase.key] || 0} items</span></div>
        <button class="button ${phase.key === project.current_phase ? "button-primary" : ""}" data-action="open-phase" data-phase="${phase.key}">${phase.key === project.current_phase ? "Continue" : "Open"} ${phase.name}</button>
      </article>`).join("")}</div>
      <div class="section-heading"><div><h2>Project toolkit</h2><p class="subtitle">A practical home for measurable, lasting change.</p></div></div>
      <div class="tool-grid"><article class="tool-card"><h3>📍 Define the opportunity</h3><p>Shape the charter, clarify customer needs, and align stakeholders around a focused goal.</p></article><article class="tool-card"><h3>📊 Build an evidence-based case</h3><p>Connect baseline measures to verified causes before investing in solutions.</p></article><article class="tool-card"><h3>🔁 Make improvements stick</h3><p>Assign implementation owners and transfer the process to a sustainable control plan.</p></article></div>`;
  }

  function phaseRailMarkup(active) {
    return getPhases().map((phase) => `<button class="rail-phase phase-${phase.key} ${active === phase.key ? "active" : ""}" data-action="open-phase" data-phase="${phase.key}" aria-label="${phase.name}" title="${phase.name}"><span class="rail-phase-letter">${phase.letter}</span><span class="rail-phase-name">${phase.name}</span></button>`).join("");
  }

  const SETTINGS_TABS = [
    ["profile", "Profile"], ["account", "Account"], ["organization", "Organization"],
    ["ai-usage", "AI Usage"], ["preferences", "Preferences"], ["security", "Security"],
    ["api-keys", "API Keys"], ["integrations", "Integrations"], ["danger-zone", "Danger Zone"]
  ];

  function renderSettings() {
    disposeBpmnEditor().catch(showError);
    document.body.classList.add("settings-active");
    $(".settings-link").classList.add("active");
    $(".workspace-button").classList.remove("active");
    $(".sidebar-section-label").textContent = "Navigation";
    $("#phase-rail").innerHTML = '<button class="rail-phase rail-nav-button" data-action="home" aria-label="Projects" title="Projects"><span class="rail-phase-letter" aria-hidden="true">▦</span><span class="rail-phase-name">Projects</span></button>';
    $("#top-project-name").textContent = currentProject()?.name || "All projects";
    updateProfileAvatar();
    const profile = Object.fromEntries(["name", "email", "job-title", "company", "phone", "sigma-role"].map((key) => [key, getSetting(`profile-${key}`)]));
    const selectedTab = SETTINGS_TABS.find(([key]) => key === settingsTab) || SETTINGS_TABS[0];
    const content = settingsTab === "profile" ? renderProfileSettings(profile) :
      settingsTab === "preferences" ? renderPreferencesSettings() :
        settingsTab === "account" ? renderAccountSettings() :
          `<section class="settings-coming-soon"><span class="settings-coming-icon" aria-hidden="true">⚙</span><h2>${escapeHtml(selectedTab[1])}</h2><p>This settings section is not available yet. Profile, Account, and Preferences are ready to use and save to your account.</p></section>`;
    $("#view-container").innerHTML = `
      <div class="settings-page">
        <div class="settings-title"><h1>Settings</h1><span class="settings-active-badge">Active</span></div>
        <nav class="settings-tabs" aria-label="Settings sections" role="tablist">
          ${SETTINGS_TABS.map(([key, label]) => `<button class="settings-tab ${settingsTab === key ? "active" : ""}" type="button" role="tab" aria-selected="${settingsTab === key}" data-action="settings-tab" data-tab="${key}">${escapeHtml(label)}</button>`).join("")}
        </nav>
        <div class="settings-content">${content}</div>
      </div>`;
  }

  function renderProfileSettings(profile) {
    const photo = pendingProfilePhoto ?? getSetting("profile-photo");
    const name = profile.name || "Workspace owner";
    const initials = name === "Workspace owner" ? "W" : name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const photoPreview = /^data:image\/(?:png|jpeg|gif);base64,/.test(photo)
      ? `<img src="${escapeHtml(photo)}" alt="Profile photo preview">`
      : escapeHtml(initials || "W");
    return `<form class="settings-form" id="profile-settings-form">
      <section class="profile-photo-field"><span class="settings-field-label">Profile Photo</span><div class="profile-photo-row"><div class="profile-photo" id="profile-photo-preview">${photoPreview}</div><div><label class="button button-small" for="settings-photo">Change Photo</label><input id="settings-photo" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif"><p>JPG, PNG or GIF. Max 2 MB.</p></div></div></section>
      <div class="form-field"><label for="profile-name">Full Name <span aria-hidden="true">*</span></label><input class="input" id="profile-name" name="name" required maxlength="120" value="${escapeHtml(name)}"></div>
      <div class="form-field"><label for="profile-email">Email</label><input class="input" id="profile-email" name="email" type="email" maxlength="160" value="${escapeHtml(profile.email)}"><p class="settings-help">Your profile is saved to your DMAIC Studio account.</p></div>
      <div class="form-field"><label for="profile-job-title">Job Title</label><input class="input" id="profile-job-title" name="job-title" maxlength="120" value="${escapeHtml(profile["job-title"])}"></div>
      <div class="form-field"><label for="profile-company">Company</label><input class="input" id="profile-company" name="company" maxlength="120" value="${escapeHtml(profile.company)}"></div>
      <div class="form-field"><label for="profile-phone">Phone Number</label><input class="input" id="profile-phone" name="phone" type="tel" maxlength="60" value="${escapeHtml(profile.phone)}"></div>
      <div class="form-field"><label for="profile-sigma-role">Six Sigma Role / Belt</label><input class="input" id="profile-sigma-role" name="sigma-role" maxlength="120" placeholder="e.g. Black Belt, Quality Manager, Green Belt" value="${escapeHtml(profile["sigma-role"])}"><p class="settings-help">Add your improvement role or belt certification.</p></div>
      <button class="button button-primary" type="submit">Save Profile</button>
    </form>`;
  }

  function renderPreferencesSettings() {
    const dateFormat = getSetting("date-format", "locale");
    const sidebarStart = getSetting("sidebar-start", "collapsed");
    return `<form class="settings-form" id="preferences-settings-form">
      <div class="settings-section-heading"><h2>Preferences</h2><p>Customize how DMAIC Studio appears for your account.</p></div>
      <div class="form-field"><label for="preference-date-format">Date Format</label><select class="select" id="preference-date-format" name="date-format">${[
        ["locale", "Use browser locale (e.g. Oct 14, 2026)"],
        ["yyyy-mm-dd", "YYYY-MM-DD (2026-10-14)"],
        ["dd/mm/yyyy", "DD/MM/YYYY (14/10/2026)"],
        ["mm/dd/yyyy", "MM/DD/YYYY (10/14/2026)"]
      ].map(([value, label]) => `<option value="${value}" ${dateFormat === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="form-field"><label for="preference-sidebar">Sidebar on startup</label><select class="select" id="preference-sidebar" name="sidebar-start"><option value="collapsed" ${sidebarStart === "collapsed" ? "selected" : ""}>Collapsed</option><option value="expanded" ${sidebarStart === "expanded" ? "selected" : ""}>Expanded</option></select><p class="settings-help">The sidebar can still be expanded or collapsed any time with its arrow button.</p></div>
      <section class="phase-color-settings"><div class="settings-section-heading"><h2>DMAIC phase colors</h2><p>Choose the accent color used for each phase and its tab-bar underline.</p></div><div class="phase-color-grid">${PHASES.map((phase) => `<div class="phase-color-field"><label for="preference-phase-color-${phase.key}">${phase.name}</label><input id="preference-phase-color-${phase.key}" name="phase-color-${phase.key}" type="color" value="${phaseColor(phase)}" aria-label="${phase.name} phase color"></div>`).join("")}</div></section>
      <button class="button button-primary" type="submit">Save Preferences</button>
    </form>`;
  }

  function renderAccountSettings() {
    return `<div class="settings-form">
      <div class="settings-section-heading"><h2>Account</h2><p>You are signed in as <strong>${escapeHtml(currentUser?.username || "")}</strong>.</p></div>
      <div class="heading-actions"><button class="button" type="button" data-action="logout">Sign out</button></div>
    </div>
    <form class="settings-form account-password-form" id="password-settings-form">
      <div class="settings-section-heading"><h2>Change password</h2><p>Changing your password signs you out on your other devices.</p></div>
      <div class="form-field"><label for="current-password">Current password</label><input class="input" id="current-password" name="current_password" type="password" autocomplete="current-password" required></div>
      <div class="form-field"><label for="new-password">New password</label><input class="input" id="new-password" name="new_password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required><p class="settings-help">Use at least 8 characters.</p></div>
      <button class="button button-primary" type="submit">Update password</button>
    </form>`;
  }

  function renderPhase() {
    disposeBpmnEditor().catch(showError);
    refreshProjects();
    $(".workspace-button").classList.remove("active");
    $(".sidebar-section-label").textContent = "Project phases";
    const project = currentProject();
    if (!project || !snapshot) return renderHome();
    const phase = getPhase(currentPhase);
    const tab = phase.tabs.find(([key]) => key === currentTab) || phase.tabs[0];
    currentTab = tab[0];
    $("#phase-rail").innerHTML = phaseRailMarkup(phase.key);
    $("#top-project-name").textContent = project.name;
    if (phase.key === "define") return renderDefinePhase(project, phase, tab);
    if (phase.key === "measure" && tab[0] === "process-map") return renderProcessMap(project, phase, tab);
    if (phase.key === "measure" && tab[0] === "metrics") return renderMetricsPlan(project, phase, tab);
    const entries = snapshot.entries.filter((entry) => entry.phase === phase.key && entry.tab === tab[0]);
    const note = noteFor(phase.key, tab[0]);
    const metadata = tabDescription(phase.key, tab[0], tab[1]);
    $("#view-container").innerHTML = `
      <div class="phase-head" style="--phase-color:${phase.color};--phase-soft:${phase.soft}">
        <div class="phase-title-wrap"><span class="phase-swatch">${phase.letter}</span><div><h1>${escapeHtml(project.name)}</h1><p class="subtitle">${phase.name} · ${phase.tagline}</p></div></div>
        <div class="heading-actions"><span class="project-active-tag">${escapeHtml(project.status)}</span><button class="button button-small" data-action="overview">Project overview</button></div>
      </div>
      <div class="tabs-scroll" style="--phase-color:${phase.color}"><nav class="tabs" role="tablist" aria-label="${phase.name} tools">${phase.tabs.map(([key, label]) => `<button class="tab ${tab[0] === key ? "active" : ""}" role="tab" aria-selected="${tab[0] === key}" data-action="tab" data-tab="${key}">${escapeHtml(label)}</button>`).join("")}</nav></div>
      <section class="panel workspace" style="--phase-color:${phase.color}">
        <div class="workspace-head"><div><h2>${escapeHtml(tab[1])}</h2><p>${escapeHtml(metadata.description)}</p></div><div class="heading-actions"><span class="record-count">${entries.length} ${entries.length === 1 ? "item" : "items"}</span><button class="button button-primary button-small" data-action="new-entry">＋ Add ${escapeHtml(metadata.singular)}</button></div></div>
        ${entries.length ? `<div class="records-wrap"><table class="records-table"><thead><tr><th>${escapeHtml(metadata.titleLabel)}</th><th>Owner</th><th>Status</th><th>Due date</th><th></th></tr></thead><tbody>${entries.map((entry) => entryRow(entry, metadata)).join("")}</tbody></table></div>` :
          `<div class="records-empty"><strong>${escapeHtml(metadata.emptyTitle)}</strong>${escapeHtml(metadata.emptyText)}</div>`}
        <div class="tab-notes"><label for="phase-note">Working notes</label><textarea class="textarea" id="phase-note" placeholder="Capture context, decisions, or questions for this ${escapeHtml(phase.name)} workstream…">${escapeHtml(note)}</textarea><div class="autosave-hint">Notes save automatically to this project on the server.</div></div>
      </section>`;
  }

  function renderMetricsPlan(project, phase, tab) {
    const note = noteFor(phase.key, tab[0]);
    const activeSubTab = METRICS_SUBTABS.some((item) => item.key === currentMetricsSubTab) ? currentMetricsSubTab : "data-collection";
    currentMetricsSubTab = activeSubTab;
    const subTabMarkup = METRICS_SUBTABS.map(({ key, label }) => `<button class="metrics-subtab ${activeSubTab === key ? "active" : ""}" type="button" role="tab" aria-selected="${activeSubTab === key}" data-action="metrics-subtab" data-tab="${key}">${escapeHtml(label)}</button>`).join("");
    const dataCollectionMarkup = `
      <div class="metrics-layout">
        <div class="metrics-card metrics-form-card">
          <div class="metrics-card-header">Metric #1</div>
          <div class="metrics-grid">
            <div class="field field-full"><label>What to Measure</label><input type="text" value="Part Weight" aria-label="What to measure"></div>
            <div class="field field-full"><label>Operational Definition</label><textarea aria-label="Operational definition">Precise definition of what qualifies, measurement rules...</textarea></div>
            <div class="field"><label>How (Method)</label><input type="text" value="e.g. Stopwatch, Caliper" aria-label="How method"></div>
            <div class="field"><label>Sample Size</label><input type="text" value="e.g. 50" aria-label="Sample size"></div>
            <div class="field"><label>Data Type</label><select aria-label="Data type"><option selected>Select</option><option>Continuous</option><option>Discrete</option></select></div>
            <div class="field"><label>Goal</label><select aria-label="Goal"><option selected>Minimize (L Better)</option><option>Target</option><option>Maximize</option></select></div>
            <div class="field"><label>Frequency</label><input type="text" value="Hourly, 5-piece subgroup" aria-label="Frequency"></div>
            <div class="field"><label>Who</label><input type="text" value="e.g. Operator, QA" aria-label="Who"></div>
            <div class="field field-full"><label>Unit of Measure</label><input type="text" value="e.g. seconds, °C, mm" aria-label="Unit of measure"></div>
          </div>
        </div>
      </div>
      <div class="metrics-impact-box">
        <div class="metrics-impact-header">Financial Impact (for Smart ROI)</div>
        <div class="metrics-impact-grid">
          <div class="field"><label>Cost Impact: Value of 1 Unit Change (€)</label><input type="text" value="e.g. 1 unit saved = €50" aria-label="Cost impact"></div>
          <div class="field"><label>Annual Volume Unit (What are we counting?)</label><input type="text" value="e.g. Total Widgets, Total Hours, Batches" aria-label="Annual volume unit"></div>
        </div>
      </div>`;
    const samplingPowerMarkup = `
      <div class="metrics-sampling-layout">
        <div class="metrics-card metrics-calc-card metrics-sampling-card">
          <div class="metrics-calc-head">
            <h3>Sampling Power</h3>
            <select aria-label="Select metric to analyze"><option selected>Select Metric to Analyze</option></select>
          </div>
          <p class="metrics-subtext">Determine how much data you need for your metric before moving to a baseline or capability study.</p>
          <div class="metrics-range">
            <div class="metrics-range-label"><span>Data type</span><strong>Variable / Continuous</strong></div>
            <input type="range" min="0" max="100" value="95" aria-label="Data type selection">
          </div>
          <div class="metrics-range">
            <div class="metrics-range-label"><span>Confidence Level</span><strong>95%</strong></div>
            <input type="range" min="0" max="100" value="95" aria-label="Confidence level">
          </div>
          <div class="metrics-range">
            <div class="metrics-range-label"><span>Margin of Error (E)</span><strong>1</strong></div>
            <input type="range" min="0" max="10" value="1" aria-label="Margin of error">
          </div>
          <div class="metrics-range">
            <div class="metrics-range-label"><span>Estimated Variation (σ)</span><strong>2</strong></div>
            <input type="range" min="0" max="10" value="2" aria-label="Estimated variation">
          </div>
          <div class="metrics-result">
            <div class="metrics-result-label">Required Sample Size</div>
            <div class="metrics-result-value">16 <small>Measurements</small></div>
          </div>
          <div class="metrics-info">
            <div class="metrics-info-icon">i</div>
            <div>
              <strong>Statistical Confidence</strong>
              To be 95% confident that your results reflect reality within ±1 you need to collect 16 points for this metric.
            </div>
          </div>
        </div>
      </div>`;
    $("#view-container").innerHTML = `
      <div class="phase-head" style="--phase-color:${phase.color};--phase-soft:${phase.soft}">
        <div class="phase-title-wrap"><span class="phase-swatch">${phase.letter}</span><div><h1>${escapeHtml(project.name)}</h1><p class="subtitle">${phase.name} · ${phase.tagline}</p></div></div>
        <div class="heading-actions"><span class="project-active-tag">${escapeHtml(project.status)}</span><button class="button button-small" data-action="overview">Project overview</button></div>
      </div>
      <div class="tabs-scroll" style="--phase-color:${phase.color}"><nav class="tabs" role="tablist" aria-label="${phase.name} tools">${phase.tabs.map(([key, label]) => `<button class="tab ${tab[0] === key ? "active" : ""}" role="tab" aria-selected="${tab[0] === key}" data-action="tab" data-tab="${key}">${escapeHtml(label)}</button>`).join("")}</nav></div>
      <section class="panel workspace metrics-plan-workspace" style="--phase-color:${phase.color}">
        <div class="workspace-head metrics-workspace-head"><div><h2>${activeSubTab === "sampling-power" ? "Sampling Power" : "Data Collection Plan"}</h2><p>${activeSubTab === "sampling-power" ? "Size your measurement effort to ensure enough confidence in the baseline." : "Define your critical metrics, operational definitions, and custom data entry fields."}</p></div><div class="heading-actions"><button class="button button-primary button-small metrics-ai-button" data-action="show-metrics-modal">✦ AI Suggestions</button></div></div>
        <div class="metrics-subtabs" role="tablist" aria-label="Metrics plan sections">${subTabMarkup}</div>
        ${activeSubTab === "sampling-power" ? samplingPowerMarkup : dataCollectionMarkup}
      </section>
      <div class="metrics-modal-backdrop" data-modal-visible="false">
        <div class="metrics-modal" role="dialog" aria-modal="true" aria-label="Configure Data Collection Plan">
          <div class="metrics-modal-header">
            <h3>Metric fields</h3>
            <button class="metrics-modal-close" type="button" data-action="close-metrics-modal" aria-label="Close modal">×</button>
          </div>
          <div class="metrics-modal-body">
            <span class="metrics-modal-metric">Metric fields</span>
            <p>Customize the required fields used for each metric to match your data collection workflow.</p>
            <div class="metrics-field-list">
              <div class="metrics-field-row">
                <span class="metrics-field-drag">⋮⋮</span>
                <span class="metrics-chip required">Required</span>
                <span class="metrics-field-name">Metric name</span>
                <span class="metrics-field-star empty">☆</span>
                <span class="metrics-field-star empty">×</span>
              </div>
              <div class="metrics-field-row">
                <span class="metrics-field-drag">⋮⋮</span>
                <span class="metrics-chip required">Required</span>
                <span class="metrics-field-name">Operational definition</span>
                <span class="metrics-field-star empty">☆</span>
                <span class="metrics-field-star empty">×</span>
              </div>
              <div class="metrics-field-row">
                <span class="metrics-field-drag">⋮⋮</span>
                <span class="metrics-chip optional">Optional</span>
                <span class="metrics-field-name">Sample size</span>
                <span class="metrics-field-star empty">☆</span>
                <span class="metrics-field-star empty">×</span>
              </div>
              <div class="metrics-field-row">
                <span class="metrics-field-drag">⋮⋮</span>
                <span class="metrics-chip optional">Optional</span>
                <span class="metrics-field-name">Data collection notes</span>
                <span class="metrics-field-star empty">☆</span>
                <span class="metrics-field-star empty">×</span>
              </div>
            </div>
            <button class="metrics-add-field" type="button">＋ Add Field</button>
          </div>
          <div class="metrics-modal-footer">
            <button class="button button-quiet" type="button">Reset to Default</button>
            <div class="heading-actions">
              <button class="button" type="button" data-action="close-metrics-modal">Cancel</button>
              <button class="button button-primary" type="button">Save Fields</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tab-notes"><label for="phase-note">Working notes</label><textarea class="textarea" id="phase-note" placeholder="Capture context, decisions, or questions for this ${escapeHtml(phase.name)} workstream…">${escapeHtml(note)}</textarea><div class="autosave-hint">Notes save automatically to this project on the server.</div></div>
    `;
  }

  function renderProcessMap(project, phase, tab) {
    const savedXml = snapshot.process_map;
    const oldSteps = snapshot.entries
      .filter((entry) => entry.phase === phase.key && entry.tab === tab[0])
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const oldNotes = noteFor(phase.key, tab[0]);
    $("#view-container").innerHTML = `
      <div class="phase-head" style="--phase-color:${phase.color};--phase-soft:${phase.soft}">
        <div class="phase-title-wrap"><span class="phase-swatch">${phase.letter}</span><div><h1>${escapeHtml(project.name)}</h1><p class="subtitle">${phase.name} · ${phase.tagline}</p></div></div>
        <div class="heading-actions"><span class="project-active-tag">${escapeHtml(project.status)}</span><button class="button button-small" data-action="overview">Project overview</button></div>
      </div>
      <div class="tabs-scroll" style="--phase-color:${phase.color}"><nav class="tabs" role="tablist" aria-label="${phase.name} tools">${phase.tabs.map(([key, label]) => `<button class="tab ${tab[0] === key ? "active" : ""}" role="tab" aria-selected="${tab[0] === key}" data-action="tab" data-tab="${key}">${escapeHtml(label)}</button>`).join("")}</nav></div>
      <section class="panel workspace process-map-workspace" style="--phase-color:${phase.color}">
        <div class="process-map-toolbar"><div><h2>Process Map</h2><p>Model process steps and handoffs with BPMN 2.0. Changes save to this project automatically.</p></div><div class="heading-actions"><button class="button button-small" data-action="import-process-map">Import BPMN</button><button class="button button-small" data-action="download-process-map">Export BPMN</button><button class="button button-primary button-small" data-action="save-process-map">Save now</button></div></div>
        <div class="bpmn-editor" id="bpmn-editor" aria-label="BPMN process diagram editor"></div>
        <div class="autosave-hint" id="bpmn-editor-status" role="status">Loading BPMN editor…</div>
        ${oldNotes ? `<details class="process-map-legacy-notes"><summary>Previous process-map notes</summary><p>${escapeHtml(oldNotes)}</p></details>` : ""}
      </section>`;
    initializeBpmnEditor(project.id, savedXml || processMapXmlFromLegacySteps(oldSteps));
  }

  function processMapXmlFromLegacySteps(steps) {
    if (!steps.length) return DEFAULT_PROCESS_MAP_XML;
    const flowCount = steps.length + 1;
    const taskXml = steps.map((step, index) => {
      const taskId = `Task_${index + 1}`;
      return `<bpmn:task id="${taskId}" name="${escapeXml(step.title)}">${step.detail ? `<bpmn:documentation>${escapeXml(step.detail)}</bpmn:documentation>` : ""}<bpmn:incoming>Flow_${index + 1}</bpmn:incoming><bpmn:outgoing>Flow_${index + 2}</bpmn:outgoing></bpmn:task>`;
    }).join("\n    ");
    const flowXml = Array.from({ length: flowCount }, (_, index) => {
      const number = index + 1;
      const source = index === 0 ? "StartEvent_1" : `Task_${index}`;
      const target = number === flowCount ? "EndEvent_1" : `Task_${number}`;
      return `<bpmn:sequenceFlow id="Flow_${number}" sourceRef="${source}" targetRef="${target}" />`;
    }).join("\n    ");
    const shapeXml = steps.map((_, index) => `<bpmndi:BPMNShape id="Task_${index + 1}_di" bpmnElement="Task_${index + 1}"><dc:Bounds x="${230 + index * 190}" y="100" width="130" height="80" /></bpmndi:BPMNShape>`).join("\n      ");
    const edgeXml = Array.from({ length: flowCount }, (_, index) => {
      const number = index + 1;
      const sourceX = index === 0 ? 196 : 360 + (index - 1) * 190;
      const targetX = number === flowCount ? 230 + steps.length * 190 : 230 + (number - 1) * 190;
      return `<bpmndi:BPMNEdge id="Flow_${number}_di" bpmnElement="Flow_${number}"><di:waypoint x="${sourceX}" y="140" /><di:waypoint x="${targetX}" y="140" /></bpmndi:BPMNEdge>`;
    }).join("\n      ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_ProcessMap" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_Map" name="Process Map" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Start"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    ${taskXml}
    <bpmn:endEvent id="EndEvent_1" name="End"><bpmn:incoming>Flow_${flowCount}</bpmn:incoming></bpmn:endEvent>
    ${flowXml}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_Map">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="160" y="122" width="36" height="36" /></bpmndi:BPMNShape>
      ${shapeXml}
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1"><dc:Bounds x="${230 + steps.length * 190}" y="122" width="36" height="36" /></bpmndi:BPMNShape>
      ${edgeXml}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
  }

  function escapeXml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[char]);
  }

  function initializeBpmnEditor(projectId, xml) {
    if (typeof window.BpmnJS !== "function") {
      throw new Error("The BPMN editor library did not load. Refresh the page and try again.");
    }
    const editor = new window.BpmnJS({ container: "#bpmn-editor" });
    bpmnModeler = editor;
    bpmnProjectId = projectId;
    editor.on("commandStack.changed", () => {
      if (bpmnModeler !== editor) return;
      $("#bpmn-editor-status").textContent = "Unsaved changes…";
      clearTimeout(bpmnSaveTimer);
      bpmnSaveTimer = setTimeout(() => queueBpmnSave(editor, projectId).catch(showError), 600);
    });
    const ready = editor.importXML(xml).then(() => {
      if (bpmnModeler !== editor) return;
      editor.get("canvas").zoom("fit-viewport");
      $("#bpmn-editor-status").textContent = "Changes save automatically to this project.";
    });
    bpmnEditorReady.set(editor, ready);
    ready.catch((error) => {
      if (bpmnModeler !== editor) return;
      $("#bpmn-editor-status").textContent = "Could not load this BPMN diagram. Import a valid BPMN 2.0 file to continue.";
      showError(error);
    });
  }

  function queueBpmnSave(editor = bpmnModeler, projectId = bpmnProjectId) {
    if (!editor || !projectId) return Promise.resolve();
    clearTimeout(bpmnSaveTimer);
    if (bpmnModeler === editor) $("#bpmn-editor-status").textContent = "Saving process map…";
    bpmnSaveQueue = bpmnSaveQueue.catch(() => {}).then(async () => {
      await bpmnEditorReady.get(editor);
      const { xml } = await editor.saveXML({ format: true });
      if (!xml) throw new Error("The BPMN editor did not produce diagram XML.");
      await api(`/api/projects/${encodeURIComponent(projectId)}/process-map`, { method: "PUT", body: { xml } });
      if (snapshot?.project?.id === projectId) snapshot.process_map = xml;
      if (bpmnModeler === editor) $("#bpmn-editor-status").textContent = "All changes saved to this project.";
    });
    return bpmnSaveQueue;
  }

  function disposeBpmnEditor() {
    clearTimeout(bpmnSaveTimer);
    const editor = bpmnModeler;
    const projectId = bpmnProjectId;
    bpmnModeler = null;
    bpmnProjectId = null;
    if (!editor) return bpmnSaveQueue;
    return queueBpmnSave(editor, projectId).finally(() => editor.destroy());
  }

  async function importBpmnDiagram(xml) {
    if (!bpmnModeler) throw new Error("Open Measure → Process Map before importing a BPMN diagram.");
    const editor = bpmnModeler;
    await bpmnEditorReady.get(editor);
    const { warnings } = await editor.importXML(xml);
    if (editor !== bpmnModeler) throw new Error("The Process Map changed before the import finished. Reopen it and try again.");
    editor.get("canvas").zoom("fit-viewport");
    await queueBpmnSave(editor, bpmnProjectId);
    return warnings;
  }

  async function downloadBpmnDiagram() {
    if (!bpmnModeler) throw new Error("The BPMN editor is not ready yet.");
    const editor = bpmnModeler;
    await bpmnEditorReady.get(editor);
    const { xml } = await editor.saveXML({ format: true });
    if (!xml) throw new Error("The BPMN editor did not produce diagram XML.");
    const blobUrl = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `${(currentProject()?.name || "process-map").replace(/[<>:"/\\|?*]/g, "-")}.bpmn`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  function renderDefinePhase(project, phase, tab) {
    const workspace = defineTabMarkup(project, tab[0]);
    $("#view-container").innerHTML = `
      <div class="phase-head" style="--phase-color:${phase.color};--phase-soft:${phase.soft}">
        <div class="phase-title-wrap"><span class="phase-swatch">${phase.letter}</span><div><h1>${escapeHtml(project.name)}</h1><p class="subtitle">Define · Align on the problem, customer, and project goals.</p></div></div>
        <div class="heading-actions"><span class="project-active-tag">${escapeHtml(project.status)}</span><button class="button button-small" data-action="overview">Project overview</button></div>
      </div>
      <div class="tabs-scroll" style="--phase-color:${phase.color}"><nav class="tabs" role="tablist" aria-label="Define tools">${phase.tabs.map(([key, label]) => `<button class="tab ${tab[0] === key ? "active" : ""}" role="tab" aria-selected="${tab[0] === key}" data-action="tab" data-tab="${key}">${escapeHtml(label)}</button>`).join("")}</nav></div>
      <section class="panel workspace define-workspace" style="--phase-color:${phase.color}">${workspace}</section>`;
  }

  function defineTabMarkup(project, tab) {
    switch (tab) {
      case "charter": return renderCharter(project);
      case "stakeholders": return renderStakeholders(project);
      case "sipoc": return renderSipoc(project);
      case "voc": return renderVoc(project);
      case "affinity": return renderAffinity(project);
      case "ctq": return renderCtq(project);
      case "risks": return renderRisks(project);
      case "evidence": return renderEvidence(project);
      case "report": return renderDefineReport(project);
      default: return "";
    }
  }

  function defineHeading(title, subtitle, actions = "") {
    return `<div class="define-heading"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><div class="heading-actions">${actions}</div></div>`;
  }

  const CHARTER_FIELDS = [
    ["problem", "Problem statement", "wide"], ["business_case", "Business case", "wide"],
    ["goal", "Goal statement (SMART)", "wide"], ["in_scope", "In scope", ""],
    ["out_scope", "Out of scope", ""], ["constraints", "Constraints", ""],
    ["assumptions", "Assumptions", ""], ["sponsor", "Sponsor", ""],
    ["start_date", "Start date", "date"], ["end_date", "End date", "date"], ["budget", "Budget", ""]
  ];

  function renderCharter(project) {
    const charter = snapshot.charter || {
      problem: project.problem, business_case: "", goal: "", in_scope: "", out_scope: "",
      constraints: "", assumptions: "", sponsor: "", start_date: "", end_date: "", budget: ""
    };
    return `${defineHeading("Project Charter", "Agree on the opportunity, goal, scope, and project boundaries.", '<button class="button button-primary button-small" data-action="define-edit-charter">✎ Edit charter</button>')}
      <div class="charter-sheet">
        ${CHARTER_FIELDS.slice(0, 3).map(([key, label]) => `<div class="charter-field charter-wide"><span class="field-label">${escapeHtml(label)}</span><div>${escapeHtml(charter[key] || "Not set")}</div></div>`).join("")}
        <div class="charter-field"><span class="field-label">In scope</span><div>${escapeHtml(charter.in_scope || "Not set")}</div></div>
        <div class="charter-field"><span class="field-label">Out of scope</span><div>${escapeHtml(charter.out_scope || "Not set")}</div></div>
        <div class="charter-field"><span class="field-label">Constraints</span><div>${escapeHtml(charter.constraints || "None identified")}</div></div>
        <div class="charter-field"><span class="field-label">Assumptions</span><div>${escapeHtml(charter.assumptions || "None identified")}</div></div>
        <div class="charter-field"><span class="field-label">Sponsor</span><div>${escapeHtml(charter.sponsor || project.owner || "Not assigned")}</div></div>
        <div class="charter-field"><span class="field-label">Start date</span><div>${dateLabel(charter.start_date)}</div></div>
        <div class="charter-field"><span class="field-label">Target end date</span><div>${dateLabel(charter.end_date)}</div></div>
        <div class="charter-field"><span class="field-label">Budget</span><div>${escapeHtml(charter.budget || "Not set")}</div></div>
      </div>`;
  }

  function renderStakeholders(project) {
    const people = snapshot.stakeholders;
    const quadrants = [
      ["monitor", "Monitor", "Low power · Low interest", "quadrant-monitor"],
      ["satisfied", "Keep Satisfied", "High power · Low interest", "quadrant-satisfied"],
      ["informed", "Keep Informed", "Low power · High interest", "quadrant-informed"],
      ["manage", "Manage Closely", "High power · High interest", "quadrant-manage"]
    ];
    const communications = snapshot.communications;
    return `${defineHeading("Stakeholder Analysis", "Map influence and interest, then plan meaningful engagement.", '<button class="button button-primary button-small" data-action="define-add" data-kind="stakeholder">＋ Add stakeholder</button>')}
      <div class="stakeholder-layout"><div class="stakeholder-matrix">${quadrants.map(([key, title, subtitle, className]) => {
        const cards = people.filter((person) => person.engagement === key);
        return `<section class="stakeholder-quadrant ${className}" data-drop-stakeholder="${key}"><div class="quadrant-title">${escapeHtml(title)}</div><div class="quadrant-subtitle">${escapeHtml(subtitle)}</div><div class="stakeholder-cards">${cards.length ? cards.map(stakeholderCardMarkup).join("") : '<span class="quadrant-empty">Drop a stakeholder here</span>'}</div></section>`;
      }).join("")}</div><aside class="stakeholder-side"><div class="side-card stakeholder-bench" data-drop-stakeholder=""><h3>Stakeholder bench</h3><p>New stakeholders start here. Drag them into an engagement quadrant.</p><span class="record-count">${people.filter((person) => !person.engagement).length} unassigned</span><div class="stakeholder-cards">${people.filter((person) => !person.engagement).map(stakeholderCardMarkup).join("") || '<span class="quadrant-empty">No unassigned stakeholders</span>'}</div></div><div class="side-card"><div class="section-heading"><h3>Communication &amp; meeting plan</h3><button class="button button-small" data-action="define-add" data-kind="communication">＋ Add</button></div>${communications.length ? `<div class="communication-list">${communications.map((item) => `<article class="communication-row"><div><strong>${escapeHtml(item.audience)}</strong><span>${escapeHtml([item.channel, item.cadence, item.owner].filter(Boolean).join(" · ") || item.purpose || "Add channel and cadence")}</span></div><button class="text-action" data-action="define-edit" data-kind="communication" data-id="${escapeHtml(item.id)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="communication" data-id="${escapeHtml(item.id)}">×</button></article>`).join("")}</div>` : '<div class="records-empty">No communication plan yet. Add a stakeholder touchpoint.</div>'}</div><p class="autosave-hint">Stakeholders and engagement plans are saved with this project.</p></aside></div>`;
  }

  function stakeholderCardMarkup(person) {
    return `<article class="stakeholder-card" draggable="true" data-stakeholder-card-id="${escapeHtml(person.id)}"><div><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.role || "Role not specified")}</span>${person.strategy ? `<small>${escapeHtml(person.strategy)}</small>` : ""}</div><div class="stakeholder-actions"><button class="text-action" data-action="define-edit" data-kind="stakeholder" data-id="${escapeHtml(person.id)}" aria-label="Edit stakeholder">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="stakeholder" data-id="${escapeHtml(person.id)}" aria-label="Delete stakeholder">×</button></div></article>`;
  }

  const SIPOC_STAGES = [
    ["suppliers", "Suppliers", "Providers"], ["inputs", "Inputs", "Requirements"],
    ["process", "Process", "Action steps"], ["outputs", "Outputs", "Deliverables"], ["customers", "Customers", "Receivers"]
  ];

  function renderSipoc(project) {
    const items = snapshot.sipoc;
    return `${defineHeading("SIPOC Diagram", "Define the high-level process scope: Suppliers → Inputs → Process → Outputs → Customers.", '<button class="button" data-action="print-report">⤓ Print / PDF</button>')}
      <div class="sipoc-board">${SIPOC_STAGES.map(([key, title, subtitle]) => `<section class="sipoc-column sipoc-${key}"><header><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></header><div class="sipoc-items">${items.filter((item) => item.stage === key).map((item) => `<div class="sipoc-item"><span>${escapeHtml(item.value)}</span><span class="sipoc-actions"><button class="text-action" data-action="define-edit" data-kind="sipoc" data-id="${escapeHtml(item.id)}" aria-label="Edit ${escapeHtml(item.value)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="sipoc" data-id="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.value)}">×</button></span></div>`).join("")}</div><button class="sipoc-add" data-action="define-add" data-kind="sipoc" data-stage="${key}">＋ Add ${escapeHtml(title.toLowerCase())}…</button></section>`).join("")}</div>
      <p class="autosave-hint">Changes save automatically. Build your process from left to right.</p>`;
  }

  function renderVoc(project) {
    const segments = snapshot.voc_segments;
    const items = snapshot.voc_items;
    return `${defineHeading("Voice of Customer (VOC) & Translation", "Capture what customers say, interpret the need, then translate it into critical requirements.", '<button class="button button-primary button-small" data-action="define-add" data-kind="voc-item">＋ Add VOC item</button>')}
      <section class="define-subpanel"><div class="section-heading"><div><h3>Customer segments</h3><p class="subtitle">Group feedback by the people you serve.</p></div><button class="button button-small" data-action="define-add" data-kind="voc-segment">＋ Add segment</button></div>
        ${segments.length ? `<div class="segment-chips">${segments.map((segment) => `<span class="segment-chip">${escapeHtml(segment.name)}<button data-action="define-delete" data-kind="voc-segment" data-id="${escapeHtml(segment.id)}" aria-label="Remove ${escapeHtml(segment.name)}">×</button></span>`).join("")}</div>` : '<p class="muted-small">No segments yet. VOC items can be categorized after you add a segment.</p>'}
      </section>
      ${items.length ? `<div class="records-wrap define-table-wrap"><table class="records-table define-wide-table"><thead><tr><th>Segment</th><th>Verbatim voice (what they said)</th><th>Key issue (interpretation)</th><th>Critical need (CCR)</th><th>Kano category</th><th></th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.segment_name || "Unassigned")}</td><td>${escapeHtml(item.voice)}</td><td>${escapeHtml(item.issue || "—")}</td><td>${escapeHtml(item.need || "—")}</td><td><span class="badge badge-phase">${escapeHtml(item.kano)}</span></td><td class="record-actions"><button class="text-action" data-action="define-edit" data-kind="voc-item" data-id="${escapeHtml(item.id)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="voc-item" data-id="${escapeHtml(item.id)}">×</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="records-empty"><strong>No voice-of-customer items yet</strong>Add verbatim feedback and translate it into a measurable need.</div>'}`;
  }

  function renderAffinity(project) {
    const groups = snapshot.affinity_groups;
    const cards = snapshot.affinity_cards;
    return `${defineHeading("Affinity Diagram", "Capture observations, group related ideas, and name the themes that emerge.", '<button class="button" data-action="define-auto-group">✧ Auto-group ideas</button><button class="button button-primary button-small" data-action="save">▣ Save</button>')}
      <div class="affinity-toolbar"><form class="inline-add-form" data-inline-kind="affinity-card"><label for="affinity-idea">Add idea / card</label><div><input class="input" id="affinity-idea" name="text" maxlength="240" placeholder="Enter observation, idea, or finding…" required><button class="button button-primary button-small" type="submit">＋ Add</button></div></form>
        <form class="inline-add-form category-add" data-inline-kind="affinity-group"><label for="affinity-group-name">Add category</label><div><input class="input" id="affinity-group-name" name="name" maxlength="80" placeholder="New group name…" required><button class="button button-small" type="submit">＋ Add</button></div></form></div>
      <div class="affinity-board">${`<section class="affinity-column affinity-uncategorized" data-drop-group=""><header>Uncategorized <span>${cards.filter((card) => !card.group_id).length}</span></header>${cards.filter((card) => !card.group_id).map(affinityCardMarkup).join("") || '<div class="affinity-drop-hint">Drop ideas here</div>'}</section>`}${groups.map((group) => `<section class="affinity-column" data-drop-group="${escapeHtml(group.id)}"><header><span>${escapeHtml(group.name)} <i>${cards.filter((card) => card.group_id === group.id).length}</i></span><span><button class="text-action" data-action="define-edit" data-kind="affinity-group" data-id="${escapeHtml(group.id)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="affinity-group" data-id="${escapeHtml(group.id)}">×</button></span></header>${cards.filter((card) => card.group_id === group.id).map(affinityCardMarkup).join("") || '<div class="affinity-drop-hint">Drop ideas here</div>'}</section>`).join("")}</div>`;
  }

  function affinityCardMarkup(card) {
    return `<article class="affinity-card" draggable="true" data-card-id="${escapeHtml(card.id)}"><span>${escapeHtml(card.text)}</span><button class="text-action delete" data-action="define-delete" data-kind="affinity-card" data-id="${escapeHtml(card.id)}" aria-label="Delete idea">×</button></article>`;
  }

  function renderCtq(project) {
    const nodes = snapshot.ctq_nodes;
    const renderNode = (node) => {
      const children = nodes.filter((child) => child.parent_id === node.id);
      const type = node.node_type;
      return `<li class="ctq-tree-node"><article class="ctq-node ctq-${escapeHtml(type)}"><div class="ctq-node-top"><span class="ctq-kind">${escapeHtml(type)}</span><span class="ctq-node-actions">${type !== "ctq" ? `<button class="text-action" data-action="define-add" data-kind="ctq" data-parent="${escapeHtml(node.id)}" data-node-type="${type === "need" ? "driver" : "ctq"}" aria-label="Add child">＋</button>` : ""}<button class="text-action" data-action="define-edit" data-kind="ctq" data-id="${escapeHtml(node.id)}" aria-label="Edit item">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="ctq" data-id="${escapeHtml(node.id)}" aria-label="Delete item">×</button></span></div><strong>${escapeHtml(node.title)}</strong></article>${children.length ? `<ul>${children.map(renderNode).join("")}</ul>` : ""}</li>`;
    };
    const roots = nodes.filter((node) => !node.parent_id);
    return `${defineHeading("CTQ Tree Designer", "Translate customer needs → drivers → critical-to-quality measures.", '<button class="button" data-action="define-suggest-ctq">✧ Suggest structure</button><button class="button button-primary button-small" data-action="define-add" data-kind="ctq" data-node-type="need">＋ Add need</button>')}
      <div class="ctq-canvas">${roots.length ? `<ul class="ctq-tree">${roots.map(renderNode).join("")}</ul>` : '<div class="records-empty"><strong>Your CTQ tree is ready to build</strong>Add a customer need, then break it into drivers and measurable CTQs.</div>'}</div>`;
  }

  function renderRisks(project) {
    const risks = snapshot.risks;
    return `${defineHeading("Project Risk Assessment (RAID Log)", "Identify, analyze, and plan mitigation for project risks.", '<button class="button button-primary button-small" data-action="define-add" data-kind="risk">＋ Add new risk</button>')}
      ${risks.length ? `<div class="records-wrap define-table-wrap"><table class="records-table define-wide-table risk-table"><thead><tr><th>Description</th><th>Impact</th><th>Probability</th><th>Risk score</th><th>Mitigation</th><th>Status</th><th>Actions</th></tr></thead><tbody>${risks.map((risk) => {
        const score = risk.impact * risk.probability;
        const level = score >= 16 ? "critical" : score >= 10 ? "high" : score >= 5 ? "medium" : "low";
        return `<tr><td>${escapeHtml(risk.description)}</td><td>${risk.impact}</td><td>${risk.probability}</td><td><span class="risk-score risk-${level}">${score} · ${level.toUpperCase()}</span></td><td>${escapeHtml(risk.mitigation || "—")}</td><td><span class="badge">${escapeHtml(risk.status)}</span></td><td class="record-actions"><button class="text-action" data-action="define-edit" data-kind="risk" data-id="${escapeHtml(risk.id)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="risk" data-id="${escapeHtml(risk.id)}">×</button></td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="records-empty"><strong>No project risks recorded</strong>Add risks with likelihood, impact, a clear mitigation, and an owner.</div>'}`;
  }

  function renderEvidence(project) {
    const evidence = snapshot.evidence;
    return `${defineHeading("Phase Evidence & Artifacts", "Keep supporting documents, photos, data, and project references with your Define phase.", '<button class="button button-primary button-small" data-action="define-add" data-kind="evidence">＋ Add evidence</button>')}
      ${evidence.length ? `<div class="evidence-grid">${evidence.map((item) => `<article class="evidence-card evidence-card-open" data-action="evidence-open" data-id="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Open evidence: ${escapeHtml(item.title)}"><div class="evidence-preview">${item.file_name ? "▤" : "▧"}<span>Open item →</span></div><div class="evidence-card-content"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail || item.file_name || "Project reference")}</p>${item.file_name ? `<span class="badge">${escapeHtml(item.file_name)}</span>` : ""}<div class="evidence-actions">${item.file_name ? `<button class="text-action" data-action="evidence-download" data-id="${escapeHtml(item.id)}">Download</button>` : ""}<button class="text-action" data-action="define-edit" data-kind="evidence" data-id="${escapeHtml(item.id)}">Edit</button><button class="text-action delete" data-action="define-delete" data-kind="evidence" data-id="${escapeHtml(item.id)}">Delete</button></div></div></article>`).join("")}</div>` : '<div class="records-empty"><strong>No evidence attached yet</strong>Upload files or add a reference so the team can trace decisions back to their source.</div>'}`;
  }

  function openEvidence(id) {
    const item = snapshot?.evidence.find((record) => record.id === id);
    if (!item) throw new Error("This evidence item could not be found.");
    const dialog = $("#record-dialog");
    dialog.classList.toggle("modal-evidence-pdf", item.mime_type === "application/pdf");
    // The server only serves these types inline; anything else is offered as a download.
    const previewableImage = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mime_type);
    let preview = '<div class="evidence-detail-empty">No file is attached to this reference.</div>';
    if (item.has_file && previewableImage) {
      preview = `<img class="evidence-detail-image" src="${escapeHtml(evidenceFileUrl(item.id, true))}" alt="${escapeHtml(item.title)}">`;
    } else if (item.has_file && item.mime_type === "application/pdf") {
      preview = `<iframe class="evidence-detail-pdf" src="${escapeHtml(evidenceFileUrl(item.id, true))}#view=FitH" title="${escapeHtml(item.title)}"></iframe>`;
    } else if (item.has_file) {
      preview = `<div class="evidence-detail-file"><span>▤</span><strong>${escapeHtml(item.file_name)}</strong><p>Preview is not available for this file type.</p><a class="button button-primary button-small" href="${escapeHtml(evidenceFileUrl(item.id))}" download>⇩ Download file</a></div>`;
    }
    dialog.innerHTML = `<div class="modal-header"><div><h2>${escapeHtml(item.title)}</h2><p>Define · Evidence &amp; artifacts</p></div><button class="modal-close" type="button" data-action="close-record" aria-label="Close">×</button></div>
      <div class="modal-body evidence-detail-body">${preview}<section class="evidence-detail-meta"><span class="field-label">Description / source</span><p>${escapeHtml(item.detail || "No description provided.")}</p>${item.file_name ? `<span class="field-label">Attached file</span><p>${escapeHtml(item.file_name)}</p><button class="button button-small" data-action="evidence-download" data-id="${escapeHtml(item.id)}">⇩ Download file</button>` : ""}</section></div>
      <div class="modal-footer"><button class="button button-primary" type="button" data-action="close-record">Done</button></div>`;
    dialog.showModal();
  }

  function renderDefineReport(project) {
    const charter = snapshot.charter || { problem: project.problem, goal: "" };
    const stakeholders = snapshot.stakeholders;
    const sipoc = snapshot.sipoc;
    const voc = snapshot.voc_items;
    const risks = snapshot.risks;
    const evidence = [...snapshot.evidence].sort((a, b) => a.title.localeCompare(b.title));
    const ctqNodes = snapshot.ctq_nodes;
    return `<div class="report-toolbar"><div><span class="eyebrow">Project deliverable</span><h2>Define Phase Report</h2><p>${escapeHtml(project.name)} · Generated ${dateLabel(new Date().toISOString())}</p></div><div class="heading-actions"><button class="button button-small" data-action="render">↻ Refresh data</button><button class="button button-primary button-small" data-action="print-report">⤓ Export / Print PDF</button></div></div>
      <article class="define-report"><div class="report-title"><span class="eyebrow">DMAIC · DEFINE</span><h1>Project Definition Report</h1><p>${escapeHtml(project.name)}</p></div>
      <section class="report-section"><h3>1. Project charter</h3>${reportDefinitionList([["Problem statement", charter.problem], ["Business case", charter.business_case], ["Goal statement", charter.goal], ["In scope", charter.in_scope], ["Out of scope", charter.out_scope], ["Sponsor", charter.sponsor || project.owner], ["Target end date", charter.end_date], ["Budget", charter.budget]])}</section>
      <section class="report-section"><h3>2. Stakeholder analysis</h3>${stakeholders.length ? `<ul>${stakeholders.map((person) => `<li><strong>${escapeHtml(person.name)}</strong> — ${escapeHtml(person.role)} · Power ${person.power}/5 · Interest ${person.interest}/5${person.strategy ? ` · ${escapeHtml(person.strategy)}` : ""}</li>`).join("")}</ul>` : "<p>No stakeholders recorded.</p>"}</section>
      <section class="report-section"><h3>3. SIPOC</h3><div class="report-sipoc">${SIPOC_STAGES.map(([key, label]) => `<div><strong>${escapeHtml(label)}</strong><ul>${sipoc.filter((item) => item.stage === key).map((item) => `<li>${escapeHtml(item.value)}</li>`).join("") || "<li>Not recorded</li>"}</ul></div>`).join("")}</div></section>
      <section class="report-section"><h3>4. Voice of customer</h3>${voc.length ? `<ul>${voc.map((item) => `<li><strong>${escapeHtml(item.voice)}</strong>${item.issue ? ` — ${escapeHtml(item.issue)}` : ""}${item.need ? ` · Need: ${escapeHtml(item.need)}` : ""}</li>`).join("")}</ul>` : "<p>No VOC items recorded.</p>"}</section>
      <section class="report-section"><h3>5. Critical to quality</h3>${ctqNodes.length ? renderCtqReportList(ctqNodes, null) : "<p>No CTQ tree recorded.</p>"}</section>
      <section class="report-section"><h3>6. Risk assessment</h3>${risks.length ? `<ul>${risks.map((risk) => `<li><strong>${escapeHtml(risk.description)}</strong> · Score ${risk.impact * risk.probability}/25 · ${escapeHtml(risk.status)}${risk.mitigation ? ` · Mitigation: ${escapeHtml(risk.mitigation)}` : ""}</li>`).join("")}</ul>` : "<p>No project risks recorded.</p>"}</section>
      <section class="report-section"><h3>7. Evidence &amp; artifacts</h3>${evidence.length ? `<ul>${evidence.map((item) => `<li><strong>${escapeHtml(item.title)}</strong>${item.detail ? ` — ${escapeHtml(item.detail)}` : ""}${item.file_name ? ` · ${escapeHtml(item.file_name)}` : ""}</li>`).join("")}</ul>` : "<p>No supporting evidence attached.</p>"}</section>
      <p class="autosave-hint">Report contents are assembled from this project's saved Define records.</p></article>`;
  }

  function renderCtqReportList(nodes, parentId) {
    const children = nodes.filter((node) => node.parent_id === parentId);
    if (!children.length) return "";
    return `<ul>${children.map((node) => `<li><span class="badge badge-phase">${escapeHtml(node.node_type)}</span> ${escapeHtml(node.title)}${renderCtqReportList(nodes, node.id)}</li>`).join("")}</ul>`;
  }

  function reportDefinitionList(fields) {
    return `<dl class="report-definitions">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "Not set")}</dd></div>`).join("")}</dl>`;
  }

  function defineFormFields(kind, item = {}) {
    const field = (name, label, options = {}) => ({ name, label, value: item[name] ?? "", ...options });
    const fields = {
      charter: CHARTER_FIELDS.map(([name, label, type]) => field(name, label, {
        type: name === "problem" || name === "business_case" || name === "goal" || name === "in_scope" || name === "out_scope" || name === "constraints" || name === "assumptions" ? "textarea" : type === "date" ? "date" : "text",
        required: name === "problem"
      })),
      stakeholder: [field("name", "Stakeholder name", { required: true }), field("role", "Role / relationship"), field("power", "Influence / power (1–5)", { type: "number", min: 1, max: 5, value: item.power ?? 3 }), field("interest", "Interest in outcome (1–5)", { type: "number", min: 1, max: 5, value: item.interest ?? 3 }), field("strategy", "Engagement strategy", { type: "textarea" })],
      communication: [field("audience", "Audience / stakeholder", { required: true }), field("purpose", "Purpose / key message", { type: "textarea" }), field("channel", "Channel", { placeholder: "e.g. Shift huddle, email, review" }), field("cadence", "Cadence", { placeholder: "e.g. Weekly" }), field("owner", "Owner")],
      sipoc: [field("value", "SIPOC element", { required: true, placeholder: "Describe one supplier, input, process step, output, or customer" })],
      "voc-segment": [field("name", "Customer segment", { required: true, placeholder: "e.g. End user, buyer, operator" })],
      "voc-item": [
        field("segment_id", "Customer segment", { type: "select", options: snapshot.voc_segments.map((row) => [row.id, row.name]), emptyOption: "Unassigned" }),
        field("voice", "Verbatim voice (what they said)", { required: true, type: "textarea" }),
        field("issue", "Key issue (interpretation)", { type: "textarea" }),
        field("need", "Critical customer need", { type: "textarea" }),
        field("kano", "Kano category", { type: "select", options: ["Must-be", "Performance", "Delighter", "Indifferent"].map((value) => [value, value]) })
      ],
      "affinity-group": [field("name", "Theme / category name", { required: true })],
      "affinity-card": [field("text", "Observation, idea, or finding", { required: true, type: "textarea" })],
      ctq: [field("title", "Need, driver, or measurable CTQ", { required: true })],
      risk: [field("description", "Risk description", { required: true, type: "textarea" }), field("impact", "Impact (1–5)", { type: "number", min: 1, max: 5, value: item.impact ?? 3 }), field("probability", "Probability (1–5)", { type: "number", min: 1, max: 5, value: item.probability ?? 3 }), field("mitigation", "Mitigation / response", { type: "textarea" }), field("status", "Status", { type: "select", options: ["Open", "Mitigating", "Closed"].map((value) => [value, value]), value: item.status || "Open" })],
      evidence: [field("title", "Evidence title", { required: true }), field("detail", "Description / source", { type: "textarea" }), { name: "file", label: "Attach a file (up to 10 MB)", type: "file", value: "" }]
    };
    return fields[kind] || [];
  }

  function openDefineForm(kind, item = {}, context = {}) {
    const labels = {
      charter: "Project charter", stakeholder: item.id ? "Edit stakeholder" : "Add stakeholder",
      communication: item.id ? "Edit communication plan" : "Add communication plan",
      sipoc: "Add SIPOC element", "voc-segment": "Add customer segment",
      "voc-item": item.id ? "Edit VOC item" : "Add VOC item",
      "affinity-group": item.id ? "Edit theme" : "Add category",
      "affinity-card": "Add affinity idea",       ctq: item.id ? "Edit CTQ item" : `Add ${context.nodeType || "need"}`,
      risk: item.id ? "Edit project risk" : "Add project risk",
      evidence: item.id ? "Edit evidence" : "Add evidence"
    };
    const fields = defineFormFields(kind, { ...item, node_type: item.node_type || context.nodeType || "need" });
    const dialog = $("#record-dialog");
    dialog.innerHTML = `<form id="define-form" data-kind="${escapeHtml(kind)}"${item.id ? ` data-id="${escapeHtml(item.id)}"` : ""}${context.parentId ? ` data-parent="${escapeHtml(context.parentId)}"` : ""}${context.stage ? ` data-stage="${escapeHtml(context.stage)}"` : ""}${context.nodeType ? ` data-node-type="${escapeHtml(context.nodeType)}"` : ""}>
      <div class="modal-header"><div><h2>${escapeHtml(labels[kind] || "Edit item")}</h2><p>Define · Changes are saved to this project.</p></div><button class="modal-close" type="button" data-action="close-record" aria-label="Close">×</button></div>
      <div class="modal-body ${kind === "charter" ? "charter-form-body" : ""}">${kind === "ctq" ? `<div class="ctq-form-level"><span>Tree level</span><strong>${escapeHtml(item.node_type || context.nodeType || "need")}</strong></div>` : ""}${fields.map((entry) => defineFormField(entry)).join("")}</div>
      <div class="modal-footer"><button class="button" type="button" data-action="close-record">Cancel</button><button class="button button-primary" type="submit">Save ${kind === "charter" ? "charter" : "changes"}</button></div>
    </form>`;
    dialog.showModal();
    $("#record-dialog input:not([type=file]), #record-dialog textarea, #record-dialog select")?.focus();
  }

  function defineFormField(field) {
    const required = field.required ? "required" : "";
    const value = field.value ?? "";
    const fieldId = `define-${field.name}`;
    let input;
    if (field.type === "textarea") {
      input = `<textarea class="textarea" id="${escapeHtml(fieldId)}" name="${escapeHtml(field.name)}" ${required} maxlength="2000" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(value)}</textarea>`;
    } else if (field.type === "select") {
      input = `<select class="select" id="${escapeHtml(fieldId)}" name="${escapeHtml(field.name)}" ${required}>${field.emptyOption ? `<option value="">${escapeHtml(field.emptyOption)}</option>` : ""}${(field.options || []).map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}" ${String(value) === String(optionValue) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
    } else {
      input = `<input class="input" id="${escapeHtml(fieldId)}" name="${escapeHtml(field.name)}" type="${escapeHtml(field.type || "text")}" value="${escapeHtml(value)}" ${required}${field.min !== undefined ? ` min="${field.min}"` : ""}${field.max !== undefined ? ` max="${field.max}"` : ""} ${field.type === "file" ? 'accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.ppt,.pptx"' : 'maxlength="240"'} placeholder="${escapeHtml(field.placeholder || "")}">`;
    }
    return `<div class="form-field"><label for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}${field.required ? ' <span aria-hidden="true">*</span>' : ""}</label>${input}</div>`;
  }

  // Saves a Define record. Evidence goes up as multipart form data so files upload unchanged.
  async function saveDefineItem(kind, id, values, context, formData = null) {
    if (kind === "charter") return api(projectUrl("/charter"), { method: "PUT", body: values });
    if (kind === "evidence") {
      return api(projectUrl(id ? `/evidence/${encodeURIComponent(id)}` : "/evidence"), { method: id ? "PUT" : "POST", body: formData });
    }
    const body = { ...values, stage: context.stage, parent_id: context.parentId, node_type: context.nodeType };
    const path = `/define/${encodeURIComponent(kind)}${id ? `/${encodeURIComponent(id)}` : ""}`;
    return api(projectUrl(path), { method: id ? "PUT" : "POST", body });
  }

  function tabDescription(phase, key, label) {
    const descriptions = {
      "define:charter": ["Define the business case, problem, goal, scope, and project boundaries.", "charter field", "Charter field", "No charter details yet", "Add the problem, goal, sponsor, or scope to get your charter started.", "Charter field"],
      "define:stakeholders": ["Identify people affected by the project and how they will participate.", "stakeholder", "Stakeholder", "No stakeholders added", "Map the people who can influence or are affected by this work.", "Stakeholder"],
      "define:sipoc": ["Summarize suppliers, inputs, process, outputs, and customers.", "SIPOC element", "Element", "Your SIPOC is ready to build", "Add suppliers, inputs, process steps, outputs, and customers.", "Element"],
      "define:voc": ["Capture customer needs and translate them into measurable requirements.", "customer need", "Customer need", "No customer needs captured", "Record customer statements and the need behind each one.", "Customer need"],
      "define:ctq": ["Break customer requirements into critical-to-quality measures.", "CTQ requirement", "Requirement", "No CTQs defined", "Add a measurable requirement linked to a customer need.", "CTQ"],
      "define:affinity": ["Group related observations into themes your team can investigate.", "theme", "Theme", "No themes grouped yet", "Collect and group related observations into affinity themes.", "Theme"],
      "define:risks": ["Record project risks early and assign an owner for each response.", "project risk", "Risk", "No project risks recorded", "Capture a risk, its potential impact, and a response owner.", "Risk"],
      "measure:process-map": ["Create a BPMN 2.0 diagram of process steps, gateways, and handoffs.", "process step", "Process step", "No process steps mapped", "Describe each step and its important inputs or outputs.", "Step"],
      "measure:metrics": ["Define operational measures, data sources, and collection frequency.", "metric", "Metric", "No metrics defined", "Add a measure with its operational definition and collection method.", "Metric"],
      "measure:collect-data": ["Log data collection activities and sampling plans.", "data collection", "Collection", "No collection activities yet", "Track what data is collected, when, and by whom.", "Collection"],
      "measure:review-data": ["Document checks for data quality, completeness, and patterns.", "data review", "Review", "No data reviews recorded", "Record a data-quality check or observation from the baseline.", "Review"],
      "measure:distribution": ["Capture distribution checks and observations about process variation.", "distribution check", "Check", "No distribution checks yet", "Add a distribution or variation check and its findings.", "Check"],
      "measure:capability": ["Record capability studies and baseline performance.", "capability study", "Study", "No capability studies yet", "Capture a capability result and the assumptions behind it.", "Study"],
      "measure:msa": ["Validate the measurement system before relying on collected data.", "MSA study", "Study", "No measurement studies recorded", "Record a gage R&R, attribute agreement, or calibration check.", "Study"],
      "analyze:fishbone": ["Organize possible causes and link them to evidence.", "possible cause", "Cause", "No causes on the fishbone yet", "Capture a potential cause and the evidence needed to verify it.", "Cause"],
      "analyze:5-whys": ["Follow a cause through successive why questions to its root.", "why chain", "Why chain", "No why chains started", "Describe the problem and the root cause your team is testing.", "Why chain"],
      "analyze:pareto": ["Prioritize categories by frequency, cost, or contribution.", "Pareto category", "Category", "No Pareto categories entered", "Add a category and its count or impact to rank contributors.", "Category"],
      "analyze:ce-matrix": ["Prioritize process inputs by their impact on customer outcomes.", "input factor", "Factor", "No factors scored", "Add an input, customer outcome, and impact score.", "Factor"],
      "analyze:correlation": ["Record suspected relationships and supporting data.", "relationship", "Relationship", "No relationships evaluated", "Document variables, the observed relationship, and next check.", "Relationship"],
      "analyze:regression": ["Track regression models and interpret the factors that matter.", "model", "Model", "No models recorded", "Capture the response, factors, and fit summary.", "Model"],
      "analyze:hypothesis": ["Plan tests that distinguish signal from random variation.", "hypothesis test", "Test", "No hypothesis tests planned", "Record the question, test, and decision rule before testing.", "Test"],
      "analyze:fmea": ["Prioritize failure modes by their effect, likelihood, and detection.", "failure mode", "Failure mode", "No failure modes entered", "Add a failure mode and its recommended next action.", "Failure mode"],
      "analyze:timwoods": ["Identify the eight wastes and where they appear in the process.", "waste observation", "Observation", "No waste observations yet", "Record a waste, its location, and its impact.", "Observation"],
      "improve:solution-selection": ["Compare solution candidates by impact, effort, and cost.", "solution", "Solution", "No solutions entered yet", "Add a solution and capture the expected impact and effort.", "Solution"],
      "improve:brainstorming": ["Capture and refine improvement ideas before prioritizing.", "improvement idea", "Idea", "No ideas captured yet", "Record an idea without losing the context behind it.", "Idea"],
      "improve:doe": ["Plan experiments that reveal how process factors affect outcomes.", "experiment", "Experiment", "No experiments planned", "Capture an experiment objective, factors, and response.", "Experiment"],
      "improve:optimizer": ["Document process settings and optimization trials.", "optimization trial", "Trial", "No optimization trials recorded", "Record a setting change and the observed process response.", "Trial"],
      "improve:future-state": ["Describe the desired future process and changes to make it real.", "future-state change", "Change", "No future-state changes yet", "Add a future-state process improvement and its rationale.", "Change"],
      "improve:implementation": ["Assign owners and timing to approved implementation actions.", "implementation action", "Action", "No implementation actions planned", "Add an action with a clear owner and target date.", "Action"],
      "control:control-plan": ["Define how critical process characteristics will be monitored.", "control item", "Control item", "No control items defined", "Specify the characteristic, method, frequency, and response.", "Control item"],
      "control:reaction-plans": ["Clarify the response when a measure drifts out of control.", "reaction plan", "Reaction plan", "No reaction plans defined", "Describe the signal, containment, escalation, and owner.", "Reaction plan"],
      "control:control-charts": ["Track control charts and meaningful signals over time.", "chart", "Chart", "No control charts configured", "Record the measure, chart type, and how signals are reviewed.", "Chart"],
      "control:mistake-proofing": ["Record error-proofing ideas that prevent or catch defects.", "mistake-proofing action", "Action", "No actions recorded", "Capture a prevention control and how its effectiveness is checked.", "Action"],
      "control:closeout": ["Summarize results, handoff, lessons learned, and next steps.", "closeout item", "Closeout item", "No closeout details yet", "Document verified results, ownership, or lessons for the next project.", "Closeout item"]
    };
    const fallback = [phase === "define" ? "Collect supporting material and decisions for the project." : "Capture evidence, decisions, and deliverables for this phase.", "work item", "Work item", "Nothing added yet", `Start building your ${label.toLowerCase()} workspace.`, "Item"];
    const values = descriptions[`${phase}:${key}`] || fallback;
    return { description: values[0], singular: values[1], titleLabel: values[2], emptyTitle: values[3], emptyText: values[4], titlePlaceholder: values[5] };
  }

  function entryRow(entry, metadata) {
    return `<tr><td><span class="record-title">${escapeHtml(entry.title)}</span>${entry.detail ? `<span class="record-detail">${escapeHtml(entry.detail)}</span>` : ""}</td><td>${escapeHtml(entry.owner || "—")}</td><td><span class="badge ${entry.status === "Complete" ? "badge-status" : ""}">${escapeHtml(entry.status)}</span></td><td>${dateLabel(entry.due_date)}</td><td class="record-actions"><button class="text-action" data-action="edit-entry" data-id="${escapeHtml(entry.id)}">Edit</button><button class="text-action delete" data-action="delete-entry" data-id="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(metadata.singular)}">Delete</button></td></tr>`;
  }

  function render() {
    if (adminActive) return renderAdmin();
    if (settingsActive) return renderSettings();
    if (currentProjectId) return currentTab ? renderPhase() : renderOverview();
    $("#phase-rail").innerHTML = "";
    return renderHome();
  }

  function openProjectForm(project = null) {
    const dialog = $("#project-dialog");
    dialog.innerHTML = `<form id="project-form">
      <div class="modal-header"><div><h2>${project ? "Edit project" : "Create a DMAIC project"}</h2><p>Start with a clear problem and an accountable owner.</p></div><button class="modal-close" type="button" data-action="close-project" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="form-field"><label for="project-name">Project name <span aria-hidden="true">*</span></label><input class="input" id="project-name" name="name" required maxlength="120" placeholder="e.g. Reduce molding scrap on Line 4" value="${escapeHtml(project?.name || "")}"></div>
        <div class="form-field"><label for="project-problem">Problem statement</label><textarea class="textarea" id="project-problem" name="problem" maxlength="1000" placeholder="What is happening, where, and why does it matter?">${escapeHtml(project?.problem || "")}</textarea></div>
        <div class="form-grid"><div class="form-field"><label for="project-owner">Project owner</label><input class="input" id="project-owner" name="owner" maxlength="100" placeholder="Name or team" value="${escapeHtml(project?.owner || "")}"></div>
          <div class="form-field"><label for="project-status">Status</label><select class="select" id="project-status" name="status">${["In progress", "On hold", "Completed"].map((status) => `<option ${project?.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></div></div>
        ${project ? `<section class="project-team" id="project-team">${projectTeamMarkup()}</section>` : ""}
      </div>
      <div class="modal-footer">${!project ? "" : project.is_owner ? '<button class="button button-danger button-quiet" type="button" data-action="delete-project">Delete project</button>' : '<button class="button button-danger button-quiet" type="button" data-action="leave-project">Leave project</button>'}<button class="button" type="button" data-action="close-project">Cancel</button><button class="button button-primary" type="submit">${project ? "Save changes" : "Create project"}</button></div>
    </form>`;
    dialog.showModal();
    $("#project-name", dialog).focus();
  }

  function projectTeamMarkup() {
    const project = currentProject();
    const members = snapshot?.members || [];
    const people = [{ id: null, username: project.owner_username, role: "Owner" }, ...members.map((member) => ({ ...member, role: "Editor" }))];
    return `<div class="project-team-head"><span class="field-label">Team access</span><p>${project.is_owner ? "Share this project with other DMAIC Studio users. Team members can view and edit every phase." : `This project is shared with you by ${escapeHtml(project.owner_username)}.`}</p></div>
      <ul class="team-list">${people.map((person) => `<li><span class="team-avatar" aria-hidden="true">${escapeHtml(person.username.slice(0, 1).toUpperCase())}</span><span class="team-name">${escapeHtml(person.username)}${person.username === currentUser?.username ? " (you)" : ""}</span><span class="badge">${person.role}</span>${project.is_owner && person.id ? `<button class="text-action delete" type="button" data-action="remove-member" data-id="${escapeHtml(person.id)}" aria-label="Remove ${escapeHtml(person.username)}">Remove</button>` : ""}</li>`).join("")}</ul>
      ${project.is_owner ? '<div class="team-add"><input class="input" id="member-username" maxlength="40" autocomplete="off" placeholder="Username to add" aria-label="Username to add"><button class="button button-small" type="button" data-action="add-member">＋ Add member</button></div>' : ""}`;
  }

  async function addProjectMember() {
    const input = $("#member-username");
    const username = input.value.trim();
    if (!username) { input.focus(); return; }
    snapshot.members = await api(projectUrl("/members"), { method: "POST", body: { username } });
    snapshot.project.member_count = snapshot.members.length;
    $("#project-team").innerHTML = projectTeamMarkup();
    showToast(`${username} can now open this project.`);
  }

  function openEntryForm(entry = null) {
    const phase = getPhase(currentPhase);
    const tab = phase.tabs.find(([key]) => key === currentTab);
    const metadata = tabDescription(currentPhase, currentTab, tab[1]);
    const dialog = $("#record-dialog");
    dialog.innerHTML = `<form id="entry-form"${entry ? ` data-id="${escapeHtml(entry.id)}"` : ""}>
      <div class="modal-header"><div><h2>${entry ? "Edit" : "Add"} ${escapeHtml(metadata.singular)}</h2><p>${escapeHtml(tab[1])} · ${phase.name}</p></div><button class="modal-close" type="button" data-action="close-record" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="form-field"><label for="entry-title">${escapeHtml(metadata.titleLabel)} <span aria-hidden="true">*</span></label><input class="input" id="entry-title" name="title" required maxlength="180" placeholder="${escapeHtml(metadata.titlePlaceholder)}" value="${escapeHtml(entry?.title || "")}"></div>
        <div class="form-field"><label for="entry-detail">Details / evidence</label><textarea class="textarea" id="entry-detail" name="detail" maxlength="1600" placeholder="Add useful context, evidence, or next steps…">${escapeHtml(entry?.detail || "")}</textarea></div>
        <div class="form-grid"><div class="form-field"><label for="entry-owner">Owner</label><input class="input" id="entry-owner" name="owner" maxlength="100" placeholder="Assign an owner" value="${escapeHtml(entry?.owner || "")}"></div>
          <div class="form-field"><label for="entry-status">Status</label><select class="select" id="entry-status" name="status">${["Not started", "In progress", "Complete", "Blocked"].map((status) => `<option ${entry?.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></div></div>
        <div class="form-field"><label for="entry-due">Target date</label><input class="input" id="entry-due" name="due_date" type="date" value="${escapeHtml(entry?.due_date || "")}"></div>
      </div>
      <div class="modal-footer"><button class="button" type="button" data-action="close-record">Cancel</button><button class="button button-primary" type="submit">${entry ? "Save changes" : "Add item"}</button></div>
    </form>`;
    dialog.showModal();
    $("#entry-title", dialog).focus();
  }

  function showToast(message, error = false) {
    const toast = document.createElement("div");
    toast.className = `toast${error ? " error" : ""}`;
    toast.textContent = message;
    $("#toast-region").append(toast);
    setTimeout(() => toast.remove(), 3400);
  }

  function showError(error) {
    console.error(error);
    $(".save-status").classList.remove("saving");
    $("#save-status").textContent = "Save failed";
    showToast(error?.message || "Something went wrong. Your changes were not saved.", true);
  }

  async function exportDatabase() {
    try {
      const response = await fetch("/api/export", { credentials: "same-origin" });
      if (response.status === 401) { showAuthScreen("Your session has ended. Sign in again to continue."); return; }
      if (!response.ok) throw new Error("The backup could not be created. Try again in a moment.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `dmaic-studio-${new Date().toISOString().slice(0, 10)}.sqlite`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("SQLite backup downloaded.");
    } catch (error) { showError(error); }
  }

  // Imports a backup (from this server or the earlier browser-only version) as new projects.
  async function importDatabase(file) {
    try {
      await disposeBpmnEditor();
      const form = new FormData();
      form.append("file", file);
      const result = await api("/api/import", { method: "POST", body: form });
      settings = await api("/api/settings");
      currentProjectId = null;
      currentTab = null;
      settingsActive = false;
      document.body.classList.remove("settings-active");
      setSidebarExpanded(getSetting("sidebar-start", "collapsed") === "expanded");
      updateProfileAvatar();
      await reload();
      showToast(`Imported ${result.projects} ${result.projects === 1 ? "project" : "projects"} into your account.`);
    } catch (error) { showError(error); }
  }

  // ---------------------------------------------------------------------------
  // Administration (visible to administrators only; the server enforces access)

  let adminActive = false;
  let adminTab = "users";
  let adminUsers = [];
  let siteSettings = null;

  async function openAdmin(tab = adminTab) {
    await disposeBpmnEditor().catch(showError);
    [adminUsers, siteSettings] = await Promise.all([api("/api/admin/users"), api("/api/admin/settings")]);
    adminActive = true;
    settingsActive = false;
    adminTab = tab;
    renderAdmin();
  }

  function renderAdmin() {
    document.body.classList.add("settings-active");
    $(".settings-link").classList.remove("active");
    $(".admin-link").classList.add("active");
    $(".workspace-button").classList.remove("active");
    $(".sidebar-section-label").textContent = "Navigation";
    $("#phase-rail").innerHTML = '<button class="rail-phase rail-nav-button" data-action="home" aria-label="Projects" title="Projects"><span class="rail-phase-letter" aria-hidden="true">▦</span><span class="rail-phase-name">Projects</span></button>';
    $("#top-project-name").textContent = "Administration";
    const tabs = [["users", "Users"], ["site", "Site settings"]];
    $("#view-container").innerHTML = `
      <div class="settings-page">
        <div class="settings-title"><h1>Administration</h1><span class="settings-active-badge">Admin</span></div>
        <nav class="settings-tabs" aria-label="Administration sections" role="tablist">
          ${tabs.map(([key, label]) => `<button class="settings-tab ${adminTab === key ? "active" : ""}" type="button" role="tab" aria-selected="${adminTab === key}" data-action="admin-tab" data-tab="${key}">${label}</button>`).join("")}
        </nav>
        <div class="settings-content">${adminTab === "site" ? renderSiteSettings() : renderAdminUsers()}</div>
      </div>`;
  }

  function renderAdminUsers() {
    const rowsMarkup = adminUsers.map((user) => {
      const self = user.id === currentUser.id;
      const badges = [
        user.is_admin ? '<span class="badge badge-phase">Admin</span>' : "",
        user.disabled ? '<span class="badge badge-disabled">Disabled</span>' : "",
        self ? '<span class="badge">You</span>' : ""
      ].join("");
      const actions = self ? '<span class="muted-small">Use Settings → Account</span>' : `
        <button class="text-action" data-action="admin-reset-password" data-id="${escapeHtml(user.id)}">Reset password</button>
        <button class="text-action" data-action="admin-toggle" data-field="is_admin" data-value="${user.is_admin ? "false" : "true"}" data-id="${escapeHtml(user.id)}">${user.is_admin ? "Remove admin" : "Make admin"}</button>
        <button class="text-action" data-action="admin-toggle" data-field="disabled" data-value="${user.disabled ? "false" : "true"}" data-id="${escapeHtml(user.id)}">${user.disabled ? "Enable" : "Disable"}</button>
        <button class="text-action delete" data-action="admin-delete-user" data-id="${escapeHtml(user.id)}">Delete</button>`;
      return `<tr><td><span class="record-title">${escapeHtml(user.username)}</span><span class="admin-badges">${badges}</span></td><td>${dateLabel(user.created_at)}</td><td>${user.last_login_at ? dateLabel(user.last_login_at) : "Never"}</td><td>${user.project_count}</td><td class="record-actions">${actions}</td></tr>`;
    }).join("");
    return `<section class="admin-section">
        <div class="settings-section-heading"><h2>Users</h2><p>${adminUsers.length} ${adminUsers.length === 1 ? "account" : "accounts"}. Disabling an account signs it out everywhere and blocks sign-in. Deleting an account also deletes the projects it owns.</p></div>
        <div class="records-wrap"><table class="records-table admin-users-table"><thead><tr><th>Username</th><th>Created</th><th>Last sign-in</th><th>Projects owned</th><th></th></tr></thead><tbody>${rowsMarkup}</tbody></table></div>
      </section>
      <form class="settings-form admin-add-user" id="admin-user-form">
        <div class="settings-section-heading"><h2>Add a user</h2><p>Leave the password blank to generate one. You will see it once, so you can pass it on.</p></div>
        <div class="form-field"><label for="admin-new-username">Username</label><input class="input" id="admin-new-username" name="username" required minlength="3" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="form-field"><label for="admin-new-password">Password (optional)</label><input class="input" id="admin-new-password" name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password"></div>
        <label class="checkbox-row"><input type="checkbox" name="is_admin" value="true"> Make this user an administrator</label>
        <button class="button button-primary" type="submit">＋ Add user</button>
      </form>`;
  }

  function renderSiteSettings() {
    return `<form class="settings-form" id="site-settings-form">
      <div class="settings-section-heading"><h2>Site settings</h2><p>These apply to everyone on this server. Saved values take precedence over the server's environment variables.</p></div>
      <label class="checkbox-row"><input type="checkbox" name="allow_signup" value="true" ${siteSettings.allow_signup ? "checked" : ""}> Allow people to create their own accounts</label>
      <div class="form-field"><label for="site-signup-code">Sign-up code</label><input class="input" id="site-signup-code" name="signup_code" maxlength="64" autocomplete="off" value="${escapeHtml(siteSettings.signup_code)}"><p class="settings-help">If set, people creating their own account must enter this code. Leave blank to allow sign-up without a code.</p></div>
      <label class="checkbox-row"><input type="checkbox" name="sample_project" value="true" ${siteSettings.sample_project ? "checked" : ""}> Give new accounts the sample injection-molding project</label>
      <button class="button button-primary" type="submit">Save site settings</button>
    </form>`;
  }

  function showGeneratedPassword(username, password, intro) {
    const dialog = $("#record-dialog");
    dialog.classList.remove("modal-evidence-pdf");
    dialog.innerHTML = `<div class="modal-header"><div><h2>Password for ${escapeHtml(username)}</h2><p>${escapeHtml(intro)}</p></div><button class="modal-close" type="button" data-action="close-record" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="password-reveal"><code id="generated-password">${escapeHtml(password)}</code><button class="button button-small" type="button" data-action="copy-password">Copy</button></div>
      <p class="settings-help">This is the only time the password is shown. Share it securely; ${escapeHtml(username)} can change it under Settings → Account after signing in.</p></div>
      <div class="modal-footer"><button class="button button-primary" type="button" data-action="close-record">Done</button></div>`;
    dialog.showModal();
  }

  async function copyGeneratedPassword() {
    const code = $("#generated-password");
    try {
      await navigator.clipboard.writeText(code.textContent);
      showToast("Password copied.");
    } catch {
      // The clipboard API needs HTTPS; fall back to selecting the text for a manual copy.
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      showToast("Press Ctrl+C to copy the selected password.");
    }
  }

  async function handleAdminClick(action, control) {
    const user = adminUsers.find((item) => item.id === control.dataset.id);
    switch (action) {
      case "admin-tab":
        adminTab = control.dataset.tab;
        return renderAdmin();
      case "copy-password":
        return copyGeneratedPassword();
      case "admin-reset-password": {
        if (!confirm(`Reset the password for ${user.username}? Their current password stops working and they are signed out everywhere.`)) return;
        const { password } = await api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST" });
        showGeneratedPassword(user.username, password, "Their password has been reset.");
        return;
      }
      case "admin-toggle": {
        const value = control.dataset.value === "true";
        if (control.dataset.field === "disabled" && value && !confirm(`Disable ${user.username}? They are signed out and cannot sign in until re-enabled.`)) return;
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PUT", body: { [control.dataset.field]: value } });
        adminUsers = await api("/api/admin/users");
        renderAdmin();
        showToast(`${user.username} updated.`);
        return;
      }
      case "admin-delete-user": {
        const projects = user.project_count ? ` and the ${user.project_count} ${user.project_count === 1 ? "project" : "projects"} they own` : "";
        if (!confirm(`Delete ${user.username}${projects}? This cannot be undone.`)) return;
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
        adminUsers = await api("/api/admin/users");
        renderAdmin();
        showToast(`${user.username} deleted.`);
        return;
      }
    }
  }

  async function handleAdminSubmit(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    if (form.id === "admin-user-form") {
      const result = await api("/api/admin/users", {
        method: "POST",
        body: { username: values.username, password: values.password, is_admin: values.is_admin === "true" }
      });
      adminUsers = await api("/api/admin/users");
      renderAdmin();
      if (result.password) showGeneratedPassword(result.user.username, result.password, "The account has been created.");
      else showToast(`${result.user.username} added.`);
    } else if (form.id === "site-settings-form") {
      siteSettings = await api("/api/admin/settings", {
        method: "PUT",
        body: { allow_signup: values.allow_signup === "true", signup_code: values.signup_code, sample_project: values.sample_project === "true" }
      });
      renderAdmin();
      showToast("Site settings saved.");
    }
  }

  const DEFINE_COLLECTIONS = {
    stakeholder: "stakeholders", communication: "communications", sipoc: "sipoc",
    "voc-item": "voc_items", "affinity-group": "affinity_groups",
    ctq: "ctq_nodes", risk: "risks", evidence: "evidence"
  };
  const DEFINE_LABELS = {
    stakeholder: "stakeholder", communication: "communication plan", sipoc: "SIPOC element",
    "voc-segment": "customer segment", "voc-item": "VOC item", "affinity-group": "theme",
    "affinity-card": "idea", ctq: "CTQ node and its children", risk: "risk", evidence: "evidence item"
  };

  async function refreshPhase() {
    await loadSnapshot();
    renderPhase();
  }

  async function handleClick(event) {
    const control = event.target.closest("[data-action]");
    const card = event.target.closest("[data-project]");
    if (card && !control) return openProject(card.dataset.project);
    if (!control) return;
    const { action } = control.dataset;
    try {
      if (action.startsWith("admin-") || action === "copy-password") return await handleAdminClick(action, control);
      // Leaving the admin page for any other view.
      if (["home", "open-settings", "open-account", "overview", "open-phase"].includes(action)) {
        adminActive = false;
        $(".admin-link").classList.remove("active");
      }
      switch (action) {
        case "toggle-sidebar": {
          const expanded = document.body.classList.toggle("sidebar-expanded");
          control.setAttribute("aria-expanded", String(expanded));
          control.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} sidebar`);
          control.querySelector("span").textContent = expanded ? "‹" : "›";
          await saveSettings({ "sidebar-start": expanded ? "expanded" : "collapsed" });
          return;
        }
        case "auth-mode":
          authMode = control.dataset.mode;
          return renderAuthScreen();
        case "logout":
          await disposeBpmnEditor().catch(() => {});
          await api("/api/auth/logout", { method: "POST" });
          window.location.reload();
          return;
        case "open-settings":
          settingsActive = true;
          settingsTab = "profile";
          pendingProfilePhoto = null;
          return renderSettings();
        case "settings-tab":
          settingsTab = control.dataset.tab;
          return renderSettings();
        case "open-admin":
          return openAdmin();
        case "open-account":
          settingsActive = true;
          settingsTab = "account";
          return renderSettings();
        case "home":
          settingsActive = false; currentProjectId = null; currentTab = null; snapshot = null;
          await loadProjects();
          return renderHome();
        case "new-project": return openProjectForm();
        case "edit-project": return openProjectForm(currentProject());
        case "close-project": $("#project-dialog").close(); return;
        case "close-record": $("#record-dialog").close(); return;
        case "add-member": return addProjectMember();
        case "remove-member":
          snapshot.members = await api(projectUrl(`/members/${encodeURIComponent(control.dataset.id)}`), { method: "DELETE" });
          snapshot.project.member_count = snapshot.members.length;
          $("#project-team").innerHTML = projectTeamMarkup();
          showToast("Team member removed.");
          return;
        case "import-process-map": $("#bpmn-import").click(); return;
        case "download-process-map": return downloadBpmnDiagram();
        case "save-process-map":
          await queueBpmnSave();
          showToast("Process map saved.");
          return;
        case "overview": settingsActive = false; document.body.classList.remove("settings-active"); $(".settings-link").classList.remove("active"); currentTab = null; return renderOverview();
        case "open-phase":
          settingsActive = false; document.body.classList.remove("settings-active"); $(".settings-link").classList.remove("active");
          currentPhase = control.dataset.phase;
          currentTab = getPhase(currentPhase).tabs[0][0];
          snapshot.project.current_phase = currentPhase;
          renderPhase();
          await api(projectUrl("/phase"), { method: "PUT", body: { phase: currentPhase } });
          return;
        case "tab": currentTab = control.dataset.tab; return renderPhase();
        case "metrics-subtab": {
          const nextSubTab = METRICS_SUBTABS.some((item) => item.key === control.dataset.tab) ? control.dataset.tab : "data-collection";
          currentMetricsSubTab = nextSubTab;
          return renderPhase();
        }
        case "show-metrics-modal":
          const metricsBackdrop = document.querySelector(".metrics-modal-backdrop");
          if (metricsBackdrop) metricsBackdrop.setAttribute("data-modal-visible", "true");
          return;
        case "close-metrics-modal":
          const closeMetricsBackdrop = document.querySelector(".metrics-modal-backdrop");
          if (closeMetricsBackdrop) closeMetricsBackdrop.setAttribute("data-modal-visible", "false");
          return;
        case "render": return refreshPhase();
        case "print-report": window.print(); return;
        case "save":
          await refreshPhase();
          showToast("Affinity diagram saved.");
          return;
        case "define-edit-charter":
          return openDefineForm("charter", snapshot.charter || { problem: currentProject()?.problem || "", sponsor: currentProject()?.owner || "" });
        case "define-suggest-ctq": {
          if (!snapshot.voc_items.length && !snapshot.charter?.goal) {
            showToast("Add a VOC item or charter goal before generating a CTQ outline.");
            return;
          }
          if (snapshot.ctq_nodes.length && !confirm("Add suggested nodes to the existing CTQ tree? Existing nodes will be kept.")) return;
          const { added } = await api(projectUrl("/ctq/suggest"), { method: "POST" });
          await refreshPhase();
          showToast(`Added ${added} suggested need → driver → CTQ path${added === 1 ? "" : "s"}. Review each node.`);
          return;
        }
        case "define-add":
          return openDefineForm(control.dataset.kind, {}, {
            stage: control.dataset.stage,
            parentId: control.dataset.parent,
            nodeType: control.dataset.nodeType
          });
        case "define-edit": {
          const collection = DEFINE_COLLECTIONS[control.dataset.kind];
          if (!collection) throw new Error("This Define item cannot be edited.");
          const record = snapshot[collection].find((item) => item.id === control.dataset.id);
          if (!record) throw new Error("This Define item could not be found.");
          return openDefineForm(control.dataset.kind, record);
        }
        case "define-delete": {
          const label = DEFINE_LABELS[control.dataset.kind];
          if (!label) throw new Error("This Define item cannot be deleted.");
          if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
          await api(projectUrl(`/define/${encodeURIComponent(control.dataset.kind)}/${encodeURIComponent(control.dataset.id)}`), { method: "DELETE" });
          await refreshPhase();
          showToast(`${label[0].toUpperCase()}${label.slice(1)} deleted.`);
          return;
        }
        case "define-auto-group": {
          if (!snapshot.affinity_cards.some((card) => !card.group_id)) { showToast("There are no uncategorized ideas to group."); return; }
          const { grouped, total } = await api(projectUrl("/affinity/auto-group"), { method: "POST" });
          await refreshPhase();
          showToast(`Suggested groups for ${grouped} of ${total} uncategorized ideas. Review and adjust the themes.`);
          return;
        }
        case "evidence-download": {
          const link = document.createElement("a");
          link.href = evidenceFileUrl(control.dataset.id);
          link.download = "";
          link.click();
          return;
        }
        case "evidence-open":
          return openEvidence(control.dataset.id);
        case "new-entry": return openEntryForm();
        case "edit-entry": return openEntryForm(snapshot.entries.find((entry) => entry.id === control.dataset.id));
        case "delete-entry":
          if (!confirm("Delete this work item? This cannot be undone.")) return;
          await api(projectUrl(`/entries/${encodeURIComponent(control.dataset.id)}`), { method: "DELETE" });
          await refreshPhase();
          showToast("Work item deleted.");
          return;
        case "delete-project":
          if (!confirm(`Delete "${currentProject()?.name}" and all its phase records for everyone on the team? This cannot be undone.`)) return;
          await api(projectUrl(), { method: "DELETE" });
          currentProjectId = null; currentTab = null; $("#project-dialog").close();
          await reload();
          showToast("Project deleted.");
          return;
        case "leave-project":
          if (!confirm(`Leave "${currentProject()?.name}"? You will lose access until the owner adds you again.`)) return;
          await api(projectUrl(`/members/${encodeURIComponent(currentUser.id)}`), { method: "DELETE" });
          currentProjectId = null; currentTab = null; $("#project-dialog").close();
          await reload();
          showToast("You left the project.");
          return;
        case "backup": return exportDatabase();
        case "import": $("#database-import").click(); return;
      }
    } catch (error) { showError(error); }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (form.id === "admin-user-form" || form.id === "site-settings-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      try { await handleAdminSubmit(form); } catch (error) { showError(error); }
      return;
    }
    if (form.id === "auth-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      const error = $("#auth-error");
      error.textContent = "";
      if ("password_confirm" in values && values.password !== values.password_confirm) {
        error.textContent = "The passwords do not match.";
        $("#auth-password-confirm").focus();
        return;
      }
      delete values.password_confirm;
      const button = $("button[type=submit]", form);
      button.disabled = true;
      try {
        await api(`/api/auth/${authMode}`, { method: "POST", body: values });
        await startSession();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (form.id === "password-settings-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        await api("/api/auth/password", { method: "POST", body: values });
        form.reset();
        showToast("Password updated. Other devices have been signed out.");
      } catch (error) { showError(error); }
      return;
    }
    if (form.id === "profile-settings-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        const updates = Object.fromEntries(["name", "email", "job-title", "company", "phone", "sigma-role"].map((key) => [`profile-${key}`, values[key].trim()]));
        if (pendingProfilePhoto !== null) updates["profile-photo"] = pendingProfilePhoto;
        await saveSettings(updates);
        pendingProfilePhoto = null;
        renderSettings();
        showToast("Profile saved.");
      } catch (error) { showError(error); }
      return;
    }
    if (form.id === "preferences-settings-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        const updates = { "date-format": values["date-format"], "sidebar-start": values["sidebar-start"] };
        PHASES.forEach((phase) => { updates[`phase-color-${phase.key}`] = values[`phase-color-${phase.key}`]; });
        await saveSettings(updates);
        setSidebarExpanded(values["sidebar-start"] === "expanded");
        renderSettings();
        showToast("Preferences saved.");
      } catch (error) { showError(error); }
      return;
    }
    if (form.id === "define-form") {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const formData = new FormData(form);
      const values = Object.fromEntries(formData.entries());
      const file = values.file instanceof File && values.file.size ? values.file : null;
      if (file && file.size > 10 * 1024 * 1024) {
        showToast("Evidence files must be 10 MB or smaller.", true);
        return;
      }
      delete values.file;
      try {
        await saveDefineItem(form.dataset.kind, form.dataset.id || null, values, {
          stage: form.dataset.stage,
          parentId: form.dataset.parent,
          nodeType: form.dataset.nodeType
        }, formData);
        $("#record-dialog").close();
        await refreshPhase();
        showToast(`${form.dataset.kind === "charter" ? "Project charter" : form.dataset.kind.replace("-", " ")} saved.`);
      } catch (error) { showError(error); }
      return;
    }
    if (form.dataset.inlineKind) {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        await saveDefineItem(form.dataset.inlineKind, null, values, {});
        await refreshPhase();
        showToast(form.dataset.inlineKind === "affinity-card" ? "Idea added." : "Theme added.");
      } catch (error) { showError(error); }
      return;
    }
    if (form.id !== "project-form" && form.id !== "entry-form") return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      if (form.id === "project-form") {
        const isNewProject = !currentProjectId;
        if (!isNewProject) {
          await api(projectUrl(), { method: "PUT", body: values });
        } else {
          const { id } = await api("/api/projects", { method: "POST", body: values });
          currentProjectId = id;
          currentPhase = "define";
          currentTab = null;
        }
        $("#project-dialog").close();
        await reload();
        showToast(isNewProject ? "Project ready. Start by defining the charter." : "Project saved.");
      } else {
        if (form.dataset.id) {
          await api(projectUrl(`/entries/${encodeURIComponent(form.dataset.id)}`), { method: "PUT", body: values });
        } else {
          await api(projectUrl("/entries"), { method: "POST", body: { ...values, phase: currentPhase, tab: currentTab } });
        }
        $("#record-dialog").close();
        await refreshPhase();
        showToast(form.dataset.id ? "Work item updated." : "Work item added.");
      }
    } catch (error) { showError(error); }
  }

  function handleInput(event) {
    const target = event.target;
    if (target.id === "project-search") {
      activeFilters.search = target.value;
      const position = target.selectionStart;
      renderHome();
      const replacement = $("#project-search");
      replacement.focus();
      replacement.setSelectionRange(position, position);
    } else if (target.id === "phase-note" && currentProjectId) {
      const phase = currentPhase;
      const tab = currentTab;
      const note = target.value;
      const existing = snapshot.notes.find((item) => item.phase === phase && item.tab === tab);
      if (existing) existing.note = note; else snapshot.notes.push({ phase, tab, note });
      queueNoteSave(`/api/projects/${encodeURIComponent(currentProjectId)}/notes/${phase}/${encodeURIComponent(tab)}`, note);
    }
  }

  // Notes save shortly after typing stops; one pending save per note.
  function queueNoteSave(url, note) {
    clearTimeout(noteSaveTimers.get(url)?.timer);
    const timer = setTimeout(() => {
      noteSaveTimers.delete(url);
      api(url, { method: "PUT", body: { note } }).catch(showError);
    }, 500);
    noteSaveTimers.set(url, { timer, note });
  }

  // Sends any note still waiting to save when the page is closed or reloaded.
  function flushNoteSaves() {
    noteSaveTimers.forEach(({ timer, note }, url) => {
      clearTimeout(timer);
      fetch(url, {
        method: "PUT", keepalive: true, credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-DMAIC": "1" },
        body: JSON.stringify({ note })
      }).catch(() => {});
    });
    noteSaveTimers.clear();
  }

  async function handleChange(event) {
    if (event.target.id === "phase-filter") { activeFilters.phase = event.target.value; renderHome(); }
    if (event.target.id === "status-filter") { activeFilters.status = event.target.value; renderHome(); }
    if (event.target.id === "database-import") {
      const file = event.target.files?.[0];
      if (file) importDatabase(file);
      event.target.value = "";
    }
    if (event.target.id === "bpmn-import") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        showToast("BPMN files must be 10 MB or smaller.", true);
        return;
      }
      const warnings = await importBpmnDiagram(await file.text());
      showToast(warnings.length ? `BPMN diagram imported with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.` : "BPMN diagram imported.");
    }
    if (event.target.id === "settings-photo") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (!["image/png", "image/jpeg", "image/gif"].includes(file.type)) {
        showToast("Choose a JPG, PNG, or GIF image.", true);
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        showToast("Profile photos must be 2 MB or smaller.", true);
        return;
      }
      try {
        const photo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error("Could not read the selected profile photo."));
          reader.readAsDataURL(file);
        });
        pendingProfilePhoto = String(photo);
        $("#profile-photo-preview").innerHTML = `<img src="${escapeHtml(pendingProfilePhoto)}" alt="Profile photo preview">`;
      } catch (error) { showError(error); }
    }
  }

  document.addEventListener("click", (event) => { handleClick(event).catch(showError); });
  document.addEventListener("submit", (event) => { handleSubmit(event).catch(showError); });
  document.addEventListener("input", handleInput);
  document.addEventListener("change", (event) => { handleChange(event).catch(showError); });
  document.addEventListener("dragstart", (event) => {
    const affinityCard = event.target.closest("[data-card-id]");
    const stakeholderCard = event.target.closest("[data-stakeholder-card-id]");
    const card = affinityCard || stakeholderCard;
    if (!card) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", affinityCard ? card.dataset.cardId : card.dataset.stakeholderCardId);
    event.dataTransfer.setData("application/x-dmaic-kind", affinityCard ? "affinity" : "stakeholder");
  });
  document.addEventListener("dragover", (event) => {
    const target = currentTab === "affinity"
      ? event.target.closest("[data-drop-group]")
      : currentTab === "stakeholders" ? event.target.closest("[data-drop-stakeholder]") : null;
    if (!target || currentPhase !== "define") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    target.classList.add("drop-active");
  });
  document.addEventListener("dragleave", (event) => {
    const target = event.target.closest("[data-drop-group], [data-drop-stakeholder]");
    if (target && !target.contains(event.relatedTarget)) target.classList.remove("drop-active");
  });
  document.addEventListener("dragend", () => {
    document.querySelectorAll(".drop-active").forEach((target) => target.classList.remove("drop-active"));
  });
  document.addEventListener("drop", (event) => {
    const kind = event.dataTransfer.getData("application/x-dmaic-kind");
    const id = event.dataTransfer.getData("text/plain");
    if (!id || !currentProjectId || currentPhase !== "define") return;
    if (kind === "affinity" && currentTab === "affinity") {
      const target = event.target.closest("[data-drop-group]");
      if (!target) return;
      event.preventDefault();
      api(projectUrl(`/affinity-cards/${encodeURIComponent(id)}/group`), { method: "PUT", body: { group_id: target.dataset.dropGroup || null } })
        .then(refreshPhase)
        .then(() => showToast("Idea moved to its new theme."))
        .catch(showError);
      return;
    }
    if (kind === "stakeholder" && currentTab === "stakeholders") {
      const target = event.target.closest("[data-drop-stakeholder]");
      if (!target) return;
      event.preventDefault();
      const engagement = target.dataset.dropStakeholder;
      api(projectUrl(`/stakeholders/${encodeURIComponent(id)}/engagement`), { method: "PUT", body: { engagement } })
        .then(refreshPhase)
        .then(() => showToast(engagement ? "Stakeholder moved to the engagement quadrant." : "Stakeholder returned to the bench."))
        .catch(showError);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.id === "member-username" && event.key === "Enter") {
      event.preventDefault();
      addProjectMember().catch(showError);
      return;
    }
    const evidenceCard = event.target.closest(".evidence-card-open");
    if (evidenceCard && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      try { openEvidence(evidenceCard.dataset.id); } catch (error) { showError(error); }
      return;
    }
    const card = event.target.closest("[data-project], .phase-card");
    if (card && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (card.dataset.project) {
        openProject(card.dataset.project).catch(showError);
      } else {
        currentPhase = card.dataset.phase; currentTab = getPhase(currentPhase).tabs[0][0]; renderPhase();
      }
    }
    if (event.key === "Escape") {
      $("#project-dialog").close();
      $("#record-dialog").close();
    }
  });
  window.addEventListener("pagehide", flushNoteSaves);

  // Modes: "setup" (first run: create the administrator), "register", or "login".
  function renderAuthScreen(message = "") {
    const status = authStatus || {};
    if (!authMode) authMode = status.setup_required ? "setup" : "login";
    if (status.setup_required && !status.has_users) authMode = "setup";
    if (!status.setup_required && authMode === "setup") authMode = "login";
    if (authMode === "register" && !status.signup_allowed) authMode = "login";
    const settingUp = authMode === "setup";
    const registering = authMode === "register";
    const creating = settingUp || registering;
    const signInLink = 'Already have an account? <button class="text-action" type="button" data-action="auth-mode" data-mode="login">Sign in</button>';
    const switcher = settingUp ? (status.has_users ? signInLink : "")
      : registering ? signInLink
        : status.setup_required ? 'No administrator yet? <button class="text-action" type="button" data-action="auth-mode" data-mode="setup">Set up the administrator account</button>'
          : status.signup_allowed ? 'New to DMAIC Studio? <button class="text-action" type="button" data-action="auth-mode" data-mode="register">Create an account</button>' : "";
    const heading = settingUp ? "Set up DMAIC Studio" : registering ? "Create your account" : "Sign in";
    const intro = settingUp
      ? "Create the administrator account. You will use it to manage users and site settings, and you can run projects with it like any other account."
      : registering ? "Your projects are saved on this server, so you can open them wherever you sign in." : "Sign in to open your improvement projects.";
    $("#auth-screen").innerHTML = `<div class="auth-card">
        <div class="auth-brand"><span class="auth-mark" aria-hidden="true">σ</span><span class="wordmark">DMAIC <span>STUDIO</span></span></div>
        ${settingUp ? '<span class="eyebrow">First-time setup</span>' : ""}
        <h1>${heading}</h1>
        <p class="subtitle">${intro}</p>
        ${message ? `<p class="auth-notice">${escapeHtml(message)}</p>` : ""}
        <form id="auth-form" class="auth-form">
          <div class="form-field"><label for="auth-username">${settingUp ? "Administrator username" : "Username"}</label><input class="input" id="auth-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="40" ${settingUp ? 'placeholder="e.g. admin"' : ""}>${creating ? '<p class="settings-help">3–40 characters: letters, numbers, and . _ - @</p>' : ""}</div>
          <div class="form-field"><label for="auth-password">${creating ? "Create a password" : "Password"}</label><input class="input" id="auth-password" name="password" type="password" autocomplete="${creating ? "new-password" : "current-password"}" required ${creating ? 'minlength="8"' : ""} maxlength="256">${creating ? '<p class="settings-help">Use at least 8 characters.</p>' : ""}</div>
          ${creating ? '<div class="form-field"><label for="auth-password-confirm">Confirm password</label><input class="input" id="auth-password-confirm" name="password_confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="256"></div>' : ""}
          ${registering && status.signup_code_required ? '<div class="form-field"><label for="auth-code">Sign-up code</label><input class="input" id="auth-code" name="signup_code" autocomplete="off" required><p class="settings-help">Ask your DMAIC Studio administrator for this code.</p></div>' : ""}
          <p class="auth-error" id="auth-error" role="alert"></p>
          <button class="button button-primary auth-submit" type="submit">${settingUp ? "Create administrator account" : registering ? "Create account" : "Sign in"}</button>
        </form>
        ${switcher ? `<p class="auth-switch">${switcher}</p>` : ""}
      </div>`;
    $("#auth-username").focus();
  }

  async function showAuthScreen(message = "") {
    currentUser = null;
    snapshot = null;
    projectCache = [];
    currentProjectId = null;
    currentTab = null;
    settingsActive = false;
    document.body.classList.add("auth-required");
    ["#project-dialog", "#record-dialog"].forEach((selector) => { if ($(selector).open) $(selector).close(); });
    if (!authStatus || authStatus.authenticated) {
      try { authStatus = await api("/api/auth/status"); } catch { authStatus = authStatus || {}; }
    }
    renderAuthScreen(message);
  }

  async function startSession() {
    authStatus = await api("/api/auth/status");
    if (!authStatus.authenticated) return showAuthScreen();
    currentUser = authStatus.user;
    $(".admin-link").hidden = !currentUser.is_admin;
    adminActive = false;
    document.body.classList.remove("auth-required");
    $("#auth-screen").innerHTML = "";
    settings = await api("/api/settings");
    setSidebarExpanded(getSetting("sidebar-start", "collapsed") === "expanded");
    updateProfileAvatar();
    settingsActive = false;
    currentProjectId = null;
    currentTab = null;
    await reload();
  }

  (async () => {
    try {
      await startSession();
    } catch (error) {
      console.error(error);
      $("#view-container").innerHTML = `<div class="empty-state"><span class="empty-icon">⚠</span><h3>Could not connect to DMAIC Studio</h3><p>${escapeHtml(error.message)} Check that the server is running, then reload the page.</p></div>`;
      $("#save-status").textContent = "Server unavailable";
    }
  })();
})();
