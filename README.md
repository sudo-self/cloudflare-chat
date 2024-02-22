### <a href="https://chat.jessejesse.com"> chat.JesseJesse.com</a>
utilizing [Durable Objects](https://blog.cloudflare.com/introducing-workers-durable-objects) This app runs 100% on Cloudflare's edge.

This chat app uses a Durable Object to control each chat room. Users connect to the object using WebSockets. Messages from one user are broadcast to all the other users. The chat history is also stored in durable storage, but this is only for history. Real-time messages are relayed directly from one user to others without going through the storage layer.

This chat app is only a few hundred lines of code. The deployment configuration is only a few lines. Yet, it will scale seamlessly to any number of chat rooms, limited only by Cloudflare's available resources. Of course, any individual chat room's scalability has a limit, since each object is single-threaded. But, that limit is far beyond what a human participant could keep up with anyway.

    wrangler publish


