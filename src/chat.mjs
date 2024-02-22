
import HTML from "./chat.html";


async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {

      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          return handleApiRequest(path.slice(1), request, env);

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}


async function handleApiRequest(path, request, env) {
  // We've received at API request. Route the request based on the path.

  switch (path[0]) {
    case "room": {
    
      if (!path[1]) {
        // The request is for just "/api/room", with no ID.
        if (request.method == "POST") {
          // POST to /api/room creates a private room.
        
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
        
          return new Response("Method not allowed", {status: 405});
        }
      }

    
      let name = path[1];

    
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
      
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
      
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

   
      let roomObject = env.rooms.get(id);


      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}


export class ChatRoom {
  constructor(controller, env) {
  
    this.storage = controller.storage;

  
    this.env = env;


    this.sessions = [];

    this.lastTimestamp = 0;
  }


  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

         
          let ip = request.headers.get("CF-Connecting-IP");


          let pair = new WebSocketPair();

         
          await this.handleSession(pair[1], ip);

         
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  
  async handleSession(webSocket, ip) {

    webSocket.accept();

   
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    let session = {webSocket, blockedMessages: []};
    this.sessions.push(session);

  
    this.sessions.forEach(otherSession => {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    });


    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });

    // Set event handlers to receive messages.
    let receivedUserInfo = false;
    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
        
          webSocket.close(1011, "WebSocket broken.");
          return;
        }

      
        if (!limiter.checkLimit()) {
          webSocket.send(JSON.stringify({
            error: "Your IP is being rate-limited, please try again later."
          }));
          return;
        }

        // I guess we'll use JSON.
        let data = JSON.parse(msg.data);

        if (!receivedUserInfo) {
          // The first message the client sends is the user info message with their name. Save it
          // into their session object.
          session.name = "" + (data.name || "anonymous");

          // Don't let people use ridiculously long names. (This is also enforced on the client,
          // so if they get here they are not using the intended client.)
          if (session.name.length > 32) {
            webSocket.send(JSON.stringify({error: "Name too long."}));
            webSocket.close(1009, "Name too long.");
            return;
          }

          // Deliver all the messages we queued up since the user connected.
          session.blockedMessages.forEach(queued => {
            webSocket.send(queued);
          });
          delete session.blockedMessages;

          // Broadcast to all other connections that this user has joined.
          this.broadcast({joined: session.name});

          webSocket.send(JSON.stringify({ready: true}));

          // Note that we've now received the user info message.
          receivedUserInfo = true;

          return;
        }

        // Construct sanitized message for storage and broadcast.
        data = { name: session.name, message: "" + data.message };

        // Block people from sending overly long messages. This is also enforced on the client,
        // so to trigger this the user must be bypassing the client code.
        if (data.message.length > 256) {
          webSocket.send(JSON.stringify({error: "Message too long."}));
          return;
        }

        // Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
        // messages at the same time (or if the clock somehow goes backwards????), we'll assign
        // them sequential timestamps, so at least the ordering is maintained.
        data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
        this.lastTimestamp = data.timestamp;

        // Broadcast the message to all other WebSockets.
        let dataStr = JSON.stringify(data);
        this.broadcast(dataStr);

        // Save message.
        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr);
      } catch (err) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
        webSocket.send(JSON.stringify({error: err.stack}));
      }
    });

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    // Iterate over all the sessions sending them messages.
    let quitters = [];
    this.sessions = this.sessions.filter(session => {
      if (session.name) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
      
        session.blockedMessages.push(message);
        return true;
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}


export class RateLimiter {
  constructor(controller, env) {
    // Timestamp at which this IP will next be allowed to send a message. Start in the distant
    // past, i.e. the IP can send a message now.
    this.nextAllowedTime = 0;
  }

  // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
  // Either way, the result is the number of seconds to wait before allowing the IP to perform its
  // next action.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // POST request means the user performed an action.
        // We allow one action per 5 seconds.
        this.nextAllowedTime += 5;
      }

      // Return the number of seconds that the client needs to wait.
      //
      // We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 requests
      // in a quick burst before they start being limited.
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
  // The constructor takes two functions:
  // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
  //   the limit. This may be called multiple times as needed to reconnect, if the connection is
  //   lost.
  // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
  //   should probably disconnect the client, so that they can reconnect and start over.
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;

    // Call the callback to get the initial stub.
    this.limiter = getLimiterStub();

    // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
    // false.
    this.inCooldown = false;
  }


  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

 
  async callLimiter() {
    try {
      let response;
      try {
        // Currently, fetch() needs a valid URL even though it's not actually going to the
        // internet. We may loosen this in the future to accept an arbitrary string. But for now,
        // we have to provide a dummy URL that will be ignored at the other end anyway.
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
      
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      // The response indicates how long we want to pause before accepting more requests.
      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      // Done waiting.
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
