import { DocumentUpdate, DocumentCommit, RoomMember } from "../types/index";

export class MemoryStore {
  private documents = new Map<string, any>();
  private updates = new Map<string, DocumentUpdate>();
  private commits = new Map<string, DocumentCommit>();
  private roomMembers = new Map<string, RoomMember[]>();
  private updatesByDocument = new Map<string, string[]>();
  private commitsByDocument = new Map<string, string[]>();

  // Document management
  getDocument(documentId: string) {
    return this.documents.get(documentId);
  }

  setDocument(documentId: string, data: any) {
    this.documents.set(documentId, data);
  }

  // Update management
  createUpdate(update: DocumentUpdate): DocumentUpdate {
    this.updates.set(update.id, update);

    // Add to document's update list
    const docUpdates = this.updatesByDocument.get(update.document_id) || [];
    docUpdates.push(update.id);
    this.updatesByDocument.set(update.document_id, docUpdates);

    return update;
  }

  getUpdate(updateId: string): DocumentUpdate | undefined {
    return this.updates.get(updateId);
  }

  getUpdatesByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      committed?: boolean;
      sort?: "asc" | "desc";
    } = {}
  ): DocumentUpdate[] {
    const updateIds = this.updatesByDocument.get(documentId) || [];
    let updates = updateIds.map((id) => this.updates.get(id)).filter(Boolean) as DocumentUpdate[];

    // Filter by committed status
    if (options.committed !== undefined) {
      updates = updates.filter((update) => update.committed === options.committed);
    }

    // Sort by creation time
    updates.sort((a, b) => {
      const order = options.sort === "desc" ? -1 : 1;
      return (a.created_at - b.created_at) * order;
    });

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || updates.length;
    return updates.slice(offset, offset + limit);
  }

  markUpdatesAsCommitted(updateIds: string[], commitId: string) {
    updateIds.forEach((updateId) => {
      const update = this.updates.get(updateId);
      if (update) {
        update.committed = true;
        update.commit_cid = commitId;
        this.updates.set(updateId, update);
      }
    });
  }

  // Commit management
  createCommit(commit: DocumentCommit): DocumentCommit {
    this.commits.set(commit.id, commit);

    // Add to document's commit list
    const docCommits = this.commitsByDocument.get(commit.document_id) || [];
    docCommits.push(commit.id);
    this.commitsByDocument.set(commit.document_id, docCommits);

    // Mark associated updates as committed
    this.markUpdatesAsCommitted(commit.updates, commit.cid);

    return commit;
  }

  getCommit(commitId: string): DocumentCommit | undefined {
    return this.commits.get(commitId);
  }

  getCommitsByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    } = {}
  ): DocumentCommit[] {
    const commitIds = this.commitsByDocument.get(documentId) || [];
    let commits = commitIds.map((id) => this.commits.get(id)).filter(Boolean) as DocumentCommit[];

    // Sort by creation time
    commits.sort((a, b) => {
      const order = options.sort === "desc" ? -1 : 1;
      return (a.created_at - b.created_at) * order;
    });

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || commits.length;
    return commits.slice(offset, offset + limit);
  }

  // Room member management
  getRoomMembers(documentId: string): RoomMember[] {
    return this.roomMembers.get(documentId) || [];
  }

  addRoomMember(documentId: string, member: RoomMember) {
    const members = this.getRoomMembers(documentId);
    const existingIndex = members.findIndex((m) => m.user_id === member.user_id);

    if (existingIndex >= 0) {
      members[existingIndex] = member;
    } else {
      members.push(member);
    }

    this.roomMembers.set(documentId, members);
  }

  removeRoomMember(documentId: string, userId: string) {
    const members = this.getRoomMembers(documentId);
    const filteredMembers = members.filter((m) => m.user_id !== userId);
    this.roomMembers.set(documentId, filteredMembers);
  }

  getRoomMember(documentId: string, userId: string): RoomMember | undefined {
    const members = this.getRoomMembers(documentId);
    return members.find((m) => m.user_id === userId);
  }

  // Statistics
  getStats() {
    return {
      documents: this.documents.size,
      updates: this.updates.size,
      commits: this.commits.size,
      rooms: this.roomMembers.size,
    };
  }

  // Clear all data (useful for testing)
  clear() {
    this.documents.clear();
    this.updates.clear();
    this.commits.clear();
    this.roomMembers.clear();
    this.updatesByDocument.clear();
    this.commitsByDocument.clear();
  }
}

export const memoryStore = new MemoryStore();
