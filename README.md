# RTC Node (with Waku Support)

This repo covers how Real-time Collaboration(RTC) with end-to-end encryption is achieved via the Fileverse middleware on [ddocs.new](ddocs.new). Our approach offers both privacy and security via client-side encryption and by offering decentralized ways of enabling RTC on one's own documents.

**Tl;dr** By default, RTC v0.2 on dDocs is facilitated by a stateless web-socket server (v0.1 was WebRTC) that deletes all the encrypted data it stores about a RTC session once the latest state of the document is pushed on IPFS and added to the document creator’s personal onchain content registry.
All data touching the stateless web-socket server is stored only ephemerally and is first encrypted client-side.

Self-hosting and Decentralization:
- Bring your own Server: RTC on ddocs.new can also work by self-hosting your own web-socket server and enabling your collaboration session through it.
- Decentralisation explorations: People using dDocs can also turn on the Waku servers discovery feature, which lets them discover and connect to community-hosted servers for RTC via Waku. This feature is still in early Alpha and highly experimental :warning:. Please use at your own risk. Thank you team Waku and Vàclav san for all the insights in helping us add this first version on dDocs! For the waku enabled version check this branch: feat/waku

This repo is currently being audited by Dedalo. Findings will be shared in a report here when completed.

## Features

- ✅ **Real-time Collaboration**: WebSocket-based communication for instant updates
- ✅ **Y.js Integration**: CRDT-based conflict resolution for collaborative editing
- ✅ **Awareness Protocol**: Real-time cursor and selection sharing
- ✅ **UCAN Authentication**: Decentralized authentication using cryptographic capabilities
- ✅ **In-Memory Storage**: Fast, ephemeral storage for development and testing
- ✅ **Room Management**: Multi-user document rooms with role-based access
- ✅ **TypeScript**: Full type safety and excellent developer experience

## Quick Start

#### Prerequisites
- Redis server should be running and listening on port `:6379`
- Create a configuration file which will contain the environment variables.
  - Run `cp env.example .env`
  - Below are the values that go into it
    ```bash
    PORT # Server port (default: 5000)
    HOST # Server host (default: 0.0.0.0)
    NODE_ENV # Environment mode (development/production)
    CORS_ORIGINS # Comma-separated list of allowed origins
    SERVER_DID # Server's DID for UCAN authentication
    MONGODB_URI # MongoDB URI where you want your updates to be saved temporarily
    RPC_URL # RPC URL to query onchain state and only allow people with relevant access to create rooms related to DDocs
    WS_URL # Optional env vars if you want your node to participate in the waku discovery
    ```
  - Here's a guide on how to generate values for some of the env variables.
    - `SERVER_DID`
      - Run the below script `node <filename>.js`
        ```js
        const UCAN = require("@ucans/ucans");

        (async () => {
          const privateKeyBase64 = "YOUR_PRIVATE_KEY_GOES_HERE";
          // creating key pair from private key
          const keyPair = await UCAN.EdKeypair.fromSecretKey(privateKeyBase64);
          const did = keyPair.did();
          console.log("Generated DID from private key:", did);
        })();
        ```
    - `RPC_URL`
      - Create an account on [QuickNode](https://www.quicknode.com/).
      - Sign in to create an endpoint (this should appear under Getting started)
      - Select Gnosis Chain.
      - Select your plan and finalize.
      - In the endpoint dashboard, copy the HTTPS RPC endpoint (It should appear on the right) and put that value in the .env for `RPC_URL`
    - `WS_URL`
      - For local development, this should be `ws://localhost:5000/`
      - For production, this should be the url of your web-socket server `wss://your-domain/path`

#### Next steps
- Clone the repository and `cd` into it
  ```bash
  git clone https://github.com/fileverse/collaboration-server.git && cd collaboration-server`
  ```
- Install the dependencies
  ```bash
  npm install
  ```
- To start the development server run 
  ```bash
  npm run dev
  ```
- For production,
  ```bash
  # Build the project
  npm run build

  # Start the production server
  npm start

  # Or use the convenient start script
  ./start.sh

  # Or with PM2 for process management
  pm2 start ecosystem.config.js --env production
  ```


## Waku Support

For this you just need to start the server with WS_URL set as the wss url that is being provided for the running rtc server. Once the server is up and running you just need to go to settings and trigger waku enabled rtc server discover and let your frontend find this server. If there are multiple options frontend client selects one of the url at random from the avaiable community servers. You can always over ride that option and set it to your own server's wss endpoint.

## API Endpoints

### HTTP Endpoints

- `GET /health` - Health check and server stats

### WebSocket API

Connect to `ws://${env.HOST}:{env.PORT}/` and send JSON messages:

#### Authentication

```json
{
  "cmd": "/auth",
  "args": {
    "username": "user123",
    "token": "ucan_token_here",
    "documentId": "room123"
  },
  "seqId": "unique_id"
}
```

#### Document Updates

```json
{
  "cmd": "/documents/update",
  "args": {
    "documentId": "room123",
    "data": "encrypted_yjs_update",
    "update_snapshot_ref": null
  },
  "seqId": "unique_id"
}
```

#### Create Commit

```json
{
  "cmd": "/documents/commit",
  "args": {
    "documentId": "room123",
    "updates": ["update_id_1", "update_id_2"],
    "cid": "ipfs_hash",
    "data": "encrypted_document_state"
  },
  "seqId": "unique_id"
}
```

#### Get Room Members

```json
{
  "cmd": "/documents/peers/list",
  "args": {
    "documentId": "room123"
  },
  "seqId": "unique_id"
}
```

#### Awareness Updates

```json
{
  "cmd": "/documents/awareness",
  "args": {
    "documentId": "room123",
    "data": {
      "position": "encrypted_cursor_data"
    }
  },
  "seqId": "unique_id"
}
```

## Usage with Sync Package

This server is designed to work with the `@fileverse-dev/sync` package. Here's how to configure the client:

```typescript
import { useSyncMachine } from "@fileverse-dev/sync";

const { connect, disconnect, isConnected, ydoc, isReady } = useSyncMachine({
  roomId: "your-room-id",
  wsProvider: "ws://localhost:5000/",
  onError: (err) => console.error(err),
});

// Connect with username and room key
const roomKey = await crypto.subtle.importKey(/* ... */);
connect("username", roomKey);
```

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client App    │    │  Collaboration   │    │   Memory Store  │
│                 │    │     Server       │    │                 │
│  ┌───────────┐  │    │                  │    │  ┌───────────┐  │
│  │ Sync Pkg  │──┼────┼─► WebSocket      │    │  │ Documents │  │
│  └───────────┘  │    │   Manager        │    │  │ Updates   │  │
│                 │    │                  │    │  │ Commits   │  │
│  ┌───────────┐  │    │  ┌─────────────┐ │    │  │ Members   │  │
│  │  Y.js Doc │  │    │  │ Auth Service│ │    │  └───────────┘  │
│  └───────────┘  │    │  └─────────────┘ │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Development

### Project Structure

```
src/
├── config/           # Configuration management
├── services/         # Core business logic
│   ├── auth.ts       # UCAN authentication
│   ├── memory-store.ts # In-memory data storage
│   └── websocket-manager.ts # WebSocket handling
├── types/            # TypeScript type definitions
└── index.ts          # Server entry point
```

### Adding Features

1. **New WebSocket Commands**: Add handlers in `websocket-manager.ts`
2. **Authentication**: Modify `auth.ts` for custom auth logic
3. **Storage**: Replace `memory-store.ts` with persistent storage
4. **Middleware**: Add Express middleware in `index.ts`

## Production Deployment

### Environment Setup

- Set `NODE_ENV=production`
- Configure proper CORS origins
- Set up monitoring and logging
- Use a process manager like PM2 for production
- Implement proper authentication key management
- Consider using a reverse proxy (nginx) for SSL termination

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details
