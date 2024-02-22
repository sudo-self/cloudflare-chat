
let currentWebSocket = null;

let nameForm = document.querySelector("#name-form");
let nameInput = document.querySelector("#name-input");
let roomForm = document.querySelector("#room-form");
let roomNameInput = document.querySelector("#room-name");
let goPublicButton = document.querySelector("#go-public");
let goPrivateButton = document.querySelector("#go-private");
let chatroom = document.querySelector("#chatroom");
let chatlog = document.querySelector("#chatlog");
let chatInput = document.querySelector("#chat-input");
let roster = document.querySelector("#roster");

// Is the chatlog scrolled to the bottom?
let isAtBottom = true;

let username;
let roomname;

let hostname = window.location.host;
if (hostname == "") {
  // Probably testing the HTML locally.
  hostname = "https://edge-chat-demo.jessejesse.workers.dev/";
}

function startNameChooser() {
  nameForm.addEventListener("submit", event => {
    event.preventDefault();
    username = nameInput.value;
    if (username.length > 0) {
      startRoomChooser();
    }
  });

  nameInput.addEventListener("input", event => {
    if (event.currentTarget.value.length > 32) {
      event.currentTarget.value = event.currentTarget.value.slice(0, 32);
    }
  });

  nameInput.focus();
}

function startRoomChooser() {
  nameForm.remove();

  if (document.location.hash.length > 1) {
    roomname = document.location.hash.slice(1);
    startChat();
    return;
  }

  roomForm.addEventListener("submit", event => {
    event.preventDefault();
    roomname = roomNameInput.value;
    if (roomname.length > 0) {
      startChat();
    }
  });

  roomNameInput.addEventListener("input", event => {
    if (event.currentTarget.value.length > 32) {
      event.currentTarget.value = event.currentTarget.value.slice(0, 32);
    }
  });

  goPublicButton.addEventListener("click", event => {
    roomname = roomNameInput.value;
    if (roomname.length > 0) {
      startChat();
    }
  });

  goPrivateButton.addEventListener("click", async event => {
    roomNameInput.disabled = true;
    goPublicButton.disabled = true;
    event.currentTarget.disabled = true;

    let response = await fetch("https://" + hostname + "/api/room", {method: "POST"});
    if (!response.ok) {
      alert("something went wrong");
      document.location.reload();
      return;
    }

    roomname = await response.text();
    startChat();
  });

  roomNameInput.focus();
}

function startChat() {
  roomForm.remove();

  // Normalize the room name a bit.
  roomname = roomname.replace(/[^a-zA-Z0-9_-]/g, "").replace(/_/g, "-").toLowerCase();

  if (roomname.length > 32 && !roomname.match(/^[0-9a-f]{64}$/)) {
    addChatMessage("ERROR", "Invalid room name.");
    return;
  }

  document.location.hash = "#" + roomname;

  chatInput.addEventListener("keydown", event => {
    if (event.keyCode == 38) {
      // up arrow
      chatlog.scrollBy(0, -50);
    } else if (event.keyCode == 40) {
      // down arrow
      chatlog.scrollBy(0, 50);
    } else if (event.keyCode == 33) {
      // page up
      chatlog.scrollBy(0, -chatlog.clientHeight + 50);
    } else if (event.keyCode == 34) {
      // page down
      chatlog.scrollBy(0, chatlog.clientHeight - 50);
    }
  });

  chatroom.addEventListener("submit", event => {
    event.preventDefault();

    if (currentWebSocket) {
      currentWebSocket.send(JSON.stringify({message: chatInput.value}));
      chatInput.value = "";

      // Scroll to bottom whenever sending a message.
      chatlog.scrollBy(0, 1e8);
    }
  });

  chatInput.addEventListener("input", event => {
    if (event.currentTarget.value.length > 256) {
      event.currentTarget.value = event.currentTarget.value.slice(0, 256);
    }
  });

  chatlog.addEventListener("scroll", event => {
    isAtBottom = chatlog.scrollTop + chatlog.clientHeight >= chatlog.scrollHeight;
  });

  chatInput.focus();
  document.body.addEventListener("click", event => {
    // If the user clicked somewhere in the window without selecting any text, focus the chat
    // input.
    if (window.getSelection().toString() == "") {
      chatInput.focus();
    }
  });

  // Detect mobile keyboard appearing and disappearing, and adjust the scroll as appropriate.
  if('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', function(event) {
      if (isAtBottom) {
        chatlog.scrollBy(0, 1e8);
      }
    });
  }

  join();
}

let lastSeenTimestamp = 0;
let wroteWelcomeMessages = false;

function join() {
  // If we are running via wrangler dev, use ws:
  const wss = document.location.protocol === "http:" ? "ws://" : "wss://";
  let ws = new WebSocket(wss + hostname + "/api/room/" + roomname + "/websocket");
  let rejoined = false;
  let startTime = Date.now();

  let rejoin = async () => {
    if (!rejoined) {
      rejoined = true;
      currentWebSocket = null;

      // Clear the roster.
      while (roster.firstChild) {
        roster.removeChild(roster.firstChild);
      }

      // Don't try to reconnect too rapidly.
      let timeSinceLastJoin = Date.now() - startTime;
      if (timeSinceLastJoin < 10000) {
        // Less than 10 seconds elapsed since last join. Pause a bit.
        await new Promise(resolve => setTimeout(resolve, 10000 - timeSinceLastJoin));
      }

      // OK, reconnect now!
      join();
    }
  }

  ws.addEventListener("open", event => {
    currentWebSocket = ws;

    // Send user info message.
    ws.send(JSON.stringify({name: username}));
  });

  ws.addEventListener("message", event => {
    let data = JSON.parse(event.data);

    if (data.error) {
      addChatMessage(null, "* Error: " + data.error);
    } else if (data.joined) {
      let p = document.createElement("p");
      p.innerText = data.joined;
      roster.appendChild(p);
    } else if (data.quit) {
      for (let child of roster.childNodes) {
        if (child.innerText == data.quit) {
          roster.removeChild(child);
          break;
        }
      }
    } else if (data.ready) {
      // All pre-join messages have been delivered.
      if (!wroteWelcomeMessages) {
        wroteWelcomeMessages = true;
        addChatMessage(null,
            "* built using Cloudflare Workers Durable Objects");
        addChatMessage(null,
            "* You can invite someone to the room by sending them the URL");
        if (roomname.length == 64) {
          addChatMessage(null,
              "* This is a private room. You can invite someone to the room by sending them the URL at top of the page.");
        } else {
          addChatMessage(null,
              "* Welcome to chat.jessejesse.com/ #" + roomname + " ");
        }
      }
    } else {
      // A regular chat message.
      if (data.timestamp > lastSeenTimestamp) {
        addChatMessage(data.name, data.message);
        lastSeenTimestamp = data.timestamp;
      }
    }
  });

  ws.addEventListener("close", event => {
    console.log("WebSocket closed, reconnecting:", event.code, event.reason);
    rejoin();
  });
  ws.addEventListener("error", event => {
    console.log("WebSocket error, reconnecting:", event);
    rejoin();
  });
}

function addChatMessage(name, text) {
  let p = document.createElement("p");
  if (name) {
    let tag = document.createElement("span");
    tag.className = "username";
    tag.innerText = name + ": ";
    p.appendChild(tag);
  }
  p.appendChild(document.createTextNode(text));

  // Append the new chat line, making sure that if the chatlog was scrolled to the bottom
  // before, it remains scrolled to the bottom, and otherwise the scroll position doesn't
  // change.
  chatlog.appendChild(p);
  if (isAtBottom) {
    chatlog.scrollBy(0, 1e8);
  }
}

startNameChooser();
   
   // Function to display current page URL
      function showCurrentPageUrl() {
        var currentPageUrl = window.location.href; // Get the full URL
        var urlContainer = document.createElement('p');
        var urlLink = document.createElement('a');
        urlLink.textContent = "" + currentPageUrl;
        urlLink.href = currentPageUrl;
        urlLink.target = "_blank";
        urlContainer.appendChild(urlLink);
        document.body.appendChild(urlContainer);
        
        // Check if navigator.share() is supported
        if (navigator.share) {
          // Add click event listener for sharing
          urlLink.addEventListener('click', function(event) {
            event.preventDefault(); // Prevent the default action
            var shareUrl = currentPageUrl;
            navigator.share({url: shareUrl})
              .then(() => console.log('Successful share'))
              .catch((error) => console.log('Error sharing:', error));
          });
        } else {
          // Fallback for browsers that do not support navigator.share()
          urlLink.removeAttribute('href'); // Remove the href attribute
          urlLink.style.cursor = 'pointer'; // Change cursor style
          urlLink.addEventListener('click', function(event) {
            event.preventDefault(); // Prevent the default action
            alert('Share this URL: ' + currentPageUrl); // Display alert with URL
          });
        }
      }
      // Call the function when the page loads
      window.onload = showCurrentPageUrl;
  
