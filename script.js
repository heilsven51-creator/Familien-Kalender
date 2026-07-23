const supabaseClient = window.supabase.createClient(window.FAMILIO_SUPABASE_URL, window.FAMILIO_SUPABASE_PUBLISHABLE_KEY);
const TODAY = "2026-07-23";
const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const dayNames = ["SO", "MO", "DI", "MI", "DO", "FR", "SA"];
const calendarNames = { familie: "Familie", schule: "Schule & Kita", sport: "Sport & Freizeit", geburtstag: "Geburtstage" };
const $ = (selector) => document.querySelector(selector);

function emptyStore() {
  return { users: [], currentUserId: null, events: [], files: [], tasks: [], invitations: [], receivedInvitations: [], members: [] };
}
let store = emptyStore();
let shownDate = new Date(2026, 6, 23);
let authMode = "signup";
let currentView = "kalender";
let calendarMode = "month";
let realtimeChannel;
let subscribedFamilyId;
let remoteSyncTimer;
function persist() { return true; }
function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function currentUser() { return store.users.find(user => user.id === store.currentUserId); }
function initials(name = "?") { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?"; }
function escapeHtml(value = "") { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function isoDate(year, month, day) { return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function familyEvents() { const user = currentUser(); return user ? store.events.filter(event => event.familyId === user.familyId) : []; }
function familyFiles() { const user = currentUser(); return user ? store.files.filter(file => file.familyId === user.familyId) : []; }
function familyTasks() { const user = currentUser(); return user ? store.tasks.filter(task => task.familyId === user.familyId) : []; }
function activeCalendars() { return [...document.querySelectorAll("[data-calendar]")].filter(input => input.checked).map(input => input.dataset.calendar); }

async function hashPassword(password) {
  if (!globalThis.crypto?.subtle) return btoa(unescape(encodeURIComponent(password)));
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00`);
  return `${date.getDate()}. ${monthNames[date.getMonth()]}`;
}
function isImage(file) { return file.type && file.type.startsWith("image/"); }
function fileGlyph(file) { return isImage(file) ? "▧" : file.type.includes("pdf") ? "PDF" : file.type.includes("word") ? "DOC" : "FILE"; }
function timeLabel(time) { return time && time !== "00:00" ? `${time} Uhr` : "Ganztägig"; }

async function fileUrl(file) {
  if (file.data) return file.data;
  if (!file.storagePath) return null;
  const { data, error } = await supabaseClient.storage.from("family-files").createSignedUrl(file.storagePath, 3600);
  return error ? null : data.signedUrl;
}

function mapEvent(row) {
  return { id: row.id, familyId: row.family_id, createdBy: row.created_by, title: row.title, date: row.event_date, time: row.event_time ? row.event_time.slice(0, 5) : "00:00", calendar: row.calendar, reminder: row.reminder_minutes ? String(row.reminder_minutes) : "none", attendees: row.attendees || "", note: row.note || "", createdAt: Date.parse(row.created_at) };
}
function mapTask(row) { return { id: row.id, familyId: row.family_id, title: row.title, done: row.done, createdAt: Date.parse(row.created_at) }; }
function mapFile(row) { return { id: row.id, familyId: row.family_id, eventId: row.event_id, uploadedBy: row.uploaded_by, storagePath: row.storage_path, name: row.name, type: row.content_type || "", size: Number(row.byte_size), createdAt: Date.parse(row.created_at) }; }
function mapInvitation(row) { return { id: row.id, familyId: row.family_id, email: row.email, message: row.message || "", status: row.status, createdAt: Date.parse(row.created_at) }; }

async function loadWorkspace() {
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !authData.user) { store = emptyStore(); return false; }
  const authUser = authData.user;
  const { data: profile, error: profileError } = await supabaseClient.from("profiles").select("*").eq("id", authUser.id).single();
  if (profileError || !profile) { showToast("Dein Profil wird noch eingerichtet – bitte gleich erneut anmelden"); return false; }
  const { data: memberships, error: membersError } = await supabaseClient.from("family_members").select("family_id, role").eq("user_id", authUser.id);
  if (membersError || !memberships?.length) { showToast("Dein Familienraum konnte nicht geladen werden"); return false; }
  const preferredFamilyId = localStorage.getItem("familio.active-family");
  const selectedMembership = memberships.find(item => item.family_id === preferredFamilyId) || memberships.find(item => item.role === "owner") || memberships[0];
  const familyId = selectedMembership.family_id;
  const [familyResult, eventsResult, tasksResult, filesResult, invitationsResult, receivedInvitationsResult, memberResult] = await Promise.all([
    supabaseClient.from("families").select("*").eq("id", familyId).single(),
    supabaseClient.from("events").select("*").eq("family_id", familyId).order("event_date").order("event_time"),
    supabaseClient.from("tasks").select("*").eq("family_id", familyId).order("created_at", { ascending: false }),
    supabaseClient.from("files").select("*").eq("family_id", familyId).order("created_at", { ascending: false }),
    supabaseClient.from("invitations").select("*").eq("family_id", familyId).order("created_at", { ascending: false }),
    supabaseClient.from("invitations").select("*").eq("email", authUser.email).eq("status", "pending").order("created_at", { ascending: false }),
    supabaseClient.from("family_members").select("user_id, role").eq("family_id", familyId)
  ]);
  if (familyResult.error) { showToast("Dein Familienraum konnte nicht geladen werden"); return false; }
  const avatar = profile.avatar_path ? await fileUrl({ storagePath: profile.avatar_path }) : null;
  store = {
    users: [{ id: authUser.id, email: profile.email, username: profile.display_name, familyName: familyResult.data.name, familyId, avatar, avatarPath: profile.avatar_path || null, role: selectedMembership.role }],
    currentUserId: authUser.id,
    events: (eventsResult.data || []).map(mapEvent),
    tasks: (tasksResult.data || []).map(mapTask),
    files: (filesResult.data || []).map(mapFile),
    invitations: (invitationsResult.data || []).map(mapInvitation),
    receivedInvitations: (receivedInvitationsResult.data || []).map(mapInvitation),
    members: memberResult.data || []
  };
  subscribeToFamily(familyId);
  return true;
}

function syncRemoteWorkspace() {
  clearTimeout(remoteSyncTimer);
  remoteSyncTimer = setTimeout(async () => {
    const loaded = await loadWorkspace();
    if (!loaded) return;
    renderAll();
    if (currentView === "aufgaben") renderTaskModule();
    if (currentView === "momente") renderMomentsModule();
    if (currentView === "dateien") renderFilesModule();
  }, 350);
}

function subscribeToFamily(familyId) {
  if (subscribedFamilyId === familyId) return;
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  subscribedFamilyId = familyId;
  realtimeChannel = supabaseClient.channel(`familio-${familyId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `family_id=eq.${familyId}` }, syncRemoteWorkspace)
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `family_id=eq.${familyId}` }, syncRemoteWorkspace)
    .on("postgres_changes", { event: "*", schema: "public", table: "files", filter: `family_id=eq.${familyId}` }, syncRemoteWorkspace)
    .on("postgres_changes", { event: "*", schema: "public", table: "invitations", filter: `family_id=eq.${familyId}` }, syncRemoteWorkspace)
    .subscribe();
}

function renderAccount() {
  const user = currentUser();
  if (!user) return;
  const letters = initials(user.username);
  const setAvatar = (selector, text) => {
    const element = $(selector);
    element.innerHTML = user.avatar ? `<img src="${user.avatar}" alt="" />` : text;
  };
  $("#greetingTitle").innerHTML = `Guten Morgen, ${escapeHtml(user.username.split(" ")[0])} <span>✦</span>`;
  $("#familyName").textContent = user.familyName;
  setAvatar("#familyAvatar", initials(user.familyName).charAt(0));
  $("#profileName").textContent = user.username;
  setAvatar("#profileAvatar", letters);
  $("#profileRole").textContent = "Profil & Einstellungen";
  $(".member-lisa").innerHTML = user.avatar ? `<img src="${user.avatar}" alt="" /><i></i>` : `<span id="memberInitials">${letters}</span><i></i>`;
  const invites = store.invitations.filter(item => item.familyId === user.familyId && item.status === "pending");
  const otherMembers = Math.max(0, (store.members || []).length - 1);
  $("#memberCount").textContent = `+${otherMembers}`;
  $("#memberCopy").textContent = otherMembers ? `${otherMembers + 1} Mitglieder planen zusammen.${invites.length ? ` ${invites.length} Einladung${invites.length > 1 ? "en" : ""} offen.` : ""}` : "Lade deine Familie dazu ein.";
}

function renderCalendar() {
  document.querySelectorAll("[data-calendar-view]").forEach(button => button.classList.toggle("active", button.dataset.calendarView === calendarMode));
  if (calendarMode === "week") return renderWeekCalendar();
  if (calendarMode === "day") return renderDayCalendar();
  renderMonthCalendar();
}

function renderMonthCalendar() {
  $("#calendarWrap").innerHTML = `<div class="weekdays"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div><div class="calendar-grid" id="calendarGrid"></div>`;
  const grid = $("#calendarGrid");
  const year = shownDate.getFullYear();
  const month = shownDate.getMonth();
  $("#monthTitle").innerHTML = `${monthNames[month]} <span>${year}</span>`;
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const selected = activeCalendars();
  const events = familyEvents();
  for (let cell = 0; cell < 42; cell++) {
    let day = cell - offset + 1;
    let cellMonth = month;
    let cellYear = year;
    let outside = false;
    if (day < 1) { day = prevDays + day; cellMonth--; outside = true; }
    if (day > daysInMonth) { day -= daysInMonth; cellMonth++; outside = true; }
    if (cellMonth < 0) { cellMonth = 11; cellYear--; }
    if (cellMonth > 11) { cellMonth = 0; cellYear++; }
    const date = isoDate(cellYear, cellMonth, day);
    const element = document.createElement("div");
    element.className = `day${outside ? " outside" : ""}${date === TODAY ? " current" : ""}`;
    element.dataset.date = date;
    element.innerHTML = `<span class="day-number">${day}</span>`;
    events.filter(event => event.date === date && selected.includes(event.calendar)).slice(0, 3).forEach(event => {
      const button = document.createElement("button");
      button.className = `event ${event.calendar}`;
      button.title = `${event.title} · ${timeLabel(event.time)}`;
      button.textContent = `${event.time !== "00:00" ? `${event.time} · ` : ""}${event.title}`;
      button.addEventListener("click", (click) => { click.stopPropagation(); openEventDetail(event); });
      element.appendChild(button);
    });
    element.addEventListener("dblclick", () => openEventModal(date));
    grid.appendChild(element);
  }
}

function startOfWeek(date) {
  const result = new Date(date);
  const day = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - day);
  result.setHours(12, 0, 0, 0);
  return result;
}

function renderWeekCalendar() {
  const monday = startOfWeek(shownDate);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday); date.setDate(monday.getDate() + index); return date;
  });
  const sunday = days[6];
  $("#monthTitle").innerHTML = `${monday.getDate()}. – ${sunday.getDate()}. ${monthNames[sunday.getMonth()]} <span>${sunday.getFullYear()}</span>`;
  const times = Array.from({ length: 13 }, (_, index) => index + 8);
  $("#calendarWrap").innerHTML = `<div class="week-head"><span></span>${days.map((date, index) => `<button class="week-day-label ${isoDate(date.getFullYear(),date.getMonth(),date.getDate()) === TODAY ? "today" : ""}" data-open-date="${isoDate(date.getFullYear(),date.getMonth(),date.getDate())}"><small>${["MO","DI","MI","DO","FR","SA","SO"][index]}</small><strong>${date.getDate()}</strong></button>`).join("")}</div><div class="week-body"><div class="week-hours">${times.map(hour => `<span>${String(hour).padStart(2,"0")}:00</span>`).join("")}</div>${days.map(date => {
    const iso = isoDate(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEvents = familyEvents().filter(event => event.date === iso && activeCalendars().includes(event.calendar));
    return `<div class="week-column" data-open-date="${iso}">${times.map(() => "<div class=week-line></div>").join("")}${dayEvents.map(event => `<button class="week-event ${event.calendar}" data-event-id="${event.id}" style="top:${Math.max(2, ((Number(event.time?.slice(0,2) || 9) - 8) * 51) + 2)}px"><strong>${escapeHtml(event.title)}</strong><small>${timeLabel(event.time)}</small></button>`).join("")}</div>`;
  }).join("")}</div>`;
  document.querySelectorAll("[data-open-date]").forEach(element => element.addEventListener("dblclick", () => openEventModal(element.dataset.openDate)));
  document.querySelectorAll(".week-event").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); openEventDetail(familyEvents().find(item => item.id === button.dataset.eventId)); }));
}

function renderDayCalendar() {
  const iso = isoDate(shownDate.getFullYear(), shownDate.getMonth(), shownDate.getDate());
  const events = familyEvents().filter(event => event.date === iso && activeCalendars().includes(event.calendar)).sort((a,b) => a.time.localeCompare(b.time));
  $("#monthTitle").innerHTML = `${["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"][shownDate.getDay()]}, ${shownDate.getDate()}. ${monthNames[shownDate.getMonth()]} <span>${shownDate.getFullYear()}</span>`;
  const times = Array.from({ length: 13 }, (_, index) => index + 8);
  $("#calendarWrap").innerHTML = `<div class="day-view"><div class="day-view-head"><div><p>${iso === TODAY ? "HEUTE" : "TAGESANSICHT"}</p><h3>${events.length ? `${events.length} Termin${events.length === 1 ? "" : "e"}` : "Noch frei"}</h3></div><button class="day-add" id="dayAdd">+ Termin</button></div><div class="day-agenda">${times.map(hour => {
    const atHour = events.filter(event => Number(event.time?.slice(0,2)) === hour || (event.time === "00:00" && hour === 8));
    return `<div class="agenda-row" data-open-date="${iso}"><span>${String(hour).padStart(2,"0")}:00</span><div class="agenda-slot">${atHour.map(event => `<button class="agenda-event ${event.calendar}" data-event-id="${event.id}"><strong>${escapeHtml(event.title)}</strong><small>${timeLabel(event.time)}${event.note ? " · Notiz" : ""}</small></button>`).join("")}</div></div>`;
  }).join("")}</div></div>`;
  $("#dayAdd").addEventListener("click", () => openEventModal(iso));
  document.querySelectorAll(".agenda-event").forEach(button => button.addEventListener("click", () => openEventDetail(familyEvents().find(item => item.id === button.dataset.eventId))));
  document.querySelectorAll(".agenda-row").forEach(row => row.addEventListener("dblclick", () => openEventModal(row.dataset.openDate)));
}

function renderToday() {
  const list = $("#todayList");
  const events = familyEvents().filter(event => event.date === TODAY).sort((a, b) => a.time.localeCompare(b.time));
  list.innerHTML = events.length ? events.map(event => `<article class="today-event ${event.calendar}"><h4>${escapeHtml(event.title)}</h4><p>${timeLabel(event.time)} · ${calendarNames[event.calendar]}</p></article>`).join("") : `<div class="clean-empty"><b>Dein Tag gehört dir.</b><span>Noch kein Termin für heute.</span></div>`;
}

function renderHighlights() {
  const week = familyEvents().filter(event => event.date >= TODAY && event.date <= "2026-07-29").sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0, 3);
  $("#highlightList").innerHTML = week.length ? week.map((event, index) => {
    const date = new Date(`${event.date}T12:00:00`);
    return `<article class="highlight" data-event-id="${event.id}"><div class="highlight-date"><b>${date.getDate()}</b><small>${dayNames[date.getDay()]}</small></div><div><h3>${escapeHtml(event.title)}</h3><p>${timeLabel(event.time)} · ${calendarNames[event.calendar]}</p></div>${index === 0 ? `<span class="mini-avatar">${initials(currentUser().username)}</span>` : ""}</article>`;
  }).join("") : `<button class="empty-highlight" id="firstEventButton"><span>+</span><div><strong>Der erste gemeinsame Moment</strong><small>Plane einen Termin für deine Familie</small></div></button>`;
  document.querySelectorAll("[data-event-id]").forEach(card => card.addEventListener("click", () => openEventDetail(familyEvents().find(event => event.id === card.dataset.eventId))));
  $("#firstEventButton")?.addEventListener("click", () => openEventModal());
}

function renderTasks() {
  const tasks = familyTasks().sort((a, b) => Number(a.done) - Number(b.done));
  const open = tasks.filter(task => !task.done).length;
  $(".reminder-ring strong").textContent = open;
  $(".reminder-card h3").textContent = open ? "Alles im Blick!" : "Alles erledigt!";
  $(".reminder-card small").textContent = tasks.length ? `${tasks.length - open} von ${tasks.length} Aufgaben erledigt` : "Lege deine erste Aufgabe an";
}

function renderAll() { renderAccount(); renderCalendar(); renderToday(); renderHighlights(); renderTasks(); }

function openModal(id) { const modal = document.getElementById(id); modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); }
function closeModal(id) { const modal = document.getElementById(id); modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }
function openEventModal(date = TODAY) { $("#eventDate").value = date; openModal("eventModal"); setTimeout(() => $("#eventTitle").focus(), 100); }
let toastTimer;
function showToast(message) { const toast = $("#toast"); toast.querySelector("p").textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3100); }

async function openEventDetail(event) {
  if (!event) return;
  const relatedFiles = familyFiles().filter(file => file.eventId === event.id);
  const tiles = await Promise.all(relatedFiles.map(fileTile));
  $("#moduleView").innerHTML = `<div class="detail-view"><button class="back-button" id="backToCalendar">← Zurück zum Kalender</button><div class="detail-head"><div class="detail-pip ${event.calendar}"></div><div><p>${calendarNames[event.calendar].toUpperCase()} · ${formatDate(event.date)}</p><h2>${escapeHtml(event.title)}</h2><span>${timeLabel(event.time)}${event.attendees ? ` · ${escapeHtml(event.attendees)}` : ""}</span></div></div>${event.note ? `<div class="note-card"><p>NOTIZ</p><div>${escapeHtml(event.note).replace(/\n/g,"<br>")}</div></div>` : ""}<div class="detail-block"><div class="section-heading"><div><p>ANHÄNGE</p><h3>${relatedFiles.length ? `${relatedFiles.length} Datei${relatedFiles.length === 1 ? "" : "en"}` : "Noch keine Anhänge"}</h3></div></div>${relatedFiles.length ? `<div class="file-strip">${tiles.join("")}</div>` : `<p class="soft-copy">Füge Fotos, Einladungen oder Dokumente direkt zum Termin hinzu.</p>`}</div></div>`;
  showView("detail");
  $("#backToCalendar").addEventListener("click", () => showView("kalender"));
  wireFileTiles();
}

function showView(view) {
  currentView = view;
  const dashboard = $("#dashboardView");
  const module = $("#moduleView");
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  if (view === "kalender") { dashboard.classList.remove("hidden"); module.classList.add("hidden"); return; }
  dashboard.classList.add("hidden"); module.classList.remove("hidden");
  if (view === "aufgaben") renderTaskModule();
  if (view === "momente") renderMomentsModule();
  if (view === "dateien") renderFilesModule();
  if (view === "profil") renderProfileModule();
}

function renderProfileModule() {
  const user = currentUser();
  $("#moduleView").innerHTML = `<div class="module-head"><div><p>DEIN BEREICH</p><h2>Profil &amp; Familienraum</h2><span>So sehen dich deine Familie und deine Einladungen.</span></div></div><div class="profile-layout"><aside class="profile-summary"><div class="profile-photo large" id="profilePreview">${user.avatar ? `<img src="${user.avatar}" alt="" />` : initials(user.username)}</div><strong>${escapeHtml(user.username)}</strong><small>${escapeHtml(user.email)}</small><label class="avatar-change">Profilbild ändern<input id="avatarInput" type="file" accept="image/*" /></label><button class="logout-button" id="logoutButton">Abmelden</button></aside><form class="profile-form" id="profileForm"><div class="profile-section"><p>PERSÖNLICHE DATEN</p><label>Dein Name<input name="username" required maxlength="28" value="${escapeHtml(user.username)}" /></label><label>E-Mail-Adresse<input name="email" type="email" required value="${escapeHtml(user.email)}" /></label></div><div class="profile-section"><p>FAMILIENRAUM</p><label>Name eurer Familie<input name="familyName" required maxlength="35" value="${escapeHtml(user.familyName)}" /></label><span class="profile-help">Alle Einladungen und Einträge bleiben in diesem Familienraum.</span></div><div class="profile-section"><p>PASSWORT ÄNDERN</p><label>Neues Passwort <small>optional · mindestens 6 Zeichen</small><input name="newPassword" type="password" minlength="6" placeholder="Nur ausfüllen, wenn du es ändern willst" autocomplete="new-password" /></label></div><div class="profile-save"><span>Änderungen werden direkt gespeichert.</span><button>Profil speichern <b>→</b></button></div></form></div>`;
  const receivedInvitations = store.receivedInvitations || [];
  if (receivedInvitations.length) {
    const section = document.createElement("section");
    section.className = "profile-section invitation-section";
    section.innerHTML = `<p>OFFENE EINLADUNGEN</p>${receivedInvitations.map(invitation => `<div class="received-invite"><div><strong>Einladung in einen Familienraum</strong><small>${escapeHtml(invitation.message || "Du wurdest zu einem Familienkalender eingeladen.")}</small></div><button data-accept-invite="${invitation.id}">Beitreten</button></div>`).join("")}`;
    $("#profileForm").insertBefore(section, $("#profileForm").firstChild);
    document.querySelectorAll("[data-accept-invite]").forEach(button => button.addEventListener("click", async () => {
      const { data: familyId, error } = await supabaseClient.rpc("accept_family_invitation", { invitation_id: button.dataset.acceptInvite });
      if (error) { showToast("Einladung konnte nicht angenommen werden"); return; }
      localStorage.setItem("familio.active-family", familyId);
      await loadWorkspace(); renderAll(); showView("kalender"); showToast("Du bist dem Familienraum beigetreten");
    }));
  }
  $("#avatarInput").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 50 * 1024 * 1024) { showToast("Bitte wähle ein Bild bis 50 MB"); return; }
    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `${user.familyId}/avatars/${user.id}-${Date.now()}-${filename}`;
    const { error: uploadError } = await supabaseClient.storage.from("family-files").upload(path, file, { upsert: false, contentType: file.type });
    if (uploadError) { showToast("Profilbild konnte nicht hochgeladen werden"); return; }
    const { error: updateError } = await supabaseClient.from("profiles").update({ avatar_path: path }).eq("id", user.id);
    if (updateError) { showToast("Profilbild konnte nicht gespeichert werden"); return; }
    if (user.avatarPath) await supabaseClient.storage.from("family-files").remove([user.avatarPath]);
    user.avatarPath = path; user.avatar = await fileUrl({ storagePath: path });
    renderAccount(); renderProfileModule(); showToast("Profilbild gespeichert");
  });
  $("#profileForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = data.get("email").trim().toLowerCase();
    const displayName = data.get("username").trim();
    const familyName = data.get("familyName").trim();
    if (email !== user.email) {
      const { error } = await supabaseClient.auth.updateUser({ email });
      if (error) { showToast("E-Mail konnte nicht geändert werden"); return; }
    }
    if (data.get("newPassword")) {
      const { error } = await supabaseClient.auth.updateUser({ password: data.get("newPassword") });
      if (error) { showToast("Passwort konnte nicht geändert werden"); return; }
    }
    const [profileUpdate, familyUpdate] = await Promise.all([
      supabaseClient.from("profiles").update({ display_name: displayName, email }).eq("id", user.id),
      supabaseClient.from("families").update({ name: familyName }).eq("id", user.familyId)
    ]);
    if (profileUpdate.error || familyUpdate.error) { showToast("Änderungen konnten nicht gespeichert werden"); return; }
    await loadWorkspace(); renderAll(); renderProfileModule();
    showToast(email !== user.email ? "Profil aktualisiert – prüfe deine E-Mails" : "Profil aktualisiert");
  });
  $("#logoutButton").addEventListener("click", async () => { await supabaseClient.auth.signOut(); store = emptyStore(); showAuth(); });
}

function renderTaskModule() {
  const tasks = familyTasks().sort((a,b) => Number(a.done) - Number(b.done));
  $("#moduleView").innerHTML = `<div class="module-head"><div><p>FÜR EUREN ALLTAG</p><h2>Gemeinsame Aufgaben</h2><span>Alles, was noch erledigt werden will – für alle sichtbar.</span></div></div><form class="quick-add" id="taskForm"><input required name="task" placeholder="Neue Aufgabe hinzufügen …" maxlength="100"/><button>Aufgabe anlegen <span>+</span></button></form><div class="task-list">${tasks.length ? tasks.map(task => `<article class="task-item ${task.done ? "done" : ""}"><label><input type="checkbox" data-task-id="${task.id}" ${task.done ? "checked" : ""}/><span class="checkmark">✓</span><div><strong>${escapeHtml(task.title)}</strong><small>${task.done ? "Erledigt" : "Offen für eure Familie"}</small></div></label><button class="delete-lite" data-delete-task="${task.id}" aria-label="Aufgabe löschen">×</button></article>`).join("") : `<div class="empty-module"><span>✓</span><h3>Alles wunderbar leer.</h3><p>Legt eure erste gemeinsame Aufgabe an.</p></div>`}</div>`;
  $("#taskForm").addEventListener("submit", async event => { event.preventDefault(); const title = new FormData(event.currentTarget).get("task").trim(); if (!title) return; const user = currentUser(); const { data, error } = await supabaseClient.from("tasks").insert({ family_id: user.familyId, created_by: user.id, title }).select().single(); if (error) { showToast("Aufgabe konnte nicht angelegt werden"); return; } store.tasks.unshift(mapTask(data)); renderTasks(); renderTaskModule(); showToast("Aufgabe angelegt"); });
  document.querySelectorAll("[data-task-id]").forEach(input => input.addEventListener("change", async () => { const task = store.tasks.find(item => item.id === input.dataset.taskId); const { error } = await supabaseClient.from("tasks").update({ done: input.checked, completed_at: input.checked ? new Date().toISOString() : null }).eq("id", task.id); if (error) { input.checked = !input.checked; showToast("Aufgabe konnte nicht gespeichert werden"); return; } task.done = input.checked; renderTasks(); renderTaskModule(); }));
  document.querySelectorAll("[data-delete-task]").forEach(button => button.addEventListener("click", async () => { const { error } = await supabaseClient.from("tasks").delete().eq("id", button.dataset.deleteTask); if (error) { showToast("Aufgabe konnte nicht gelöscht werden"); return; } store.tasks = store.tasks.filter(task => task.id !== button.dataset.deleteTask); renderTasks(); renderTaskModule(); showToast("Aufgabe gelöscht"); }));
}

async function renderMomentsModule() {
  const images = familyFiles().filter(isImage).sort((a,b) => b.createdAt - a.createdAt);
  const cards = await Promise.all(images.map(async file => { const url = await fileUrl(file); return url ? `<article class="moment-card" data-file-id="${file.id}"><img src="${url}" alt="${escapeHtml(file.name)}"/><div><strong>${escapeHtml(file.name.replace(/\.[^.]+$/, ""))}</strong><small>${formatDate(new Date(file.createdAt).toISOString().slice(0,10))}</small></div></article>` : ""; }));
  $("#moduleView").innerHTML = `<div class="module-head split"><div><p>EURE ERINNERUNGEN</p><h2>Momente</h2><span>Fotos von allem, was euch wichtig ist.</span></div><label class="module-upload">Foto hochladen<input id="momentUpload" type="file" accept="image/*" multiple /></label></div>${images.length ? `<div class="moment-grid">${cards.join("")}</div>` : `<div class="empty-module visual-empty"><span>✦</span><h3>Hier sammeln sich eure Lieblingsmomente.</h3><p>Lade euer erstes Foto hoch – schön groß, bunt und für alle da.</p><label class="soft-upload">Erstes Foto auswählen<input id="emptyMomentUpload" type="file" accept="image/*" multiple /></label></div>`}`;
  $("#momentUpload")?.addEventListener("change", event => addFiles(event.target.files));
  $("#emptyMomentUpload")?.addEventListener("change", event => addFiles(event.target.files));
  document.querySelectorAll("[data-file-id]").forEach(card => card.addEventListener("click", () => openFileViewer(card.dataset.fileId)));
}

async function fileTile(file) {
  const url = isImage(file) ? await fileUrl(file) : null;
  return `<button class="file-tile" data-file-id="${file.id}">${url ? `<img src="${url}" alt="" />` : `<span class="file-type">${fileGlyph(file)}</span>`}<span><strong>${escapeHtml(file.name)}</strong><small>${formatSize(file.size)}</small></span></button>`;
}
async function renderFilesModule() {
  const files = familyFiles().sort((a,b) => b.createdAt - a.createdAt);
  const tiles = await Promise.all(files.map(fileTile));
  const storageInfo = "Privater Familien-Speicher in Supabase · bis zu 50 MB pro Datei";
  $("#moduleView").innerHTML = `<div class="module-head split"><div><p>ALLES AN EINEM ORT</p><h2>Dateien &amp; Fotos</h2><span>Dokumente, Bilder und wichtige Anhänge für eure Familie.</span></div><label class="module-upload">Dateien hochladen<input id="libraryUpload" type="file" multiple /></label></div><div class="storage-note"><span>⌁</span><p><strong>${files.length} Datei${files.length === 1 ? "" : "en"} in eurem Raum</strong><small>${storageInfo}</small></p></div>${files.length ? `<div class="file-library">${tiles.join("")}</div>` : `<div class="empty-module"><span>⌁</span><h3>Alles Wichtige an einem Ort.</h3><p>Große Bilder, Dokumente und Anhänge kannst du jetzt direkt ablegen.</p><label class="soft-upload">Datei auswählen<input id="emptyLibraryUpload" type="file" multiple /></label></div>`}`;
  $("#libraryUpload")?.addEventListener("change", event => addFiles(event.target.files));
  $("#emptyLibraryUpload")?.addEventListener("change", event => addFiles(event.target.files));
  wireFileTiles();
}
function wireFileTiles() { document.querySelectorAll("[data-file-id]").forEach(element => element.addEventListener("click", () => openFileViewer(element.dataset.fileId))); }

async function openFileViewer(fileId) {
  const file = familyFiles().find(item => item.id === fileId);
  if (!file) return;
  const url = await fileUrl(file);
  $("#moduleView").innerHTML = `<div class="detail-view"><button class="back-button" id="backToFiles">← Zurück zu Dateien</button><div class="file-viewer">${isImage(file) && url ? `<img src="${url}" alt="${escapeHtml(file.name)}"/>` : `<span class="viewer-file-icon">${fileGlyph(file)}</span>`}<div><p>DATEI</p><h2>${escapeHtml(file.name)}</h2><span>${formatSize(file.size)} · ${file.type || "Datei"}</span><div class="viewer-actions">${url ? `<a download="${escapeHtml(file.name)}" href="${url}">Herunterladen</a>` : ""}<button id="deleteFile" class="delete-file">Datei entfernen</button></div></div></div></div>`;
  showView("detail");
  $("#backToFiles").addEventListener("click", () => showView("dateien"));
  $("#deleteFile")?.addEventListener("click", async () => { const [storageResult, metadataResult] = await Promise.all([supabaseClient.storage.from("family-files").remove([file.storagePath]), supabaseClient.from("files").delete().eq("id", file.id)]); if (storageResult.error || metadataResult.error) { showToast("Datei konnte nicht entfernt werden"); return; } store.files = store.files.filter(item => item.id !== file.id); renderFilesModule(); showToast("Datei entfernt"); });
}

function fileAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
async function addFiles(files, eventId = null) {
  if (!files?.length) return;
  const allowed = [...files].slice(0, 25);
  const user = currentUser();
  let stored = 0;
  for (const file of allowed) {
    if (file.size > 50 * 1024 * 1024) { showToast(`${file.name} ist zu groß (max. 50 MB)`); continue; }
    try {
      const storageId = uid("file");
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const storagePath = `${user.familyId}/${storageId}-${safeName}`;
      const { error: uploadError } = await supabaseClient.storage.from("family-files").upload(storagePath, file, { contentType: file.type || "application/octet-stream" });
      if (uploadError) throw uploadError;
      const { data, error: metadataError } = await supabaseClient.from("files").insert({ family_id: user.familyId, event_id: eventId, uploaded_by: user.id, storage_path: storagePath, name: file.name, content_type: file.type || "application/octet-stream", byte_size: file.size }).select().single();
      if (metadataError) { await supabaseClient.storage.from("family-files").remove([storagePath]); throw metadataError; }
      store.files.unshift(mapFile(data));
      stored++;
    } catch { showToast("Eine Datei konnte nicht gespeichert werden"); }
  }
  if (stored) { renderAll(); if (currentView === "momente") renderMomentsModule(); if (currentView === "dateien") renderFilesModule(); showToast(`${stored} Datei${stored > 1 ? "en" : ""} hinzugefügt`); }
}

function configureAuth(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.querySelectorAll("[data-auth-mode]").forEach(button => button.classList.toggle("active", button.dataset.authMode === mode));
  $("#usernameField").classList.toggle("hidden", !signup);
  $("#familyField").classList.toggle("hidden", !signup);
  $("#usernameField input").required = signup;
  $("#familyField input").required = signup;
  $("#authEyebrow").textContent = signup ? "DEIN ZUHAUSE FÜR ALLES, WAS ZÄHLT" : "WILLKOMMEN ZURÜCK";
  $("#authTitle").textContent = signup ? "Schön, dass du da bist." : "Dein Familienraum wartet.";
  $("#authSubcopy").textContent = signup ? "Erstelle deinen persönlichen Familienraum in weniger als einer Minute." : "Melde dich an und mach dort weiter, wo ihr aufgehört habt.";
  $("#authSubmitText").textContent = signup ? "Familienraum starten" : "Jetzt anmelden";
  $("#authForm [name=password]").autocomplete = signup ? "new-password" : "current-password";
}
function showAuth() { $("#authGate").classList.remove("hidden"); configureAuth("login"); }
function hideAuth() { $("#authGate").classList.add("hidden"); renderAll(); }

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const email = data.get("email").trim().toLowerCase();
  const password = data.get("password");
  if (authMode === "signup") {
    const { data: signUpData, error } = await supabaseClient.auth.signUp({ email, password, options: { data: { display_name: data.get("username").trim(), family_name: data.get("familyName").trim() } } });
    if (error) { showToast(error.message); return; }
    if (!signUpData.session) { showToast("Prüfe deine E-Mails und bestätige dein Konto"); configureAuth("login"); return; }
    const loaded = await loadWorkspace();
    if (loaded) { hideAuth(); showToast("Dein Familienraum ist bereit"); }
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) { showToast("E-Mail oder Passwort stimmen nicht"); return; }
    const loaded = await loadWorkspace();
    if (loaded) { hideAuth(); showToast(`Willkommen zurück, ${currentUser().username.split(" ")[0]}`); }
  }
});

$("#newEventButton").addEventListener("click", () => openEventModal());
function shiftCalendar(direction) {
  if (calendarMode === "month") shownDate.setMonth(shownDate.getMonth() + direction);
  if (calendarMode === "week") shownDate.setDate(shownDate.getDate() + direction * 7);
  if (calendarMode === "day") shownDate.setDate(shownDate.getDate() + direction);
  renderCalendar();
}
$("#prevMonth").addEventListener("click", () => shiftCalendar(-1));
$("#nextMonth").addEventListener("click", () => shiftCalendar(1));
$("#todayButton").addEventListener("click", () => { shownDate = new Date(2026, 6, 23); renderCalendar(); showToast("Zurück zu heute"); });
$("#showDayButton").addEventListener("click", () => { calendarMode = "day"; shownDate = new Date(2026, 6, 23); renderCalendar(); });
$("#notificationButton").addEventListener("click", () => showToast("Erinnerungen werden direkt bei deinen Terminen verwaltet"));
$("#familySwitcher").addEventListener("click", () => showToast("Du bist in deinem Familienraum"));
$(".add-calendar").addEventListener("click", () => showToast("Dein Familienraum ist dein gemeinsamer Kalender"));
$("#profileButton").addEventListener("click", () => showView("profil"));
$("#inviteButton").addEventListener("click", () => openModal("inviteModal"));
$("#inviteInline").addEventListener("click", () => openModal("inviteModal"));
const sidebar = $(".sidebar");
const mobileMenu = $("#mobileMenu");
const sidebarScrim = $("#sidebarScrim");
mobileMenu.setAttribute("aria-controls", "sidebar");
mobileMenu.setAttribute("aria-expanded", "false");
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarScrim.classList.remove("visible");
  mobileMenu.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sidebar-open");
}
function toggleSidebar() {
  const isOpen = sidebar.classList.toggle("open");
  sidebarScrim.classList.toggle("visible", isOpen);
  mobileMenu.setAttribute("aria-expanded", String(isOpen));
  document.body.classList.toggle("sidebar-open", isOpen);
}
mobileMenu.addEventListener("click", toggleSidebar);
$("#sidebarClose").addEventListener("click", closeSidebar);
sidebarScrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", event => { if (event.key === "Escape") closeSidebar(); });
window.addEventListener("resize", () => { if (window.innerWidth > 860) closeSidebar(); });

document.querySelectorAll("[data-calendar]").forEach(input => input.addEventListener("change", renderCalendar));
document.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => { calendarMode = button.dataset.calendarView; renderCalendar(); }));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => closeModal(button.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(backdrop => backdrop.addEventListener("click", event => { if (event.target === backdrop) closeModal(backdrop.id); }));
document.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelectorAll(".modal-backdrop.open").forEach(modal => closeModal(modal.id)); });
$("#eventAttachment").addEventListener("change", event => { const count = event.target.files.length; $("#attachmentName").textContent = count ? `${count} Datei${count > 1 ? "en" : ""} ausgewählt` : "Bis zu 8 Dateien · für alle sichtbar"; });

$("#eventForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const user = currentUser();
  const reminder = form.get("reminder") === "none" ? null : Number(form.get("reminder"));
  const { data, error } = await supabaseClient.from("events").insert({ family_id: user.familyId, created_by: user.id, title: form.get("title").trim(), event_date: form.get("date"), event_time: form.get("time") || null, calendar: form.get("calendar"), reminder_minutes: reminder, attendees: form.get("attendees"), note: form.get("note").trim() || null }).select().single();
  if (error) { showToast("Termin konnte nicht gespeichert werden"); return; }
  const newEvent = mapEvent(data);
  store.events.push(newEvent);
  await addFiles($("#eventAttachment").files, newEvent.id);
  event.currentTarget.reset(); $("#attachmentName").textContent = "Bis zu 8 Dateien · für alle sichtbar";
  closeModal("eventModal"); renderAll(); showView("kalender"); showToast("Termin gespeichert");
});
$("#inviteForm").addEventListener("submit", async event => { event.preventDefault(); const data = new FormData(event.currentTarget); const user = currentUser(); const { data: invitation, error } = await supabaseClient.rpc("create_family_invitation", { target_family_id: user.familyId, invitee_email: data.get("email").trim().toLowerCase(), invite_message: data.get("message").trim() || null }); if (error) { showToast("Einladung konnte nicht erstellt werden"); return; } store.invitations.unshift(mapInvitation(invitation)); closeModal("inviteModal"); event.currentTarget.reset(); renderAccount(); showToast("Einladung im Familienraum gespeichert"); });
document.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => configureAuth(button.dataset.authMode)));
document.querySelectorAll("[data-view]").forEach(link => link.addEventListener("click", event => { if (!link.classList.contains("nav-item")) return; event.preventDefault(); showView(link.dataset.view); closeSidebar(); }));
$(".arrow-button").addEventListener("click", () => showView("aufgaben"));

async function initializeApp() {
  const loaded = await loadWorkspace();
  if (loaded) hideAuth(); else showAuth();
}
initializeApp();
