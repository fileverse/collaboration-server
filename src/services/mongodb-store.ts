import { DocumentUpdate, DocumentCommit } from "../types/index";
import { DocumentUpdateModel, DocumentCommitModel } from "../database/models";

export class MongoDBStore {
  // Update management
  async createUpdate(update: DocumentUpdate): Promise<DocumentUpdate> {
    try {
      const mongoUpdate = new DocumentUpdateModel({
        _id: update.id,
        documentId: update.documentId,

        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
      });

      await mongoUpdate.save();
      return update;
    } catch (error) {
      console.error("Error creating update:", error);
      throw error;
    }
  }

  async getUpdate(updateId: string): Promise<DocumentUpdate | undefined> {
    try {
      const update = await DocumentUpdateModel.findById(updateId);
      if (!update) return undefined;

      return {
        id: update._id,
        documentId: update.documentId,

        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
      };
    } catch (error) {
      console.error("Error getting update:", error);
      return undefined;
    }
  }

  async getUpdatesByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      committed?: boolean;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentUpdate[]> {
    try {
      let query = DocumentUpdateModel.find({ documentId: documentId });

      // Filter by committed status
      if (options.committed !== undefined) {
        query = query.where({ committed: options.committed });
      }

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ createdAt: sortOrder });

      // Apply pagination
      if (options.offset) {
        query = query.skip(options.offset);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const updates = await query.exec();

      return updates.map((update) => ({
        id: update._id,
        documentId: update.documentId,

        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
      }));
    } catch (error) {
      console.error("Error getting updates by document:", error);
      return [];
    }
  }

  async markUpdatesAsCommitted(updateIds: string[], commitId: string) {
    try {
      await DocumentUpdateModel.updateMany(
        { _id: { $in: updateIds } },
        {
          committed: true,
          commitCid: commitId,
        }
      );
    } catch (error) {
      console.error("Error marking updates as committed:", error);
      throw error;
    }
  }

  // Commit management
  async createCommit(commit: DocumentCommit): Promise<DocumentCommit> {
    try {
      const mongoCommit = new DocumentCommitModel({
        _id: commit.id,
        documentId: commit.documentId,

        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
      });

      await mongoCommit.save();

      // Mark associated updates as committed
      await this.markUpdatesAsCommitted(commit.updates, commit.cid);

      return commit;
    } catch (error) {
      console.error("Error creating commit:", error);
      throw error;
    }
  }

  async getCommit(commitId: string): Promise<DocumentCommit | undefined> {
    try {
      const commit = await DocumentCommitModel.findById(commitId);
      if (!commit) return undefined;

      return {
        id: commit._id,
        documentId: commit.documentId,
        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
      };
    } catch (error) {
      console.error("Error getting commit:", error);
      return undefined;
    }
  }

  async getCommitsByDocument(
    documentId: string,
    options: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentCommit[]> {
    try {
      let query = DocumentCommitModel.find({ documentId: documentId });

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ createdAt: sortOrder });

      // Apply pagination
      if (options.offset) {
        query = query.skip(options.offset);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const commits = await query.exec();

      return commits.map((commit) => ({
        id: commit._id,
        documentId: commit.documentId,
        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
      }));
    } catch (error) {
      console.error("Error getting commits by document:", error);
      return [];
    }
  }

  // Statistics
  async getStats() {
    try {
      const [updates, commits] = await Promise.all([
        DocumentUpdateModel.countDocuments(),
        DocumentCommitModel.countDocuments(),
      ]);

      return {
        updates,
        commits,
      };
    } catch (error) {
      console.error("Error getting stats:", error);
      return {
        updates: 0,
        commits: 0,
      };
    }
  }

  // Clear all data (useful for testing)
  async clear() {
    try {
      await Promise.all([DocumentUpdateModel.deleteMany({}), DocumentCommitModel.deleteMany({})]);
    } catch (error) {
      console.error("Error clearing data:", error);
      throw error;
    }
  }
}

export const mongodbStore = new MongoDBStore();
