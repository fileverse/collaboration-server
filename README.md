# Fileverse Collaboration Server

A WebSocket-based real-time collaboration server that provides document synchronization, awareness features, and UCAN-based authentication.

## Features

- ✅ **Real-time Collaboration**: WebSocket-based communication for instant updates
- ✅ **Y.js Integration**: CRDT-based conflict resolution for collaborative editing
- ✅ **Awareness Protocol**: Real-time cursor and selection sharing
- ✅ **UCAN Authentication**: Decentralized authentication using cryptographic capabilities
- ✅ **In-Memory Storage**: Fast, ephemeral storage for development and testing
- ✅ **Room Management**: Multi-user document rooms with role-based access
- ✅ **TypeScript**: Full type safety and excellent developer experience

## Quick Start

### Installation

```bash
npm install
```

### Development

```bash
# Start in development mode with auto-reload
npm run dev
```

### Production

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

## Configuration

Copy `env.example` to `.env` and adjust the settings:

```bash
cp env.example .env
```

### Environment Variables

- `PORT`: Server port (default: 5000)
- `HOST`: Server host (default: 0.0.0.0)
- `NODE_ENV`: Environment mode (development/production)
- `CORS_ORIGINS`: Comma-separated list of allowed origins
- `SERVER_DID`: Server's DID for UCAN authentication
- `RATE_LIMIT_WINDOW_MS`: Rate limiting window in milliseconds
- `RATE_LIMIT_MAX`: Maximum requests per window

## API Endpoints

### HTTP Endpoints

- `GET /health` - Health check and server stats
- `GET /info` - Server information and capabilities
- `GET /stats` - WebSocket connection statistics

### WebSocket API

Connect to `ws://localhost:5000/` and send JSON messages:

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
