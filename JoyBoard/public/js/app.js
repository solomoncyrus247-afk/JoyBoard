const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("joyboard_token");
let me = null;
let activeUser = null;
let socket = null;
let typingTimer = null;

let currentView = "friends";

/* Keep track of online users */
const onlineUsers = new Set();

/* =========================
   HELPERS
========================= */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function initials(name) {
  return (name || "J").trim().charAt(0).toUpperCase();
}

function timeText(date) {
  return new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dateText(date) {
  if (!date) return "Unknown";

  return new Date(date).toLocaleDateString([], {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function isOnline(userId) {
  return onlineUsers.has(Number(userId));
}

/* =========================
   AVATAR
========================= */

function avatarHtml(user, className = "avatar") {
  const letter = escapeHtml(
    initials(user?.name)
  );

  if (user?.avatar_url) {
    return `
      <div class="${className}">
        <img
          src="${escapeHtml(user.avatar_url)}"
          class="profile-avatar-image"
          alt="Profile picture"
        >
      </div>
    `;
  }

  return `
    <div class="${className}">
      ${letter}
    </div>
  `;
}

function setMyAvatar() {
  if (!me) return;

  if (me.avatar_url) {
    $("myAvatar").innerHTML = `
      <img
        src="${escapeHtml(me.avatar_url)}"
        class="profile-avatar-image"
        alt="Profile picture"
      >
    `;
  } else {
    $("myAvatar").textContent =
      initials(me.name);
  }
}

/* =========================
   PROFILE MODAL
========================= */

function createProfileModal() {
  if ($("profileModal")) {
    return;
  }

  const modal =
    document.createElement("div");

  modal.id = "profileModal";

  modal.innerHTML = `
    <div class="profile-modal-overlay">

      <div class="profile-modal-card">

        <button
          type="button"
          class="profile-modal-close"
          id="profileModalClose"
        >
          ×
        </button>

        <div class="profile-modal-cover"></div>

        <div class="profile-modal-photo" id="profileModalPhoto">
          J
        </div>

        <div class="profile-modal-content">

          <h2 id="profileModalName">
            User
          </h2>

          <div
            class="profile-online-status"
            id="profileModalStatus"
          >
            Offline
          </div>

          <p
            class="profile-modal-email"
            id="profileModalEmail"
          >
            email@example.com
          </p>

          <div class="profile-information">

            <div class="profile-info-box">
              <strong id="profileModalFriends">
                0
              </strong>

              <span>
                Friends
              </span>
            </div>

            <div class="profile-info-box">
              <strong id="profileModalJoined">
                -
              </strong>

              <span>
                Joined
              </span>
            </div>

          </div>

          <div
            class="profile-modal-actions"
            id="profileModalActions"
          ></div>

        </div>

      </div>

    </div>
  `;

  document.body.appendChild(modal);

  $("profileModalClose").onclick =
    closeProfileModal;

  const overlay =
    modal.querySelector(
      ".profile-modal-overlay"
    );

  overlay.onclick = (event) => {
    if (event.target === overlay) {
      closeProfileModal();
    }
  };
}

function closeProfileModal() {
  const modal =
    $("profileModal");

  if (modal) {
    modal.classList.remove("show");
  }
}

function showProfileModal(user) {
  createProfileModal();

  $("profileModalName").textContent =
    user.name;

  $("profileModalEmail").textContent =
    user.email || "";

  $("profileModalFriends").textContent =
    Number(user.friends_count || 0);

  $("profileModalJoined").textContent =
    dateText(user.created_at);

  const online =
    typeof user.online === "boolean"
      ? user.online
      : isOnline(user.id);

  $("profileModalStatus").innerHTML =
    online
      ? `<span class="profile-online-dot"></span> Online`
      : `<span class="profile-offline-dot"></span> Offline`;

  const photo =
    $("profileModalPhoto");

  if (user.avatar_url) {
    photo.innerHTML = `
      <img
        src="${escapeHtml(user.avatar_url)}"
        alt="Profile picture"
      >
    `;
  } else {
    photo.textContent =
      initials(user.name);
  }

  const actions =
    $("profileModalActions");

  actions.innerHTML = "";

  if (
    me &&
    Number(user.id) === Number(me.id)
  ) {

    const editButton =
      document.createElement("button");

    editButton.className =
      "profile-main-button";

    editButton.textContent =
      "Edit Profile";

    editButton.onclick = () => {
      closeProfileModal();

      $("editProfileButton").click();
    };

    actions.appendChild(
      editButton
    );

  } else {

    const status =
      user.friendship_status || "none";

    if (status === "friend") {

      const messageButton =
        document.createElement("button");

      messageButton.className =
        "profile-main-button";

      messageButton.textContent =
        "Message";

      messageButton.onclick = () => {
        closeProfileModal();
        openChat(user);
      };

      actions.appendChild(
        messageButton
      );

      const removeButton =
        document.createElement("button");

      removeButton.className =
        "profile-remove-button";

      removeButton.textContent =
        "Remove Friend";

      removeButton.onclick = async () => {

        const confirmed =
          window.confirm(
            `Remove ${user.name} from your friends?`
          );

        if (!confirmed) {
          return;
        }

        try {

          await api(
            `/api/friends/${user.id}`,
            {
              method: "DELETE"
            }
          );

          closeProfileModal();

          await loadFriends();

          if (currentView === "people") {
            await loadPeople(
              $("searchInput").value.trim()
            );
          }

        } catch (error) {

          alert(error.message);
        }
      };

      actions.appendChild(
        removeButton
      );

    } else if (
      status === "request_sent"
    ) {

      const cancelButton =
        document.createElement("button");

      cancelButton.className =
        "profile-secondary-button";

      cancelButton.textContent =
        "Cancel Request";

      cancelButton.onclick = async () => {

        try {

          await api(
            `/api/friends/request/${user.id}`,
            {
              method: "DELETE"
            }
          );

          closeProfileModal();

          await loadPeople(
            $("searchInput").value.trim()
          );

        } catch (error) {

          alert(error.message);
        }
      };

      actions.appendChild(
        cancelButton
      );

    } else if (
      status === "request_received"
    ) {

      const requestsButton =
        document.createElement("button");

      requestsButton.className =
        "profile-main-button";

      requestsButton.textContent =
        "View Friend Request";

      requestsButton.onclick = () => {

        closeProfileModal();

        currentView =
          "requests";

        setActiveMenu(
          "requestsButton"
        );

        $("searchInput").value = "";

        loadFriendRequests();
      };

      actions.appendChild(
        requestsButton
      );

    } else {

      const addButton =
        document.createElement("button");

      addButton.className =
        "profile-main-button";

      addButton.textContent =
        "+ Add Friend";

      addButton.onclick = async () => {

        addButton.disabled = true;

        addButton.textContent =
          "Sending...";

        try {

          await api(
            `/api/friends/request/${user.id}`,
            {
              method: "POST"
            }
          );

          user.friendship_status =
            "request_sent";

          addButton.textContent =
            "Request Sent";

          addButton.className =
            "profile-secondary-button";

        } catch (error) {

          addButton.disabled = false;

          addButton.textContent =
            "+ Add Friend";

          alert(error.message);
        }
      };

      actions.appendChild(
        addButton
      );
    }
  }

  $("profileModal").classList.add(
    "show"
  );
}

/* =========================
   AUTH
========================= */

function showAuth(mode = "login") {
  $("authScreen").classList.remove(
    "hidden"
  );

  $("chatApp").classList.add(
    "hidden"
  );

  const register =
    mode === "register";

  $("loginTab").classList.toggle(
    "active",
    !register
  );

  $("registerTab").classList.toggle(
    "active",
    register
  );

  $("nameGroup").classList.toggle(
    "hidden",
    !register
  );

  $("name").required =
    register;

  $("authButton").textContent =
    register
      ? "Create account"
      : "Login";

  $("authMessage").textContent =
    "";
}

function showChatApp() {
  $("authScreen").classList.add(
    "hidden"
  );

  $("chatApp").classList.remove(
    "hidden"
  );

  $("myName").textContent =
    me.name;

  setMyAvatar();
}

/* =========================
   API
========================= */

async function api(
  url,
  options = {}
) {
  const headers = {
    "Content-Type":
      "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization =
      `Bearer ${token}`;
  }

  const response =
    await fetch(url, {
      ...options,
      headers
    });

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Something went wrong."
    );
  }

  return data;
}

/* =========================
   START APP
========================= */

async function boot() {
  createProfileModal();

  if (!token) {
    return showAuth();
  }

  try {

    const data =
      await api("/api/me");

    me = data.user;

    showChatApp();

    connectSocket();

    await loadFriends();

    await loadFriendRequests();

  } catch (error) {

    localStorage.removeItem(
      "joyboard_token"
    );

    token = null;

    showAuth();
  }
}

/* =========================
   AUTH TABS
========================= */

$("loginTab").onclick = () => {
  showAuth("login");
};

$("registerTab").onclick = () => {
  showAuth("register");
};

/* =========================
   LOGIN / REGISTER
========================= */

$("authForm").addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    const register =
      !$("nameGroup")
        .classList
        .contains("hidden");

    $("authMessage").textContent =
      "Please wait...";

    try {

      const data =
        await api(
          register
            ? "/api/register"
            : "/api/login",
          {
            method: "POST",

            body: JSON.stringify({
              name:
                $("name").value,
              email:
                $("email").value,
              password:
                $("password").value
            })
          }
        );

      token = data.token;

      localStorage.setItem(
        "joyboard_token",
        token
      );

      me = data.user;

      $("authForm").reset();

      showChatApp();

      connectSocket();

      await loadFriends();

      await loadFriendRequests();

    } catch (error) {

      $("authMessage").textContent =
        error.message;
    }
  }
);

/* =========================
   SOCKET
========================= */

function connectSocket() {

  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: {
      token
    }
  });

  /* CONNECT */

  socket.on("connect", () => {

    if (me) {
      onlineUsers.add(
        Number(me.id)
      );
    }

    updateCurrentProfileStatus();
  });

  /* PRESENCE */

  socket.on(
    "presence",
    ({ userId, online }) => {

      const id =
        Number(userId);

      if (online) {
        onlineUsers.add(id);
      } else {
        onlineUsers.delete(id);
      }

      if (
        activeUser &&
        Number(activeUser.id) === id
      ) {

        activeUser.online =
          online;

        setStatus(online);
      }

      updateCurrentProfileStatus();

      if (
        currentView === "friends" ||
        currentView === "chats"
      ) {
        loadFriends();
      }

      if (
        currentView === "people"
      ) {
        loadPeople(
          $("searchInput")
            .value
            .trim()
        );
      }
    }
  );

  /* TYPING */

  socket.on(
    "typing",
    ({ from, typing }) => {

      if (
        activeUser &&
        Number(activeUser.id) ===
        Number(from)
      ) {

        $("typingIndicator")
          .classList
          .toggle(
            "hidden",
            !typing
          );
      }
    }
  );

  /* NEW MESSAGE */

  socket.on(
    "message:new",
    (message) => {

      if (
        activeUser &&
        Number(message.sender_id) ===
        Number(activeUser.id)
      ) {

        addMessage(message);

        api(
          `/api/messages/${activeUser.id}/read`,
          {
            method: "PATCH"
          }
        ).catch(() => {});
      }

      loadFriends();
    }
  );

  /* SENT MESSAGE */

  socket.on(
    "message:sent",
    (message) => {

      if (
        activeUser &&
        Number(message.receiver_id) ===
        Number(activeUser.id)
      ) {

        addMessage(message);
      }

      loadFriends();
    }
  );

  /* READ */

  socket.on(
    "messages:read",
    ({ by }) => {

      if (
        activeUser &&
        Number(activeUser.id) ===
        Number(by)
      ) {

        [
          ...$("messages")
            .querySelectorAll(
              ".mine .message-meta"
            )
        ].forEach((el) => {

          el.textContent =
            `${el.dataset.time || ""}  ✓✓`;
        });
      }
    }
  );

  /* FRIEND REQUEST */

  socket.on(
    "friend:request",
    () => {

      loadFriendRequests();

      if (
        currentView ===
        "requests"
      ) {
        loadFriendRequests();
      }

      alert(
        "You received a new friend request!"
      );
    }
  );

  /* FRIEND ACCEPTED */

  socket.on(
    "friend:accepted",
    () => {

      loadFriends();

      if (
        currentView ===
        "people"
      ) {
        loadPeople(
          $("searchInput")
            .value
            .trim()
        );
      }

      alert(
        "Your friend request was accepted!"
      );
    }
  );

  /* DISCONNECT */

  socket.on(
    "disconnect",
    () => {
      if (me) {
        onlineUsers.delete(
          Number(me.id)
        );
      }

      updateCurrentProfileStatus();
    }
  );
}

/* =========================
   UPDATE PROFILE STATUS
========================= */

function updateCurrentProfileStatus() {

  if (
    !$("profileModal") ||
    !$("profileModal").classList.contains("show") ||
    !activeProfileUser
  ) {
    return;
  }

  const online =
    isOnline(
      activeProfileUser.id
    );

  $("profileModalStatus").innerHTML =
    online
      ? `<span class="profile-online-dot"></span> Online`
      : `<span class="profile-offline-dot"></span> Offline`;
}

let activeProfileUser = null;

/* =========================================================
   VIEW MANAGEMENT
========================================================= */

function setActiveMenu(buttonId) {

  const buttons = [
    "chatsButton",
    "friendsButton",
    "peopleButton",
    "requestsButton"
  ];

  buttons.forEach((id) => {

    $(id)?.classList.remove(
      "active"
    );
  });

  $(buttonId)?.classList.add(
    "active"
  );
}

/* =========================
   CHATS
========================= */

async function loadChats() {

  currentView = "chats";

  setActiveMenu(
    "chatsButton"
  );

  $("searchInput").value = "";

  $("listTitle").textContent =
    "Recent Chats";

  try {

    const data =
      await api(
        "/api/conversations"
      );

    renderChats(
      data.conversations
    );

  } catch (error) {

    console.error(error);

    $("userList").innerHTML = `
      <div class="empty-list">
        <strong>No conversations</strong>
        <small>
          Start chatting with one of your friends.
        </small>
      </div>
    `;
  }
}

function renderChats(chats) {

  $("userList").innerHTML = "";

  if (!chats.length) {

    $("userList").innerHTML = `
      <div class="empty-list">
        <strong>No conversations yet</strong>
        <small>
          Open Friends and start a conversation.
        </small>
      </div>
    `;

    return;
  }

  chats.forEach((user) => {

    const button =
      document.createElement(
        "button"
      );

    button.className =
      "user-item";

    button.innerHTML = `
      ${avatarHtml(user)}

      <div class="user-item-info">

        <strong>
          ${escapeHtml(user.name)}
        </strong>

        <small>
          ${escapeHtml(
            user.last_message ||
            "Start a conversation"
          )}
        </small>

      </div>

      ${
        Number(user.unread_count) > 0
          ? `
            <span class="unread">
              ${user.unread_count}
            </span>
          `
          : ""
      }
    `;

    button.onclick = () =>
      openChat(user);

    $("userList")
      .appendChild(button);
  });
}

/* =========================
   FRIENDS
========================= */

async function loadFriends() {

  try {

    const data =
      await api(
        "/api/friends"
      );

    $("friendsCount")
      .textContent =
      data.friends.length;

    if (
      currentView ===
      "friends"
    ) {

      $("listTitle").textContent =
        "My Friends";

      renderFriends(
        data.friends
      );
    }

  } catch (error) {

    console.error(error);
  }
}

function renderFriends(friends) {

  $("userList").innerHTML = "";

  if (!friends.length) {

    $("userList").innerHTML = `
      <div class="empty-list">

        <strong>No friends yet</strong>

        <small>
          Visit People and connect with someone.
        </small>

      </div>
    `;

    return;
  }

  friends.forEach((user) => {

    const button =
      document.createElement(
        "button"
      );

    button.className =
      "user-item";

    const online =
      typeof user.online === "boolean"
        ? user.online
        : isOnline(user.id);

    button.innerHTML = `
      ${avatarHtml(user)}

      <div class="user-item-info">

        <strong>
          ${escapeHtml(user.name)}
        </strong>

        <small>
          ${
            online
              ? "Online"
              : "Offline"
          }
        </small>

      </div>
    `;

    button.onclick = () =>
      openChat(user);

    button.oncontextmenu =
      (event) => {

        event.preventDefault();

        openUserProfile(
          user.id
        );
      };

    $("userList")
      .appendChild(button);
  });
}

/* =========================================================
   PEOPLE
========================================================= */

async function loadPeople(query = "") {

  currentView = "people";

  setActiveMenu(
    "peopleButton"
  );

  $("listTitle").textContent =
    query
      ? "Search Results"
      : "People";

  try {

    const data =
      await api(
        `/api/users?q=${encodeURIComponent(query)}`
      );

    renderPeople(
      data.users
    );

  } catch (error) {

    console.error(error);

    $("userList").innerHTML = `
      <div class="empty-list">
        <strong>Unable to load people</strong>
        <small>
          Please try again.
        </small>
      </div>
    `;
  }
}

function renderPeople(users) {

  $("userList").innerHTML = "";

  if (!users.length) {

    $("userList").innerHTML = `
      <div class="empty-list">

        <strong>No people found</strong>

        <small>
          Try searching for another person.
        </small>

      </div>
    `;

    return;
  }

  const grid =
    document.createElement(
      "div"
    );

  grid.className =
    "people-grid";

  users.forEach((user) => {

    const card =
      document.createElement(
        "div"
      );

    card.className =
      "person-card";

    const online =
      typeof user.online === "boolean"
        ? user.online
        : isOnline(user.id);

    let action = "";

    if (
      user.friendship_status ===
      "friend"
    ) {

      action = `
        <button
          class="person-action-button friend"
          type="button"
        >
          ✓ Friends
        </button>
      `;

    } else if (
      user.friendship_status ===
      "request_sent"
    ) {

      action = `
        <button
          class="person-action-button pending"
          type="button"
        >
          Request Sent
        </button>
      `;

    } else if (
      user.friendship_status ===
      "request_received"
    ) {

      action = `
        <button
          class="person-action-button pending"
          type="button"
        >
          Check Request
        </button>
      `;

    } else {

      action = `
        <button
          class="person-action-button add"
          type="button"
        >
          + Add Friend
        </button>
      `;
    }

    card.innerHTML = `

      <div class="person-cover"></div>

      <div class="person-photo">

        ${
          user.avatar_url
            ? `
              <img
                src="${escapeHtml(
                  user.avatar_url
                )}"
                class="person-image"
                alt="Profile picture"
              >
            `
            : `
              <div class="person-image person-initial">
                ${escapeHtml(
                  initials(user.name)
                )}
              </div>
            `
        }

      </div>

      <div class="person-content">

        <h3>
          ${escapeHtml(user.name)}
        </h3>

        <p>
          ${escapeHtml(user.email)}
        </p>

        <div class="person-status">

          <span
            class="online-dot"
            style="
              background:
                ${online
                  ? "#2eae65"
                  : "#a9b3b0"};
            "
          ></span>

          ${
            online
              ? "Online"
              : "Offline"
          }

        </div>

        ${action}

      </div>
    `;

    /* Open profile by clicking the card */
    card.onclick = (event) => {

      if (
        event.target.closest(
          ".person-action-button"
        )
      ) {
        return;
      }

      openUserProfile(
        user.id
      );
    };

    /* Friend action */
    const actionButton =
      card.querySelector(
        ".person-action-button"
      );

    if (
      user.friendship_status ===
      "friend"
    ) {

      actionButton.onclick = () => {
        openUserProfile(
          user.id
        );
      };

    } else if (
      user.friendship_status ===
      "request_received"
    ) {

      actionButton.onclick = () => {

        currentView =
          "requests";

        setActiveMenu(
          "requestsButton"
        );

        $("searchInput").value =
          "";

        loadFriendRequests();
      };

    } else if (
      user.friendship_status ===
      "request_sent"
    ) {

      actionButton.onclick =
        async () => {

          try {

            await api(
              `/api/friends/request/${user.id}`,
              {
                method: "DELETE"
              }
            );

            await loadPeople(
              $("searchInput")
                .value
                .trim()
            );

          } catch (error) {

            alert(
              error.message
            );
          }
        };

    } else {

      actionButton.onclick =
        async () => {

          actionButton.disabled =
            true;

          actionButton.textContent =
            "Sending...";

          try {

            await api(
              `/api/friends/request/${user.id}`,
              {
                method: "POST"
              }
            );

            actionButton.className =
              "person-action-button pending";

            actionButton.textContent =
              "Request Sent";

            user.friendship_status =
              "request_sent";

          } catch (error) {

            actionButton.disabled =
              false;

            actionButton.textContent =
              "+ Add Friend";

            alert(
              error.message
            );
          }
        };
    }

    grid.appendChild(card);
  });

  $("userList")
    .appendChild(grid);
}

/* =========================================================
   OPEN USER PROFILE
========================================================= */

async function openUserProfile(
  userId
) {

  try {

    const data =
      await api(
        `/api/users/${userId}/profile`
      );

    activeProfileUser =
      data.user;

    showProfileModal(
      data.user
    );

  } catch (error) {

    alert(
      error.message
    );
  }
}

/* =========================
   FRIEND REQUESTS
========================= */

async function loadFriendRequests() {

  try {

    const data =
      await api(
        "/api/friends/requests"
      );

    $("requestsCount")
      .textContent =
      data.requests.length;

    if (
      currentView ===
      "requests"
    ) {

      $("listTitle").textContent =
        "Friend Requests";

      renderFriendRequests(
        data.requests
      );
    }

  } catch (error) {

    console.error(error);
  }
}

function renderFriendRequests(
  requests
) {

  $("userList").innerHTML =
    "";

  if (!requests.length) {

    $("userList").innerHTML = `
      <div class="empty-list">

        <strong>No friend requests</strong>

        <small>
          New requests will appear here.
        </small>

      </div>
    `;

    return;
  }

  requests.forEach(
    (request) => {

      const item =
        document.createElement(
          "div"
        );

      item.className =
        "friend-request-item";

      item.innerHTML = `

        ${avatarHtml({
          name:
            request.name,
          avatar_url:
            request.avatar_url
        })}

        <div
          class="friend-request-user"
        >

          <strong>
            ${escapeHtml(
              request.name
            )}
          </strong>

          <small>
            Wants to be your friend
          </small>

        </div>

        <div
          class="friend-request-actions"
        >

          <button
            class="accept-friend-button"
            type="button"
          >
            Accept
          </button>

          <button
            class="decline-friend-button"
            type="button"
          >
            Decline
          </button>

        </div>
      `;

      item.onclick =
        (event) => {

          if (
            event.target.closest(
              ".friend-request-actions"
            )
          ) {
            return;
          }

          openUserProfile(
            request.sender_id
          );
        };

      item.querySelector(
        ".accept-friend-button"
      ).onclick =
        async () => {

          try {

            await api(
              `/api/friends/accept/${request.id}`,
              {
                method: "POST"
              }
            );

            await loadFriendRequests();

            await loadFriends();

          } catch (error) {

            alert(
              error.message
            );
          }
        };

      item.querySelector(
        ".decline-friend-button"
      ).onclick =
        async () => {

          try {

            await api(
              `/api/friends/decline/${request.id}`,
              {
                method: "POST"
              }
            );

            await loadFriendRequests();

          } catch (error) {

            alert(
              error.message
            );
          }
        };

      $("userList")
        .appendChild(item);
    }
  );
}

/* =========================================================
   MENU BUTTONS
========================================================= */

$("chatsButton").onclick = () => {
  loadChats();
};

$("friendsButton").onclick = () => {

  currentView =
    "friends";

  setActiveMenu(
    "friendsButton"
  );

  $("searchInput").value =
    "";

  loadFriends();
};

$("peopleButton").onclick = () => {

  $("searchInput").value =
    "";

  loadPeople();
};

$("requestsButton").onclick = () => {

  currentView =
    "requests";

  setActiveMenu(
    "requestsButton"
  );

  $("searchInput").value =
    "";

  loadFriendRequests();
};

/* =========================================================
   SEARCH
========================================================= */

let searchTimer = null;

$("searchInput").addEventListener(
  "input",
  () => {

    const query =
      $("searchInput")
        .value
        .trim();

    currentView =
      "people";

    setActiveMenu(
      "peopleButton"
    );

    clearTimeout(
      searchTimer
    );

    searchTimer =
      setTimeout(
        () => {

          loadPeople(
            query
          );

        },
        250
      );
  }
);

/* =========================================================
   OPEN CHAT
========================================================= */

async function openChat(user) {

  activeUser =
    user;

  $("emptyChat")
    .classList
    .add("hidden");

  $("conversation")
    .classList
    .remove("hidden");

  $("chatApp")
    .classList
    .add("show-chat");

  $("chatName").textContent =
    user.name;

  if (user.avatar_url) {

    $("chatAvatar").innerHTML = `
      <img
        src="${escapeHtml(
          user.avatar_url
        )}"
        class="profile-avatar-image"
        alt="Profile picture"
      >
    `;

  } else {

    $("chatAvatar").textContent =
      initials(user.name);
  }

  $("typingIndicator")
    .classList
    .add("hidden");

  setStatus(
    typeof user.online === "boolean"
      ? user.online
      : isOnline(user.id)
  );

  try {

    const data =
      await api(
        `/api/messages/${user.id}`
      );

    $("messages").innerHTML =
      "";

    data.messages.forEach(
      addMessage
    );

    scrollMessages();

    await api(
      `/api/messages/${user.id}/read`,
      {
        method: "PATCH"
      }
    );

    loadFriends();

  } catch (error) {

    $("messages").innerHTML = `
      <div style="padding:20px">
        ${escapeHtml(
          error.message
        )}
      </div>
    `;
  }
}

/* =========================
   STATUS
========================= */

function setStatus(
  online
) {

  $("chatStatus").textContent =
    online
      ? "online"
      : "offline";
}

/* =========================
   MESSAGES
========================= */

function addMessage(
  message
) {

  if (
    $("messages")
      .querySelector(
        `[data-id="${message.id}"]`
      )
  ) {
    return;
  }

  const mine =
    Number(
      message.sender_id
    ) === Number(
      me.id
    );

  const item =
    document.createElement(
      "div"
    );

  item.className =
    `message ${
      mine
        ? "mine"
        : ""
    }`;

  item.dataset.id =
    message.id;

  const time =
    timeText(
      message.created_at
    );

  const meta =
    `${time}${
      mine
        ? message.is_read
          ? "  ✓✓"
          : "  ✓"
        : ""
    }`;

  item.innerHTML = `
    <div class="message-body">
      ${escapeHtml(
        message.body
      )}
    </div>

    <div
      class="message-meta"
      data-time="${escapeHtml(
        time
      )}"
    >
      ${meta}
    </div>
  `;

  $("messages")
    .appendChild(item);

  scrollMessages();
}

function scrollMessages() {

  $("messages").scrollTop =
    $("messages")
      .scrollHeight;
}

/* =========================
   SEND MESSAGE
========================= */

$("messageForm").addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    const body =
      $("messageInput")
        .value
        .trim();

    if (
      !body ||
      !activeUser
    ) {
      return;
    }

    $("messageInput").value =
      "";

    try {

      await api(
        "/api/messages",
        {
          method: "POST",

          body:
            JSON.stringify({
              receiverId:
                activeUser.id,
              body
            })
        }
      );

    } catch (error) {

      alert(
        error.message
      );
    }
  }
);

/* =========================
   TYPING
========================= */

$("messageInput").addEventListener(
  "input",
  () => {

    if (
      !activeUser ||
      !socket
    ) {
      return;
    }

    socket.emit(
      "typing",
      {
        to:
          activeUser.id,
        typing:
          true
      }
    );

    clearTimeout(
      typingTimer
    );

    typingTimer =
      setTimeout(
        () => {

          socket.emit(
            "typing",
            {
              to:
                activeUser.id,
              typing:
                false
            }
          );

        },
        700
      );
  }
);

/* =========================
   BACK
========================= */

$("backButton").onclick =
  () => {

    $("chatApp")
      .classList
      .remove(
        "show-chat"
      );

    activeUser =
      null;
  };

/* =========================
   PROFILE PICTURE
========================= */

$("myAvatar").onclick =
  () => {

    $("profilePictureInput")
      .click();
  };

$("profilePictureInput")
  .addEventListener(
    "change",
    async () => {

      const file =
        $("profilePictureInput")
          .files[0];

      if (!file) {
        return;
      }

      if (
        !file.type.startsWith(
          "image/"
        )
      ) {

        alert(
          "Please choose an image."
        );

        return;
      }

      if (
        file.size >
        1024 * 1024
      ) {

        alert(
          "Please choose an image smaller than 1MB."
        );

        return;
      }

      const reader =
        new FileReader();

      reader.onload =
        async () => {

          try {

            const data =
              await api(
                "/api/profile",
                {
                  method:
                    "PATCH",

                  body:
                    JSON.stringify({
                      name:
                        me.name,

                      avatar_url:
                        reader.result
                    })
                }
              );

            me =
              data.user;

            setMyAvatar();

            $("myName")
              .textContent =
              me.name;

            loadFriends();

            alert(
              "Profile picture updated!"
            );

          } catch (error) {

            alert(
              error.message
            );
          }
        };

      reader.readAsDataURL(
        file
      );

      $("profilePictureInput")
        .value = "";
    }
  );

/* =========================
   EDIT PROFILE
========================= */

$("editProfileButton").onclick =
  async () => {

    const newName =
      prompt(
        "Enter your name:",
        me.name
      );

    if (
      newName === null
    ) {
      return;
    }

    const name =
      newName.trim();

    if (
      name.length < 2
    ) {

      alert(
        "Name must be at least 2 characters."
      );

      return;
    }

    try {

      const data =
        await api(
          "/api/profile",
          {
            method:
              "PATCH",

            body:
              JSON.stringify({
                name,
                avatar_url:
                  me.avatar_url ||
                  ""
              })
          }
        );

      me =
        data.user;

      $("myName")
        .textContent =
        me.name;

      setMyAvatar();

      loadFriends();

      if (activeUser) {

        $("chatName")
          .textContent =
          activeUser.name;
      }

      alert(
        "Profile updated!"
      );

    } catch (error) {

      alert(
        error.message
      );
    }
  };

/* =========================
   MY PROFILE CLICK
========================= */

$("myName").onclick =
  () => {

    if (me) {
      activeProfileUser =
        me;

      showProfileModal(
        me
      );
    }
  };

/* =========================
   LOGOUT
========================= */

$("logoutButton").onclick =
  () => {

    if (socket) {
      socket.disconnect();
    }

    onlineUsers.clear();

    localStorage.removeItem(
      "joyboard_token"
    );

    token = null;
    me = null;
    activeUser = null;

    closeProfileModal();

    showAuth("login");
  };

/* =========================
   START
========================= */

boot();
