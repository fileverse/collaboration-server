import { v4 as uuidv4 } from "uuid";
import {
  AckResponse,
  AuthArgs,
  AuthResponseData,
  DocumentUpdateArgs,
  DocumentUpdateResponseData,
  DocumentCommitArgs,
  DocumentCommitResponseData,
  CommitHistoryArgs,
  UpdateHistoryArgs,
  UpdateHistoryResponseData,
  SnapshotArgs,
  MirrorSnapshotArgs,
  DocumentMetaArgs,
  PeersListArgs,
  AwarenessArgs,
  TerminateSessionArgs,
  EpochLoadedArgs,
  DocumentCommit,
  AppServer,
  AppSocket,
  AppType,
  ErrorCode,
} from "../types/index";
import { requireAuth } from "./auth-middleware";
import { authService } from "./auth";
import { mongodbStore, SessionTerminatedError } from "./mongodb-store";
import { sessionManager } from "./session-manager";
import { editBoundCache } from "./gate-epoch";
import { rotationCoordinator } from "./rotation-coordinator";
import { Hex, isAddress } from "viem";
import type { SocketHandlerDeps } from "./socket-handlers.deps";
import { config } from "../config";

const defaultDeps: SocketHandlerDeps = {
  authService,
  sessionManager,
  mongodbStore,
  editBoundCache,
};

function validateHexAddress(address: string | undefined, fieldName: string): address is Hex {
  if (!address || !isAddress(address)) {
    return false;
  }
  return true;
}

export function getRoomName(documentId: string, sessionDid: string): string {
  return `session::${documentId}__${sessionDid}`;
}

// Awareness-path re-check throttle; matches the edit-bound TTL so a revoked-but-idle
// actor is caught within one cache window without adding gate traffic.
const ADMIT_RECHECK_INTERVAL_MS = 10_000;

/**
 * Coerce an untrusted appType into a known AppType. Anything that is not exactly
 * "dsheet" becomes "ddoc" (the legacy default), so missing or invalid values
 * never fail enum validation and never widen access during the isolation check.
 */
function normalizeAppType(value: unknown): AppType {
  return value === "dsheet" ? "dsheet" : "ddoc";
}

export function registerEventHandlers(io: AppServer): void {
  io.on("connection", (socket: AppSocket) => {
    console.log(`New Socket.IO connection: ${socket.id}`);

    // Send handshake immediately
    socket.emit("/server/handshake", {
      server_did: authService.getServerDid(),
      message: "Connected to collaboration server",
    });

    // Register event handlers
    socket.on("/auth", (args, callback) => handleAuth(defaultDeps, io, socket, args, callback));
    socket.on("/documents/update", (args, callback) =>
      handleDocumentUpdate(defaultDeps, io, socket, args, callback)
    );
    socket.on("/documents/commit", (args, callback) =>
      handleDocumentCommit(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/commit/history", (args, callback) =>
      handleCommitHistory(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/update/history", (args, callback) =>
      handleUpdateHistory(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/snapshot", (args, callback) =>
      handleSnapshot(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/mirror-snapshot", (args, callback) =>
      handleMirrorSnapshot(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/meta", (args, callback) =>
      handleSetDocumentMeta(defaultDeps, socket, args, callback)
    );
    socket.on("/documents/peers/list", (args, callback) => handlePeersList(io, socket, args, callback));
    socket.on("/documents/awareness", (args) => handleAwareness(defaultDeps, io, socket, args));
    socket.on("/documents/terminate", (args, callback) =>
      handleTerminateSession(defaultDeps, io, socket, args, callback)
    );
    socket.on("/session/epoch_loaded", (args, callback) => handleEpochLoaded(socket, args, callback));

    // Disconnection handling
    socket.on("disconnecting", () => handleDisconnecting(defaultDeps, socket));
    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
    });
    socket.on("error", (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });
}

export async function handleAuth(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: AuthArgs,
  callback: (response: AckResponse<AuthResponseData>) => void
): Promise<void> {
  try {
    const { authService, sessionManager } = deps;
    const { documentId, collaborationToken, sessionDid } = args;
    const claimedAppType = normalizeAppType(args.appType);

    if (!collaborationToken) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Collaboration token is required",
        errorCode: ErrorCode.AUTH_TOKEN_MISSING,
      });
    }

    if (!documentId) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Document ID is required",
        errorCode: ErrorCode.DOCUMENT_ID_MISSING,
      });
    }

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
        errorCode: ErrorCode.SESSION_DID_MISSING,
      });
    }

    let existingSession = await sessionManager.getSession(documentId, sessionDid);

    let role: "owner" | "editor";
    let sessionType: "new" | "existing";
    let roomInfo: string | undefined;
    let resolvedAppType: AppType;
    let rail: "gp" | "workspace" | "public" | undefined = undefined;
    let railKind: "gp-actor" | "workspace" | "public" | undefined = undefined;
    let actorHandle: string | undefined = undefined;
    let provenIdentityDid: string | null = null;

    // joinOnly is strictly privilege-reducing: never create or bind a room on behalf of
    // a joiner. A workspace member's valid SHARED ownerToken would otherwise create the
    // session and bind THEIR identity as the room's root of trust (member-first-bind).
    // Distinct code so clients can render read-only-until-creator-opens.
    if (!existingSession && args.joinOnly === true) {
      // Termination blocks WRITES only (state-based, enforced independently in
      // createUpdate) — a rotated-away session's durable rows are still readable, so
      // retry terminated-inclusive before giving up. See docs/architecture/gp-semaphore.md.
      existingSession = await sessionManager.getSessionIncludingTerminated(documentId, sessionDid);
      if (!existingSession) {
        return callback({
          status: false,
          statusCode: 404,
          error: "Room not established",
          errorCode: ErrorCode.ROOM_NOT_ESTABLISHED,
        });
      }
    }

    if (!existingSession && args.ownerToken) {
      // - Set up a new session (owner flow)
      if (!args.ownerToken || !args.sessionDid) {
        return callback({
          status: false,
          statusCode: 400,
          error: "Document ID, owner token, and session DID are required",
          errorCode: ErrorCode.AUTH_TOKEN_MISSING,
        });
      }

      if (!validateHexAddress(args.contractAddress, "contractAddress") ||
        !validateHexAddress(args.ownerAddress, "ownerAddress")) {
        return callback({
          status: false,
          statusCode: 400,
          error: "Invalid contract address or owner address format",
          errorCode: ErrorCode.INVALID_ADDRESS,
        });
      }

      const ownerDid = await authService.verifyOwnerToken(
        args.ownerToken,
        args.contractAddress,
        args.ownerAddress
      );

      if (!ownerDid) {
        return callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
          errorCode: ErrorCode.AUTH_TOKEN_INVALID,
        });
      }

      // R3 owner binding (ddoc-only): the identity that becomes the room's root of
      // trust must be cryptographically proven, not client-asserted. Verify the identity
      // UCAN against the on-chain signingDid and bind THAT. Dsheets keep the legacy path
      // (no durable recovery / owner-op surface) — mirrors the ddoc-only join gate so a
      // dsheet owner is never rejected here.
      let boundOwnerIdentityDid = args.ownerIdentityDid;
      if (claimedAppType === "ddoc") {
        const provenSigningDid =
          args.identityToken && args.identityContractAddress
            ? await authService.verifyIdentityToken(
                args.identityToken,
                args.identityContractAddress as Hex,
                documentId
              )
            : null;
        if (!provenSigningDid) {
          return callback({
            status: false,
            statusCode: 401,
            error: "Valid identity proof required to create a durable session",
            errorCode: ErrorCode.AUTH_TOKEN_INVALID,
          });
        }
        boundOwnerIdentityDid = provenSigningDid;
        provenIdentityDid = provenSigningDid;
      }

      // Terminate other sessions with socket notification
      const otherSessions = await sessionManager.getOtherNonTerminatedSessions(
        documentId,
        ownerDid,
        args.contractAddress ?? null,
        sessionDid
      );
      for (const oldSession of otherSessions) {
        const oldRoomName = getRoomName(oldSession.documentId, oldSession.sessionDid);

        // Notify connected sockets before terminating
        io.to(oldRoomName).emit("/server/error", {
          errorCode: ErrorCode.SESSION_TERMINATED,
          message: "Session terminated by owner creating a new session",
          roomId: oldSession.documentId,
        });
        io.to(oldRoomName).emit("/session/terminated", {
          roomId: oldSession.documentId,
        });

        // Force-leave all sockets and reset auth
        const socketsInOldRoom = await io.in(oldRoomName).fetchSockets();
        for (const s of socketsInOldRoom) {
          s.data.authenticated = false;
          s.leave(oldRoomName);
        }

        // Now clean up DB — use the terminated session's own appType, not the new connection's claimed one
        await sessionManager.terminateSession(
          oldSession.documentId,
          oldSession.sessionDid,
          oldSession.appType ?? "ddoc"
        );
        console.log(
          `[Auth] Terminated old session: ${oldSession.sessionDid} for document: ${documentId}`
        );
      }

      await sessionManager.createSession({
        documentId,
        sessionDid,
        ownerDid,
        ownerIdentityDid: boundOwnerIdentityDid,
        portalAddress: args.contractAddress,
        collabJoinEnabled: false,
        roomInfo: args.roomInfo,
        appType: claimedAppType,
      });

      role = "owner";
      sessionType = "new";
      roomInfo = args.roomInfo;
      resolvedAppType = claimedAppType;
    } else if (existingSession) {
      // Join an existing session
      const userDid = await authService.verifyCollaborationToken(
        collaborationToken,
        existingSession.sessionDid,
        documentId
      );

      if (!userDid) {
        return callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
          errorCode: ErrorCode.AUTH_TOKEN_INVALID,
        });
      }

      // Isolation guard: a document belongs to exactly one app. Reject a client
      // whose declared app (missing ⇒ "ddoc") differs from the document's stored
      // app (missing ⇒ "ddoc"), so ddoc and dsheet can never join the same room.
      const storedAppType = normalizeAppType(existingSession.appType);
      if (claimedAppType !== storedAppType) {
        return callback({
          status: false,
          statusCode: 403,
          error: "App type mismatch for this document",
          errorCode: ErrorCode.APP_MISMATCH,
        });
      }

      let ownerDid = null;
      if (args.ownerToken && args.ownerAddress && args.contractAddress) {
        if (!validateHexAddress(args.contractAddress, "contractAddress") ||
          !validateHexAddress(args.ownerAddress, "ownerAddress")) {
          return callback({
            status: false,
            statusCode: 400,
            error: "Invalid contract address or owner address format",
            errorCode: ErrorCode.INVALID_ADDRESS,
          });
        }
        ownerDid = await authService.verifyOwnerToken(
          args.ownerToken,
          args.contractAddress,
          args.ownerAddress
        );
      }

      // Rotation heal: the chain is the root of trust for the portal collab
      // DID; the stored session value is a cache of it. A verified ownerToken
      // for the session's OWN portal that resolves to a different DID means
      // the workspace rotated (member removal) — adopt it, or the whole team
      // stays locked out of the established session. A foreign portal's owner
      // fails the address guard; a removed member's stale token never
      // verifies against the rotated chain slot.
      if (
        ownerDid &&
        existingSession.portalAddress &&
        args.contractAddress &&
        existingSession.portalAddress.toLowerCase() ===
          args.contractAddress.toLowerCase() &&
        ownerDid !== existingSession.ownerDid
      ) {
        await sessionManager.updateSessionOwnerDid(
          documentId,
          existingSession.sessionDid,
          ownerDid
        );
        existingSession.ownerDid = ownerDid;
      }

      // Identity-based role (ddoc-only): the shared team-portal
      // DID cannot tell a member from the creator, but the per-person identity signingDid
      // can. On a bound session a presented identityToken DECIDES the role — owner needs
      // BOTH the proven identity match and the portal ownerToken match. An invalid token
      // is a 401, never a fallback; a token-less join keeps the legacy compare only while
      // the sunset flag is on.
      const boundIdentityDid = existingSession.ownerIdentityDid ?? null;
      if (storedAppType === "ddoc" && boundIdentityDid && args.identityToken) {
        const provenDid = args.identityContractAddress
          ? await authService.verifyIdentityToken(
              args.identityToken,
              args.identityContractAddress as Hex,
              documentId
            )
          : null;
        if (!provenDid) {
          return callback({
            status: false,
            statusCode: 401,
            error: "Invalid identity proof",
            errorCode: ErrorCode.AUTH_TOKEN_INVALID,
          });
        }
        role =
          provenDid === boundIdentityDid && ownerDid === existingSession.ownerDid
            ? "owner"
            : "editor";
        provenIdentityDid = provenDid;
      } else if (
        storedAppType === "ddoc" &&
        boundIdentityDid &&
        !args.identityToken &&
        !config.auth.legacyRoleFallback
      ) {
        role = "editor";
      } else {
        role = ownerDid === existingSession.ownerDid ? "owner" : "editor";
      }

      // Captured pre-cap: whatever role resolution (above) already decided is "owner" —
      // the same credentials would get full owner rights via the plain (non-joinOnly)
      // path, so a joinOnly read for them is strictly privilege-reducing, never a new grant.
      const ownerVerifiedPreCap = role === "owner";

      // joinOnly caps the role: on an unbound/legacy session the shared-DID compare
      // resolves a team member to owner — a join-only bearer never gets owner powers.
      if (args.joinOnly === true && role === "owner") role = "editor";

      // R3 heal (ddoc-only): a session bound before identity proof was required (or
      // bound empty) is filled — once, atomically — by a proven owner, so the pre-fix
      // corpus becomes recoverable on the owner's next open. Never overwrites a real bind.
      if (
        storedAppType === "ddoc" &&
        role === "owner" &&
        args.joinOnly !== true &&
        !existingSession.ownerIdentityDid &&
        args.identityToken &&
        args.identityContractAddress
      ) {
        const provenSigningDid = await authService.verifyIdentityToken(
          args.identityToken,
          args.identityContractAddress as Hex,
          documentId
        );
        if (provenSigningDid) {
          provenIdentityDid = provenSigningDid;
          await sessionManager.fillOwnerIdentityDidIfAbsent(
            documentId,
            existingSession.sessionDid,
            provenSigningDid
          );
          existingSession.ownerIdentityDid = provenSigningDid;
        }
      }

      // Rail-exclusive edit admission (ddoc-only, non-owner): resolved by the credential the
      // client presents, never a sequential try-each. An editUcan join is GP-or-reject and must
      // NEVER fall through to workspace/public — a demoted GP editor still holds the un-rotated
      // roomKey, and falling through would let them re-enter as a lower-trust bearer.
      //
      // Owner-verified joinOnly bypasses this gate entirely (admission only — role stays
      // capped to "editor" above): the gate exists to admit non-owner editors onto a grant
      // rail, but an owner-shaped bearer already cleared a stricter bar. rail/railKind are
      // left unset, so isStillAdmitted's default (checks collabJoinEnabled) fails closed for
      // any later write attempt on a private doc — the headless read path never calls it.
      if (storedAppType === "ddoc" && role === "editor" && !(args.joinOnly === true && ownerVerifiedPreCap)) {
        if (args.editUcan) {
          const gp = await authService.verifyEditUcan(args.editUcan, documentId);
          if (gp?.kind === "actor") {
            const minEpoch = await deps.mongodbStore.getMinEditEpoch(documentId);
            if (gp.epoch < minEpoch) {
              return callback({
                status: false,
                statusCode: 403,
                error: "Edit access is not authorized for this document",
                errorCode: ErrorCode.JOIN_DISABLED,
              });
            }
            // Per-actor positive-state admission (keyed on editHandle = hash(C, docId)); fail-closed on
            // cold/unbound. See docs/architecture/gp-semaphore.md.
            const state = await deps.editBoundCache.check(documentId, gp.editHandle);
            if (state === "bound" || state === "stale-bound") {
              rail = "gp";
              railKind = "gp-actor";
              actorHandle = gp.editHandle;
            } else {
              return callback({
                status: false,
                statusCode: 403,
                error: "Edit access is not authorized for this document",
                errorCode: ErrorCode.JOIN_DISABLED,
              });
            }
          } else {
            return callback({
              status: false,
              statusCode: 403,
              error: "Edit access is not authorized for this document",
              errorCode: ErrorCode.JOIN_DISABLED,
            });
          }
        } else if (
          // Whole-team PrivateEdit: membership proof is the SHARED portal secret — the
          // ownerToken must resolve to the session's own ownerDid (identity already told
          // us this bearer is not the creator). A valid-but-DIFFERENT ownerToken is some
          // other portal's owner and gets no workspace admission.
          ownerDid &&
          ownerDid === existingSession.ownerDid &&
          (await sessionManager.getWorkspaceEditEnabled(documentId, existingSession.sessionDid)) === true
        ) {
          rail = "workspace";
          railKind = "workspace";
          actorHandle = args.ownerAddress?.toLowerCase();
        } else {
          // Read fresh from Mongo (an HTTP process can flip this; the in-memory copy may be
          // stale). Only an explicit `true` opens a ddoc room to a non-GP, non-workspace bearer.
          const joinEnabled = await sessionManager.getCollabJoinEnabled(documentId, existingSession.sessionDid);
          if (joinEnabled !== true) {
            return callback({
              status: false,
              statusCode: 403,
              error: "Link sharing is disabled for this document",
              errorCode: ErrorCode.JOIN_DISABLED,
            });
          }
          rail = "public";
          railKind = "public";
          actorHandle = args.actorHandle;
        }
      }

      if (role === "owner" && args.roomInfo) {
        await sessionManager.updateRoomInfo(
          documentId,
          existingSession.sessionDid,
          existingSession.ownerDid,
          args.roomInfo
        );
      }

      sessionType = "existing";
      roomInfo = existingSession.roomInfo;
      resolvedAppType = storedAppType;
    } else {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    // In-place re-auth on rotation cutover: capture the pre-rotation room membership
    // BEFORE it's overwritten below, so the socket can be silently migrated off it.
    const priorSessionDid = socket.data.sessionDid;

    // Set socket data
    socket.data.authenticated = true;
    socket.data.documentId = documentId;
    socket.data.sessionDid = sessionDid;
    socket.data.role = role;
    socket.data.appType = resolvedAppType;
    socket.data.rail = rail;
    socket.data.railKind = railKind;
    socket.data.actorHandle = actorHandle;
    socket.data.actorIdentityDid = provenIdentityDid ?? undefined;

    // Join the Socket.IO room
    const roomName = getRoomName(documentId, sessionDid);

    if (args.rotationCutover && priorSessionDid && priorSessionDid !== sessionDid) {
      // Silent migration — no user_left. The socket never disconnects, so the
      // `disconnecting` sweep never fires for the pre-rotation sessionDid; do that
      // cleanup here instead to keep the old session's client list honest.
      socket.leave(getRoomName(documentId, priorSessionDid));
      await sessionManager.removeClientFromSession(documentId, priorSessionDid, socket.id);
    }

    socket.join(roomName);

    // Track in session manager (for session lifecycle / deactivation logic)
    await sessionManager.addClientToSession(documentId, sessionDid, socket.id);

    console.log(sessionType === "new" ? "SETUP DONE" : "JOINED SESSION", documentId, role);

    // Broadcast membership change to others in the room — suppressed on a rotation
    // cutover re-auth so the surviving socket doesn't blip presence for itself.
    if (!args.rotationCutover) {
      const membershipPayload = {
        action: "user_joined" as const,
        user: { role },
        roomId: documentId,
      };
      socket.to(roomName).emit("/room/membership_change", membershipPayload);
    }

    // Latest stored title beats the session-frozen roomInfo blob for joiners
    // arriving after a mid-session rename.
    const documentMeta = await deps.mongodbStore
      .getDocumentMeta(documentId)
      .catch(() => null);

    callback({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role,
        sessionType,
        roomInfo,
        title: documentMeta?.title ?? null,
      },
    });
  } catch (error) {
    console.error("Error in auth handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

// Live per-actor edit-admission re-check against the ADMITTED context stamped at JOIN.
// Fail-closed for the actor rail (cold/unbound → reject). See docs/architecture/gp-semaphore.md.
export async function isStillAdmitted(socket: AppSocket, deps: SocketHandlerDeps): Promise<boolean> {
  const { rail, railKind, documentId, sessionDid, actorHandle } = socket.data;
  if (!documentId || !sessionDid) return false;
  if (railKind === "gp-actor") {
    if (!actorHandle) return false;
    const s = await deps.editBoundCache.check(documentId, actorHandle);
    return s === "bound" || s === "stale-bound";
  }
  if (rail === "workspace") return (await deps.sessionManager.getWorkspaceEditEnabled(documentId, sessionDid)) === true;
  return (await deps.sessionManager.getCollabJoinEnabled(documentId, sessionDid)) === true;
}

export async function handleDocumentUpdate(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: DocumentUpdateArgs,
  callback: (response: AckResponse<DocumentUpdateResponseData>) => void
): Promise<void> {
  try {
    const { authService, sessionManager, mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const { data, collaborationToken } = args;
    const documentId = args.documentId || socket.data.documentId;

    if (!data) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Update data is required",
        errorCode: ErrorCode.UPDATE_DATA_MISSING,
      });
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid,
      documentId
    );

    if (!isVerified) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
    }

    if (socket.data.role !== "owner" && normalizeAppType(socket.data.appType) === "ddoc") {
      const revoked = !(await isStillAdmitted(socket, deps));
      if (revoked) {
        // Ack the reason first, then drop the socket — the revoked actor must not
        // keep presence/read on a session they can no longer write to.
        callback({
          status: false,
          statusCode: 403,
          error: "Edit access has been revoked",
          errorCode: ErrorCode.EDIT_REVOKED,
        });
        socket.disconnect(true);
        return;
      }
    }

    const updateId = uuidv4();
    const createdAt = Date.now();

    // Persist before broadcasting: a peer must never hold an update that is absent from
    // the durable seq stream. On write failure this fails safe — nothing is fanned out.
    let update;
    try {
      update = await mongodbStore.createUpdate({
        id: updateId,
        documentId,
        data,
        updateType: "yjs_update",
        committed: false,
        commitCid: null,
        createdAt,
        sessionDid,
        appType: socket.data.appType,
      });
    } catch (err) {
      if (err instanceof SessionTerminatedError) {
        callback({
          status: false,
          statusCode: 409,
          error: "Session terminated",
          errorCode: ErrorCode.SESSION_TERMINATED,
        });
        return;
      }
      throw err;
    }

    const roomName = getRoomName(documentId, socket.data.sessionDid);
    socket.to(roomName).emit("/document/content_update", {
      id: updateId,
      data,
      createdAt,
      roomId: documentId,
    });

    callback({
      status: true,
      statusCode: 200,
      data: {
        id: update.id,
        documentId: update.documentId,
        data: update.data,
        updateType: update.updateType,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
      },
    });
  } catch (error) {
    console.error("Error in document update handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleDocumentCommit(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: DocumentCommitArgs,
  callback: (response: AckResponse<DocumentCommitResponseData>) => void
): Promise<void> {
  try {
    const { authService, sessionManager, mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    if (socket.data.role !== "owner") {
      return callback({
        status: false,
        statusCode: 403,
        error: "Only owners can create commits",
        errorCode: ErrorCode.COMMIT_UNAUTHORIZED,
      });
    }

    const { updates, cid, ownerToken, ownerAddress, contractAddress } = args;
    const documentId = args.documentId || socket.data.documentId;

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    if (!updates || !Array.isArray(updates) || !cid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Updates array and CID are required",
        errorCode: ErrorCode.COMMIT_MISSING_DATA,
      });
    }

    if (!validateHexAddress(contractAddress, "contractAddress") ||
      !validateHexAddress(ownerAddress, "ownerAddress")) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Invalid contract address or owner address format",
        errorCode: ErrorCode.INVALID_ADDRESS,
      });
    }

    const isVerified = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress,
      ownerAddress
    );

    if (!isVerified) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
    }

    // Create commit record
    const commit = await mongodbStore.createCommit({
      id: uuidv4(),
      documentId,
      cid,
      updates,
      createdAt: Date.now(),
      sessionDid,
      appType: socket.data.appType,
    });

    callback({
      status: true,
      statusCode: 200,
      data: {
        cid: commit.cid,
        createdAt: commit.createdAt,
        documentId: commit.documentId,
        updates: commit.updates,
      },
    });
  } catch (error) {
    console.error("Error in document commit handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleCommitHistory(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: CommitHistoryArgs,
  callback: (response: AckResponse<{ history: DocumentCommit[]; total: number }>) => void
): Promise<void> {
  try {
    const { mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const filterParams = { documentId, sessionDid: socket.data.sessionDid };
    const [commits, total] = await Promise.all([
      mongodbStore.getCommitsByDocument(filterParams, { offset, limit, sort }),
      mongodbStore.countCommitsByDocument(filterParams),
    ]);

    callback({
      status: true,
      statusCode: 200,
      data: {
        history: commits,
        total,
      },
    });
  } catch (error) {
    console.error("Error in commit history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleUpdateHistory(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: UpdateHistoryArgs,
  callback: (response: AckResponse<UpdateHistoryResponseData>) => void
): Promise<void> {
  try {
    const { mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;
    const { snapshot, updates, nextSeq, hasMore } = await mongodbStore.getHydrationRange(
      documentId,
      socket.data.sessionDid,
      { sinceSeq: args.sinceSeq }
    );
    const history = snapshot ? [snapshot, ...updates] : updates;

    callback({
      status: true,
      statusCode: 200,
      data: { history, total: history.length, snapshot, nextSeq, hasMore },
    });
  } catch (error) {
    console.error("Error in update history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleSnapshot(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: SnapshotArgs,
  callback: (response: AckResponse<{ id: string; seq: number }>) => void
): Promise<void> {
  try {
    const { authService, sessionManager, mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    if (socket.data.role !== "owner") {
      return callback({
        status: false,
        statusCode: 403,
        error: "Only owners can write snapshots",
        errorCode: ErrorCode.COMMIT_UNAUTHORIZED,
      });
    }

    const { data, collaborationToken, publishedMarker, floorSeq } = args;
    const documentId = args.documentId || socket.data.documentId;

    if (!data) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Snapshot data is required",
        errorCode: ErrorCode.UPDATE_DATA_MISSING,
      });
    }

    // floorSeq is load-bearing for gapless hydration (§3.7): the tail is served as
    // seq > floorSeq. A snapshot without a proven floor would let the server serve
    // seq > snapshot.seq and silently orphan a concurrent writer's update, so reject it.
    if (typeof floorSeq !== "number" || !Number.isInteger(floorSeq) || floorSeq < 0) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Snapshot floorSeq (non-negative integer) is required",
        errorCode: ErrorCode.UPDATE_DATA_MISSING,
      });
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid,
      documentId
    );

    if (!isVerified) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
    }

    const snapshot = await mongodbStore.createSnapshot({
      id: uuidv4(),
      documentId,
      data,
      updateType: "snapshot",
      committed: false,
      commitCid: null,
      createdAt: Date.now(),
      sessionDid,
      appType: socket.data.appType,
      publishedMarker: publishedMarker ?? null,
      floorSeq,
    });

    callback({
      status: true,
      statusCode: 200,
      data: { id: snapshot.id, seq: snapshot.seq! },
    });
  } catch (error) {
    console.error("Error in snapshot handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

// fileKeyEpoch is a client-asserted rotation counter (0 until a private narrow rotates the
// fileKey). The mirror read returns the highest epoch, so an out-of-range value would shadow
// every legitimate write; bound it generously here, at the trust boundary.
const MAX_FILE_KEY_EPOCH = 1_000_000;

export async function handleMirrorSnapshot(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: MirrorSnapshotArgs,
  callback: (response: AckResponse<{ ok: true }>) => void
): Promise<void> {
  try {
    const { sessionManager, mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({ status: false, statusCode: 401, error: "Not authenticated", errorCode: ErrorCode.NOT_AUTHENTICATED });
    }
    // Any admitted editor may author the mirror: the owner, or a rail-admitted non-owner
    // editor (socket.data.rail set at JOIN). Viewers never socket-connect (load-on-open).
    if (socket.data.role !== "owner" && !socket.data.rail) {
      return callback({ status: false, statusCode: 403, error: "Not an editor", errorCode: ErrorCode.COMMIT_UNAUTHORIZED });
    }
    // Live per-actor re-check: a demoted editor holding a stale socket must not author a mirror.
    if (socket.data.role !== "owner" && !(await isStillAdmitted(socket, deps))) {
      callback({ status: false, statusCode: 403, error: "Edit access has been revoked", errorCode: ErrorCode.EDIT_REVOKED });
      socket.disconnect(true);
      return;
    }

    const { data, fileKeyEpoch } = args;
    const documentId = args.documentId || socket.data.documentId;
    if (!data || !Number.isSafeInteger(fileKeyEpoch) || fileKeyEpoch < 0 || fileKeyEpoch > MAX_FILE_KEY_EPOCH) {
      return callback({ status: false, statusCode: 400, error: "Mirror data and an in-range non-negative integer fileKeyEpoch are required", errorCode: ErrorCode.UPDATE_DATA_MISSING });
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    if (!session) {
      return callback({ status: false, statusCode: 404, error: "Session not found", errorCode: ErrorCode.SESSION_NOT_FOUND });
    }

    await mongodbStore.upsertMirrorSnapshot({
      documentId,
      data,
      fileKeyEpoch,
      sessionDid: session.sessionDid,
      createdAt: Date.now(),
    });

    callback({ status: true, statusCode: 200, data: { ok: true } });
  } catch (error) {
    console.error("Error in mirror snapshot handler:", error);
    callback({ status: false, statusCode: 500, error: "Internal server error", errorCode: ErrorCode.INTERNAL_ERROR });
  }
}

export async function handleSetDocumentMeta(
  deps: SocketHandlerDeps,
  socket: AppSocket,
  args: DocumentMetaArgs,
  callback: (response: AckResponse<{ ok: true }>) => void
): Promise<void> {
  try {
    const { sessionManager, mongodbStore } = deps;
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    if (socket.data.role !== "owner") {
      return callback({
        status: false,
        statusCode: 403,
        error: "Only owners can write document metadata",
        errorCode: ErrorCode.COMMIT_UNAUTHORIZED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;
    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);

    if (!session) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    await mongodbStore.upsertDocumentMeta({
      documentId,
      sessionDid: session.sessionDid,
      ownerDid: session.ownerDid ?? null,
      ownerIdentityDid: session.ownerIdentityDid ?? null,
      portalAddress: session.portalAddress ?? null,
      editLock: args.editLock,
      title: args.title,
    });

    const roomName = getRoomName(documentId, socket.data.sessionDid);
    socket.to(roomName).emit("/document/meta_update", {
      roomId: documentId,
      title: args.title,
    });

    callback({
      status: true,
      statusCode: 200,
      data: { ok: true },
    });
  } catch (error) {
    console.error("Error in set-document-meta handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handlePeersList(
  io: AppServer,
  socket: AppSocket,
  args: PeersListArgs,
  callback: (response: AckResponse<{ peers: string[] }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;

    const roomName = getRoomName(documentId, socket.data.sessionDid);
    const sockets = await io.in(roomName).fetchSockets();
    const peers = sockets.map((s) => s.id);

    callback({
      status: true,
      statusCode: 200,
      data: { peers },
    });
  } catch (error) {
    console.error("Error in peers list handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleAwareness(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: AwarenessArgs,
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      return;
    }

    const documentId = args.documentId || socket.data.documentId;
    const { data } = args;

    // Broadcast awareness update to room, excluding sender
    const roomName = getRoomName(documentId, socket.data.sessionDid);
    const awarenessPayload = { data, roomId: documentId };
    socket.to(roomName).emit("/document/awareness_update", awarenessPayload);

    // Post-broadcast, fire-and-forget: catches revoked-but-idle (reading, cursor-moving)
    // actors that never hit the write chokepoints. Kicks are per-actor/rail-off only.
    if (socket.data.role !== "owner" && normalizeAppType(socket.data.appType) === "ddoc") {
      const now = Date.now();
      if (now - (socket.data.lastAdmitRecheckAt ?? 0) >= ADMIT_RECHECK_INTERVAL_MS) {
        socket.data.lastAdmitRecheckAt = now;
        void isStillAdmitted(socket, deps)
          .then((ok) => {
            if (!ok) socket.disconnect(true);
          })
          .catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("Error in awareness handler:", error);
  }
}

export async function handleTerminateSession(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: TerminateSessionArgs,
  callback: (response: AckResponse<{ message: string }>) => void
): Promise<void> {
  try {
    const { authService, sessionManager } = deps;
    const { documentId, sessionDid, ownerToken, ownerAddress, contractAddress } = args;

    console.log("TERMINATING SESSION", documentId);

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
        errorCode: ErrorCode.SESSION_DID_MISSING,
      });
    }

    const session = await sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    if (!validateHexAddress(contractAddress, "contractAddress") ||
      !validateHexAddress(ownerAddress, "ownerAddress")) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Invalid contract address or owner address format",
        errorCode: ErrorCode.INVALID_ADDRESS,
      });
    }

    const ownerDid = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress,
      ownerAddress
    );

    if (
      ownerDid &&
      session.portalAddress &&
      contractAddress &&
      session.portalAddress.toLowerCase() === String(contractAddress).toLowerCase() &&
      ownerDid !== session.ownerDid
    ) {
      await sessionManager.updateSessionOwnerDid(documentId, session.sessionDid, ownerDid);
      session.ownerDid = ownerDid;
    }

    if (ownerDid !== session.ownerDid) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Unauthorized",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
    }

    const roomName = getRoomName(documentId, session.sessionDid);

    // 1. Capture all sockets in room before any mutations
    const socketsInRoom = await io.in(roomName).fetchSockets();

    // 2. Broadcast termination to all in room (excluding sender)
    const terminatePayload = { roomId: documentId };
    socket.to(roomName).emit("/session/terminated", terminatePayload);

    // 3. Deauth and force-leave all sockets (blocks new handlers)
    for (const s of socketsInRoom) {
      s.data.authenticated = false;
      s.leave(roomName);
    }

    // 4. Deactivate session in memory (prevents new handlers from finding it)
    await sessionManager.deactivateSession(documentId, session.sessionDid);

    // 5. Clean up DB
    await sessionManager.terminateSession(documentId, session.sessionDid, session.appType ?? "ddoc");

    callback({
      status: true,
      statusCode: 200,
      data: { message: "Session terminated" },
    });
  } catch (error) {
    console.error("Error in terminate session handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export function handleEpochLoaded(
  socket: AppSocket,
  args: EpochLoadedArgs,
  callback: (r: AckResponse<{ ok: true }>) => void
): void {
  if (!requireAuth(socket)) {
    return callback({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
      errorCode: ErrorCode.NOT_AUTHENTICATED,
    });
  }
  rotationCoordinator.recordAck(args.documentId || socket.data.documentId, socket.id);
  callback({ status: true, statusCode: 200, data: { ok: true } });
}

export async function handleDisconnecting(
  deps: SocketHandlerDeps,
  socket: AppSocket
): Promise<void> {
  try {
    const { sessionManager } = deps;
    if (!socket.data.authenticated || !socket.data.documentId || !socket.data.sessionDid) {
      return;
    }

    const roomName = getRoomName(socket.data.documentId, socket.data.sessionDid);

    // Broadcast departure BEFORE leaving rooms
    // (socket is still in its rooms during "disconnecting" event)
    const departurePayload = {
      action: "user_left" as const,
      user: { role: socket.data.role },
      roomId: socket.data.documentId,
    };
    socket.to(roomName).emit("/room/membership_change", departurePayload);

    // Remove from session tracking (handles deactivation if last client)
    await sessionManager.removeClientFromSession(
      socket.data.documentId,
      socket.data.sessionDid,
      socket.id
    );
  } catch (error) {
    console.error(`Error during disconnection cleanup for ${socket.id}:`, error);
  }
}
