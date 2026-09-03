# RTC Node (and Bring Your Own Server)

This repo covers how Real-time Collaboration (RTC) with end-to-end encryption is achieved via the Fileverse middleware on [ddocs.new](https://ddocs.new), [dsheets.new](https://dsheets.new) and Fileverse Workspace. Our approach offers both privacy and security via client-side encryption and by offering decentralized ways of enabling private multiplayer collaboration for one's own documents, spreadsheets and workspaces.

**Tl;dr** By default, RTC v0.2 is facilitated by a stateless web-socket server (v0.1 was WebRTC) that deletes all the encrypted data it stores about a RTC session once the latest state of the file is pushed on IPFS and added to the creator’s personal onchain content registry. All data touching the stateless web-socket server is stored only ephemerally and is first encrypted client-side.

**Update:** RTC Node has improved from the stateless relay described above into a durable collaboration backend. Encrypted file updates are now persisted instead of held only in memory, an editing session survives everyone going offline and the latest state of a file can always be recovered from the server, while everything stored remains encrypted client-side. The server cannot read any content. The server also enforces edit access permissions: to be admitted as an editor, a collaborator first proves to the access gate (a separate service, hosted in the [voprf-server](https://github.com/fileverse/voprf-server) repo) that they were granted edit access on that file, using a [Semaphore](https://semaphore.pse.dev) Zero-Knowledge Proof; the gate then mints a signed edit credential (a UCAN), and this server verifies that credential against the gate's pinned DID before accepting any edits. When access is revoked the affected peer is disconnected and the remaining editors move to a new room key. Presence (who is currently in a file session) is server-side as well, and long sessions are periodically compacted into snapshots to keep rooms small and fast to load.

Self-hosting and Decentralization:

- Bring Your Own Server: RTC on ddocs.new and Fileverse Workspace can also work by self-hosting your own web-socket server and enabling your collaboration session through it.
- Decentralisation explorations: People using ddocs can also turn on the Waku servers discovery feature, which lets them discover and connect to community-hosted servers for RTC via Waku. This feature is still in early Alpha and highly experimental. Please use at your own risk. Thank you team Waku and Vàclav san for all the insights in helping us add this first version on ddocs! For the waku enabled version check this branch: feat/waku.

This repo was audited by [Dédalo](https://www.dedalo.io) in Q3 2025 as part of a broader security assessment of dDocs, with this collaboration server explicitly in scope. The full report (September 2025, revised October 2025) is available here: [Dédalo audit report](./audits/dedalo-ddocs-audit-2025-q3.pdf). Note that the audit covered the stateless relay described at the top of this README — the durable-edit and edit-access changes described in the update above landed after the audit.

## Features

- ✅ **Real-time Collaboration**: Socket.IO-based communication for instant updates
- ✅ **Y.js Integration**: CRDT-based conflict resolution for collaborative editing
- ✅ **Awareness Protocol**: Real-time cursor and selection sharing
- ✅ **UCAN Authentication**: Decentralized authentication using cryptographic capabilities
- ✅ **Edit-Access Enforcement**: Writes require an edit credential minted by the access gate after a Semaphore zero-knowledge proof
- ✅ **Durable Storage**: Encrypted updates and snapshots persisted in MongoDB, so sessions survive everyone going offline
- ✅ **Room Management & Presence**: Multi-user rooms with a server-side roster, revocation kicks, and room-key rotation
- ✅ **TypeScript**: Full type safety and excellent developer experience

## Quick Start

#### Prerequisites

- MongoDB should be running (encrypted updates and snapshots are persisted there)
- Redis is optional — enable it with `REDIS_ENABLED=true` if you run one
- Create a `.env` file at the repo root which will contain the environment variables.
  - Below are the values that go into it
    ```bash
    PORT # Server port (default: 5001)
    HOST # Server host (default: 0.0.0.0)
    NODE_ENV # Environment mode (development/production)
    CORS_ORIGINS # Comma-separated list of allowed origins, or * to allow any origin (default: *)
    SERVER_DID # Server's DID for UCAN authentication
    MONGODB_URI # MongoDB URI where encrypted updates and snapshots are persisted
    REDIS_ENABLED # "true" to use Redis (default: false)
    REDISCLOUD_URL # Redis URL (default: redis://localhost:6379)
    RPC_URL # RPC URL to query onchain state and only allow people with relevant access to create rooms related to DDocs
    GATE_DID # DID of the access gate (see the voprf-server repo); gate-based edit admission stays disabled until this is set
    COLLAB_WEBHOOK_API_KEY # API key protecting the /webhooks/file-deleted endpoint
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
      - For local development, this should be `ws://localhost:5001/`
      - For production, this should be the url of your web-socket server `wss://your-domain/path`

#### Next steps

- Clone the repository and `cd` into it
  ```bash
  git clone https://github.com/fileverse/collaboration-server.git && cd collaboration-server
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
  ```

## Waku Support

For this you just need to start the server with WS_URL set as the wss url that is being provided for the running rtc server. Once the server is up and running you just need to go to settings and trigger waku enabled rtc server discover and let your frontend find this server. If there are multiple options frontend client selects one of the url at random from the avaiable community servers. You can always over ride that option and set it to your own server's wss endpoint.

## API Endpoints

### HTTP Endpoints

- `GET /health` - Health check and server stats
- `GET /documents/:documentId/mirror` - Read the latest encrypted state the server holds for a document
- `GET /documents/:documentId/share-context` - Read the context a client needs to open a shared document
- `POST /flush` - Push a final encrypted state for a document outside a live socket session
- `POST /list-my-documents` - List the documents the server holds state for (authenticated)
- `DELETE /documents/:documentId` - Delete the server-held state for a document
- `POST /documents/:documentId/collab-join-enabled` - Owner action: allow or stop collaborators joining live editing
- `POST /documents/:documentId/workspace-edit-tier` - Owner action: turn workspace-wide editing on or off
- `POST /documents/:documentId/evict-edit-actors` - Owner action: disconnect editors whose access was revoked
- `POST /workspaces/:portalAddress/evict-member` - Owner action: disconnect a removed workspace member from its sessions
- `POST /documents/:documentId/rotate-session` - Owner action: move a live session to a fresh room key
- `POST /webhooks/file-deleted` - Webhook (API-key protected) that ends sessions when a file is deleted

### WebSocket API

The server speaks [Socket.IO](https://socket.io) — it is no longer the raw-JSON message protocol of earlier versions. Connect a Socket.IO client to `ws://${env.HOST}:${env.PORT}/`; the server greets each connection with a `/server/handshake` event, and the client must then authenticate before anything else.

#### Authentication

Emit `/auth` with an acknowledgement callback. Core fields:

```json
{
  "documentId": "doc123",
  "sessionDid": "did:key:z6Mk...",
  "collaborationToken": "ucan_token_here",
  "editUcan": "(gate-minted edit credential — required to write on edit-gated documents)",
  "actorHandle": "(per-editor handle bound to that credential)"
}
```

The acknowledgement returns the assigned role (`owner` or `editor`) and whether the session is `new` or `existing`.

#### Client → server events

- `/documents/update` - Send an encrypted Y.js update
- `/documents/update/history` - Fetch the stored updates for a document
- `/documents/commit` - Record that a batch of updates was committed to IPFS
- `/documents/commit/history` - Fetch past commits
- `/documents/snapshot` - Store a compacted snapshot of the session so far
- `/documents/mirror-snapshot` - Store the latest full encrypted state of the document
- `/documents/meta` - Update encrypted document metadata (e.g. the live title)
- `/documents/peers/list` - List who is in the room
- `/documents/awareness` - Broadcast encrypted cursor/selection data
- `/documents/terminate` - End the session
- `/session/epoch_loaded` - Confirm a new room key was loaded after rotation

#### Server → client events

- `/server/handshake` - Sent on connect
- `/document/content_update` - Another editor's encrypted update
- `/document/awareness_update` - Another editor's cursor/selection data
- `/document/meta_update` - Encrypted document metadata changed
- `/room/membership_change` - Someone joined or left the room
- `/session/terminated` - The session ended, or your access was revoked
- `/server/error` - Something went wrong

## Usage with the Sync Engine

The client half of this protocol lives in the [fileverse-ddoc](https://github.com/fileverse/fileverse-ddoc) repo, under `package/sync-local` (`useSyncManager`). It handles connecting, authenticating, encrypting updates with the room key, and recovering a document from the server's stored state — apps embedding the dDocs editor get it out of the box.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│   Client App    │     │ Collaboration Server │     │     Storage      │
│                 │     │                      │     │                  │
│  ┌───────────┐  │     │  Socket.IO events    │     │  MongoDB:        │
│  │Sync engine│──┼─────┼─► Auth (UCAN + gate  │─────┼─► updates,       │
│  └───────────┘  │     │    edit credentials) │     │   snapshots,     │
│  ┌───────────┐  │     │  Session manager     │     │   sessions       │
│  │ Y.js Doc  │  │     │  Owner-op HTTP API   │     │  Redis: pub/sub  │
│  └───────────┘  │     └──────────┬───────────┘     └──────────────────┘
└─────────────────┘                │
                                   ▼
                        Access gate (voprf-server):
                     mints edit credentials after a
                    Semaphore zero-knowledge proof
```

## Development

### Project Structure

```
src/
├── config/                 # Configuration management
├── services/               # Core business logic
│   ├── auth.ts                  # UCAN auth + gate edit-credential verification
│   ├── socket-handlers.ts       # Socket.IO event handlers
│   ├── session-manager.ts       # Session and room lifecycle
│   ├── mongodb-store.ts         # Durable storage for updates, snapshots, commits
│   ├── owner-op-routes.ts       # Owner HTTP actions (join toggle, evictions, ...)
│   ├── rotate-route.ts          # Room-key rotation endpoint
│   ├── rotation-coordinator.ts  # Coordinates rotation across live editors
│   ├── flush-route.ts           # Out-of-session state flush
│   ├── published-reconciler.ts  # Background reconciliation of published documents
│   └── deleted-file-webhook.ts  # Cleanup when a file is deleted
├── database/               # MongoDB models
├── cron/                   # Scheduled background jobs
├── redis.ts                # Redis wiring
├── types/                  # TypeScript type definitions
└── index.ts                # Server entry point + HTTP routes
```

### Adding Features

1. **New Socket.IO Events**: Add handlers in `socket-handlers.ts`
2. **Authentication**: Modify `auth.ts` for custom auth logic
3. **Storage**: Extend `mongodb-store.ts`
4. **HTTP Endpoints & Middleware**: Add Express routes in `index.ts`

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
