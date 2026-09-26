const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("joyboard_token");
let me = null;
let activeUser = null;
let socket = null;
let typingTimer = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function initials(name) {
  return (name || "J").trim().charAt(0).toUpperCase();
}

function timeText(date) {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function showAuth(mode = "login") {
  $("authScreen").classList.remove("hidden");
  $("chatApp").classList.add("hidden");
  const register = mode === "register";
  $("loginTab").classList.toggle("active", !register);
  $("registerTab").classList.toggle("active", register);
  $("nameGroup").classList.toggle("hidden", !register);
  $("name").required = register;
  $("authButton").textContent = register ? "Create account" : "Login";
  $("authMessage").textContent = "";
}

function showChatApp() {
  $("authScreen").classList.add("hidden");
  $("chatApp").classList.remove("hidden");
  $("myName").textContent = me.name;
  $("myAvatar").textContent = initials(me.name);
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function boot() {
  if (!token) return showAuth();
  try {
    const data = await api("/api/me");
    me = data.user;
    showChatApp();
    connectSocket();
    loadConversations();
  } catch {
    localStorage.removeItem("joyboard_token");
    token = null;
    showAuth();
  }
}

$("loginTab").onclick = () => showAuth("login");
$("registerTab").onclick = () => showAuth("register");

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const register = !$("nameGroup").classList.contains("hidden");
  $("authMessage").textContent = "Please wait…";

  try {
    const data = await api(register ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({
        name: $("name").value,
        email: $("email").value,
        password: $("password").value
      })
    });

    token = data.token;
    localStorage.setItem("joyboard_token", token);
    me = data.user;
    $("authForm").reset();
    showChatApp();
    connectSocket();
    loadConversations();
  } catch (error) {
    $("authMessage").textContent = error.message;
  }
});

function connectSocket() {
  if (socket) socket.disconnect();

  socket = io({
    auth: { token }
  });

  socket.on("presence", ({ userId, online }) => {
    if (activeUser && Number(activeUser.id) === Number(userId)) {
      setStatus(online);
    }
    loadConversations();
  });

  socket.on("typing", ({ from, typing }) => {
    if (activeUser && Number(activeUser.id) === Number(from)) {
      $("typingIndicator").classList.toggle("hidden", !typing);
    }
  });

  socket.on("message:new", (message) => {
    if (activeUser && Number(message.sender_id) === Number(activeUser.id)) {
      addMessage(message);
      api(`/api/messages/${activeUser.id}/read`, { method: "PATCH" }).catch(() => {});
    }
    loadConversations();
  });

  socket.on("message:sent", (message) => {
    if (activeUser && Number(message.receiver_id) === Number(activeUser.id)) {
      if (![...$("messages").querySelectorAll("[data-id]")].some(el => el.dataset.id == message.id)) {
        addMessage(message);
      }
    }
    loadConversations();
  });

  socket.on("messages:read", ({ by }) => {
    if (activeUser && Number(activeUser.id) === Number(by)) {
      [...$("messages").querySelectorAll(".mine .message-meta")].forEach(el => {
        el.textContent = `${el.dataset.time || ""}  ✓✓`;
      });
    }
  });
}

async function loadConversations() {
  try {
    const data = await api("/api/conversations");
    renderUsers(data.conversations, true);
  } catch {}
}

async function searchUsers(query = "") {
  try {
    const data = await api(`/api/users?q=${encodeURIComponent(query)}`);
    renderUsers(data.users, false);
  } catch {}
}

function renderUsers(users, conversationsMode) {
  $("userList").innerHTML = "";
  if (!users.length) {
    $("userList").innerHTML = `<div style="padding:25px;color:#71807a;text-align:center">No people found.</div>`;
    return;
  }

  users.forEach((user) => {
    const button = document.createElement("button");
    button.className = "user-item";
    button.innerHTML = `
      <div class="avatar">${escapeHtml(initials(user.name))}</div>
      <div class="user-item-info">
        <strong>${escapeHtml(user.name)}</strong>
        <small>${conversationsMode ? escapeHtml(user.last_message || "Start a conversation") : escapeHtml(user.email)}</small>
      </div>
      ${conversationsMode && Number(user.unread_count) > 0 ? `<span class="unread">${user.unread_count}</span>` : ""}
    `;
    button.onclick = () => openChat(user);
    $("userList").appendChild(button);
  });
}

$("searchInput").addEventListener("input", () => {
  const query = $("searchInput").value.trim();
  if (query) searchUsers(query);
  else loadConversations();
});

async function openChat(user) {
  activeUser = user;
  $("emptyChat").classList.add("hidden");
  $("conversation").classList.remove("hidden");
  $("chatApp").classList.add("show-chat");
  $("chatName").textContent = user.name;
  $("chatAvatar").textContent = initials(user.name);
  $("typingIndicator").classList.add("hidden");
  setStatus(false);

  try {
    const data = await api(`/api/messages/${user.id}`);
    $("messages").innerHTML = "";
    data.messages.forEach(addMessage);
    scrollMessages();
    await api(`/api/messages/${user.id}/read`, { method: "PATCH" });
    loadConversations();
  } catch (error) {
    $("messages").innerHTML = `<div style="padding:20px">${escapeHtml(error.message)}</div>`;
  }
}

function setStatus(online) {
  $("chatStatus").textContent = online ? "online" : "offline";
}

function addMessage(message) {
  if ($("messages").querySelector(`[data-id="${message.id}"]`)) return;

  const mine = Number(message.sender_id) === Number(me.id);
  const item = document.createElement("div");
  item.className = `message ${mine ? "mine" : ""}`;
  item.dataset.id = message.id;

  const meta = `${timeText(message.created_at)}${mine ? (message.is_read ? "  ✓✓" : "  ✓") : ""}`;

  item.innerHTML = `
    <div class="message-body">${escapeHtml(message.body)}</div>
    <div class="message-meta" data-time="${escapeHtml(timeText(message.created_at))}">${meta}</div>
  `;

  $("messages").appendChild(item);
  scrollMessages();
}

function scrollMessages() {
  $("messages").scrollTop = $("messages").scrollHeight;
}

$("messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("messageInput").value.trim();
  if (!body || !activeUser) return;

  $("messageInput").value = "";

  try {
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ receiverId: activeUser.id, body })
    });
  } catch (error) {
    alert(error.message);
  }
});

$("messageInput").addEventListener("input", () => {
  if (!activeUser || !socket) return;

  socket.emit("typing", { to: activeUser.id, typing: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit("typing", { to: activeUser.id, typing: false });
  }, 700);
});

$("backButton").onclick = () => {
  $("chatApp").classList.remove("show-chat");
  activeUser = null;
};

$("logoutButton").onclick = () => {
  if (socket) socket.disconnect();
  localStorage.removeItem("joyboard_token");
  token = null;
  me = null;
  activeUser = null;
  showAuth("login");
};

boot();
